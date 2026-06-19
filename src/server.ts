import 'dotenv/config';
import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/database';
import { redis } from './config/redis';
import { app } from './app';
import { runSubscriptionJobs } from './jobs/subscription-reminders';
import { runInsuranceExpiryJob } from './jobs/insurance-expiry';
import { runAppointmentReminderJob } from './jobs/appointment-reminders';
import { runInventoryAlertsJob } from './jobs/inventory-alerts';
import { runNdpsDailyCloseJob } from './jobs/ndps-daily-close';
import { archiveStaleOpProgressNotes } from './modules/progress-notes/progress-notes.service';
import { tickLifecycle as emarTickLifecycle } from './modules/emar/emar.service';

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

// eMAR lifecycle tick: pending → due → overdue → missed (every 60s)
const ONE_MINUTE = 60 * 1000;
setTimeout(() => {
  emarTickLifecycle().catch((err) => logger.error({ err }, 'eMAR lifecycle tick failed on startup'));
}, 90_000);
setInterval(() => {
  emarTickLifecycle().catch((err) => logger.error({ err }, 'eMAR lifecycle tick failed'));
}, ONE_MINUTE);

// Insurance expiry sweep + deadline reminders (every 12 hours)
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
setTimeout(() => {
  runInsuranceExpiryJob().catch((err) => logger.error({ err }, 'Insurance expiry job failed on startup'));
}, 120_000);
setInterval(() => {
  runInsuranceExpiryJob().catch((err) => logger.error({ err }, 'Insurance expiry job failed'));
}, TWELVE_HOURS);

// Appointment reminders for next-day appointments (hourly; idempotent via notification lookup)
setTimeout(() => {
  runAppointmentReminderJob().catch((err) =>
    logger.error({ err }, 'Appointment reminder job failed on startup'),
  );
}, 150_000);
setInterval(() => {
  runAppointmentReminderJob().catch((err) => logger.error({ err }, 'Appointment reminder job failed'));
}, ONE_HOUR);

// Inventory low-stock / expiry alerts across tenants (every 12h; deduped via notification lookup)
setTimeout(() => {
  runInventoryAlertsJob().catch((err) => logger.error({ err }, 'Inventory alerts job failed on startup'));
}, 180_000);
setInterval(() => {
  runInventoryAlertsJob().catch((err) => logger.error({ err }, 'Inventory alerts job failed'));
}, TWELVE_HOURS);

// NDPS Form 3H daily close across tenants (hourly; idempotent — overwrites the
// day's row each run so the books stay accurate even after late entries). A
// dedicated external cron can also POST /ndps/daily-close at the legal cutoff.
setTimeout(() => {
  runNdpsDailyCloseJob().catch((err) => logger.error({ err }, 'NDPS daily close job failed on startup'));
}, 210_000);
setInterval(() => {
  runNdpsDailyCloseJob().catch((err) => logger.error({ err }, 'NDPS daily close job failed'));
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
