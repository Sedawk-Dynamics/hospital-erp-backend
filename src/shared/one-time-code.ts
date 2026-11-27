import crypto from 'crypto';
import { redis } from '../config/redis';
import { env } from '../config/env';
import { AppError } from './appError';

// ---------------------------------------------------------------------------
// One-time codes: one implementation for every place that sends one.
//
//   - 6 random digits from crypto.randomInt.
//   - Redis holds an HMAC only, bound to purpose + subject + binding (the phone
//     number) + the challenge id, so a code issued for one thing cannot be used
//     for another, or for another number.
//   - Guesses are counted with INCR *before* the comparison, so parallel
//     guesses each get their own number and at most `maxAttempts` are ever
//     compared. Consuming is a SET NX on the challenge id, so exactly one
//     request can use a code.
//   - If Redis is down every step throws: codes fail closed.
// ---------------------------------------------------------------------------

export type OtpPurpose = 'patient-login' | 'patient-signup' | 'patient-auth' | 'pin-setup' | 'phone-change';

export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 60;
/** Codes sent per phone (or per user), on top of the per-IP route limiter. */
export const OTP_SENDS_PER_HOUR = 5;
export const OTP_SENDS_PER_DAY = 10;

interface StoredChallenge {
  id: string;
  codeHash: string;
  data?: Record<string, unknown>;
}

export interface OtpChallenge {
  id: string;
  purpose: OtpPurpose;
  subject: string;
  ttlSeconds: number;
  data: Record<string, unknown>;
}

const codeKey = (purpose: OtpPurpose, subject: string) => `${purpose}:${subject}`;
const cooldownKey = (purpose: OtpPurpose, subject: string) => `${purpose}-cooldown:${subject}`;
const attemptsKey = (id: string) => `otp-attempts:${id}`;
const usedKey = (id: string) => `otp-used:${id}`;

function hashOtp(purpose: OtpPurpose, subject: string, binding: string, id: string, code: string): string {
  return crypto
    .createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`otp:${purpose}:${subject}:${binding}:${id}:${code}`)
    .digest('hex');
}

const expired = () => AppError.badRequest('The code has expired. Ask for a new code.', 'OTP_EXPIRED');
const exhausted = () => new AppError('Too many wrong codes. Ask for a new code.', 429, 'OTP_ATTEMPTS_EXCEEDED');

async function countSend(key: string, windowSeconds: number, max: number) {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSeconds);
  if (n > max) {
    throw new AppError('Too many codes requested. Try again later.', 429, 'OTP_SEND_LIMIT');
  }
}

/** Create a code. The caller delivers it, and calls {@link discardOtp} if it cannot. */
export async function issueOtp(p: {
  purpose: OtpPurpose;
  subject: string;
  /** What the code is valid for, e.g. the E.164 number. Part of the HMAC. */
  binding: string;
  /** Whose send budget this uses (a phone or user digest). Shared across purposes. */
  limitSubject: string;
  ttlSeconds?: number;
  data?: Record<string, unknown>;
}): Promise<string> {
  const ttl = p.ttlSeconds ?? OTP_TTL_SECONDS;

  const cooldown = await redis.set(cooldownKey(p.purpose, p.subject), '1', 'EX', OTP_RESEND_SECONDS, 'NX');
  if (cooldown !== 'OK') {
    throw new AppError('Please wait a minute before asking for another code', 429, 'OTP_COOLDOWN');
  }
  await countSend(`otp-sends-h:${p.limitSubject}`, 60 * 60, OTP_SENDS_PER_HOUR);
  await countSend(`otp-sends-d:${p.limitSubject}`, 24 * 60 * 60, OTP_SENDS_PER_DAY);

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const id = crypto.randomBytes(16).toString('hex');
  const stored: StoredChallenge = {
    id,
    codeHash: hashOtp(p.purpose, p.subject, p.binding, id, code),
    data: p.data,
  };
  // Replaces any earlier code for the same purpose and subject.
  await redis.set(codeKey(p.purpose, p.subject), JSON.stringify(stored), 'EX', ttl);
  return code;
}

/** Delivery failed: a code nobody received must not stay valid, and may be asked for again at once. */
export async function discardOtp(purpose: OtpPurpose, subject: string): Promise<void> {
  await redis.del(codeKey(purpose, subject), cooldownKey(purpose, subject));
}

/**
 * Check a code. Counts the attempt first; throws on a wrong, expired or burned
 * code. A match is NOT yet used: call {@link consumeOtp} before acting on it.
 */
export async function checkOtp(p: {
  purpose: OtpPurpose;
  subject: string;
  binding: string;
  code: string;
  ttlSeconds?: number;
  maxAttempts?: number;
}): Promise<OtpChallenge> {
  const ttl = p.ttlSeconds ?? OTP_TTL_SECONDS;
  const max = p.maxAttempts ?? OTP_MAX_ATTEMPTS;
  const key = codeKey(p.purpose, p.subject);

  const raw = await redis.get(key);
  if (!raw) throw expired();
  let stored: StoredChallenge;
  try {
    stored = JSON.parse(raw);
  } catch {
    await redis.del(key);
    throw expired();
  }
  if (!stored?.id) throw expired();

  const attempts = await redis.incr(attemptsKey(stored.id));
  // Outlives the code, so the count can never reset while the code is valid.
  if (attempts === 1) await redis.expire(attemptsKey(stored.id), ttl + 60);
  if (attempts > max) {
    await redis.del(key);
    throw exhausted();
  }

  const expected = Buffer.from(String(stored.codeHash || ''), 'hex');
  const actual = Buffer.from(hashOtp(p.purpose, p.subject, p.binding, stored.id, p.code), 'hex');
  const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!matches) {
    if (attempts >= max) {
      await redis.del(key);
      throw exhausted();
    }
    const left = max - attempts;
    throw AppError.badRequest(`The code is wrong. ${left} attempt${left === 1 ? '' : 's'} left.`, 'OTP_INVALID');
  }
  return { id: stored.id, purpose: p.purpose, subject: p.subject, ttlSeconds: ttl, data: stored.data ?? {} };
}

/** Use up a checked code. Exactly one caller succeeds, however many raced. */
export async function consumeOtp(challenge: OtpChallenge): Promise<void> {
  const won = await redis.set(usedKey(challenge.id), '1', 'EX', challenge.ttlSeconds + 60, 'NX');
  if (won !== 'OK') throw expired();
  await redis.del(codeKey(challenge.purpose, challenge.subject));
}
