import 'dotenv/config';
import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/database';
import { redis } from './config/redis';
import { app } from './app';
import { runSubscriptionJobs } from './jobs/subscription-reminders';
import { archiveStaleOpProgressNotes } from './modules/progress-notes/progress-notes.service';

const server = app.listen(env.PORT, () => {
  logger.info(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
});

// Subscription maintenance: expiry checks + renewal reminders (every 6 hours)
const SIX_HOURS = 6 * 60 * 60 * 1000;
setTimeout(() => {
  runSubscriptionJobs().catch((err) => logger.error({ err }, 'Subscription jobs failed on startup'));
}, 30_000);
setInterval(() => {
  runSubscriptionJobs().catch((err) => logger.error({ err }, 'Subscription jobs failed'));
}, SIX_HOURS);

// OP progress-note auto-archive: flip active → archived after 24h (hourly sweep)
const ONE_HOUR = 60 * 60 * 1000;
setTimeout(() => {
  archiveStaleOpProgressNotes().catch((err) =>
    logger.error({ err }, 'Progress-note auto-archive failed on startup'),
  );
}, 60_000);
setInterval(() => {
  archiveStaleOpProgressNotes().catch((err) =>
    logger.error({ err }, 'Progress-note auto-archive failed'),
  );
}, ONE_HOUR);

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  server.close(async () => {
    logger.info('HTTP server closed');

    await prisma.$disconnect();
    logger.info('Database disconnected');

    await redis.quit();
    logger.info('Redis disconnected');

    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});
