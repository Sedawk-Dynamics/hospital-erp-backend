import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import {
  notifyUsers,
  clinicianUserIdsForVisit,
  describePatientForNotification,
} from '../../shared/notify';
import { checkInteractions } from '../prescriptions/prescriptions.service';
import { buildDrugHistory } from '../prescriptions/drug-history.service';
import {
  evaluatePanic,
  findDosageLimit,
  resolveDosageLimit,
  parseDoseMg,
  parseFrequencyToDosesPerDay,
  getOrderSuggestions,
} from './cdss.data';
import { findAllergyClassRules, drugInAllergyClass } from './allergy-classes.data';
import type {
  ValidatePrescriptionInput,
  OrderSuggestionsQuery,
  EvaluateLabResultsInput,
  AlertsQuery,
} from './cdss.validation';

// ============================================================
// Prescription validation: allergy + interaction + dosage
// ============================================================

export interface CdssWarning {
  severity: 'info' | 'minor' | 'moderate' | 'major' | 'contraindicated';
  kind: 'allergy' | 'interaction' | 'dosage' | 'recall';
  drug?: string;
  pair?: [string, string];
  message: string;
  detail?: string;
  /**
   * Whether a doctor may override this blocker with a documented reason.
   * Interaction contraindications are overridable (clinical judgement);
   * severe allergies and recalled drugs are never overridable.
   */
  overridable?: boolean;
}

export async function validatePrescription(
  tenantId: string,
  userId: string,
  data: ValidatePrescriptionInput,
): Promise<{ warnings: CdssWarning[]; blockers: CdssWarning[]; overridden: CdssWarning[] }> {
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
    include: { allergies: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  // Weight (kg) is needed for weight-based dosage check — pull latest from Vital.
  const latestVital = await prisma.vital.findFirst({
    where: { patientId: data.patientId, weightKg: { not: null } },
    orderBy: { recordedAt: 'desc' },
    select: { weightKg: true },
  });
  const weightKg = latestVital?.weightKg ? Number(latestVital.weightKg) : null;

  // Age (years) for age-band dosage limits and pediatric contraindications.
  const ageYears = patient.dateOfBirth
    ? Math.floor((Date.now() - new Date(patient.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
    : null;

  // Resolve drug names to formulary entries so we know the generic name.
  const drugNames = data.items.map((i) => i.drugName);
  const formulary = await prisma.drugFormulary.findMany({
    where: { tenantId },
    select: {
      drugName: true, genericName: true, contraindications: true,
    },
  });

  const findFormulary = (name: string) => {
    const n = name.toLowerCase();
    return formulary.find((f) =>
      f.drugName.toLowerCase().includes(n) ||
      n.includes(f.drugName.toLowerCase()) ||
      (f.genericName && (f.genericName.toLowerCase().includes(n) || n.includes(f.genericName.toLowerCase()))),
    );
  };

  const warnings: CdssWarning[] = [];
  const blockers: CdssWarning[] = [];

  // ── Allergy check ─────────────────────────────────────
  for (const item of data.items) {
    const formularyHit = findFormulary(item.drugName);
    const nameLower = item.drugName.toLowerCase();
    const genericLower = formularyHit?.genericName?.toLowerCase() ?? '';

    for (const allergy of patient.allergies) {
      const allergen = allergy.allergen.toLowerCase();
      const directMatch =
        allergen.includes(nameLower) ||
        nameLower.includes(allergen) ||
        (genericLower && (allergen.includes(genericLower) || genericLower.includes(allergen)));

      if (directMatch) {
        const severity = allergy.severity === 'life_threatening' || allergy.severity === 'severe' ? 'contraindicated' : 'major';
        const alert: CdssWarning = {
          severity,
          kind: 'allergy',
          drug: item.drugName,
          message: `Patient has a documented ${allergy.severity ?? 'allergy'} to ${allergy.allergen}`,
          detail: allergy.reaction ?? undefined,
        };
        // contraindicated = block; major = warn
        if (severity === 'contraindicated') blockers.push(alert);
        else warnings.push(alert);
        continue;
      }

      // Class-based check: allergen identifies a drug class the prescribed
      // drug belongs to (or cross-reacts with), even with no name overlap —
      // e.g. "penicillin" allergy vs amoxicillin, or vs ceftriaxone (cross).
      for (const rule of findAllergyClassRules(allergy.allergen)) {
        if (!drugInAllergyClass(rule, item.drugName, formularyHit?.genericName)) continue;

        const severeAllergy = allergy.severity === 'life_threatening' || allergy.severity === 'severe';
        // Cross-class reactivity is a caution, never an auto-block.
        const severity = !rule.crossReactivity && severeAllergy ? 'contraindicated' : 'major';
        const alert: CdssWarning = {
          severity,
          kind: 'allergy',
          drug: item.drugName,
          message: rule.crossReactivity
            ? `${item.drugName} may cross-react with documented ${allergy.allergen} allergy (${rule.className})`
            : `${item.drugName} is in the same class as documented ${allergy.severity ?? ''} allergy to ${allergy.allergen} (${rule.className})`.replace(/\s+/g, ' '),
          detail: [rule.note, allergy.reaction].filter(Boolean).join(' Reaction history: '),
        };
        if (severity === 'contraindicated') blockers.push(alert);
        else warnings.push(alert);
        break; // one class alert per allergy+drug is enough
      }
    }

    // No drug-wide recall check: a recall applies to a specific batch, which is
    // only known at dispensing time. The pharmacy hard-blocks dispensing from a
    // recalled batch, and recalled batches are excluded from the stock the
    // prescriber sees, so a fully-recalled drug already reads as out of stock.
  }

  // ── Drug-drug interactions ────────────────────────────
  //
  // Checked against the patient's CURRENT medications as well as the drugs on
  // this form. Two bugs used to make this look dead: the check only ran when
  // the form itself had 2+ items (so adding a single new drug was never
  // checked at all), and drugs the patient is already on were never in the
  // set — which is the interaction that actually matters clinically.
  try {
    const history = await buildDrugHistory({
      patientIds: [data.patientId],
      tenantId,
      limit: 50,
    });
    const existingNames = history.current.map((i: { drugName: string }) => i.drugName);

    // De-dupe case-insensitively, keeping the form's spelling.
    const seen = new Set<string>();
    const allDrugs: string[] = [];
    for (const name of [...drugNames, ...existingNames]) {
      const key = name?.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allDrugs.push(name.trim());
    }

    if (allDrugs.length > 1) {
      const newOnForm = new Set(drugNames.map((n) => n.trim().toLowerCase()));
      const interactionResult = await checkInteractions(tenantId, { drugs: allDrugs });
      for (const pair of interactionResult.pairs) {
        // A pair where neither drug is being prescribed now is pre-existing —
        // surface it as info rather than blocking this prescription on it.
        const touchesForm = pair.drugs.some((d) => newOnForm.has(d.trim().toLowerCase()));
        const onFileOnly = pair.drugs.filter((d) => !newOnForm.has(d.trim().toLowerCase()));
        const suffix = onFileOnly.length
          ? ` (already on ${onFileOnly.join(', ')})`
          : '';

        const alert: CdssWarning = {
          severity: pair.severity === 'minor' ? 'minor' : pair.severity,
          kind: 'interaction',
          pair: pair.drugs,
          message: `${pair.drugs[0]} + ${pair.drugs[1]}: ${pair.description}${suffix}`,
          overridable: pair.severity === 'contraindicated',
        };
        if (pair.severity === 'contraindicated' && touchesForm) blockers.push(alert);
        else warnings.push(alert);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'CDSS interaction check failed; continuing without');
  }

  // ── Dosage validation ─────────────────────────────────
  // Cumulative daily mg per generic so two items of the same drug
  // (e.g. paracetamol tablet + syrup) are checked together.
  const cumulativeByGeneric = new Map<string, { dailyMg: number; drugs: string[] }>();

  for (const item of data.items) {
    if (!item.dosage) continue;
    const limit = findDosageLimit(item.drugName);
    if (!limit) continue;

    // Pediatric / age contraindication regardless of dose.
    if (limit.minAgeYearsAllowed && ageYears !== null && ageYears < limit.minAgeYearsAllowed) {
      warnings.push({
        severity: 'major',
        kind: 'dosage',
        drug: item.drugName,
        message: `${item.drugName} is not recommended under ${limit.minAgeYearsAllowed} years (patient is ${ageYears})`,
        detail: limit.note,
      });
    }

    const doseMg = parseDoseMg(item.dosage);
    if (doseMg === null) continue;
    const dosesPerDay = item.frequency ? parseFrequencyToDosesPerDay(item.frequency) : 1;
    const dailyMg = doseMg * dosesPerDay;
    const effective = resolveDosageLimit(limit, ageYears);
    const ageLabel = ageYears !== null ? ` (patient age ${ageYears})` : '';

    const generic = (findFormulary(item.drugName)?.genericName ?? limit.drug).toLowerCase();
    const cum = cumulativeByGeneric.get(generic) ?? { dailyMg: 0, drugs: [] };
    cum.dailyMg += dailyMg;
    cum.drugs.push(item.drugName);
    cumulativeByGeneric.set(generic, cum);

    if (effective.maxPerDoseMg && doseMg > effective.maxPerDoseMg) {
      warnings.push({
        severity: 'major',
        kind: 'dosage',
        drug: item.drugName,
        message: `${item.drugName} single dose ${doseMg} mg exceeds recommended max ${effective.maxPerDoseMg} mg${ageLabel}`,
        detail: effective.note,
      });
    }
    if (effective.maxDailyMg && dailyMg > effective.maxDailyMg) {
      warnings.push({
        severity: 'major',
        kind: 'dosage',
        drug: item.drugName,
        message: `${item.drugName} daily dose ${dailyMg} mg exceeds recommended max ${effective.maxDailyMg} mg/day${ageLabel}`,
        detail: effective.note,
      });
    }
    if (effective.maxMgPerKgDay && weightKg) {
      const mgPerKg = dailyMg / weightKg;
      if (mgPerKg > effective.maxMgPerKgDay) {
        warnings.push({
          severity: 'major',
          kind: 'dosage',
          drug: item.drugName,
          message: `${item.drugName} at ${mgPerKg.toFixed(1)} mg/kg/day exceeds recommended max ${effective.maxMgPerKgDay} mg/kg/day (patient ${weightKg} kg)`,
          detail: effective.note,
        });
      }
    }
  }

  // Cumulative check: same generic prescribed as multiple items.
  for (const [generic, cum] of cumulativeByGeneric) {
    if (cum.drugs.length < 2) continue;
    const limit = findDosageLimit(generic) ?? findDosageLimit(cum.drugs[0]);
    if (!limit) continue;
    const effective = resolveDosageLimit(limit, ageYears);
    if (effective.maxDailyMg && cum.dailyMg > effective.maxDailyMg) {
      warnings.push({
        severity: 'major',
        kind: 'dosage',
        drug: cum.drugs.join(' + '),
        message: `Combined daily dose of ${generic} across ${cum.drugs.length} items is ${cum.dailyMg} mg — exceeds max ${effective.maxDailyMg} mg/day`,
        detail: effective.note,
      });
    }
  }

  // ── Override + persistence ────────────────────────────
  // With a documented reason, overridable blockers (interaction
  // contraindications) are cleared; severe allergies and recalls stay.
  let overridden: CdssWarning[] = [];
  let remainingBlockers = blockers;
  if (data.overrideReason) {
    overridden = blockers.filter((b) => b.overridable);
    remainingBlockers = blockers.filter((b) => !b.overridable);
  }

  // Sign-time persistence: store major+ findings for the review dashboard.
  if (data.persist) {
    const toAlertType = (kind: CdssWarning['kind']) =>
      kind === 'interaction' ? 'drug_interaction' : kind;
    const rows = [
      ...warnings.filter((w) => w.severity === 'major' || w.severity === 'contraindicated')
        .map((w) => ({ w, status: 'active' as const })),
      ...remainingBlockers.map((w) => ({ w, status: 'active' as const })),
      ...overridden.map((w) => ({ w, status: 'overridden' as const })),
    ];
    for (const { w, status } of rows) {
      try {
        await prisma.cdssAlert.create({
          data: {
            tenantId,
            patientId: data.patientId,
            alertType: toAlertType(w.kind),
            severity: w.severity,
            message: w.message,
            detail: w.detail ?? null,
            drugName: w.drug ?? w.pair?.join(' + ') ?? null,
            referenceType: 'prescription',
            referenceId: data.prescriptionId ?? null,
            notifiedUserId: userId,
            status,
            ...(status === 'overridden'
              ? {
                  acknowledgedById: userId,
                  acknowledgedAt: new Date(),
                  overrideReason: data.overrideReason,
                }
              : {}),
          },
        });
      } catch (err) {
        logger.warn({ err }, 'CDSS prescription alert persistence failed');
      }
    }
  }

  return { warnings, blockers: remainingBlockers, overridden };
}

// ============================================================
// ICD-based order suggestions
// ============================================================

export function getOrderRecommendations(query: OrderSuggestionsQuery) {
  const suggestions = getOrderSuggestions(query.icdCode, query.diagnosisName);
  // Flatten: dedupe labs and imaging across all matches
  const labs = new Set<string>();
  const imaging = new Set<string>();
  const notes: string[] = [];
  for (const s of suggestions) {
    s.labs.forEach((l) => labs.add(l));
    s.imaging.forEach((i) => imaging.add(i));
    if (s.note) notes.push(s.note);
  }
  return {
    matched: suggestions.length > 0,
    labs: Array.from(labs),
    imaging: Array.from(imaging),
    notes,
    rules: suggestions,
  };
}

// ============================================================
// Critical lab value evaluation
// ============================================================
// Called inline from the lab result-entry path. Creates a Notification for
// the ordering doctor (and an "all CDSS alerts" feed entry).

export async function evaluateLabResults(
  tenantId: string,
  userId: string,
  data: EvaluateLabResultsInput,
) {
  const alerts: Array<{
    parameterName: string;
    value: string | number;
    unit?: string;
    severity: 'critical';
    message: string;
  }> = [];

  for (const r of data.results) {
    const hit = evaluatePanic(r.parameterName, r.value);
    if (hit) {
      alerts.push({
        parameterName: r.parameterName,
        value: r.value,
        unit: r.unit ?? hit.unit,
        severity: 'critical',
        message: `${hit.message} (${r.parameterName}=${r.value}${r.unit ? ' ' + r.unit : ''})`,
      });
    }
  }

  if (alerts.length === 0) {
    return { alerts: [] as typeof alerts, notified: 0 };
  }

  // Who hears about a panic value.
  //
  // This used to be `LabOrder.orderedBy` alone, falling back to the PATIENT's
  // own user account. Both were wrong. The doctor who placed an order is not
  // always the one looking after the patient — on the dev database 4 of 17 lab
  // orders were ordered by someone other than the visit's doctor, and the
  // treating doctor was told nothing in every one. And the fallback meant that
  // when no ordering doctor could be resolved, a panic value went to the
  // PATIENT: "Critical potassium — cardiac arrhythmia risk", unmediated, while
  // no clinician was told at all.
  let order: { orderedBy: string | null; visitId: string | null } | null = null;
  if (data.labOrderId) {
    order = await prisma.labOrder.findFirst({
      where: { id: data.labOrderId, tenantId },
      select: { orderedBy: true, visitId: true },
    });
  }
  const recipients = await clinicianUserIdsForVisit(tenantId, {
    visitId: order?.visitId,
    orderedBy: order?.orderedBy,
  });

  // Named so the alert can be triaged from the bell. A critical value that says
  // only what is wrong and not who it is about has to be opened before it means
  // anything.
  const patientLabel = await describePatientForNotification(tenantId, data.patientId);

  let notified = 0;
  for (const a of alerts) {
    // Persist the alert for the review dashboard regardless of whether a
    // doctor could be resolved for notification.
    try {
      await prisma.cdssAlert.create({
        data: {
          tenantId,
          patientId: data.patientId,
          alertType: 'critical_value',
          severity: 'critical',
          message: a.message,
          parameterName: a.parameterName,
          parameterValue: String(a.value),
          referenceType: 'lab_order',
          referenceId: data.labOrderId,
          notifiedUserId: recipients[0] ?? null,
        },
      });
    } catch (err) {
      logger.warn({ err }, 'CDSS critical-value alert persistence failed');
    }

    if (recipients.length === 0) continue;
    // CDSS critical-value alerts ride on the existing 'alert' enum and tag
    // themselves via referenceType='lab_critical' so the alerts feed can
    // filter precisely without a schema migration.
    notified += await notifyUsers({
      tenantId,
      userIds: recipients,
      title: `Critical lab value — ${patientLabel}`,
      message: `${patientLabel}
${a.message}`,
      notificationType: 'alert',
      referenceType: 'lab_critical',
      referenceId: data.labOrderId,
    });
  }

  logger.info({ tenantId, alerts: alerts.length, notified }, 'CDSS evaluated lab results');
  return { alerts, notified };
}

// ============================================================
// CDSS Alerts feed — persisted CdssAlert rows (all alert types)
// + recent abnormal results for the alerts dashboard.
// ============================================================

export async function getAlertsFeed(tenantId: string, query: AlertsQuery) {
  const page = query.page;
  const limit = query.limit;
  const skip = (page - 1) * limit;

  const where: any = { tenantId };
  if (query.type && query.type !== 'all') {
    where.alertType = query.type === 'critical_value' ? 'critical_value' : query.type;
  }
  if (query.status && query.status !== 'all') where.status = query.status;
  if (query.patientId) where.patientId = query.patientId;
  if (query.fromDate) where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  if (query.toDate) where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };

  const [alerts, total, abnormalResults] = await Promise.all([
    prisma.cdssAlert.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
        acknowledgedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
    prisma.cdssAlert.count({ where }),
    // Recent abnormal lab results in the last 7 days for context
    prisma.labResult.findMany({
      where: {
        labOrder: { tenantId, ...(query.patientId ? { patientId: query.patientId } : {}) },
        isAbnormal: true,
        enteredAt: {
          gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        },
      },
      orderBy: { enteredAt: 'desc' },
      take: 25,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
        labOrder: { select: { id: true } },
      },
    }),
  ]);

  return {
    alerts,
    page,
    limit,
    total,
    abnormalResults,
  };
}

export async function getAlertsSummary(tenantId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [criticalToday, criticalWeek, activeTotal, byTypeRaw] = await Promise.all([
    prisma.cdssAlert.count({
      where: { tenantId, alertType: 'critical_value', createdAt: { gte: today } },
    }),
    prisma.cdssAlert.count({
      where: { tenantId, alertType: 'critical_value', createdAt: { gte: weekAgo } },
    }),
    prisma.cdssAlert.count({ where: { tenantId, status: 'active' } }),
    prisma.cdssAlert.groupBy({
      by: ['alertType'],
      where: { tenantId, status: 'active' },
      _count: { _all: true },
    }),
  ]);

  const byType: Record<string, number> = {};
  for (const row of byTypeRaw) byType[row.alertType] = row._count._all;

  return {
    criticalToday,
    criticalWeek,
    activeTotal,
    byType,
    // Back-compat alias for the previous notification-based summary shape.
    unreadCritical: byType['critical_value'] ?? 0,
  };
}

// ============================================================
// Alert review workflow — acknowledge / override with reason
// ============================================================

export async function acknowledgeAlert(
  tenantId: string,
  userId: string,
  alertId: string,
  note?: string,
) {
  const alert = await prisma.cdssAlert.findFirst({ where: { id: alertId, tenantId } });
  if (!alert) throw AppError.notFound('Alert not found');
  if (alert.status !== 'active') throw AppError.badRequest(`Alert is already ${alert.status}`);

  return prisma.cdssAlert.update({
    where: { id: alertId },
    data: {
      status: 'acknowledged',
      acknowledgedById: userId,
      acknowledgedAt: new Date(),
      acknowledgeNote: note ?? null,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      acknowledgedBy: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}

export async function overrideAlert(
  tenantId: string,
  userId: string,
  alertId: string,
  reason: string,
) {
  const alert = await prisma.cdssAlert.findFirst({ where: { id: alertId, tenantId } });
  if (!alert) throw AppError.notFound('Alert not found');
  if (alert.status === 'overridden') throw AppError.badRequest('Alert is already overridden');

  return prisma.cdssAlert.update({
    where: { id: alertId },
    data: {
      status: 'overridden',
      acknowledgedById: userId,
      acknowledgedAt: new Date(),
      overrideReason: reason,
    },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      acknowledgedBy: { select: { id: true, firstName: true, lastName: true } },
    },
  });
}
