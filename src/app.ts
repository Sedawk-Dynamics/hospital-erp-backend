import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { corsOptions } from './config/cors';
import { logger } from './config/logger';
import { errorHandler } from './middleware/errorHandler';
import { apiRouter } from './modules/router';
import { formatDateTimeIST } from './shared/date.utils';

const app = express();

// Security
app.use(helmet());
app.use(cors(corsOptions));

// Razorpay webhooks need raw body for signature verification — must come BEFORE json parser
app.use('/api/v1/online-payments/webhook', express.raw({ type: 'application/json' }));
app.use('/api/v1/subscription-plans/webhook', express.raw({ type: 'application/json' }));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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
