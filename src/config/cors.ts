import { CorsOptions } from 'cors';

// CORS policy.
//
// Reflect every request origin and allow credentials. Credentials
// (cookies) are required by the PACS auth gateway (the OHIF iframe rides a
// cookie); the browser refuses to store cross-origin cookies under a wildcard
// origin, so `origin: true` echoes the caller's exact Origin instead of sending
// "*". This permits browser clients from any domain, localhost, preview URL,
// or mobile webview. Non-browser clients such as Postman do not enforce CORS,
// but continue to work as normal.

export const corsOptions: CorsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Tenant-Slug'],
  exposedHeaders: ['X-Total-Count', 'Content-Disposition'],
  maxAge: 86400,
  optionsSuccessStatus: 204,
};
