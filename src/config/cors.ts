import { CorsOptions } from 'cors';
import { env } from './env';

export const corsOptions: CorsOptions = {
  origin: env.NODE_ENV === 'production'
    ? env.FRONTEND_URL
    : [env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002', 'http://localhost:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Tenant-Slug'],
  exposedHeaders: ['X-Total-Count'],
};
