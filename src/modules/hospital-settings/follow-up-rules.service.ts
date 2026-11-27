import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import { istDateStr, istDayEnd } from '../../shared/date.utils';
import {
  combineRuleLayers,
  describeRule,
  hospitalRuleSchema,
  isEmptyLayer,
  normaliseLayer,
  overrideRuleSchema,
  priceUnderRule,
  type FeeResolution,
  type FollowUpAnchor,
  type FollowUpRule,
  type FollowUpRuleLayer,
  type RuleLevel,
} from '../../shared/follow-up-fee';

// ---------------------------------------------------------------------------
// Follow-up fee rules (gap items #331 and #019).
//
// Two jobs: the hospital admin's settings, and the ONE resolver that prices a
// consultation. The desk preview, the desk bill, the portal quote, the portal
// order and the billing feed all call `resolveConsultationFee`, so the amount
// cannot differ between them.
// ---------------------------------------------------------------------------

export interface SettingsActor {
  userId: string;
  roles: string[];
}

/** The only roles that may set a follow-up price. */
export const FOLLOW_UP_RULE_ROLES = ['super_admin', 'admin'] as const;

export const canEditFollowUpRules = (actor?: SettingsActor | null): boolean =>
  !!actor?.roles?.some((r) => (FOLLOW_UP_RULE_ROLES as readonly string[]).includes(r));

/**
 * The actor is an admin OF THIS hospital.
 *
 * Holding the `admin` role is not enough: `X-Tenant-Id` lets any admin name any
 * hospital, so the role says nothing about which one. An admin belongs to the
 * hospital when their user row does, or when they own it (an owner's row sits
 * on the platform tenant, and one person can have several user rows).
 */
async function assertAdminOfHospital(tenantId: string, actor: SettingsActor): Promise<void> {
  if (!canEditFollowUpRules(actor)) {
    throw AppError.forbidden('Only the Hospital Admin can change follow-up rules');
  }
  if (actor.roles.includes('super_admin')) return;

  const user = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { tenantId: true, email: true },
  });
  if (user?.tenantId === tenantId) return;
  if (user) {
    const owns = await prisma.tenantOwner.findFirst({
      where: { tenantId, user: { email: user.email } },
      select: { id: true },
    });
    if (owns) return;
  }
  throw AppError.forbidden('You are not an admin of this hospital');
}

// ── Reading the rules ──────────────────────────────────────────────────────

type RuleRow = {
  level: string;
  targetId: string;
  freeDays: number | null;
  afterWindow: string | null;
  fixedFee: unknown;
  scope: string | null;
  dischargeStartsWindow: boolean | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const EMPTY_LAYER: FollowUpRuleLayer = {
  freeDays: null,
  afterWindow: null,
  fixedFee: null,
  scope: null,
  dischargeStartsWindow: null,
};

function toLayer(row: RuleRow | undefined | null): FollowUpRuleLayer {
  if (!row) return { ...EMPTY_LAYER };
  return {
    freeDays: row.freeDays ?? null,
    afterWindow: row.afterWindow === 'full' || row.afterWindow === 'fixed' ? row.afterWindow : null,
    fixedFee: row.fixedFee === null || row.fixedFee === undefined ? null : Number(row.fixedFee),
    scope: row.scope === 'same_doctor' || row.scope === 'same_department' ? row.scope : null,
    dischargeStartsWindow: row.dischargeStartsWindow ?? null,
  };
}

/** The two tables are new: before `db push` has run, nothing is configured. */
const isMissingTable = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2021';

async function readRows(where: Prisma.FollowUpFeeRuleWhereInput): Promise<RuleRow[]> {
  try {
    return (await prisma.followUpFeeRule.findMany({ where })) as RuleRow[];
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

export interface DoctorForRule {
  id: string;
  departmentId?: string | null;
  freeFollowUpDays?: number | null;
}

/** Combine the rows already read into the rule for one doctor. */
function ruleForDoctor(tenantId: string, doctor: DoctorForRule, rows: RuleRow[]): FollowUpRule {
  const hospital = rows.find((r) => r.level === 'hospital' && r.targetId === tenantId);
  const department = doctor.departmentId
    ? rows.find((r) => r.level === 'department' && r.targetId === doctor.departmentId)
    : undefined;
  const own = rows.find((r) => r.level === 'doctor' && r.targetId === doctor.id);

  const layers: Array<{ level: RuleLevel; layer: FollowUpRuleLayer }> = [
    // The doctor's free days live on the profile, where they always have.
    { level: 'doctor', layer: { ...toLayer(own), freeDays: doctor.freeFollowUpDays ?? null } },
  ];
  if (department) layers.push({ level: 'department', layer: toLayer(department) });
  if (hospital) layers.push({ level: 'hospital', layer: toLayer(hospital) });

  // A bare freeFollowUpDays is NOT a configured rule: it predates them, and the
  // doctors who have one keep their pricing until the admin sets a default or
  // saves an override.
  return combineRuleLayers(layers, !!(hospital || department || own));
}

/** The rule that applies to a doctor now, and since when one has existed. */
export async function loadRuleForDoctor(
  tenantId: string,
  doctor: DoctorForRule,
): Promise<{ rule: FollowUpRule; configuredAt: Date | null }> {
  const targets: Prisma.FollowUpFeeRuleWhereInput[] = [
    { level: 'hospital', targetId: tenantId },
    { level: 'doctor', targetId: doctor.id },
  ];
  if (doctor.departmentId) targets.push({ level: 'department', targetId: doctor.departmentId });
  const rows = (await readRows({ tenantId, OR: targets })) ?? [];
  const since = rows
    .map((r) => r.createdAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return { rule: ruleForDoctor(tenantId, doctor, rows), configuredAt: since ?? null };
}

// ── Snapshots ──────────────────────────────────────────────────────────────

interface RuleSnapshot extends FollowUpRule {
  doctorId: string;
  /** The doctor's own free days then — all that pricing under no rule needs. */
  legacyFreeDays: number | null;
}

/**
 * Remember the rule an appointment was booked under. Best effort: a booking
 * must not fail over it, and without one the rule in force at billing applies.
 */
export async function snapshotRuleAtBooking(
  tenantId: string,
  appointment: { id: string; doctorId: string },
  doctor: DoctorForRule,
): Promise<void> {
  try {
    const { rule } = await loadRuleForDoctor(tenantId, { ...doctor, id: appointment.doctorId });
    const snapshot: RuleSnapshot = {
      ...rule,
      doctorId: appointment.doctorId,
      legacyFreeDays: doctor.freeFollowUpDays ?? null,
    };
    await prisma.appointmentFeeSnapshot.create({
      data: { tenantId, appointmentId: appointment.id, rule: snapshot as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    logger.warn({ err, tenantId, appointmentId: appointment.id }, 'Could not record the follow-up rule at booking');
  }
}

/** Remember how the consultation was priced when its bill was raised. */
export async function recordBilledResolution(
  tenantId: string,
  appointment: { id: string; doctorId: string },
  billId: string,
  resolution: FeeResolution,
): Promise<void> {
  try {
    const { rule, legacyFreeDays } = resolution as FeeResolution & PricedRule;
    const snapshot = { ...rule, doctorId: appointment.doctorId, legacyFreeDays };
    const data = {
      billId,
      rule: snapshot as unknown as Prisma.InputJsonValue,
      resolution: publicResolution(resolution) as unknown as Prisma.InputJsonValue,
    };
    await prisma.appointmentFeeSnapshot.upsert({
      where: { appointmentId: appointment.id },
      update: data,
      create: {
        tenantId,
        appointmentId: appointment.id,
        ...data,
      },
    });
  } catch (err) {
    logger.warn({ err, tenantId, appointmentId: appointment.id, billId }, 'Could not record how the consultation was priced');
  }
}

async function readSnapshot(tenantId: string, appointmentId: string) {
  try {
    return await prisma.appointmentFeeSnapshot.findFirst({ where: { tenantId, appointmentId } });
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** How each billed appointment was priced, for lists. Never fails the list. */
export async function billedResolutions(
  tenantId: string,
  appointmentIds: string[],
): Promise<Map<string, Partial<FeeResolution>>> {
  const out = new Map<string, Partial<FeeResolution>>();
  if (appointmentIds.length === 0) return out;
  try {
    const rows = await prisma.appointmentFeeSnapshot.findMany({
      where: { tenantId, appointmentId: { in: appointmentIds }, billId: { not: null } },
      select: { appointmentId: true, resolution: true },
    });
    for (const r of rows ?? []) {
      if (r.resolution && typeof r.resolution === 'object') {
        out.set(r.appointmentId, r.resolution as Partial<FeeResolution>);
      }
    }
  } catch (err) {
    if (!isMissingTable(err)) logger.warn({ err, tenantId }, 'Could not read follow-up pricing labels');
  }
  return out;
}

// ── The resolver ───────────────────────────────────────────────────────────

interface PricedRule {
  rule: FollowUpRule;
  legacyFreeDays: number | null;
}

export type ConsultationPricing = FeeResolution & PricedRule;

/** The resolution without the rule it was made under. */
export function publicResolution(r: FeeResolution): FeeResolution {
  const { rule: _rule, legacyFreeDays: _legacy, ...rest } = r as ConsultationPricing;
  return rest;
}

export interface ConsultationToPrice {
  /** Null for a booking that has not been made yet. */
  appointmentId?: string | null;
  /** A visit with no appointment behind it (billing feed). */
  visitId?: string | null;
  /** Null for a patient being registered in the same step. */
  patientId: string | null;
  doctorId: string;
  consultationType?: string | null;
  /** The day of the visit. Today in IST when not given. */
  date?: Date | string | null;
  createdAt?: Date | null;
  doctor: { consultationFee: unknown; freeFollowUpDays?: number | null; departmentId?: string | null };
}

/** Statuses in which an appointment counts as an earlier consultation. */
const QUALIFYING_STATUSES = ['completed', 'in_consultation', 'checked_in', 'confirmed'] as const;

/**
 * What a consultation costs, and why.
 *
 * Under a rule the admin set (`governed`):
 *   - days are counted from the last PAID consultation in scope (or discharge,
 *     if the rule says so), by IST calendar day, to the day of the VISIT;
 *   - inside the free period the visit is ₹0 whatever the desk called it — as
 *     it already was under a doctor's own window;
 *   - after it, a visit booked as a follow-up is charged the follow-up fee and
 *     anything else the full fee;
 *   - booked as a follow-up with nothing earlier that counts, it is not one:
 *     full fee.
 *
 * With no rule anywhere, nothing changes: `ungoverned: 'desk'` is the desk's
 * old behaviour, and `'list_fee'` is that of the callers that have always
 * charged the plain fee (the patient portal and the billing feed).
 *
 * The rule is the one the appointment was booked under, so changing a setting
 * does not re-price a booking already made.
 */
export async function resolveConsultationFee(
  tenantId: string,
  visit: ConsultationToPrice,
  opts: { ungoverned: 'desk' | 'list_fee' } = { ungoverned: 'desk' },
): Promise<ConsultationPricing> {
  const listFee = visit.doctor?.consultationFee ? Number(visit.doctor.consultationFee) : 0;
  const { rule, legacyFreeDays, departmentId } = await ruleForVisit(tenantId, visit);
  const priced = { rule, legacyFreeDays };

  if (!rule.configured) {
    const plain: FeeResolution = {
      fee: listFee,
      listFee,
      isFreeFollowUp: false,
      kind: 'legacy',
      governed: false,
      basedOn: null,
      anchorKind: null,
      dayNumber: null,
      windowDays: 0,
      label: null,
      ruleSummary: null,
    };
    if (opts.ungoverned === 'list_fee') return { ...plain, ...priced };
    return { ...(await resolveWithoutRule(tenantId, visit, plain, legacyFreeDays)), ...priced };
  }

  const date = istDateStr(visit.date ?? undefined);
  const anchor = visit.patientId
    ? await findAnchor(tenantId, rule, { ...visit, patientId: visit.patientId, date, departmentId })
    : null;
  return {
    ...priceUnderRule(rule, {
      listFee,
      declaredFollowUp: visit.consultationType === 'follow_up',
      date,
      anchor,
    }),
    ...priced,
  };
}

async function ruleForVisit(
  tenantId: string,
  visit: ConsultationToPrice,
): Promise<PricedRule & { departmentId: string | null }> {
  let departmentId = visit.doctor?.departmentId ?? null;
  if (visit.doctor?.departmentId === undefined) {
    const profile = await prisma.doctorProfile.findFirst({
      where: { id: visit.doctorId, tenantId },
      select: { departmentId: true },
    });
    departmentId = profile?.departmentId ?? null;
  }
  const liveFreeDays = visit.doctor?.freeFollowUpDays ?? null;

  if (visit.appointmentId) {
    const row = await readSnapshot(tenantId, visit.appointmentId);
    const saved = row?.rule as unknown as RuleSnapshot | undefined;
    // Moved to another doctor since: that doctor's rule applies, not this one.
    if (saved && saved.doctorId === visit.doctorId) {
      const { doctorId: _doctorId, legacyFreeDays, ...rule } = saved;
      return { rule, legacyFreeDays: legacyFreeDays ?? null, departmentId };
    }
  }

  const { rule, configuredAt } = await loadRuleForDoctor(tenantId, {
    id: visit.doctorId,
    departmentId,
    freeFollowUpDays: liveFreeDays,
  });
  // Booked before any rule existed (and before snapshots did): not re-priced.
  if (rule.configured && configuredAt && visit.createdAt && visit.createdAt < configuredAt) {
    return { rule: { ...rule, configured: false }, legacyFreeDays: liveFreeDays, departmentId };
  }
  return { rule, legacyFreeDays: liveFreeDays, departmentId };
}

/** The last paid consultation in scope, or discharge if that counts. */
async function findAnchor(
  tenantId: string,
  rule: FollowUpRule,
  visit: ConsultationToPrice & { patientId: string; date: string; departmentId: string | null },
): Promise<FollowUpAnchor | null> {
  const inScope =
    rule.scope === 'same_department' && visit.departmentId
      ? { doctor: { departmentId: visit.departmentId } }
      : { doctorId: visit.doctorId };

  // A line that charged something, on a bill that is fully paid. A waived
  // follow-up sits on a ₹0 bill that reads `paid`; its line charged nothing, so
  // it does not restart the period.
  const paidLines = await prisma.billItem.findMany({
    where: {
      referenceType: { in: ['appointment', 'visit'] },
      referenceId: { not: null },
      totalAmount: { gt: 0 },
      bill: { tenantId, patientId: visit.patientId, status: 'paid' },
    },
    select: { referenceType: true, referenceId: true },
  });
  const idsOf = (type: string) => [
    ...new Set(paidLines.filter((l) => l.referenceType === type && l.referenceId).map((l) => l.referenceId as string)),
  ];
  const appointmentIds = idsOf('appointment').filter((id) => id !== visit.appointmentId);
  const visitIds = idsOf('visit').filter((id) => id !== visit.visitId);

  const [appointment, paidVisit, admission] = await Promise.all([
    appointmentIds.length
      ? prisma.appointment.findFirst({
          where: {
            tenantId,
            patientId: visit.patientId,
            id: { in: appointmentIds },
            // A calendar date, held at UTC midnight.
            appointmentDate: { lte: new Date(`${visit.date}T00:00:00.000Z`) },
            status: { in: [...QUALIFYING_STATUSES] },
            ...inScope,
          },
          orderBy: { appointmentDate: 'desc' },
          select: { appointmentDate: true },
        })
      : null,
    visitIds.length
      ? prisma.visit.findFirst({
          where: {
            tenantId,
            patientId: visit.patientId,
            id: { in: visitIds },
            visitType: 'op',
            visitDate: { lte: istDayEnd(visit.date) },
            ...(visit.appointmentId ? { NOT: { appointmentId: visit.appointmentId } } : {}),
            ...inScope,
          },
          orderBy: { visitDate: 'desc' },
          select: { visitDate: true },
        })
      : null,
    rule.dischargeStartsWindow
      ? prisma.admission.findFirst({
          where: {
            tenantId,
            patientId: visit.patientId,
            status: 'discharged',
            dischargeDate: { not: null, lte: istDayEnd(visit.date) },
            ...inScope,
          },
          orderBy: { dischargeDate: 'desc' },
          select: { dischargeDate: true },
        })
      : null,
  ]);

  const candidates: FollowUpAnchor[] = [];
  if (appointment) candidates.push({ date: appointment.appointmentDate, kind: 'consultation' });
  if (paidVisit) candidates.push({ date: paidVisit.visitDate, kind: 'consultation' });
  if (admission?.dischargeDate) candidates.push({ date: admission.dischargeDate, kind: 'discharge' });
  candidates.sort((a, b) => b.date.getTime() - a.date.getTime());
  return candidates[0] ?? null;
}

/**
 * The desk's pricing from before there were rules, kept exactly as it was for
 * hospitals that have set none: a follow-up declared at the desk is free, and
 * so is a return to the same doctor inside the doctor's own window.
 */
async function resolveWithoutRule(
  tenantId: string,
  visit: ConsultationToPrice,
  plain: FeeResolution,
  freeDays: number | null,
): Promise<FeeResolution> {
  if (visit.consultationType === 'follow_up') {
    return { ...plain, fee: 0, isFreeFollowUp: true };
  }
  const windowDays = Number(freeDays ?? 0) || 0;
  if (windowDays <= 0 || plain.listFee <= 0 || !visit.patientId) return plain;

  const since = new Date();
  since.setDate(since.getDate() - windowDays);

  // The most recent consultation with this doctor whose bill was actually
  // settled. `paid` only — a partially paid bill has not been paid for.
  const previous = await prisma.appointment.findFirst({
    where: {
      tenantId,
      patientId: visit.patientId,
      doctorId: visit.doctorId,
      ...(visit.appointmentId ? { id: { not: visit.appointmentId } } : {}),
      appointmentDate: { gte: since },
      status: { in: [...QUALIFYING_STATUSES] },
    },
    orderBy: { appointmentDate: 'desc' },
    select: { id: true, appointmentDate: true },
  });
  if (!previous) return { ...plain, windowDays };

  const paidBill = await prisma.bill.findFirst({
    where: {
      tenantId,
      patientId: visit.patientId,
      status: 'paid',
      billItems: { some: { referenceType: 'appointment', referenceId: previous.id } },
    },
    select: { id: true },
  });
  if (!paidBill) return { ...plain, windowDays };
  return { ...plain, fee: 0, isFreeFollowUp: true, basedOn: previous.appointmentDate, windowDays };
}

// ── The admin's settings ───────────────────────────────────────────────────

const doctorSelect = {
  id: true,
  departmentId: true,
  freeFollowUpDays: true,
  consultationFee: true,
  isAvailable: true,
  user: { select: { firstName: true, lastName: true } },
  department: { select: { id: true, name: true } },
} as const;

type DoctorRow = Prisma.DoctorProfileGetPayload<{ select: typeof doctorSelect }>;

const doctorName = (d: DoctorRow) => `Dr. ${d.user?.firstName ?? ''} ${d.user?.lastName ?? ''}`.trim();

function doctorView(tenantId: string, d: DoctorRow, rows: RuleRow[]) {
  const own = rows.find((r) => r.level === 'doctor' && r.targetId === d.id);
  const rule = ruleForDoctor(tenantId, d, rows);
  const inherited = ruleForDoctor(
    tenantId,
    { id: d.id, departmentId: d.departmentId, freeFollowUpDays: null },
    rows.filter((r) => !(r.level === 'doctor' && r.targetId === d.id)),
  );
  return {
    doctorId: d.id,
    name: doctorName(d),
    department: d.department,
    consultationFee: d.consultationFee === null ? null : Number(d.consultationFee),
    /** What is set for this doctor; null fields use the default. */
    override: { ...toLayer(own), freeDays: d.freeFollowUpDays ?? null } as FollowUpRuleLayer,
    rule,
    summary: rule.configured ? describeRule(rule) : null,
    /** What the doctor would have with nothing of their own. */
    inheritedSummary: inherited.configured ? describeRule(inherited) : null,
  };
}

/** Everything the settings screen shows. Readable by staff, edited by admins. */
export async function getFollowUpRules(tenantId: string, actor: SettingsActor) {
  const [rows, doctors, departments] = await Promise.all([
    readRows({ tenantId }),
    prisma.doctorProfile.findMany({
      where: { tenantId },
      select: doctorSelect,
      orderBy: { user: { firstName: 'asc' } },
    }),
    prisma.department.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  const hospital = rows.find((r) => r.level === 'hospital' && r.targetId === tenantId);
  const hospitalLayer = hospital ? toLayer(hospital) : null;
  return {
    canEdit: canEditFollowUpRules(actor),
    hospital: hospitalLayer,
    hospitalSummary: hospitalLayer
      ? describeRule(combineRuleLayers([{ level: 'hospital', layer: hospitalLayer }], true))
      : null,
    hospitalUpdatedAt: hospital?.updatedAt ?? null,
    departments: departments.map((dept) => {
      const row = rows.find((r) => r.level === 'department' && r.targetId === dept.id);
      const layers: Array<{ level: RuleLevel; layer: FollowUpRuleLayer }> = [];
      if (row) layers.push({ level: 'department', layer: toLayer(row) });
      if (hospitalLayer) layers.push({ level: 'hospital', layer: hospitalLayer });
      return {
        departmentId: dept.id,
        name: dept.name,
        override: row ? toLayer(row) : null,
        summary: layers.length ? describeRule(combineRuleLayers(layers, true)) : null,
      };
    }),
    doctors: doctors.map((d) => doctorView(tenantId, d, rows)),
  };
}

/** One doctor's rule, for that doctor's own settings screen. */
export async function getDoctorFollowUpRule(tenantId: string, doctorId: string, actor: SettingsActor) {
  const doctor = await prisma.doctorProfile.findFirst({ where: { id: doctorId, tenantId }, select: doctorSelect });
  if (!doctor) throw AppError.notFound('Doctor not found');
  const rows = await readRows({ tenantId });
  return { canEdit: canEditFollowUpRules(actor), ...doctorView(tenantId, doctor, rows) };
}

function parse(schema: typeof hospitalRuleSchema | typeof overrideRuleSchema, body: unknown): FollowUpRuleLayer {
  const out = schema.safeParse(body);
  if (out.success) return normaliseLayer(out.data as FollowUpRuleLayer);
  const issue = out.error.issues[0];
  throw new AppError(issue?.message ?? 'Invalid follow-up rule', 400, 'INVALID_FIELD', {
    field: issue?.path.join('.') ?? null,
  });
}

const layerColumns = (layer: FollowUpRuleLayer) => ({
  afterWindow: layer.afterWindow,
  fixedFee: layer.fixedFee,
  scope: layer.scope,
  dischargeStartsWindow: layer.dischargeStartsWindow,
});

async function readLayer(tenantId: string, level: RuleLevel, targetId: string) {
  const [row] = await readRows({ tenantId, level, targetId });
  return row ? toLayer(row) : null;
}

const sameLayer = (a: FollowUpRuleLayer | null, b: FollowUpRuleLayer | null) =>
  JSON.stringify(a) === JSON.stringify(b);

async function auditChange(
  tenantId: string,
  actor: SettingsActor,
  level: RuleLevel,
  targetId: string,
  name: string,
  oldValues: FollowUpRuleLayer | null,
  newValues: FollowUpRuleLayer | null,
) {
  const action = !oldValues ? 'create' : !newValues ? 'delete' : 'update';
  const verb = { create: 'set', update: 'changed', delete: 'removed' }[action];
  await writeAudit({
    tenantId,
    userId: actor.userId,
    action: action as 'create' | 'update' | 'delete',
    entityType: 'follow_up_rule',
    entityId: targetId,
    description: `Follow-up rule ${verb} — ${name}`,
    oldValues: oldValues ? { level, ...oldValues } : undefined,
    newValues: newValues ? { level, ...newValues } : undefined,
  });
}

/** Set or remove (`body === null`) the hospital default. */
export async function saveHospitalRule(tenantId: string, actor: SettingsActor, body: unknown) {
  await assertAdminOfHospital(tenantId, actor);
  const layer = body === null ? null : parse(hospitalRuleSchema, body);
  return saveSharedLayer(tenantId, actor, 'hospital', tenantId, 'hospital default', layer);
}

/** Set or remove (`body === null`) a department default. */
export async function saveDepartmentRule(
  tenantId: string,
  actor: SettingsActor,
  departmentId: string,
  body: unknown,
) {
  await assertAdminOfHospital(tenantId, actor);
  const department = await prisma.department.findFirst({
    where: { id: departmentId, tenantId },
    select: { id: true, name: true },
  });
  if (!department) throw AppError.notFound('Department not found');
  const layer = body === null ? null : parse(overrideRuleSchema, body);
  return saveSharedLayer(
    tenantId,
    actor,
    'department',
    departmentId,
    `${department.name} department`,
    layer && isEmptyLayer(layer) ? null : layer,
  );
}

async function saveSharedLayer(
  tenantId: string,
  actor: SettingsActor,
  level: 'hospital' | 'department',
  targetId: string,
  name: string,
  layer: FollowUpRuleLayer | null,
) {
  const before = await readLayer(tenantId, level, targetId);
  if (sameLayer(before, layer)) return layer;
  const key = { tenantId_level_targetId: { tenantId, level, targetId } };
  if (!layer) {
    await prisma.followUpFeeRule.deleteMany({ where: { tenantId, level, targetId } });
  } else {
    const columns = { freeDays: layer.freeDays, ...layerColumns(layer), updatedBy: actor.userId };
    await prisma.followUpFeeRule.upsert({
      where: key,
      update: columns,
      create: { tenantId, level, targetId, ...columns },
    });
  }
  await auditChange(tenantId, actor, level, targetId, name, before, layer);
  return layer;
}

/** Set or clear (`body === null`) a doctor's override. */
export async function saveDoctorRule(tenantId: string, actor: SettingsActor, doctorId: string, body: unknown) {
  await assertAdminOfHospital(tenantId, actor);
  const layer = body === null ? { ...EMPTY_LAYER } : parse(overrideRuleSchema, body);
  await writeDoctorLayer(tenantId, actor, doctorId, layer);
  return getDoctorFollowUpRule(tenantId, doctorId, actor);
}

/**
 * The free days alone, through the doctor-profile endpoint that has always
 * carried them. The same right, the same limits and the same audit apply.
 */
export async function saveDoctorFreeDays(
  tenantId: string,
  actor: SettingsActor,
  doctorId: string,
  freeDays: number | null,
) {
  await assertAdminOfHospital(tenantId, actor);
  const current = (await readLayer(tenantId, 'doctor', doctorId)) ?? { ...EMPTY_LAYER };
  const layer = parse(overrideRuleSchema, { ...current, freeDays });
  await writeDoctorLayer(tenantId, actor, doctorId, layer);
}

async function writeDoctorLayer(
  tenantId: string,
  actor: SettingsActor,
  doctorId: string,
  layer: FollowUpRuleLayer,
) {
  const doctor = await prisma.doctorProfile.findFirst({ where: { id: doctorId, tenantId }, select: doctorSelect });
  if (!doctor) throw AppError.notFound('Doctor not found');

  const row = await readLayer(tenantId, 'doctor', doctorId);
  const before: FollowUpRuleLayer = { ...(row ?? EMPTY_LAYER), freeDays: doctor.freeFollowUpDays ?? null };
  if (sameLayer(before, layer)) return;

  const empty = isEmptyLayer(layer);
  await prisma.$transaction(async (tx) => {
    await tx.doctorProfile.update({ where: { id: doctorId }, data: { freeFollowUpDays: layer.freeDays } });
    if (empty) {
      await tx.followUpFeeRule.deleteMany({ where: { tenantId, level: 'doctor', targetId: doctorId } });
      return;
    }
    // Written even when only the free days are set: the row is what says the
    // admin has chosen this rule, as against a window left from before.
    const columns = { freeDays: null, ...layerColumns(layer), updatedBy: actor.userId };
    await tx.followUpFeeRule.upsert({
      where: { tenantId_level_targetId: { tenantId, level: 'doctor', targetId: doctorId } },
      update: columns,
      create: { tenantId, level: 'doctor', targetId: doctorId, ...columns },
    });
  });
  await auditChange(
    tenantId,
    actor,
    'doctor',
    doctorId,
    doctorName(doctor),
    isEmptyLayer(before) ? null : before,
    empty ? null : layer,
  );
}
