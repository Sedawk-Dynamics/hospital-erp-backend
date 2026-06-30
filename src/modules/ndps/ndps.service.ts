import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';

// ============================================================
// NDPS Narcotic Accounting (spec — Essential Narcotic Drug lifecycle)
// ============================================================
// Drives the statutory Form 3C (incoming consignments), Form 3E (patient-wise
// consumption) and Form 3H (daily account) with a location-aware chain of
// custody from the Central Vault to the patient's bedside.

const NDPS_ADMIN_ROLES = new Set(['super_admin', 'admin', 'pharmacy_admin']);
const DISPOSAL_REASONS = new Set(['breakage', 'contamination', 'expiry', 'other']);

function assertNdpsAdmin(roles: string[], action: string) {
  if (!roles.some((r) => NDPS_ADMIN_ROLES.has(r))) {
    throw AppError.forbidden(`You do not have permission to ${action}.`);
  }
}

/** Ensure the tenant's Central Vault exists (auto-provisioned on first use). */
export async function getOrCreateMainVault(tenantId: string) {
  const existing = await prisma.ndpsLocation.findFirst({
    where: { tenantId, type: 'main_vault' },
  });
  if (existing) return existing;
  return prisma.ndpsLocation.create({
    data: { tenantId, name: 'Central Vault', type: 'main_vault' },
  });
}

export async function listLocations(tenantId: string) {
  await getOrCreateMainVault(tenantId);
  return prisma.ndpsLocation.findMany({
    where: { tenantId, isActive: true },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });
}

export async function createLocation(
  tenantId: string,
  roles: string[],
  data: { name: string; type?: string; wardId?: string },
) {
  assertNdpsAdmin(roles, 'manage NDPS locations');
  const dup = await prisma.ndpsLocation.findFirst({ where: { tenantId, name: data.name } });
  if (dup) throw AppError.conflict('A location with this name already exists');
  return prisma.ndpsLocation.create({
    data: { tenantId, name: data.name, type: data.type === 'main_vault' ? 'main_vault' : 'sub_store', wardId: data.wardId ?? null },
  });
}

/** Assert a drug is an NDPS narcotic before any register operation touches it. */
async function assertNarcoticDrug(tenantId: string, drugFormularyId: string) {
  const drug = await prisma.drugFormulary.findFirst({
    where: { id: drugFormularyId, tenantId },
    select: { id: true, drugName: true, isNarcotic: true },
  });
  if (!drug) throw AppError.notFound('Drug not found in formulary');
  if (!drug.isNarcotic) {
    throw AppError.badRequest(`${drug.drugName} is not flagged as an NDPS narcotic drug.`);
  }
  return drug;
}

/** Adjust the live per-drug × location balance inside a transaction. */
async function adjustBalance(
  tx: any,
  tenantId: string,
  drugFormularyId: string,
  locationId: string,
  delta: number,
) {
  const existing = await tx.ndpsStockBalance.findFirst({
    where: { tenantId, drugFormularyId, locationId },
  });
  const current = existing?.quantity ?? 0;
  const next = current + delta;
  if (next < 0) {
    throw AppError.badRequest('Insufficient narcotic stock at the source location.');
  }
  if (existing) {
    await tx.ndpsStockBalance.update({ where: { id: existing.id }, data: { quantity: next } });
  } else {
    await tx.ndpsStockBalance.create({
      data: { tenantId, drugFormularyId, locationId, quantity: next },
    });
  }
  return next;
}

/**
 * Step 1 — Form 3C inward. Receives a narcotic consignment into the Central
 * Vault, capturing the vendor's NDPS licence, the Form 3C consignment-note
 * number, transport details and gross weight. Stock is added to the vault (it is
 * implicitly "locked in the main safe" until transferred out via a dual-auth
 * challan).
 */
export async function receiveConsignment(
  tenantId: string,
  userId: string,
  roles: string[],
  data: {
    drugFormularyId: string;
    quantity: number;
    ndpsLicenseNumber: string;
    form3cNumber: string;
    transportDetails?: string;
    grossWeight?: string;
    supplierId?: string;
    batchNumber?: string;
    expiryDate?: string;
    notes?: string;
  },
) {
  assertNdpsAdmin(roles, 'receive an NDPS consignment');
  await assertNarcoticDrug(tenantId, data.drugFormularyId);
  if (data.quantity <= 0) throw AppError.badRequest('Quantity must be positive');
  const vault = await getOrCreateMainVault(tenantId);

  return prisma.$transaction(async (tx) => {
    await adjustBalance(tx, tenantId, data.drugFormularyId, vault.id, data.quantity);
    return tx.ndpsTransaction.create({
      data: {
        tenantId,
        drugFormularyId: data.drugFormularyId,
        entryType: 'inward',
        quantity: data.quantity,
        toLocationId: vault.id,
        ndpsLicenseNumber: data.ndpsLicenseNumber,
        form3cNumber: data.form3cNumber,
        transportDetails: data.transportDetails ?? null,
        grossWeight: data.grossWeight ?? null,
        supplierId: data.supplierId ?? null,
        batchNumber: data.batchNumber ?? null,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
        recordedById: userId,
        notes: data.notes ?? null,
      },
    });
  });
}

/**
 * Step 2 — Internal NDPS Delivery Challan (dual-authentication). Moves stock
 * from one location to another (vault → ICU/OT cart), crediting the source and
 * debiting the destination, and recording BOTH the issuing and receiving
 * individuals so the chain of custody is continuous.
 */
export async function transferStock(
  tenantId: string,
  userId: string,
  roles: string[],
  data: {
    drugFormularyId: string;
    fromLocationId: string;
    toLocationId: string;
    quantity: number;
    counterpartyId: string;
    notes?: string;
  },
) {
  assertNdpsAdmin(roles, 'transfer NDPS stock');
  await assertNarcoticDrug(tenantId, data.drugFormularyId);
  if (data.quantity <= 0) throw AppError.badRequest('Quantity must be positive');
  if (data.fromLocationId === data.toLocationId) {
    throw AppError.badRequest('Source and destination locations must differ');
  }
  if (!data.counterpartyId || data.counterpartyId === userId) {
    throw AppError.badRequest('A second person (the receiving custodian) must co-sign the transfer.');
  }
  const [from, to] = await Promise.all([
    prisma.ndpsLocation.findFirst({ where: { id: data.fromLocationId, tenantId } }),
    prisma.ndpsLocation.findFirst({ where: { id: data.toLocationId, tenantId } }),
  ]);
  if (!from) throw AppError.notFound('Source location not found');
  if (!to) throw AppError.notFound('Destination location not found');

  return prisma.$transaction(async (tx) => {
    await adjustBalance(tx, tenantId, data.drugFormularyId, data.fromLocationId, -data.quantity);
    await adjustBalance(tx, tenantId, data.drugFormularyId, data.toLocationId, data.quantity);
    return tx.ndpsTransaction.create({
      data: {
        tenantId,
        drugFormularyId: data.drugFormularyId,
        entryType: 'transfer',
        quantity: data.quantity,
        fromLocationId: data.fromLocationId,
        toLocationId: data.toLocationId,
        recordedById: userId,
        counterpartyId: data.counterpartyId,
        notes: data.notes ?? null,
      },
    });
  });
}

/**
 * Step 3 — Form 3E patient consumption. Logs a bedside administration: drops the
 * sub-store inventory by the exact dose and records the mandatory audit fields a
 * drug inspector verifies — the prescribing doctor's NMC/State-Council number,
 * the patient's UHID and bed, and the medical justification (diagnosis).
 */
export async function recordConsumption(
  tenantId: string,
  userId: string,
  roles: string[],
  data: {
    drugFormularyId: string;
    fromLocationId: string;
    quantity: number;
    patientId: string;
    doctorRegNo: string;
    bedNumber: string;
    diagnosis: string;
    notes?: string;
  },
) {
  assertNdpsAdmin(roles, 'record NDPS consumption');
  await assertNarcoticDrug(tenantId, data.drugFormularyId);
  if (data.quantity <= 0) throw AppError.badRequest('Quantity must be positive');
  if (!data.doctorRegNo?.trim()) throw AppError.badRequest("The prescribing doctor's registration number is mandatory.");
  if (!data.bedNumber?.trim()) throw AppError.badRequest("The patient's bed number is mandatory.");
  if (!data.diagnosis?.trim()) throw AppError.badRequest('A medical justification (diagnosis) is mandatory.');

  const [location, patient] = await Promise.all([
    prisma.ndpsLocation.findFirst({ where: { id: data.fromLocationId, tenantId } }),
    prisma.patient.findFirst({ where: { id: data.patientId, tenantId }, select: { id: true } }),
  ]);
  if (!location) throw AppError.notFound('Sub-store location not found');
  if (!patient) throw AppError.notFound('Patient not found');

  return prisma.$transaction(async (tx) => {
    await adjustBalance(tx, tenantId, data.drugFormularyId, data.fromLocationId, -data.quantity);
    return tx.ndpsTransaction.create({
      data: {
        tenantId,
        drugFormularyId: data.drugFormularyId,
        entryType: 'dispense',
        quantity: data.quantity,
        fromLocationId: data.fromLocationId,
        patientId: data.patientId,
        doctorRegNo: data.doctorRegNo.trim(),
        bedNumber: data.bedNumber.trim(),
        diagnosis: data.diagnosis.trim(),
        recordedById: userId,
        notes: data.notes ?? null,
      },
    });
  });
}

/**
 * Non-clinical disposal (broken / spoiled / contaminated vial). Deducts from the
 * location's inventory and records a reason code, the police-complaint or
 * institutional-destruction reference, an evidence attachment and the executive
 * medical director's co-sign. Surfaces as a flagged line in Form 3H.
 */
export async function logDisposal(
  tenantId: string,
  userId: string,
  roles: string[],
  data: {
    drugFormularyId: string;
    locationId: string;
    quantity: number;
    reasonCode: string;
    referenceNumber: string;
    coSignById: string;
    attachmentUrl?: string;
    notes?: string;
  },
) {
  assertNdpsAdmin(roles, 'log an NDPS disposal');
  await assertNarcoticDrug(tenantId, data.drugFormularyId);
  if (data.quantity <= 0) throw AppError.badRequest('Quantity must be positive');
  if (!DISPOSAL_REASONS.has(data.reasonCode)) throw AppError.badRequest('Invalid disposal reason code');
  if (!data.referenceNumber?.trim()) {
    throw AppError.badRequest('A police-complaint / destruction reference number is mandatory.');
  }
  if (!data.coSignById || data.coSignById === userId) {
    throw AppError.badRequest("The medical director's co-sign is mandatory for a narcotic disposal.");
  }
  const location = await prisma.ndpsLocation.findFirst({ where: { id: data.locationId, tenantId } });
  if (!location) throw AppError.notFound('Location not found');

  return prisma.$transaction(async (tx) => {
    await adjustBalance(tx, tenantId, data.drugFormularyId, data.locationId, -data.quantity);
    return tx.ndpsTransaction.create({
      data: {
        tenantId,
        drugFormularyId: data.drugFormularyId,
        entryType: 'disposal',
        quantity: data.quantity,
        fromLocationId: data.locationId,
        reasonCode: data.reasonCode,
        referenceNumber: data.referenceNumber.trim(),
        attachmentUrl: data.attachmentUrl ?? null,
        coSignById: data.coSignById,
        recordedById: userId,
        notes: data.notes ?? null,
      },
    });
  });
}

/**
 * Step 4 — Form 3H daily close. For each narcotic drug computes
 * opening + received − dispensed − disposed = closing for the given date and
 * hard-writes one Form 3H row. Idempotent (re-running a date overwrites it). The
 * opening balance comes from the previous day's close, else is derived from the
 * current live total net of the day's movement.
 */
export async function runDailyClose(tenantId: string, dateStr?: string) {
  const day = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setHours(23, 59, 59, 999);
  const prevDay = new Date(start); prevDay.setDate(prevDay.getDate() - 1);

  const narcotics = await prisma.drugFormulary.findMany({
    where: { tenantId, isNarcotic: true },
    select: { id: true, drugName: true },
  });

  const rows = [] as any[];
  for (const drug of narcotics) {
    const [txns, prevClose, liveBalances] = await Promise.all([
      prisma.ndpsTransaction.findMany({
        where: { tenantId, drugFormularyId: drug.id, occurredAt: { gte: start, lte: end } },
        select: { entryType: true, quantity: true },
      }),
      prisma.ndpsDailyBalance.findFirst({
        where: { tenantId, drugFormularyId: drug.id, date: prevDay },
        select: { closingBalance: true },
      }),
      prisma.ndpsStockBalance.aggregate({
        where: { tenantId, drugFormularyId: drug.id },
        _sum: { quantity: true },
      }),
    ]);

    const received = txns.filter((t) => t.entryType === 'inward').reduce((s, t) => s + t.quantity, 0);
    const dispensed = txns.filter((t) => t.entryType === 'dispense').reduce((s, t) => s + t.quantity, 0);
    const disposed = txns.filter((t) => t.entryType === 'disposal').reduce((s, t) => s + t.quantity, 0);
    const liveTotal = liveBalances._sum.quantity ?? 0;
    // Opening: previous close if recorded, else back out today's net from the live total.
    const opening = prevClose ? prevClose.closingBalance : liveTotal - (received - dispensed - disposed);
    const closing = opening + received - dispensed - disposed;

    const existing = await prisma.ndpsDailyBalance.findFirst({
      where: { tenantId, drugFormularyId: drug.id, date: start },
    });
    const saved = existing
      ? await prisma.ndpsDailyBalance.update({
          where: { id: existing.id },
          data: { openingBalance: opening, received, dispensed, disposed, closingBalance: closing, closedAt: new Date() },
        })
      : await prisma.ndpsDailyBalance.create({
          data: { tenantId, drugFormularyId: drug.id, date: start, openingBalance: opening, received, dispensed, disposed, closingBalance: closing },
        });
    rows.push({ ...saved, drugName: drug.drugName });
  }

  logger.info({ tenantId, date: start, drugs: rows.length }, 'NDPS Form 3H daily close run');
  return { date: start, count: rows.length, rows };
}

/** Sign off a Form 3H row against the physical count (matched / variance). */
export async function verifyDailyBalance(
  tenantId: string,
  userId: string,
  roles: string[],
  id: string,
  physicalCount: number,
) {
  assertNdpsAdmin(roles, 'verify the NDPS daily account');
  const row = await prisma.ndpsDailyBalance.findFirst({ where: { id, tenantId } });
  if (!row) throw AppError.notFound('Daily account row not found');
  return prisma.ndpsDailyBalance.update({
    where: { id },
    data: { physicalCount, isVerified: true, verifiedById: userId },
  });
}

// ── Inspector Dashboard read models ─────────────────────────

/**
 * One-click physical-vs-digital: the live system balance of each narcotic drug
 * across the whole facility, broken down by where the vials are (vault + carts).
 */
export async function getStockByLocation(tenantId: string, drugFormularyId?: string) {
  const locations = await listLocations(tenantId);
  const locById = new Map(locations.map((l) => [l.id, l]));
  const balances = await prisma.ndpsStockBalance.findMany({
    where: { tenantId, ...(drugFormularyId ? { drugFormularyId } : {}), quantity: { gt: 0 } },
    include: { drug: { select: { id: true, drugName: true, strength: true } } },
  });

  const byDrug = new Map<string, { drugId: string; drugName: string; strength: string | null; total: number; locations: Array<{ locationId: string; name: string; type: string; quantity: number }> }>();
  for (const b of balances) {
    const key = b.drugFormularyId;
    const cur = byDrug.get(key) ?? {
      drugId: key,
      drugName: b.drug?.drugName ?? '-',
      strength: b.drug?.strength ?? null,
      total: 0,
      locations: [],
    };
    const loc = locById.get(b.locationId);
    cur.total += b.quantity;
    cur.locations.push({ locationId: b.locationId, name: loc?.name ?? '-', type: loc?.type ?? 'sub_store', quantity: b.quantity });
    byDrug.set(key, cur);
  }
  return { items: [...byDrug.values()].sort((a, b) => a.drugName.localeCompare(b.drugName)) };
}

/**
 * Statutory register listing for the Inspector Dashboard. formType maps to the
 * entry types: 3C → inward, 3E → dispense, disposal → disposal, else all.
 */
export async function getRegister(
  tenantId: string,
  query: { formType?: string; drugFormularyId?: string; fromDate?: string; toDate?: string },
) {
  const where: any = { tenantId };
  if (query.formType === '3C') where.entryType = 'inward';
  else if (query.formType === '3E') where.entryType = 'dispense';
  else if (query.formType === 'disposal') where.entryType = 'disposal';
  else if (query.formType === 'transfer') where.entryType = 'transfer';
  if (query.drugFormularyId) where.drugFormularyId = query.drugFormularyId;
  if (query.fromDate || query.toDate) {
    where.occurredAt = {};
    if (query.fromDate) where.occurredAt.gte = new Date(query.fromDate);
    if (query.toDate) where.occurredAt.lte = new Date(query.toDate);
  }

  const rows = await prisma.ndpsTransaction.findMany({
    where,
    orderBy: { occurredAt: 'desc' },
    take: 3000,
    include: { drug: { select: { drugName: true, strength: true } } },
  });

  // Resolve location + person names in one batch each.
  const locations = await prisma.ndpsLocation.findMany({ where: { tenantId }, select: { id: true, name: true } });
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const userIds = [...new Set(rows.flatMap((r) => [r.recordedById, r.counterpartyId, r.coSignById].filter(Boolean)))] as string[];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const userName = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName ?? ''}`.trim()]));
  const patientIds = [...new Set(rows.map((r) => r.patientId).filter(Boolean))] as string[];
  const patients = patientIds.length
    ? await prisma.patient.findMany({ where: { id: { in: patientIds } }, select: { id: true, mrn: true, firstName: true, lastName: true } })
    : [];
  const patientById = new Map(patients.map((p) => [p.id, p]));

  return {
    items: rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt,
      entryType: r.entryType,
      drugName: r.drug?.drugName ?? '-',
      strength: r.drug?.strength ?? null,
      quantity: r.quantity,
      from: r.fromLocationId ? locName.get(r.fromLocationId) ?? null : null,
      to: r.toLocationId ? locName.get(r.toLocationId) ?? null : null,
      recordedBy: userName.get(r.recordedById) ?? null,
      counterparty: r.counterpartyId ? userName.get(r.counterpartyId) ?? null : null,
      coSignBy: r.coSignById ? userName.get(r.coSignById) ?? null : null,
      // Form 3C
      ndpsLicenseNumber: r.ndpsLicenseNumber,
      form3cNumber: r.form3cNumber,
      transportDetails: r.transportDetails,
      grossWeight: r.grossWeight,
      batchNumber: r.batchNumber,
      // Form 3E
      patient: r.patientId ? (() => { const p = patientById.get(r.patientId!); return p ? { mrn: p.mrn, name: `${p.firstName} ${p.lastName ?? ''}`.trim() } : null; })() : null,
      doctorRegNo: r.doctorRegNo,
      bedNumber: r.bedNumber,
      diagnosis: r.diagnosis,
      // Disposal
      reasonCode: r.reasonCode,
      referenceNumber: r.referenceNumber,
      attachmentUrl: r.attachmentUrl,
      notes: r.notes,
    })),
    total: rows.length,
  };
}

/** Tenant/hospital identity block for the statutory PDF headers. */
export async function getTenantHeader(tenantId: string) {
  return prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, address: true, city: true, state: true, phone: true, email: true, licenseNumber: true },
  });
}

/** Bundle the register + tenant header for a Form 3C/3E/transfer/disposal PDF. */
export async function getRegisterExport(
  tenantId: string,
  query: { formType?: string; drugFormularyId?: string; fromDate?: string; toDate?: string },
) {
  const [tenant, reg] = await Promise.all([getTenantHeader(tenantId), getRegister(tenantId, query)]);
  return { tenant, items: reg.items, formType: query.formType ?? 'all', from: query.fromDate, to: query.toDate };
}

/** Bundle the daily accounts + tenant header for the Form 3H PDF. */
export async function getDailyExport(
  tenantId: string,
  query: { drugFormularyId?: string; fromDate?: string; toDate?: string },
) {
  const [tenant, daily] = await Promise.all([getTenantHeader(tenantId), getDailyBalances(tenantId, query)]);
  return { tenant, items: daily.items, from: query.fromDate, to: query.toDate };
}

/** Form 3H listing (daily accounts) for the Inspector Dashboard. */
export async function getDailyBalances(
  tenantId: string,
  query: { drugFormularyId?: string; fromDate?: string; toDate?: string },
) {
  const where: any = { tenantId };
  if (query.drugFormularyId) where.drugFormularyId = query.drugFormularyId;
  if (query.fromDate || query.toDate) {
    where.date = {};
    if (query.fromDate) where.date.gte = new Date(query.fromDate);
    if (query.toDate) where.date.lte = new Date(query.toDate);
  }
  const rows = await prisma.ndpsDailyBalance.findMany({
    where,
    orderBy: [{ date: 'desc' }],
    take: 2000,
    include: { drug: { select: { drugName: true, strength: true } } },
  });
  return {
    items: rows.map((r) => ({
      id: r.id,
      date: r.date,
      drugName: r.drug?.drugName ?? '-',
      strength: r.drug?.strength ?? null,
      openingBalance: r.openingBalance,
      received: r.received,
      dispensed: r.dispensed,
      disposed: r.disposed,
      closingBalance: r.closingBalance,
      physicalCount: r.physicalCount,
      isVerified: r.isVerified,
      variance: r.physicalCount != null ? r.physicalCount - r.closingBalance : null,
    })),
    total: rows.length,
  };
}
