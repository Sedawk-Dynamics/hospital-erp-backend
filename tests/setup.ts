import { vi } from 'vitest';

// ─── Mock environment variables BEFORE any module imports ───
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-key-at-least-10-chars';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-key-at-least-10-chars';
process.env.JWT_ACCESS_EXPIRY = '15m';
process.env.JWT_REFRESH_EXPIRY = '7d';
process.env.PORT = '4000';
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.BCRYPT_SALT_ROUNDS = '4';
// Required by src/config/env.ts with no default — without them the schema fails
// and env.ts calls process.exit(1), which kills the whole test FILE before a
// single test runs. Any suite that transitively imports a service died this way.
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';

// ─── Mock Prisma ───
//
// Self-maintaining: every model is materialised on first access with the full
// set of delegate methods, so the mock can never drift behind the schema.
//
// It used to be a hand-written list of ~100 models against a 161-model schema,
// each with a hand-picked subset of methods. Any query touching a model or
// method nobody had listed blew up with "Cannot read properties of undefined"
// or "vi.mocked(...).mockResolvedValue is not a function" — and because that
// kills the whole suite file, ~20 files and 134 tests were dead, leaving most
// of the backend with no test cover at all. Adding a `prisma.x.aggregate()`
// call to a service should never break unrelated tests.
vi.mock('../src/config/database', () => {
  // Every method a Prisma model delegate exposes.
  const DELEGATE_METHODS = [
    'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
    'create', 'createMany', 'createManyAndReturn',
    'update', 'updateMany', 'upsert',
    'delete', 'deleteMany',
    'count', 'aggregate', 'groupBy',
  ] as const;

  // Default returns follow Prisma's real contract, so a service that does
  // `rows.length` or `agg._sum.x` on a query the test did not bother to stub
  // gets an empty result instead of crashing on undefined. Tests still override
  // any of these with mockResolvedValue as usual.
  const DEFAULTS: Record<string, () => unknown> = {
    findMany: () => [],
    groupBy: () => [],
    count: () => 0,
    aggregate: () => ({ _sum: {}, _count: 0, _avg: {}, _min: {}, _max: {} }),
    createMany: () => ({ count: 0 }),
    createManyAndReturn: () => [],
    updateMany: () => ({ count: 0 }),
    deleteMany: () => ({ count: 0 }),
  };

  const models = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const modelMock = (name: string) => {
    let m = models.get(name);
    if (!m) {
      m = {};
      for (const fn of DELEGATE_METHODS) {
        const def = DEFAULTS[fn];
        // findUnique / findFirst deliberately keep returning undefined — the
        // "not found" path in every service depends on a falsy result.
        m[fn] = def ? vi.fn(async () => def()) : vi.fn();
      }
      models.set(name, m);
    }
    return m;
  };

  // Top-level client methods. `$transaction` hands the callback the client
  // itself — it used to pass `{}`, so any service doing `tx.bill.update(...)`
  // inside a transaction crashed in tests. It also accepts an array form.
  const topLevel: Record<string, unknown> = {
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(proxy)
        : Promise.all((arg as unknown[]) ?? []),
    ),
    // A raw SELECT returns rows; services legitimately do `rows.map(...)`
    // straight off it, so undefined would be a mock artefact, not a real state.
    $queryRaw: vi.fn(async () => []),
    $queryRawUnsafe: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
    $executeRawUnsafe: vi.fn(async () => 0),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $on: vi.fn(),
    $extends: vi.fn(),
  };

  const proxy: Record<string, unknown> = new Proxy(topLevel, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      // Vitest / node poke at these when inspecting the object; they must not
      // be mistaken for model names.
      if (prop === 'then' || prop === 'constructor' || prop.startsWith('@@')) return undefined;
      return modelMock(prop);
    },
    set(target, prop, value) {
      if (typeof prop === 'string') target[prop] = value;
      return true;
    },
    has: () => true,
  });

  return { prisma: proxy };
});

// ─── Mock Redis ───
vi.mock('../src/config/redis', () => {
  // Enough of the ioredis surface that cache and rate-limiter paths behave like
  // a cold cache instead of throwing "unexpected reply from redis client".
  const redis: Record<string, unknown> = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    setex: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 0),
    exists: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => -1),
    incr: vi.fn(async () => 1),
    decr: vi.fn(async () => 0),
    keys: vi.fn(async () => []),
    scan: vi.fn(async () => ['0', []]),
    mget: vi.fn(async () => []),
    hget: vi.fn(async () => null),
    hset: vi.fn(async () => 1),
    hgetall: vi.fn(async () => ({})),
    lpush: vi.fn(async () => 1),
    rpush: vi.fn(async () => 1),
    lrange: vi.fn(async () => []),
    sadd: vi.fn(async () => 1),
    smembers: vi.fn(async () => []),
    zadd: vi.fn(async () => 1),
    zrange: vi.fn(async () => []),
    // rate-limit-redis SCRIPT LOADs a Lua script at startup and expects a SHA
    // string back; returning null threw an unhandled rejection on every run.
    eval: vi.fn(async () => null),
    call: vi.fn(async () => 'da39a3ee5e6b4b0d3255bfef95601890afd80709'),
    script: vi.fn(async () => 'da39a3ee5e6b4b0d3255bfef95601890afd80709'),
    evalsha: vi.fn(async () => 1),
    defineCommand: vi.fn(),
    pipeline: vi.fn(() => ({ exec: vi.fn(async () => []) })),
    multi: vi.fn(() => ({ exec: vi.fn(async () => []) })),
    on: vi.fn(),
    quit: vi.fn(async () => 'OK'),
    disconnect: vi.fn(),
  };
  return { redis, default: redis };
});

// ─── Mock Logger ───
// app.ts hands this logger to pino-http, which reads `levels.values` to build
// its list of valid log levels — a bare {info, warn, error} mock makes the whole
// import of app.ts throw, so every integration test in the file fails to collect.
// Mirror enough of pino's real surface for that to work.
const PINO_LEVELS = {
  values: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 },
  labels: { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' },
};

vi.mock('../src/config/logger', () => {
  const logger: Record<string, unknown> = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    level: 'silent',
    levels: PINO_LEVELS,
    bindings: vi.fn(() => ({})),
    isLevelEnabled: vi.fn(() => false),
  };
  logger.child = vi.fn(() => logger);
  return { logger };
});
