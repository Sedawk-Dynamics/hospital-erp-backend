// Prisma returns BigInt for fields like fileSizeBytes; JSON.stringify cannot
// serialize BigInt natively and Express's res.json() would otherwise 500.
// Serialize as a string to preserve precision — callers that need a number
// can wrap in Number().
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { corsOptions } from './config/cors';
import { env } from './config/env';
import { logger } from './config/logger';
import { runWithRequestContext } from './config/request-context';
import { errorHandler } from './middleware/errorHandler';
import { globalIpLimiter } from './middleware/rateLimiter';
import { apiRouter } from './modules/router';
import { formatDateTimeIST } from './shared/date.utils';

const app = express();

// ---------------------------------------------------------------
// Proxy configuration
// ---------------------------------------------------------------
// We run behind a load balancer / reverse proxy (Traefik, Nginx, etc.)
// in every non-dev environment. Without this, `req.ip` reports the proxy's
// address and rate limiting becomes worthless — every user sees the same IP.
// '1' trusts the first hop, which is the correct value for a single LB/proxy.
app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : 'loopback');

// CORS must run before helmet / rate limiter so preflights always get headers.
// The global cors() middleware also answers OPTIONS preflights automatically.
app.use(cors(corsOptions));

// ---------------------------------------------------------------
// Security headers (Helmet)
// ---------------------------------------------------------------
// This is a JSON API that is called cross-domain by the SPA (cenaps.in →
// api.cenaps.in), serves user images from /uploads cross-domain, and embeds
// the OHIF DICOM viewer in a cross-domain iframe. So we keep the low-risk
// hardening headers but disable the ones that would break those flows:
//   - CSP off: the browser app + iframe are on other origins; a default CSP
//     (frameAncestors 'none') would block the viewer iframe.
//   - CORP cross-origin: lets the SPA load /uploads assets from this origin.
//   - COEP/COOP off: don't force cross-origin isolation on embedded resources.
//   - frameguard off: the viewer is framed from a different domain.
// HSTS is enabled only in production (dev runs on http://localhost).
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    frameguard: false,
    referrerPolicy: { policy: 'no-referrer' },
    hsts:
      env.NODE_ENV === 'production'
        ? { maxAge: 15552000, includeSubDomains: true, preload: false }
        : false,
  }),
);

// ---------------------------------------------------------------
// Global per-IP rate limit (DDoS / scraping guard)
// Applied before body parsing so we reject floods cheaply — without
// buffering 10 MB JSON payloads for requests we're about to drop.
// Webhooks and /health are skipped inside the limiter itself.
// ---------------------------------------------------------------
app.use(globalIpLimiter);

// Razorpay webhooks need raw body for signature verification — must come BEFORE json parser
app.use('/api/v1/online-payments/webhook', express.raw({ type: 'application/json' }));
app.use('/api/v1/subscription-plans/webhook', express.raw({ type: 'application/json' }));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 1000 }));

// Compression.
//
// Skipped for /uploads: everything there is already-compressed binary — PDFs,
// JPEGs, PNGs, DICOM. Re-compressing costs CPU per byte, returns essentially
// nothing, and makes the response buffer through the compressor instead of
// streaming straight off disk. That is the opposite of what a report download
// wants.
app.use(
  compression({
    filter: (req, res) => {
      if (req.path.startsWith('/uploads')) return false;
      return compression.filter(req, res);
    },
  }),
);

// Logging
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: formatDateTimeIST(new Date()) });
});

// Serve uploaded files statically.
//
// Upload filenames are content-unique (`file-<timestamp>-<random>.ext`) and are
// never rewritten in place, so a given URL always returns the same bytes. That
// makes them safe to cache hard. Without this every re-open of a report pulled
// the whole file down again — the report a doctor looks at three times was
// fetched three times.
//
// `immutable` stops the browser even revalidating; `etag`/`lastModified` remain
// on for any client that ignores it.
app.use(
  '/uploads',
  express.static(path.resolve(process.cwd(), 'uploads'), {
    maxAge: '7d',
    immutable: true,
    etag: true,
    lastModified: true,
  }),
);

// Per-request context (client IP + user-agent = the "Machine" of an action).
// Runs the rest of the request inside an AsyncLocalStorage store so audit
// writers deep in the services can stamp who/where without extra plumbing.
// `authenticate` later adds userId to this same store.
app.use('/api/v1', (req, res, next) => {
  const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress || undefined;
  const userAgent = req.headers['user-agent'] as string | undefined;
  runWithRequestContext({ ipAddress, userAgent }, () => next());
});

// API routes
app.use('/api/v1', apiRouter);

// Error handling
app.use(errorHandler);

export { app };
