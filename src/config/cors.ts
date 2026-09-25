import { CorsOptions } from 'cors';
import { env } from './env';

// CORS policy.
//
// Default: reflect the request origin and allow credentials. Credentials
// (cookies) are required by the PACS auth gateway (the OHIF iframe rides a
// cookie); the browser refuses to store cross-origin cookies under a wildcard
// origin, so we echo the specific origin instead of "*". Bearer-token auth is
// unaffected.
//
// Lockdown switch: set CORS_ORIGINS to a comma-separated allowlist
// (e.g. "https://cenaps.in,https://www.cenaps.in") to restrict the API to
// those origins only. Leave it empty to allow every origin (current prod
// default per product decision). FRONTEND_URL is always allowed when set.
const normalizeOrigin = (origin: string) => origin.trim().replace(/\/+$/, '');

// These are the first-party browser origins for the hosted product. Keep them
// available even when a deployment still has an older CORS_ORIGINS value (for
// example the legacy trms.webelio.org origin from docker-compose). Environment
// values can add more origins, but cannot accidentally lock the live SPA out.
const firstPartyOrigins = [
  'https://dev.cenaps.in',
  'https://cenaps.in',
  'https://www.cenaps.in',
];

const allowlist = [
  ...firstPartyOrigins,
  ...env.CORS_ORIGINS.split(',').map((s) => s.trim()),
  env.FRONTEND_URL,
]
  .map(normalizeOrigin)
  .filter(Boolean);

const useAllowlist = env.CORS_ORIGINS.trim().length > 0;

export const corsOptions: CorsOptions = {
  // When CORS_ORIGINS is set → restrict to the allowlist. Otherwise reflect any
  // origin (cors echoes the caller's Origin, which keeps credentials working).
  origin: useAllowlist
    ? (origin, cb) => {
        // Non-browser clients (curl, server-to-server, health checks) send no
        // Origin — always allow those. Disallowed browser origins are denied by
        // simply omitting the CORS headers (cb(null, false)) rather than raising
        // an error, so the request still returns normally and the browser blocks
        // it — no 500s in the logs.
        if (!origin || allowlist.includes(normalizeOrigin(origin))) return cb(null, true);
        return cb(null, false);
      }
    : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Tenant-Slug'],
  exposedHeaders: ['X-Total-Count', 'Content-Disposition'],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};
