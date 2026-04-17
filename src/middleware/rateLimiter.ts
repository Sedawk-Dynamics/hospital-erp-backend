/**
 * Rate limiting stack for Hospital ERP.
 *
 * Sizing target: 10k–100k concurrent users across many tenants.
 *
 * Layered strategy (each layer handles a different abuse vector):
 *   1. globalIpLimiter       → per-IP ceiling that catches DDoS and scraping
 *                              without punishing clinics behind a single NAT.
 *   2. userTierLimiter       → per authenticated-user limit, tiered by role so
 *                              that high-traffic clinical roles never hit 429
 *                              during normal work while low-traffic roles stay
 *                              bounded.
 *   3. authLimiter           → per-IP limit on /auth/login, /auth/register,
 *                              /auth/refresh — low enough to slow credential
 *                              stuffing but high enough for shared-IP clinics.
 *   4. sensitiveAuthLimiter  → very tight /auth/forgot-password,
 *                              /auth/reset-password, /auth/2fa/* — these are
 *                              rarely legitimate in bulk.
 *   5. loginAttemptGuard     → per-email failed-login counter + lockout.
 *                              Complements authLimiter (which is per-IP) so
 *                              attackers rotating IPs still get blocked.
 *
 * All counters live in Redis so they are shared across every Node process /
 * horizontal replica. Super-admin requests bypass every limiter.
 */
import type { Request, Response, NextFunction } from 'express';
import rateLimit, { Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redis } from '../config/redis';
import { AppError } from '../shared/appError';
import { AuthenticatedRequest } from '../shared/types';

/* ------------------------------------------------------------------ */
/*  Role → tier map                                                    */
/* ------------------------------------------------------------------ */

/**
 * Per-user request budgets. Limits are per ROLLING WINDOW (60s) and sized
 * around real clinical workflows — a doctor opening a patient chart fires
 * 10-20 API calls; an eMAR round for a nurse caring for 8 patients can fire
 * 100+ calls in a burst; a pharmacy POS sale fires a call per line item.
 */
const PER_MINUTE = 60 * 1000;

type Tier = { limit: number; windowMs: number };

const TIERS = {
  /** Platform owner — effectively unlimited. */
  UNLIMITED: { limit: 6000, windowMs: PER_MINUTE },
  /** Front-line clinical & operations roles. Heavy polling + writes. */
  HIGH: { limit: 1500, windowMs: PER_MINUTE },
  /** Back-office roles — reports, claims, rosters. Moderate usage. */
  MEDIUM: { limit: 600, windowMs: PER_MINUTE },
  /** Patient portal. Browsing-speed usage. */
  LOW: { limit: 200, windowMs: PER_MINUTE },
  /** Fallback for unknown roles. */
  DEFAULT: { limit: 120, windowMs: PER_MINUTE },
} as const satisfies Record<string, Tier>;

const ROLE_TIER: Record<string, keyof typeof TIERS> = {
  super_admin: 'UNLIMITED',

  admin: 'HIGH',
  doctor: 'HIGH',
  nurse: 'HIGH',
  front_desk: 'HIGH',
  lab_technician: 'HIGH',
  lab_supervisor: 'HIGH',
  pharmacist: 'HIGH',
  pharmacy_technician: 'HIGH',
  billing_admin: 'HIGH',
  cashier: 'HIGH',

  pharmacy_admin: 'MEDIUM',
  inventory_manager: 'MEDIUM',
  radiologist: 'MEDIUM',
  insurance_staff: 'MEDIUM',
  blood_bank_staff: 'MEDIUM',
  hr_staff: 'MEDIUM',
  counsellor: 'MEDIUM',

  patient: 'LOW',
};

/** Doctor sub-specializations all inherit the doctor (HIGH) tier. */
const DOCTOR_SPECIALIZATIONS = [
  'general_physician', 'ent', 'diabetologist', 'obstetrics_gynaecologist',
  'cardiologist', 'dermatologist', 'neurologist', 'ophthalmologist',
  'orthopedic', 'pediatrician', 'psychiatrist', 'pulmonologist',
  'surgeon', 'urologist', 'opt', 'physiotherapist',
];
for (const spec of DOCTOR_SPECIALIZATIONS) ROLE_TIER[spec] = 'HIGH';

function pickTier(roles: string[] | undefined): Tier {
  if (!roles || roles.length === 0) return TIERS.DEFAULT;
  // Pick the most permissive tier the user holds.
  let best: keyof typeof TIERS = 'DEFAULT';
  const rank: Record<keyof typeof TIERS, number> = {
    UNLIMITED: 4, HIGH: 3, MEDIUM: 2, LOW: 1, DEFAULT: 0,
  };
  for (const r of roles) {
    const t = ROLE_TIER[r];
    if (t && rank[t] > rank[best]) best = t;
  }
  return TIERS[best];
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * IPv6-aware key. Collapses a full IPv6 address down to its /64 subnet so an
 * attacker cannot rotate through the trailing bits for free, while keeping
 * IPv4 addresses as-is.
 */
function normalizedIpKey(req: Request): string {
  const ip = req.ip ?? '0.0.0.0';
  if (ip.includes(':')) {
    // IPv6 → /64 subnet (first 4 hextets)
    const parts = ip.split(':').slice(0, 4);
    return `ip6:${parts.join(':')}::/64`;
  }
  return `ip4:${ip}`;
}

function isSuperAdmin(req: AuthenticatedRequest): boolean {
  return !!req.user?.roles?.includes('super_admin');
}

/** Webhooks must never be rate limited — Razorpay will retry on 429. */
function isWebhook(req: Request): boolean {
  return (
    req.path.endsWith('/online-payments/webhook') ||
    req.path.endsWith('/subscription-plans/webhook')
  );
}

/** Health check is called by load balancers at high frequency. */
function isHealthCheck(req: Request): boolean {
  return req.path === '/health';
}

function makeStore(prefix: string) {
  return new RedisStore({
    sendCommand: (...args: string[]) =>
      redis.call(...(args as [string, ...string[]])) as any,
    prefix,
  });
}

const rateLimitedBody = (retryAfterSeconds: number) => ({
  success: false,
  message: 'Too many requests. Please slow down and try again shortly.',
  code: 'RATE_LIMITED',
  retryAfter: retryAfterSeconds,
  data: null,
});

function jsonHandler(_req: Request, res: Response, _next: NextFunction, opts: Options) {
  const retryAfter = Math.ceil(opts.windowMs / 1000);
  res.setHeader('Retry-After', String(retryAfter));
  res.status(opts.statusCode ?? 429).json(rateLimitedBody(retryAfter));
}

/* ------------------------------------------------------------------ */
/*  1. Global per-IP limiter (DDoS / scraping guard)                   */
/* ------------------------------------------------------------------ */

/**
 * Very high ceiling — a clinic of 30 users behind a single NAT'd IP can
 * easily emit 2k req/min during busy hours. We set this high enough to let
 * that pass while blocking obvious scrapers and DDoS.
 */
export const globalIpLimiter = rateLimit({
  windowMs: PER_MINUTE,
  limit: 3000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: makeStore('rl:ip:'),
  keyGenerator: normalizedIpKey,
  skip: (req) =>
    isWebhook(req) || isHealthCheck(req) || isSuperAdmin(req as AuthenticatedRequest),
  handler: jsonHandler,
});

/* ------------------------------------------------------------------ */
/*  2. Per-user role-tiered limiter                                    */
/* ------------------------------------------------------------------ */

/**
 * Applied AFTER `authenticate` runs. Key is the userId, so the limit follows
 * the user even if they roam across IPs (desktop → laptop → phone). Limit is
 * sized by the user's most permissive role.
 *
 * NB: express-rate-limit evaluates `limit` dynamically when given a function,
 * so each user gets their correct budget per their role.
 */
export const userTierLimiter = rateLimit({
  windowMs: PER_MINUTE,
  limit: (req) => pickTier((req as AuthenticatedRequest).user?.roles).limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: makeStore('rl:user:'),
  keyGenerator: (req) => {
    const user = (req as AuthenticatedRequest).user;
    if (user?.userId) return `u:${user.userId}`;
    // Fallback: never reached in practice (mounted after `authenticate`),
    // but defensively key by IP so unauthenticated requests that slip
    // through still have a bound.
    return normalizedIpKey(req);
  },
  skip: (req) => isWebhook(req) || isSuperAdmin(req as AuthenticatedRequest),
  handler: jsonHandler,
});

/* ------------------------------------------------------------------ */
/*  3. Auth endpoint limiter (pre-login, IP keyed)                     */
/* ------------------------------------------------------------------ */

/**
 * 30 attempts / 15 min is enough for a clinic where multiple receptionists
 * share an IP and mistype passwords. It is not enough for credential
 * stuffing. Combined with {@link loginAttemptGuard} (per-email) this stops
 * both burst attacks from one IP and slow attacks across many IPs.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * PER_MINUTE,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: makeStore('rl:auth:'),
  keyGenerator: normalizedIpKey,
  handler: jsonHandler,
});

/**
 * Tighter limiter for endpoints that should rarely fire in bulk: password
 * reset, 2FA setup/verify. Keeps account-recovery flows from being weaponized.
 */
export const sensitiveAuthLimiter = rateLimit({
  windowMs: 60 * PER_MINUTE, // 1 hour
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: makeStore('rl:auth-sensitive:'),
  keyGenerator: normalizedIpKey,
  handler: jsonHandler,
});

/**
 * Refresh happens silently in browsers and may burst when a tab re-wakes.
 * Keep it generous per-IP.
 */
export const refreshLimiter = rateLimit({
  windowMs: 15 * PER_MINUTE,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: makeStore('rl:refresh:'),
  keyGenerator: normalizedIpKey,
  handler: jsonHandler,
});

/* ------------------------------------------------------------------ */
/*  4. Login brute-force lockout (per-email counter)                   */
/* ------------------------------------------------------------------ */

/**
 * Why this exists in addition to `authLimiter`:
 * `authLimiter` is per-IP and stops bursts from one IP. A patient attacker
 * rotates IPs and defeats it. This counter is per-EMAIL (lowercased) and
 * makes the account itself the choke point.
 *
 * Thresholds:
 *   - 7 failed attempts in 30 min → temporary lockout for 15 min.
 *   - counters auto-expire; successful login clears the counter.
 */
const FAILED_WINDOW_SECONDS = 30 * 60;
const FAILED_THRESHOLD = 7;
const LOCKOUT_SECONDS = 15 * 60;

function failKey(email: string) {
  return `rl:login-fail:${email.trim().toLowerCase()}`;
}
function lockoutKey(email: string) {
  return `rl:lockout:${email.trim().toLowerCase()}`;
}

/**
 * Middleware that rejects the request early if the email is currently locked.
 * Mount on POST /auth/login BEFORE the controller.
 */
export async function loginAttemptGuard(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const email = (req.body?.email ?? '').toString();
    if (!email) return next();

    const locked = await redis.get(lockoutKey(email));
    if (locked) {
      const ttl = await redis.ttl(lockoutKey(email));
      return next(
        new AppError(
          `Account temporarily locked due to repeated failed logins. Try again in ${Math.max(ttl, 60)} seconds.`,
          429,
          'ACCOUNT_LOCKED',
        ),
      );
    }
    next();
  } catch {
    // Redis issues shouldn't block legitimate logins — fail open on lookup.
    next();
  }
}

/**
 * Record a failed login attempt. Call this from the auth service whenever
 * credentials are rejected. Increments a counter; if it exceeds the
 * threshold, sets a lockout key.
 */
export async function recordFailedLogin(email: string): Promise<void> {
  if (!email) return;
  try {
    const key = failKey(email);
    const n = await redis.incr(key);
    if (n === 1) {
      await redis.expire(key, FAILED_WINDOW_SECONDS);
    }
    if (n >= FAILED_THRESHOLD) {
      await redis.set(lockoutKey(email), '1', 'EX', LOCKOUT_SECONDS);
      await redis.del(key);
    }
  } catch {
    // Counter is best-effort; don't fail the login path over Redis hiccups.
  }
}

/**
 * Clear the failure counter and any lockout. Call on successful login.
 */
export async function clearLoginFailures(email: string): Promise<void> {
  if (!email) return;
  try {
    await redis.del(failKey(email), lockoutKey(email));
  } catch {
    // Non-fatal.
  }
}

/* ------------------------------------------------------------------ */
/*  Legacy export — keep `generalLimiter` alias for any external users */
/* ------------------------------------------------------------------ */

/** @deprecated Use `globalIpLimiter` at the app level. */
export const generalLimiter = globalIpLimiter;
