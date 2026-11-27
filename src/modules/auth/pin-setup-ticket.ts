import crypto from 'crypto';
import { redis } from '../../config/redis';

// ---------------------------------------------------------------------------
// Proof that this session has just signed in with a one-time code, which is
// what setting a PIN needs. A random ticket goes back with the sign-in; Redis
// keeps only its hash. A bare access token is not enough: whoever picked one up
// could otherwise turn a 15-minute token into a permanent way in.
// ---------------------------------------------------------------------------

export const PIN_SETUP_TICKET_SECONDS = 15 * 60;

const key = (ticket: string) => `pin-setup-ticket:${crypto.createHash('sha256').update(ticket).digest('hex')}`;

export async function issuePinSetupTicket(userId: string): Promise<string> {
  const ticket = crypto.randomBytes(32).toString('base64url');
  await redis.set(key(ticket), userId, 'EX', PIN_SETUP_TICKET_SECONDS);
  return ticket;
}

/** True exactly once, for the user it was issued to. */
export async function consumePinSetupTicket(ticket: string, userId: string): Promise<boolean> {
  const owner = await redis.get(key(ticket));
  if (!owner || owner !== userId) return false;
  return (await redis.del(key(ticket))) === 1;
}
