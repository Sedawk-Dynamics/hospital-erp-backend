import { CorsOptions } from 'cors';
import { env } from './env';

const STATIC_ALLOWED_ORIGINS = [
  'https://trms.webelio.org',
  'https://www.trms.webelio.org',
  'http://localhost:3000',
  'http://localhost:5173',
];

const envOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
const allowedOrigins = new Set([...STATIC_ALLOWED_ORIGINS, env.FRONTEND_URL, ...envOrigins]);

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    if (env.NODE_ENV !== 'production') return callback(null, true);
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Tenant-Slug'],
  exposedHeaders: ['X-Total-Count'],
  optionsSuccessStatus: 204,
};
