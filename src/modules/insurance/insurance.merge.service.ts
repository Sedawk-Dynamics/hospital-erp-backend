import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { getRequestContext } from '../../config/request-context';
import { AppError } from '../../shared/appError';

/**
 * Gap 293: merging duplicate insurers / TPAs.
 *
 * Blocking new duplicates (assertUniquePayer) stops the problem growing; this
 * cleans up the ones that already exist. A Hospital Admin picks the record to
 * KEEP; every reference to the duplicate — policies, payer cases (direct link,
 * payment-responsible party, claim administrator), payer contracts and, for a
 * TPA, communication logs — is re-pointed at the kept record. Claims,
 * pre-authorisations and settlements reach their payer through the policy or
 * the case, so they follow automatically; they are counted so the admin sees
 * what moves.
 *
 * Everything happens in ONE transaction, including the audit row: either the
 * whole merge lands and is recorded, or nothing moves. The duplicate is
 * deactivated and stamped with the record it went into — never deleted, so old
 * ids in audit trails and exports still resolve.
 */

export type MergeablePayerKind = 'insurer' | 'tpa';

/** Roles allowed to merge payers. Enforced at the route and again here. */
export const PAYER_MERGE_ROLES = ['admin', 'super_admin'] as const;

export function assertCanMergePayers(roles: readonly string[] | undefined): void {
  if (!roles?.some((role) => (PAYER_MERGE_ROLES as readonly string[]).includes(role))) {
    throw AppError.forbidden('Only a Hospital Admin can merge duplicate insurers or TPAs');
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

interface PayerRow {
  id: string;
  tenantId: string;
  name: string;
  gstin: string | null;
  isActive: boolean;
  mergedIntoId: string | null;
}

export interface PayerMergeCounts {
  policies: number;
  /** Payer cases that name the duplicate in any role (direct, payer, administrator). */
  cases: number;
  contracts: number;
  /** Duplicate's contracts that overlapped an active contract of the kept record. */
  contractsDeactivated: number;
  /** TPA only. */
  communicationLogs: number;
  /** Follow their policy / case — counted, not updated directly. */
  claims: number;
  preAuths: number;
  settlements: number;
}

const PAYER_SELECT = { id: true, tenantId: true, name: true, gstin: true, isActive: true, mergedIntoId: true } as const;

const kindLabel = (kind: MergeablePayerKind) => (kind === 'insurer' ? 'Insurer' : 'TPA');

function findPayer(db: Db, kind: MergeablePayerKind, tenantId: string, id: string): Promise<PayerRow | null> {
  // Tenant-scoped: a record from another hospital is simply "not found".
  return kind === 'insurer'
    ? db.insurer.findFirst({ where: { id, tenantId }, select: PAYER_SELECT })
    : db.tpaProvider.findFirst({ where: { id, tenantId }, select: PAYER_SELECT });
}

async function loadPair(db: Db, kind: MergeablePayerKind, tenantId: string, duplicateId: string, keepId: string) {
  if (duplicateId === keepId) {
    throw AppError.badRequest('A record cannot be merged into itself — pick a different record to keep');
  }
  const [duplicate, keep] = await Promise.all([
    findPayer(db, kind, tenantId, duplicateId),
    findPayer(db, kind, tenantId, keepId),
  ]);
  const label = kindLabel(kind);
  if (!duplicate) throw AppError.notFound(`${label} to merge was not found in this hospital`);
  if (!keep) throw AppError.notFound(`${label} to keep was not found in this hospital`);
  if (duplicate.mergedIntoId) {
    throw AppError.conflict(`"${duplicate.name}" has already been merged into another record`, 'PAYER_ALREADY_MERGED', {
      mergedIntoId: duplicate.mergedIntoId,
    });
  }
  if (!keep.isActive || keep.mergedIntoId) {
    throw AppError.badRequest(
      `"${keep.name}" is inactive — reactivate it first, or keep a different record`,
      'MERGE_TARGET_INACTIVE',
    );
  }
  return { duplicate, keep };
}

/** Every place a payer id is stored, as Prisma where-clauses. */
function referenceWheres(kind: MergeablePayerKind, tenantId: string, id: string) {
  const payerType = kind; // PayerType enum values 'insurer' | 'tpa'
  const policies: Prisma.InsurancePolicyWhereInput =
    kind === 'insurer' ? { tenantId, insurerId: id } : { tenantId, tpaId: id };
  const casesDirect: Prisma.InsuranceCaseWhereInput =
    kind === 'insurer' ? { tenantId, insurerId: id } : { tenantId, tpaId: id };
  const casesPaymentResponsible: Prisma.InsuranceCaseWhereInput = {
    tenantId,
    paymentResponsibleType: payerType,
    paymentResponsibleId: id,
  };
  const casesClaimAdministrator: Prisma.InsuranceCaseWhereInput = {
    tenantId,
    claimAdministratorType: payerType,
    claimAdministratorId: id,
  };
  const casesAny: Prisma.InsuranceCaseWhereInput = {
    OR: [casesDirect, casesPaymentResponsible, casesClaimAdministrator],
  };
  const contracts: Prisma.PayerContractWhereInput = { tenantId, payerType, payerId: id };
  const claims: Prisma.InsuranceClaimWhereInput = {
    tenantId,
    OR: [{ policy: policies }, { insuranceCase: casesAny }],
  };
  const preAuths: Prisma.PreAuthorizationRequestWhereInput = {
    tenantId,
    OR: [{ policy: policies }, { insuranceCase: casesAny }],
  };
  const settlements: Prisma.ClaimSettlementWhereInput = { tenantId, claim: claims };
  const communicationLogs: Prisma.TpaCommunicationLogWhereInput = { tenantId, tpaId: id };
  return { policies, casesDirect, casesPaymentResponsible, casesClaimAdministrator, casesAny, contracts, claims, preAuths, settlements, communicationLogs };
}

type ContractRow = { id: string; name: string; contractNumber: string | null; validFrom: Date; validTo: Date; isActive: boolean };

/**
 * Contracts of the duplicate that would compete with an active contract of the
 * kept record over the same dates. Contract lookup takes the first active one
 * covering a date, so two overlapping active contracts would make the tariff
 * applied to a bill arbitrary. The kept record's contract wins; the duplicate's
 * one still moves (history is kept) but is deactivated.
 */
async function contractCollisions(db: Db, tenantId: string, kind: MergeablePayerKind, duplicateId: string, keepId: string) {
  const select = { id: true, name: true, contractNumber: true, validFrom: true, validTo: true, isActive: true } as const;
  const [fromDuplicate, ofKeep] = (await Promise.all([
    db.payerContract.findMany({ where: { tenantId, payerType: kind, payerId: duplicateId }, select }),
    db.payerContract.findMany({ where: { tenantId, payerType: kind, payerId: keepId, isActive: true }, select }),
  ])) as [ContractRow[], ContractRow[]];
  return (fromDuplicate ?? []).filter(
    (c) => c.isActive && (ofKeep ?? []).some((k) => c.validFrom <= k.validTo && c.validTo >= k.validFrom),
  );
}

async function countReferences(db: Db, kind: MergeablePayerKind, tenantId: string, id: string) {
  const w = referenceWheres(kind, tenantId, id);
  const [policies, cases, contracts, communicationLogs, claims, preAuths, settlements] = await Promise.all([
    db.insurancePolicy.count({ where: w.policies }),
    db.insuranceCase.count({ where: { tenantId, ...w.casesAny } }),
    db.payerContract.count({ where: w.contracts }),
    kind === 'tpa' ? db.tpaCommunicationLog.count({ where: w.communicationLogs }) : Promise.resolve(0),
    db.insuranceClaim.count({ where: w.claims }),
    db.preAuthorizationRequest.count({ where: w.preAuths }),
    db.claimSettlement.count({ where: w.settlements }),
  ]);
  return { policies, cases, contracts, communicationLogs, claims, preAuths, settlements };
}

/** What a merge would move — shown to the admin before they confirm. */
export async function previewPayerMerge(kind: MergeablePayerKind, tenantId: string, duplicateId: string, keepId: string) {
  const { duplicate, keep } = await loadPair(prisma, kind, tenantId, duplicateId, keepId);
  const [counts, collisions] = await Promise.all([
    countReferences(prisma, kind, tenantId, duplicate.id),
    contractCollisions(prisma, tenantId, kind, duplicate.id, keep.id),
  ]);
  return {
    kind,
    duplicate: { id: duplicate.id, name: duplicate.name, gstin: duplicate.gstin, isActive: duplicate.isActive },
    keep: { id: keep.id, name: keep.name, gstin: keep.gstin },
    counts: { ...counts, contractsDeactivated: collisions.length } satisfies PayerMergeCounts,
    contractCollisions: collisions.map((c) => ({ id: c.id, name: c.name, contractNumber: c.contractNumber })),
  };
}

/**
 * Merge `duplicateId` into `keepId`. Atomic: any failure rolls the whole merge
 * back, audit row included.
 */
export async function mergePayers(
  kind: MergeablePayerKind,
  tenantId: string,
  actor: { userId: string; roles: readonly string[] },
  duplicateId: string,
  keepId: string,
) {
  assertCanMergePayers(actor.roles);
  const now = new Date();
  const table = kind === 'insurer' ? 'insurers' : 'tpa_providers';
  const label = kindLabel(kind);

  const result = await prisma.$transaction(async (tx) => {
    // Lock both rows (in a fixed order, so two opposite merges cannot
    // deadlock) before reading them: a concurrent merge of either record waits
    // here and then sees this one's outcome.
    const ordered = [duplicateId, keepId].sort();
    await tx.$queryRaw`SELECT id FROM ${Prisma.raw(table)} WHERE tenant_id = ${tenantId} AND id IN (${Prisma.join(ordered)}) ORDER BY id FOR UPDATE`;

    const { duplicate, keep } = await loadPair(tx, kind, tenantId, duplicateId, keepId);

    // Counted before anything moves: claims / pre-auths / settlements follow
    // their policy or case and would no longer match the duplicate afterwards.
    const counts = await countReferences(tx, kind, tenantId, duplicate.id);
    const collisions = await contractCollisions(tx, tenantId, kind, duplicate.id, keep.id);
    const w = referenceWheres(kind, tenantId, duplicate.id);

    const policies =
      kind === 'insurer'
        ? await tx.insurancePolicy.updateMany({ where: w.policies, data: { insurerId: keep.id } })
        : await tx.insurancePolicy.updateMany({ where: w.policies, data: { tpaId: keep.id } });
    const casesDirect =
      kind === 'insurer'
        ? await tx.insuranceCase.updateMany({ where: w.casesDirect, data: { insurerId: keep.id } })
        : await tx.insuranceCase.updateMany({ where: w.casesDirect, data: { tpaId: keep.id } });
    const casesPaymentResponsible = await tx.insuranceCase.updateMany({
      where: w.casesPaymentResponsible,
      data: { paymentResponsibleId: keep.id },
    });
    const casesClaimAdministrator = await tx.insuranceCase.updateMany({
      where: w.casesClaimAdministrator,
      data: { claimAdministratorId: keep.id },
    });
    if (collisions.length) {
      await tx.payerContract.updateMany({
        where: { tenantId, id: { in: collisions.map((c) => c.id) } },
        data: { payerId: keep.id, isActive: false },
      });
    }
    const contracts = await tx.payerContract.updateMany({ where: w.contracts, data: { payerId: keep.id } });
    const communicationLogs =
      kind === 'tpa'
        ? await tx.tpaCommunicationLog.updateMany({ where: w.communicationLogs, data: { tpaId: keep.id } })
        : { count: 0 };

    // Deactivate, never delete. The mergedIntoId guard makes a second,
    // concurrent merge of the same duplicate a no-op that fails loudly.
    const deactivate = { isActive: false, mergedIntoId: keep.id, mergedAt: now };
    const retired =
      kind === 'insurer'
        ? await tx.insurer.updateMany({ where: { id: duplicate.id, tenantId, mergedIntoId: null }, data: deactivate })
        : await tx.tpaProvider.updateMany({ where: { id: duplicate.id, tenantId, mergedIntoId: null }, data: deactivate });
    if (retired.count !== 1) {
      throw AppError.conflict(`"${duplicate.name}" was merged by someone else just now`, 'PAYER_ALREADY_MERGED');
    }

    const moved: PayerMergeCounts = {
      policies: policies.count,
      cases: counts.cases,
      contracts: (contracts.count ?? 0) + collisions.length,
      contractsDeactivated: collisions.length,
      communicationLogs: communicationLogs.count,
      claims: counts.claims,
      preAuths: counts.preAuths,
      settlements: counts.settlements,
    };
    const caseLinks = {
      direct: casesDirect.count,
      paymentResponsible: casesPaymentResponsible.count,
      claimAdministrator: casesClaimAdministrator.count,
    };

    // Inside the transaction on purpose: a merge that is not recorded must not
    // happen (criterion 3), so an audit failure rolls the merge back.
    const ctx = getRequestContext();
    const entityType = kind === 'insurer' ? 'insurer' : 'tpa_provider';
    const description =
      `Merged ${label} "${duplicate.name}" into "${keep.name}": ` +
      `${moved.policies} polic${moved.policies === 1 ? 'y' : 'ies'}, ${moved.cases} payer case(s), ` +
      `${moved.contracts} contract(s)${moved.contractsDeactivated ? ` (${moved.contractsDeactivated} overlapping deactivated)` : ''}, ` +
      `${moved.claims} claim(s), ${moved.preAuths} pre-auth(s), ${moved.settlements} settlement(s)` +
      (kind === 'tpa' ? `, ${moved.communicationLogs} communication log(s)` : '') +
      ' moved';
    const newValues = {
      event: 'payer.merged',
      kind,
      duplicate: { id: duplicate.id, name: duplicate.name },
      kept: { id: keep.id, name: keep.name },
      mergedBy: actor.userId,
      mergedAt: now.toISOString(),
      moved: { ...moved },
      caseLinks,
      deactivatedContractIds: collisions.map((c) => c.id),
    } satisfies Prisma.InputJsonObject;
    const base = {
      tenantId,
      userId: actor.userId,
      action: 'update' as const,
      entityType,
      description,
      newValues,
      ipAddress: ctx?.ipAddress,
      userAgent: ctx?.userAgent,
    };
    // One row on each record, so the history of either one shows the merge.
    await tx.auditLog.createMany({
      data: [
        { ...base, entityId: keep.id },
        {
          ...base,
          entityId: duplicate.id,
          oldValues: { id: duplicate.id, name: duplicate.name, gstin: duplicate.gstin, isActive: duplicate.isActive },
        },
      ],
    });

    return {
      kind,
      duplicate: { id: duplicate.id, name: duplicate.name, isActive: false, mergedIntoId: keep.id, mergedAt: now },
      kept: { id: keep.id, name: keep.name },
      moved,
      deactivatedContractIds: collisions.map((c) => c.id),
    };
  });

  logger.info({ tenantId, kind, duplicateId, keepId, moved: result.moved }, 'Duplicate payer merged');
  return result;
}
