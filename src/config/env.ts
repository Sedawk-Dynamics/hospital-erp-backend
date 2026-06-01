import { z } from 'zod';

// Env vars are strings. z.coerce.boolean() is unsafe here — Boolean("false")
// is true — so parse the literal "true"/"1" tokens instead.
const boolFromEnv = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : v === 'true' || v === '1'));

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string().min(10),
  JWT_REFRESH_SECRET: z.string().min(10),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default(''),
  BCRYPT_SALT_ROUNDS: z.coerce.number().default(12),
  RAZORPAY_KEY_ID: z.string().min(1),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),

  // ── PACS / DICOM integration ────────────────────────────────────────────
  // PACS_PROVIDER selects how uploaded DICOM is archived + viewed:
  //   none       → keep files in /uploads, render with the in-house viewer (default)
  //   orthanc    → push to a self-hosted Orthanc server; view via its bundled OHIF
  //   postdicom  → cloud PostDICOM PACS + its zero-footprint web viewer
  PACS_PROVIDER: z.enum(['none', 'orthanc', 'postdicom']).default('none'),

  // Orthanc — backend talks to ORTHANC_URL (server-to-server, e.g. http://orthanc:8042),
  // browsers open the viewer at ORTHANC_PUBLIC_URL (e.g. http://localhost:8042).
  ORTHANC_URL: z.string().default('http://localhost:8042'),
  ORTHANC_PUBLIC_URL: z.string().default(''),
  ORTHANC_USERNAME: z.string().default(''),
  ORTHANC_PASSWORD: z.string().default(''),
  // Path the Orthanc OHIF plugin serves the viewer at (RouterBasename + /viewer).
  ORTHANC_OHIF_PATH: z.string().default('/ohif/viewer'),

  // PostDICOM — cloud PACS. Credentials come from Settings → Cloud API Settings
  // (Premium plan). When upload creds are absent the provider runs in
  // link/embed mode (store + embed a PostDICOM viewer URL).
  POSTDICOM_API_URL: z.string().default('https://www.postdicom.com'),
  POSTDICOM_ACCOUNT_KEY: z.string().default(''),
  POSTDICOM_API_KEY: z.string().default(''),
  POSTDICOM_VIEWER_URL: z.string().default(''),

  // ── PACS auth gateway (reverse proxy) ───────────────────────────────────
  // When enabled, browsers never touch Orthanc directly: OHIF + DICOMweb are
  // served through /api/v1/pacs/o/* on this backend, gated by a short-lived
  // cookie minted from the user's JWT and scoped to the user's tenant.
  // Production-safe; keep Orthanc OFF the public network and point only this
  // proxy at it.
  PACS_PROXY_ENABLED: boolFromEnv(false),
  // Browser-facing base URL of THIS backend (where the proxy is reachable),
  // e.g. http://localhost:4000 in dev or https://api.example.com in prod.
  PACS_PROXY_PUBLIC_URL: z.string().default('http://localhost:4000'),
  // Cookie attributes. Local (http, same-site): lax + insecure. Prod (https,
  // cross-domain iframe): 'none' + secure=true (required for the iframe to
  // send the cookie).
  PACS_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  PACS_COOKIE_SECURE: boolFromEnv(false),
  PACS_SESSION_TTL_MIN: z.coerce.number().default(30),

  // Single source of truth: when true, delete the local /uploads copy of a
  // DICOM after it is successfully archived to Orthanc (S3). Download + the
  // in-house fallback viewer then stream the bytes back from the PACS through
  // an authenticated retrieve endpoint. Default false (keep the local copy).
  PACS_DROP_LOCAL: boolFromEnv(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
