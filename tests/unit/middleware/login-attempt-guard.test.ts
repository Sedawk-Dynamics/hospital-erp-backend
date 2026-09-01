import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted above the file's own consts, so the stub has to be built
// inside vi.hoisted or the factory closes over an uninitialised binding.
const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  ttl: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  // The module builds its rate-limit stores at import time, and rate-limit-redis
  // probes the client through `call`. Without it the stores throw on load and
  // vitest reports the failures even though the tests themselves pass.
  call: vi.fn().mockResolvedValue('OK'),
}));

vi.mock('../../../src/config/redis', () => ({ redis: redisMock }));

import { loginAttemptGuard } from '../../../src/middleware/rateLimiter';

function run(email = 'someone@example.com') {
  const req = { body: { email } } as never;
  const next = vi.fn();
  return { next, done: loginAttemptGuard(req, {} as never, next) };
}

/** The AppError handed to next(), if any. */
const errorFrom = (next: ReturnType<typeof vi.fn>) => next.mock.calls[0]?.[0];

describe('loginAttemptGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets a login through when the address is not locked', async () => {
    redisMock.get.mockResolvedValue(null);

    const { next, done } = run();
    await done;

    expect(next).toHaveBeenCalledWith();
    expect(redisMock.ttl).not.toHaveBeenCalled();
  });

  it('reports the remaining time when the address is locked', async () => {
    redisMock.get.mockResolvedValue('1');
    redisMock.ttl.mockResolvedValue(420);

    const { next, done } = run();
    await done;

    const err = errorFrom(next);
    expect(err?.statusCode).toBe(429);
    expect(err?.message).toContain('420 seconds');
  });

  it('never says "NaN seconds" when the ttl comes back undefined', async () => {
    // Seen for real: during a Redis reconnect the `get` answered while the
    // `ttl` did not, nothing threw, so the fail-open catch never ran and the
    // caller was told to try again in NaN seconds.
    redisMock.get.mockResolvedValue('1');
    redisMock.ttl.mockResolvedValue(undefined);

    const { next, done } = run();
    await done;

    const err = errorFrom(next);
    expect(err?.statusCode).toBe(429);
    expect(err?.message).not.toMatch(/NaN/);
    expect(err?.message).toContain('900 seconds');
  });

  it('falls back to the full lockout for a key with no expiry', async () => {
    // -1 is "exists, never expires". Reporting 60 seconds was a lie — the
    // caller would still be locked when they tried again.
    redisMock.get.mockResolvedValue('1');
    redisMock.ttl.mockResolvedValue(-1);

    const { next, done } = run();
    await done;

    expect(errorFrom(next)?.message).toContain('900 seconds');
  });

  it('lets the login through if the lockout expired between the two reads', async () => {
    redisMock.get.mockResolvedValue('1');
    redisMock.ttl.mockResolvedValue(-2); // key is gone

    const { next, done } = run();
    await done;

    expect(next).toHaveBeenCalledWith();
  });

  it('fails open when Redis itself is unreachable', async () => {
    redisMock.get.mockRejectedValue(new Error('ECONNREFUSED'));

    const { next, done } = run();
    await done;

    expect(next).toHaveBeenCalledWith();
  });

  it('does nothing when no email was sent', async () => {
    const { next, done } = run('');
    await done;

    expect(next).toHaveBeenCalledWith();
    expect(redisMock.get).not.toHaveBeenCalled();
  });
});
