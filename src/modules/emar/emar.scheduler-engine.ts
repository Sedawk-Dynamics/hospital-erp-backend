import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import type { EmarFrequency, EmarTimeSlot, PrescriptionItem, MedicationRoute } from '@prisma/client';

/**
 * Defaults used when a tenant hasn't customised its time slot or
 * frequency masters yet. Persisted on first use via seed-or-create.
 */
export const DEFAULT_TIME_SLOTS: Array<Omit<EmarTimeSlot, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>> = [
  { code: 'EARLY_MORNING', label: 'Early Morning', time: '06:00', sortOrder: 0, isActive: true },
  { code: 'MORNING', label: 'Morning', time: '08:00', sortOrder: 1, isActive: true },
  { code: 'NOON', label: 'Noon', time: '12:00', sortOrder: 2, isActive: true },
  { code: 'AFTERNOON', label: 'Afternoon', time: '14:00', sortOrder: 3, isActive: true },
  { code: 'EVENING', label: 'Evening', time: '18:00', sortOrder: 4, isActive: true },
  { code: 'NIGHT', label: 'Night', time: '20:00', sortOrder: 5, isActive: true },
  { code: 'BEDTIME', label: 'Bedtime', time: '22:00', sortOrder: 6, isActive: true },
];

export const DEFAULT_FREQUENCIES: Array<{
  code: string;
  label: string;
  type: 'slot' | 'interval' | 'once' | 'prn';
  slotCodes?: string[];
  intervalHours?: number | null;
  minPrnIntervalMinutes?: number | null;
}> = [
  { code: 'OD', label: 'Once daily', type: 'slot', slotCodes: ['MORNING'] },
  { code: 'BD', label: 'Twice a day (BD/BID)', type: 'slot', slotCodes: ['MORNING', 'NIGHT'] },
  { code: 'TID', label: 'Three times a day (TID/TDS)', type: 'slot', slotCodes: ['MORNING', 'AFTERNOON', 'BEDTIME'] },
  { code: 'QID', label: 'Four times a day (QID/QDS)', type: 'slot', slotCodes: ['EARLY_MORNING', 'NOON', 'EVENING', 'BEDTIME'] },
  { code: 'HS', label: 'Bedtime only', type: 'slot', slotCodes: ['BEDTIME'] },
  { code: 'MANE', label: 'Morning only', type: 'slot', slotCodes: ['MORNING'] },
  { code: 'NOCTE', label: 'Night only', type: 'slot', slotCodes: ['NIGHT'] },
  { code: 'Q4H', label: 'Every 4 hours', type: 'interval', intervalHours: 4 },
  { code: 'Q6H', label: 'Every 6 hours', type: 'interval', intervalHours: 6 },
  { code: 'Q8H', label: 'Every 8 hours', type: 'interval', intervalHours: 8 },
  { code: 'Q12H', label: 'Every 12 hours', type: 'interval', intervalHours: 12 },
  { code: 'STAT', label: 'Immediately, once', type: 'once' },
  { code: 'ONCE', label: 'Once', type: 'once' },
  { code: 'PRN', label: 'As needed (PRN)', type: 'prn', minPrnIntervalMinutes: 240 },
  { code: 'SOS', label: 'When required (SOS)', type: 'prn', minPrnIntervalMinutes: 240 },
];

/**
 * Make sure the tenant has its time slot and frequency masters seeded.
 * Idempotent — safe to call before every scheduling operation.
 */
export async function ensureMasters(tenantId: string): Promise<{
  slots: EmarTimeSlot[];
  freqs: EmarFrequency[];
}> {
  let slots = await prisma.emarTimeSlot.findMany({ where: { tenantId } });
  if (slots.length === 0) {
    await prisma.emarTimeSlot.createMany({
      data: DEFAULT_TIME_SLOTS.map((s) => ({ ...s, tenantId })),
      skipDuplicates: true,
    });
    slots = await prisma.emarTimeSlot.findMany({ where: { tenantId } });
  }

  let freqs = await prisma.emarFrequency.findMany({ where: { tenantId } });
  if (freqs.length === 0) {
    await prisma.emarFrequency.createMany({
      data: DEFAULT_FREQUENCIES.map((f) => ({
        tenantId,
        code: f.code,
        label: f.label,
        type: f.type,
        slotCodes: f.slotCodes ?? [],
        intervalHours: f.intervalHours ?? null,
        minPrnIntervalMinutes: f.minPrnIntervalMinutes ?? null,
        isActive: true,
      })),
      skipDuplicates: true,
    });
    freqs = await prisma.emarFrequency.findMany({ where: { tenantId } });
  }

  // Settings row
  await prisma.emarSettings.upsert({
    where: { tenantId },
    create: { tenantId },
    update: {},
  });

  return { slots, freqs };
}

/**
 * Best-effort match of a free-text frequency string from the prescription
 * (e.g. "BD", "twice a day", "every 6 hours", "1-0-1") to a frequency
 * master row.
 */
export function resolveFrequency(
  raw: string,
  freqs: EmarFrequency[],
): EmarFrequency | null {
  if (!raw) return null;
  const norm = raw.trim().toLowerCase().replace(/[\s.]+/g, ' ');

  // Direct code match
  const direct = freqs.find((f) => f.code.toLowerCase() === norm);
  if (direct) return direct;

  // Common synonyms → code
  const synonymToCode: Record<string, string> = {
    'od': 'OD', 'qd': 'OD', 'once daily': 'OD', '1-0-0': 'MANE', '0-0-1': 'NOCTE',
    'bd': 'BD', 'bid': 'BD', 'twice': 'BD', 'twice a day': 'BD', 'twice daily': 'BD', '1-0-1': 'BD',
    'tid': 'TID', 'tds': 'TID', 'thrice': 'TID', 'thrice a day': 'TID', '1-1-1': 'TID',
    'qid': 'QID', 'qds': 'QID', 'four times': 'QID', 'four times a day': 'QID',
    'hs': 'HS', 'bedtime': 'HS', 'at night': 'NOCTE', 'night': 'NOCTE',
    'mane': 'MANE', 'morning': 'MANE',
    'nocte': 'NOCTE',
    'q4h': 'Q4H', 'every 4 hours': 'Q4H', 'every 4 hour': 'Q4H', '4 hourly': 'Q4H',
    'q6h': 'Q6H', 'every 6 hours': 'Q6H', 'every 6 hour': 'Q6H', '6 hourly': 'Q6H',
    'q8h': 'Q8H', 'every 8 hours': 'Q8H', 'every 8 hour': 'Q8H', '8 hourly': 'Q8H',
    'q12h': 'Q12H', 'every 12 hours': 'Q12H', '12 hourly': 'Q12H',
    'stat': 'STAT', 'immediately': 'STAT', 'one time': 'ONCE', 'one dose': 'ONCE', 'once': 'ONCE',
    'prn': 'PRN', 'as needed': 'PRN', 'when required': 'PRN', 'sos': 'SOS', 'as required': 'PRN',
  };
  const code = synonymToCode[norm];
  if (code) return freqs.find((f) => f.code === code) ?? null;

  // Pattern-based fallback for "every N hours"
  const intervalMatch = norm.match(/every\s+(\d+)\s*h/);
  if (intervalMatch) {
    const hrs = parseInt(intervalMatch[1], 10);
    return freqs.find((f) => f.type === 'interval' && f.intervalHours === hrs) ?? null;
  }

  return null;
}

/**
 * Parse "1-0-1"/"1-1-1" style schedules → pick slots accordingly.
 */
function parseDosagePattern(raw: string): string[] | null {
  const m = raw.trim().match(/^(\d)\s*-\s*(\d)\s*-\s*(\d)(?:\s*-\s*(\d))?$/);
  if (!m) return null;
  const slots: string[] = [];
  const map4 = ['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT'];
  const map3 = ['MORNING', 'AFTERNOON', 'NIGHT'];
  const counts = [m[1], m[2], m[3], m[4]].filter(Boolean).map((x) => parseInt(x as string, 10));
  const map = counts.length === 4 ? map4 : map3;
  counts.forEach((c, i) => {
    if (c > 0) slots.push(map[i]);
  });
  return slots.length ? slots : null;
}

interface DurationParse {
  days?: number;
  doses?: number;
}

/**
 * Parse common duration strings: "5 days", "10 days", "1 week", "3 doses",
 * "till discharge". Returns days (and/or doses for once-type).
 */
export function parseDuration(raw: string | null | undefined): DurationParse {
  if (!raw) return { days: 7 }; // sane default for IP
  const norm = raw.toLowerCase().trim();
  if (/discharge|d\/?c|continue/.test(norm)) return { days: 30 }; // open-ended → cap at 30
  const days = norm.match(/(\d+)\s*d(ay|ays)?\b/);
  if (days) return { days: parseInt(days[1], 10) };
  const weeks = norm.match(/(\d+)\s*w(k|ks|eek|eeks)?\b/);
  if (weeks) return { days: parseInt(weeks[1], 10) * 7 };
  const doses = norm.match(/(\d+)\s*dose/);
  if (doses) return { doses: parseInt(doses[1], 10) };
  // bare number → assume days
  const bare = norm.match(/^(\d+)$/);
  if (bare) return { days: parseInt(bare[1], 10) };
  return { days: 7 };
}

/**
 * Build a Date for `dateStr` (YYYY-MM-DD) at `time` (HH:mm) in the server's
 * local timezone. Server is set to IST per project convention.
 */
function buildDateTime(date: Date, time: string): Date {
  const [hh, mm] = time.split(':').map((s) => parseInt(s, 10));
  const d = new Date(date);
  d.setHours(hh, mm, 0, 0);
  return d;
}

/**
 * Compute every scheduled dose datetime for a prescription item.
 * Returns an array of { scheduledAt, slotCode? }.
 *
 * - SLOT type: one row per slot per day for the duration window
 * - INTERVAL type: rows every N hours from start until end
 * - ONCE/STAT: a single row at the start time
 * - PRN: empty (no advance schedule — nurse triggers manually)
 */
export function computeDoseSchedule(args: {
  freq: EmarFrequency;
  slots: EmarTimeSlot[];
  startAt: Date;
  durationDays: number;
  durationDoses?: number;
}): Array<{ scheduledAt: Date; slotCode: string | null }> {
  const { freq, slots, startAt, durationDays, durationDoses } = args;
  const out: Array<{ scheduledAt: Date; slotCode: string | null }> = [];

  if (freq.type === 'prn') return out;

  if (freq.type === 'once') {
    out.push({ scheduledAt: new Date(startAt), slotCode: null });
    return out;
  }

  if (freq.type === 'interval') {
    const stepMs = (freq.intervalHours ?? 6) * 3600_000;
    const endTs = startAt.getTime() + durationDays * 86400_000;
    let t = startAt.getTime();
    let safety = 0;
    while (t <= endTs && safety < 5000) {
      out.push({ scheduledAt: new Date(t), slotCode: null });
      t += stepMs;
      safety++;
    }
    return out;
  }

  // SLOT
  const slotByCode = new Map(slots.map((s) => [s.code, s]));
  const targetSlots = freq.slotCodes
    .map((c) => slotByCode.get(c))
    .filter((s): s is EmarTimeSlot => !!s && s.isActive)
    .sort((a, b) => a.time.localeCompare(b.time));

  if (targetSlots.length === 0) return out;

  const cutoffDoses = durationDoses ?? Number.POSITIVE_INFINITY;
  for (let day = 0; day < durationDays && out.length < cutoffDoses; day++) {
    const day0 = new Date(startAt);
    day0.setDate(day0.getDate() + day);
    for (const s of targetSlots) {
      if (out.length >= cutoffDoses) break;
      const dt = buildDateTime(day0, s.time);
      // First day: skip slots that are before the order's start time
      if (day === 0 && dt.getTime() < startAt.getTime()) continue;
      out.push({ scheduledAt: dt, slotCode: s.code });
    }
  }
  return out;
}

/**
 * Generate schedule rows for one prescription item.
 * Idempotent — only adds rows that don't already exist for the item.
 * Returns the number of rows newly created.
 */
export async function generateForPrescriptionItem(args: {
  tenantId: string;
  prescriptionId: string;
  patientId: string;
  admissionId: string | null;
  item: PrescriptionItem;
  slots: EmarTimeSlot[];
  freqs: EmarFrequency[];
  startAt?: Date;
}): Promise<number> {
  const { tenantId, prescriptionId, patientId, admissionId, item, slots, freqs } = args;

  // Skip non-IP items handled by the parent caller — this fn is unconditional once called.

  // Resolve frequency — first by patterned dosage like "1-0-1", else by free-text
  const dosagePattern = parseDosagePattern(item.frequency) ?? parseDosagePattern(item.dosage);
  let freq: EmarFrequency | null = null;

  if (dosagePattern) {
    // Find a matching slot-type frequency, else build a synthetic one in-memory
    freq = freqs.find(
      (f) => f.type === 'slot' && JSON.stringify([...f.slotCodes].sort()) === JSON.stringify([...dosagePattern].sort()),
    ) ?? null;
    if (!freq) {
      freq = {
        id: 'inline',
        tenantId,
        code: `INLINE_${dosagePattern.join('_')}`,
        label: 'Inline pattern',
        type: 'slot',
        slotCodes: dosagePattern,
        intervalHours: null,
        minPrnIntervalMinutes: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as EmarFrequency;
    }
  } else {
    freq = resolveFrequency(item.frequency, freqs);
  }

  if (item.isPrn) {
    // PRN — no advance schedule
    return 0;
  }

  if (!freq) {
    logger.warn(
      { tenantId, prescriptionId, itemId: item.id, frequency: item.frequency },
      'eMAR: could not resolve frequency, skipping schedule generation',
    );
    return 0;
  }

  const { days, doses } = parseDuration(item.duration);
  const startAt = args.startAt ?? new Date();

  const computed = computeDoseSchedule({
    freq,
    slots,
    startAt,
    durationDays: Math.min(days ?? 7, 30),
    durationDoses: doses,
  });

  if (computed.length === 0) return 0;

  // Avoid duplicates: only insert rows whose scheduledAt isn't already present
  const existing = await prisma.emarSchedule.findMany({
    where: { tenantId, prescriptionItemId: item.id },
    select: { scheduledAt: true },
  });
  const existingTs = new Set(existing.map((r) => r.scheduledAt.getTime()));

  const rows = computed
    .filter((c) => !existingTs.has(c.scheduledAt.getTime()))
    .map((c) => ({
      tenantId,
      prescriptionId,
      prescriptionItemId: item.id,
      patientId,
      admissionId,
      drugName: item.drugName,
      dosage: item.dosage,
      route: (item.route ?? 'oral') as MedicationRoute,
      frequencyCode: freq!.code,
      slotCode: c.slotCode,
      scheduledAt: c.scheduledAt,
      isPrn: false,
      status: 'pending' as const,
    }));

  if (rows.length === 0) return 0;

  await prisma.emarSchedule.createMany({ data: rows });

  // Audit log batch insert
  const inserted = await prisma.emarSchedule.findMany({
    where: { tenantId, prescriptionItemId: item.id, scheduledAt: { in: rows.map((r) => r.scheduledAt) } },
    select: { id: true, status: true },
  });
  await prisma.emarAuditLog.createMany({
    data: inserted.map((r) => ({
      tenantId,
      scheduleId: r.id,
      action: 'generated' as const,
      fromStatus: null,
      toStatus: r.status,
      reason: null,
      notes: 'Schedule row generated by eMAR scheduling engine',
    })),
  });

  return rows.length;
}

/**
 * Generate (or re-generate) schedules for an entire prescription.
 */
export async function generateForPrescription(prescriptionId: string): Promise<number> {
  const rx = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    include: { prescriptionItems: true },
  });
  if (!rx) return 0;
  if (rx.prescriptionType !== 'ip') return 0; // OP prescriptions don't get eMAR rows
  if (rx.status === 'cancelled') return 0;

  const visit = await prisma.visit.findUnique({
    where: { id: rx.visitId },
    select: { admission: { select: { id: true } } },
  });
  const admissionId = visit?.admission?.id ?? null;

  const { slots, freqs } = await ensureMasters(rx.tenantId);

  let total = 0;
  for (const item of rx.prescriptionItems) {
    total += await generateForPrescriptionItem({
      tenantId: rx.tenantId,
      prescriptionId: rx.id,
      patientId: rx.patientId,
      admissionId,
      item,
      slots,
      freqs,
      startAt: new Date(),
    });
  }
  if (total > 0) {
    logger.info(
      { tenantId: rx.tenantId, prescriptionId: rx.id, rowsCreated: total },
      'eMAR: schedule generated',
    );
  }
  return total;
}

/**
 * Soft-cancel future pending schedule rows for a cancelled prescription.
 */
export async function cancelFutureSchedules(prescriptionId: string, reason = 'Prescription cancelled'): Promise<number> {
  const now = new Date();
  const result = await prisma.emarSchedule.updateMany({
    where: {
      prescriptionId,
      scheduledAt: { gt: now },
      status: { in: ['pending', 'due'] },
    },
    data: {
      status: 'cancelled',
      cancelledAt: now,
      cancelReason: reason,
      actionedAt: now,
    },
  });
  if (result.count > 0) {
    const cancelled = await prisma.emarSchedule.findMany({
      where: { prescriptionId, status: 'cancelled', cancelledAt: { gte: now } },
      select: { id: true, tenantId: true },
    });
    await prisma.emarAuditLog.createMany({
      data: cancelled.map((s) => ({
        tenantId: s.tenantId,
        scheduleId: s.id,
        action: 'cancelled' as const,
        fromStatus: null,
        toStatus: 'cancelled' as const,
        reason,
      })),
    });
  }
  return result.count;
}
