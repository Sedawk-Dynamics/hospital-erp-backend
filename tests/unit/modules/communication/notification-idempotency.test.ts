// Gap 295: notification writes are idempotent on (tenant, recipient,
// event/type, reference record, reminder stage) — sequentially and under
// concurrency. The prisma mock below behaves like the real table WITHOUT a
// unique index (inserts never conflict), and like Postgres' advisory lock:
// `pg_advisory_xact_lock` inside a transaction blocks other transactions on
// the same key until the holder commits. So only the lock can keep one row.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createNotificationWithStatus,
  getUnreadCount,
} from '../../../../src/modules/communication/communication.service';
import { notificationDedupeKey } from '../../../../src/modules/communication/notification-dedupe';
import { notificationLockKey, writeNotificationOnce } from '../../../../src/modules/communication/notification-writer';

type Row = Record<string, any> & { id: string };

let rows: Row[] = [];
let seq = 0;

const tick = () => new Promise((r) => setTimeout(r, 5));

function installTable() {
  rows = [];
  seq = 0;
  const n = vi.mocked(prisma.notification);
  // Snapshot at call time, answer later — so simultaneous writers all miss the
  // row and are forced onto the insert race the unique index decides.
  n.findFirst.mockImplementation((async (args: any) => {
    const w = args.where;
    await tick(); // snapshot now, answer later — like a real round trip
    const hit = rows
      .filter((r) => Object.entries(w).every(([key, v]) => (v === null ? r[key] == null : r[key] === v)))
      .sort((a, b) => b.seq - a.seq)[0];
    return hit ? { ...hit } : null;
  }) as never);
  n.create.mockImplementation((async (args: any) => {
    const d = args.data;
    await tick(); // an insert takes time: a racing writer without the lock would slip in
    const row = { id: `n-${++seq}`, seq, isRead: false, createdAt: new Date(), ...d };
    rows.push(row);
    return { ...row };
  }) as never);
  n.update.mockImplementation((async (args: any) => {
    const row = rows.find((r) => r.id === args.where.id)!;
    Object.assign(row, args.data);
    return { ...row };
  }) as never);
  n.findMany.mockImplementation((async (args: any) =>
    rows.filter((r) => r.userId === args.where.userId && (args.where.isRead === undefined || r.isRead === args.where.isRead))) as never);

  // pg_advisory_xact_lock: one holder per key; released when its transaction ends.
  const held = new Map<string, Promise<void>>();
  let current: { release?: () => void } | null = null;
  vi.mocked(prisma.$executeRaw).mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!String(strings.join('?')).includes('pg_advisory_xact_lock')) return 0;
    const key = String(values[0]);
    locksTaken.push(key);
    const tx = current!;
    while (held.has(key)) await held.get(key);
    let release!: () => void;
    held.set(key, new Promise<void>((r) => (release = () => { held.delete(key); r(); })));
    tx.release = release;
    return 1;
  }) as never);
  vi.mocked(prisma.$transaction).mockImplementation((async (fn: any) => {
    const tx: { release?: () => void } = {};
    // Each transaction has its own lock slot; the callback runs with it current.
    const run = async () => {
      current = tx;
      return fn(prisma);
    };
    try {
      return await run();
    } finally {
      tx.release?.();
    }
  }) as never);
}

let locksTaken: string[] = [];

const T = 'tenant-1';
const input = {
  userId: 'user-2',
  title: 'Claim CLM-1 approved',
  message: 'Approved ₹800',
  notificationType: 'billing',
  channel: 'in_app',
  referenceType: 'insurance_claim',
  referenceId: 'claim-1',
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  locksTaken = [];
  installTable();
  vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: 'user-2' } as never);
});

describe('notificationDedupeKey (gap 295)', () => {
  it('is the same for the same event, type, record and stage', () => {
    expect(notificationDedupeKey(input)).toBe(notificationDedupeKey({ ...input, title: '  claim clm-1   APPROVED ' }));
  });

  it('differs by reminder stage, type, record and event', () => {
    const base = notificationDedupeKey(input);
    expect(notificationDedupeKey({ ...input, reminderStage: '3d' })).not.toBe(base);
    expect(notificationDedupeKey({ ...input, notificationType: 'alert' })).not.toBe(base);
    expect(notificationDedupeKey({ ...input, referenceId: 'claim-2' })).not.toBe(base);
    expect(notificationDedupeKey({ ...input, title: 'Claim CLM-1 settled' })).not.toBe(base);
    // An explicit event key overrides the title.
    expect(notificationDedupeKey({ ...input, eventKey: 'claim_deadline', title: 'A' }))
      .toBe(notificationDedupeKey({ ...input, eventKey: 'claim_deadline', title: 'B' }));
  });

  it('is null without a reference record, and always fits the column', () => {
    expect(notificationDedupeKey({ ...input, referenceId: undefined })).toBeNull();
    const long = notificationDedupeKey({ ...input, title: 'x'.repeat(400) })!;
    expect(long.length).toBeLessThanOrEqual(255);
    expect(long).toBe(notificationDedupeKey({ ...input, title: 'x'.repeat(400) }));
  });
});

describe('POST /communication/notifications is idempotent (gap 295)', () => {
  it('a repeated request returns the existing notification with the same id', async () => {
    const first = await createNotificationWithStatus(T, input);
    const second = await createNotificationWithStatus(T, input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.notification.id).toBe(first.notification.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe(notificationDedupeKey(input));
    await expect(getUnreadCount(T, 'user-2')).resolves.toEqual({ unreadCount: 1 });
  });

  it('simultaneous requests leave exactly one row and all return its id', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => createNotificationWithStatus(T, input)));

    expect(rows).toHaveLength(1);
    expect(new Set(results.map((r) => r.notification.id))).toEqual(new Set([rows[0].id]));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    await expect(getUnreadCount(T, 'user-2')).resolves.toEqual({ unreadCount: 1 });
  });

  it('a repeat does not re-raise a notification the user already read', async () => {
    const first = await createNotificationWithStatus(T, input);
    rows[0].isRead = true;
    const again = await createNotificationWithStatus(T, { ...input, message: 'Approved ₹800 (updated)' });

    expect(again.notification.id).toBe(first.notification.id);
    expect(rows[0]).toMatchObject({ isRead: true, message: 'Approved ₹800 (updated)' });
    await expect(getUnreadCount(T, 'user-2')).resolves.toEqual({ unreadCount: 0 });
  });

  it('each reminder stage is its own notification', async () => {
    await createNotificationWithStatus(T, { ...input, eventKey: 'claim_deadline', reminderStage: '7d' });
    await createNotificationWithStatus(T, { ...input, eventKey: 'claim_deadline', reminderStage: '3d' });
    await createNotificationWithStatus(T, { ...input, eventKey: 'claim_deadline', reminderStage: '3d' });
    expect(rows.map((r) => r.dedupeKey.split('|').pop())).toEqual(['7d', '3d']);
  });

  it('adopts a legacy duplicate written before the key existed instead of adding another', async () => {
    rows.push({ id: 'old-1', seq: 0, tenantId: T, userId: 'user-2', title: input.title, message: input.message, notificationType: 'billing', referenceType: 'insurance_claim', referenceId: 'claim-1', dedupeKey: null, isRead: false });
    const res = await createNotificationWithStatus(T, input);

    expect(res).toMatchObject({ created: false, notification: { id: 'old-1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe(notificationDedupeKey(input));
  });

  it('a notification with no reference record is never merged', async () => {
    await createNotificationWithStatus(T, { ...input, referenceId: undefined, referenceType: undefined });
    await createNotificationWithStatus(T, { ...input, referenceId: undefined, referenceType: undefined });
    expect(rows).toHaveLength(2);
  });
});

describe('the advisory lock is what keeps one row (gap 295)', () => {
  it('locks on tenant + recipient + dedupe key before reading', async () => {
    await writeNotificationOnce({ ...input, tenantId: T });
    expect(locksTaken).toEqual([notificationLockKey(T, 'user-2', notificationDedupeKey(input)!)]);
  });

  it('without the lock, simultaneous writers would duplicate (the table has no unique index)', async () => {
    vi.mocked(prisma.$executeRaw).mockResolvedValue(0 as never); // lock is a no-op
    await Promise.all(Array.from({ length: 3 }, () => writeNotificationOnce({ ...input, tenantId: T })));
    expect(rows.length).toBeGreaterThan(1);
  });
});

describe('reminder-job writes share the key (gap 295)', () => {
  it('two overlapping job runs write one row per stage', async () => {
    const reminder = {
      tenantId: T, userId: 'user-2', title: 'Policy expiring in 3 days', message: 'Policy POL-1 expires…',
      notificationType: 'alert', referenceType: 'insurance_policy', referenceId: 'pol-1',
      eventKey: 'policy_expiry', reminderStage: '3d',
    };
    const [a, b] = await Promise.all([writeNotificationOnce(reminder), writeNotificationOnce(reminder)]);
    expect(rows).toHaveLength(1);
    expect(a.notification.id).toBe(b.notification.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
  });
});
