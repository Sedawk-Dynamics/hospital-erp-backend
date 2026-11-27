// G-4: the B2B buyer on a bill.
//
// `recipientGstin` had readers everywhere — the document type, the credit
// note, every return — and the only writer was the TPA stamp, so a corporate
// or a business patient could never be issued a B2B invoice. This puts the
// buyer on a bill BEFORE it is issued, which is the only moment it can still
// change what the document is.
//
// #265: and the place of supply. The buyer's state no longer decides it — health
// services are supplied where they are performed. The exceptions (goods shipped
// out, a service performed off site) are set explicitly, on a draft, by billing
// or admin, and audited.

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import { stateNameForCode } from '../../shared/gst';
import {
  normalizeBuyer, normalizeSupplyType, supplyTypeOf, SUPPLY_TYPE_LABELS,
  type BuyerInput, type SupplyTypeInput,
} from './billing.gst-checks';

export async function setBillBuyer(tenantId: string, userId: string, billId: string, input: BuyerInput) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    select: {
      id: true, billNumber: true, status: true, invoiceNumber: true, gstDocumentType: true,
      recipientGstin: true, recipientLegalName: true, supplyType: true, supplyDestinationStateCode: true,
    },
  });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status === 'cancelled') throw AppError.badRequest('This bill is cancelled');
  // Once numbered, the document IS a B2C (or B2B) invoice; adding a buyer now
  // would rewrite a filed document. The correction is a credit note.
  if (bill.invoiceNumber) {
    throw AppError.badRequest(
      `Bill ${bill.billNumber} has already been issued (${bill.invoiceNumber}). Add the buyer's GSTIN before ` +
        'finalising; for an issued bill, cancel it (a credit note is raised) and bill again.',
    );
  }

  const fields = normalizeBuyer(input);
  // #265: an off-site service is billed to a registered buyer in the destination
  // state, so the buyer cannot be taken away (or moved) from under it.
  if (
    supplyTypeOf(bill.supplyType) === 'off_site_service' &&
    fields.buyerStateCode !== (bill.supplyDestinationStateCode ?? null)
  ) {
    throw AppError.badRequest(
      'This bill is marked as a service performed off site in the buyer’s state. Set it back to "Performed at the hospital" before changing the buyer.',
    );
  }
  const updated = await prisma.bill.update({
    where: { id: billId },
    data: {
      recipientGstin: fields.recipientGstin,
      recipientLegalName: fields.recipientLegalName,
      recipientAddress: fields.recipientAddress,
      // #265: never the buyer's state. Finalisation stamps the place of supply
      // from the bill's supply type; a draft carries none.
      placeOfSupplyStateCode: null,
    },
    select: {
      id: true, billNumber: true, recipientGstin: true, recipientLegalName: true,
      recipientAddress: true, placeOfSupplyStateCode: true,
    },
  });

  logger.info({ tenantId, billId, b2b: !!fields.recipientGstin }, 'Bill buyer set');
  void writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'bill',
    entityId: billId,
    description: fields.recipientGstin
      ? `Buyer GSTIN ${fields.recipientGstin} (${fields.recipientLegalName}) set on ${bill.billNumber} — B2B`
      : `Buyer GSTIN cleared on ${bill.billNumber} — B2C`,
    oldValues: { recipientGstin: bill.recipientGstin, recipientLegalName: bill.recipientLegalName },
    newValues: { recipientGstin: fields.recipientGstin, recipientLegalName: fields.recipientLegalName },
  });
  return updated;
}

/**
 * Set where a DRAFT bill is supplied (#265). Refused once the document is
 * numbered, and refused where the bill's own lines contradict the choice.
 */
export async function setBillSupplyType(tenantId: string, userId: string, billId: string, input: SupplyTypeInput) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    select: {
      id: true, billNumber: true, status: true, invoiceNumber: true, recipientGstin: true, admissionId: true,
      supplyType: true, supplyDestinationStateCode: true, supplyTypeReason: true,
      billItems: { select: { description: true, category: true, referenceType: true } },
    },
  });
  if (!bill) throw AppError.notFound('Bill not found');
  if (bill.status !== 'draft' || bill.invoiceNumber) {
    throw AppError.badRequest(
      `The place of supply can only be changed on a draft bill${
        bill.invoiceNumber ? ` — ${bill.billNumber} has been issued as ${bill.invoiceNumber}` : ''
      }. For an issued bill, cancel it (a credit note is raised) and bill again.`,
    );
  }

  const next = normalizeSupplyType(input, {
    recipientGstin: bill.recipientGstin,
    admissionId: bill.admissionId,
    billItems: bill.billItems.map((i) => ({ ...i, category: String(i.category) })),
  });
  const updated = await prisma.bill.update({
    where: { id: billId },
    data: { ...next, placeOfSupplyStateCode: null },
    select: {
      id: true, billNumber: true, supplyType: true, supplyDestinationStateCode: true, supplyTypeReason: true,
      recipientGstin: true,
    },
  });

  const where = next.supplyDestinationStateCode ? ` to ${stateNameForCode(next.supplyDestinationStateCode)}` : '';
  logger.info({ tenantId, billId, supplyType: next.supplyType }, 'Bill supply type set');
  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'bill',
    entityId: billId,
    description: `Place of supply on ${bill.billNumber} set to "${SUPPLY_TYPE_LABELS[next.supplyType]}"${where}`,
    reason: next.supplyTypeReason ?? undefined,
    oldValues: {
      supplyType: bill.supplyType, supplyDestinationStateCode: bill.supplyDestinationStateCode,
      supplyTypeReason: bill.supplyTypeReason,
    },
    newValues: next,
  });
  return updated;
}
