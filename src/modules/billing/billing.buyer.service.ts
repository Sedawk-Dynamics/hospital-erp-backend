// G-4: the B2B buyer on a bill.
//
// `recipientGstin` had readers everywhere — the document type, the credit
// note, every return — and the only writer was the TPA stamp, so a corporate
// or a business patient could never be issued a B2B invoice. This puts the
// buyer on a bill BEFORE it is issued, which is the only moment it can still
// change what the document is.

import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import { normalizeBuyer, type BuyerInput } from './billing.gst-checks';

export async function setBillBuyer(tenantId: string, userId: string, billId: string, input: BuyerInput) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    select: {
      id: true, billNumber: true, status: true, invoiceNumber: true, gstDocumentType: true,
      recipientGstin: true, recipientLegalName: true,
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
  const updated = await prisma.bill.update({
    where: { id: billId },
    data: {
      recipientGstin: fields.recipientGstin,
      recipientLegalName: fields.recipientLegalName,
      recipientAddress: fields.recipientAddress,
      // For a service the place of supply is the registered buyer's state;
      // cleared, finalisation falls back to the hospital's own state.
      placeOfSupplyStateCode: fields.buyerStateCode,
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
