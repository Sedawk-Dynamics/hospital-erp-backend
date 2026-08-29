import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { createReturn } from '../../../../src/modules/pharmacy/pharmacy.service';

/**
 * A voided sale has already given its stock back and reversed its payment.
 * Taking a return on top restocks a second time and refunds money that was
 * never kept.
 *
 * This used to be impossible by accident: voiding DELETED the dispensing
 * record, so the lookup found nothing. The record is kept now — the
 * controlled-drug register needs it, since a statutory register is corrected by
 * a further entry rather than by erasing one — which opened the path, so the
 * refusal has to be explicit.
 */

const TENANT = 'tenant-1';
const USER = 'user-1';
const ROLES = ['pharmacy_admin'];

const record = (over: Record<string, unknown> = {}) => ({
  id: 'disp-1', tenantId: TENANT, patientId: 'pat-1', drugBatchId: 'batch-1',
  quantityDispensed: 20, billId: 'bill-1', saleUnit: 'pack',
  unitPrice: 2, discountPercent: 0, nonReturnable: false, cancelledAt: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('returning against a voided sale', () => {
  it('is refused, and says why in words the counter can act on', async () => {
    (prisma.dispensingRecord.findFirst as any).mockResolvedValue(
      record({ cancelledAt: new Date('2026-08-25T10:00:00Z') }),
    );

    await expect(
      createReturn(TENANT, USER, ROLES, {
        returnType: 'patient_return', dispensingRecordId: 'disp-1',
        quantity: 20, reason: 'change of mind',
      } as never),
    ).rejects.toThrow(/voided/i);

    // Nothing was created, so nothing has to be unwound.
    expect(prisma.drugReturn.create).not.toHaveBeenCalled();
  });

  it('is refused before the returnable quantity is even worked out', async () => {
    // The cap is computed from prior returns; reaching that query at all would
    // mean the void check sits in the wrong place.
    (prisma.dispensingRecord.findFirst as any).mockResolvedValue(
      record({ cancelledAt: new Date('2026-08-25T10:00:00Z') }),
    );
    await expect(
      createReturn(TENANT, USER, ROLES, {
        returnType: 'patient_return', dispensingRecordId: 'disp-1',
        quantity: 1, reason: 'x',
      } as never),
    ).rejects.toThrow();
    expect(prisma.drugReturn.aggregate).not.toHaveBeenCalled();
  });

  it('still allows a return against a sale that stands', async () => {
    (prisma.dispensingRecord.findFirst as any).mockResolvedValue(record());
    (prisma.drugReturn.aggregate as any).mockResolvedValue({ _sum: { quantity: 0 } });
    (prisma.drugBatch.findFirst as any).mockResolvedValue({ id: 'batch-1', quantityInStock: 100 });
    (prisma.patient.findFirst as any).mockResolvedValue({ id: 'pat-1' });
    (prisma.drugReturn.create as any).mockResolvedValue({ id: 'ret-1', drugBatch: null });
    // Stop after creation — processing is a separate concern with its own tests.
    (prisma.drugReturn.findFirst as any).mockResolvedValue(null);

    await expect(
      createReturn(TENANT, USER, ROLES, {
        returnType: 'patient_return', dispensingRecordId: 'disp-1',
        quantity: 5, reason: 'change of mind',
      } as never),
    ).rejects.toThrow(/not found/i);
    expect(prisma.drugReturn.create).toHaveBeenCalled();
  });
});
