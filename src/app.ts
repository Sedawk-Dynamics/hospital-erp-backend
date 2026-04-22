import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { corsOptions } from './config/cors';
import { env } from './config/env';
import { logger } from './config/logger';
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
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ---------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------
app.use(
  helmet({
    // We serve an API — no inline HTML — so a strict default CSP is safe.
    // Note: static `/uploads` is served by the same origin so we allow self.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // API responses should never be cached across users by intermediaries.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    // HSTS only applies in production (dev uses http://localhost).
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

// Compression
app.use(compression());

// Logging
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: formatDateTimeIST(new Date()) });
});

// Serve uploaded files statically
app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));

// API routes
app.use('/api/v1', apiRouter);

// Error handling
app.use(errorHandler);

export { app };
