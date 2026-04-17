import { CorsOptions } from 'cors';
import { env } from './env';

const allowedOrigins = [
  env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:5173',
  'https://trms-frontend-belnie-2a9c34-82-29-166-148.traefik.me',
];

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Tenant-Slug'],
  exposedHeaders: ['X-Total-Count'],
};
