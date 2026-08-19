import type { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

/**
 * Log any request that takes longer than it should, with enough detail to say
 * WHERE the time went.
 *
 * Written for the "pathology report download takes about a minute" report,
 * which could not be pinned down by reading: the files on that build are all
 * under 1MB and the report query is an ordinary nested include, so neither the
 * transfer nor the query explains 60s on its own. That leaves the things you
 * cannot see in source — Redis latency on the rate limiter, DNS, a cold
 * container, disk, or the client's own network.
 *
 * So rather than guess at a fix, this records the evidence. A slow request now
 * leaves a line naming the route, the status, the bytes and the elapsed time,
 * and every response carries a Server-Timing header so the same number is
 * visible in the browser's network panel without reading server logs.
 */

/** Anything past this is worth a line in the log. */
const SLOW_MS = 1000;
/** Anything past this is a defect, not a slow day. */
const VERY_SLOW_MS = 5000;

export function slowRequestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (elapsedMs < SLOW_MS) return;

    const bytes = Number(res.getHeader('content-length') ?? 0);
    const detail = {
      method: req.method,
      // `originalUrl` keeps the mount prefix, so /uploads and /api/v1 are
      // distinguishable — which is the whole question here.
      url: req.originalUrl,
      status: res.statusCode,
      ms: Math.round(elapsedMs),
      bytes: Number.isFinite(bytes) ? bytes : 0,
      // Throughput makes a slow transfer obvious versus slow processing: a
      // 900KB file taking 60s is a network/pipe problem, the same file in 60s
      // at 0 bytes is the server thinking.
      kbPerSec: elapsedMs > 0 ? Math.round((bytes / 1024 / elapsedMs) * 1000) : 0,
    };

    if (elapsedMs >= VERY_SLOW_MS) {
      logger.warn(detail, 'Very slow request');
    } else {
      logger.info(detail, 'Slow request');
    }
  });

  next();
}

/**
 * Expose the server's own view of the duration to the browser.
 *
 * Chrome and Firefox render Server-Timing directly in the network panel, so
 * whoever reproduces the slow download can see at a glance whether the server
 * spent the time or the wire did — without shell access. Set before the
 * response is sent, so it measures time-to-first-byte rather than the full
 * transfer; the log line above covers the rest.
 */
export function serverTiming(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  const write = res.writeHead.bind(res);

  res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    // Never let instrumentation break a response — headers may already be sent
    // on an aborted or upgraded connection.
    try {
      if (!res.headersSent) {
        res.setHeader('Server-Timing', `app;dur=${elapsedMs.toFixed(1)}`);
      }
    } catch {
      /* ignore */
    }
    return write(...args);
  }) as typeof res.writeHead;

  next();
}
