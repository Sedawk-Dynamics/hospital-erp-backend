import { PrismaClient } from '@prisma/client';
import { env } from './env';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    // Optional override for interactive-transaction limits. Prisma's defaults
    // (timeout 5s, maxWait 2s) are too tight when the DB is remote (e.g.
    // Supabase), where flows like demo-request approval run ~30 round trips.
    // Unset = Prisma defaults, so behaviour is unchanged unless configured.
    ...(process.env.PRISMA_TX_TIMEOUT_MS
      ? {
          transactionOptions: {
            timeout: Number(process.env.PRISMA_TX_TIMEOUT_MS),
            maxWait: Number(process.env.PRISMA_TX_MAX_WAIT_MS ?? 10_000),
          },
        }
      : {}),
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
