import { z } from 'zod';

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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
