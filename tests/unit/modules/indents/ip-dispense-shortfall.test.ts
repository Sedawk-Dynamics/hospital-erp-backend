import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { dispenseIpPrescription } from '../../../../src/modules/indents/indents.service';

/**
 * What happens when the shelf cannot meet the order.
 *
 * The doctor asks for thirty capsules and the pharmacy holds four. Four are
 * handed over — and the patient used to be billed for thirty, with the
 * dispensing record claiming thirty units had left stock. So a patient was
 * charged for medicine they never received, and the stock ledger showed
 * twenty-six units leaving that never did.
 *
 * The shortfall was written into a free-text note and nowhere anybody reads.
 */

const TENANT = 'tenant-1';
const USER = 'user-1';
const ROLES = ['pharmacy_admin'];
const RX = 'rx-1';

const DRUG = {
  id: 'drug-1', drugName: 'Amoxicillin 500', price: 5, taxPercent: 12,
  looseUnitLabel: 'capsule', isNarcotic: false, isReimbursable: null,
  schedule: 'H', controlledClass: null, vaultControlled: false,
};

function setup(stock: number, ordered = 30, isPrn = false) {
  (prisma.prescription.findFirst as any).mockResolvedValue({
    id: RX, tenantId: TENANT, patientId: 'pat-1', prescriptionType: 'ip',
    prescriptionItems: [{ id: 'item-1', drugId: 'drug-1', isPrn, quantity: ordered }],
    visit: { admission: { id: 'adm-1' } },
  });
  (prisma.dispensingRecord.findFirst as any).mockResolvedValue(null);
  (prisma.tenant.findFirst as any).mockResolvedValue({ themeConfig: {} });

  const tx: any = {
    admission: { findFirst: vi.fn().mockResolvedValue({ id: 'adm-1' }) },
    bill: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'bill-1', admissionId: 'adm-1', subtotal: 0, taxAmount: 0,
        totalAmount: 0, patientPayableAmount: 0, balanceDue: 0,
      }),
      update: vi.fn(), create: vi.fn(),
    },
    drugFormulary: { findFirst: vi.fn().mockResolvedValue(DRUG) },
    drugBatch: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'batch-1', batchNumber: 'B-1', quantityInStock: stock, sellingPrice: 5, purchasePrice: 3, expiryDate: new Date('2027-01-31') },
      ]),
      update: vi.fn(),
    },
    dispensingRecord: { create: vi.fn().mockResolvedValue({ id: 'rec-1' }) },
    billItem: { create: vi.fn() },
    emarSchedule: { updateMany: vi.fn() },
    prescription: { update: vi.fn() },
  };
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(tx));
  return tx;
}

beforeEach(() => vi.clearAllMocks());

describe('an IP dispense the shelf cannot fill', () => {
  it('bills only what was handed over', async () => {
    const tx = setup(4);
    await dispenseIpPrescription(TENANT, USER, ROLES, RX);
    const line = tx.billItem.create.mock.calls[0][0].data;
    expect(line.quantity).toBe(4);
    expect(line.totalAmount).toBe(20);
  });

  it('records how many units actually left the shelf', async () => {
    const tx = setup(4);
    await dispenseIpPrescription(TENANT, USER, ROLES, RX);
    expect(tx.dispensingRecord.create.mock.calls[0][0].data.quantityDispensed).toBe(4);
  });

  it('says on the BILL what is still owed, not only in a note', async () => {
    // The ward reads the bill. A shortfall buried in a free-text field is a
    // shortfall nobody acts on.
    const tx = setup(4);
    await dispenseIpPrescription(TENANT, USER, ROLES, RX);
    expect(tx.billItem.create.mock.calls[0][0].data.description).toMatch(/26 of 30 still owed/);
  });

  it('refuses rather than billing nothing when there is no stock at all', async () => {
    setup(0);
    await expect(dispenseIpPrescription(TENANT, USER, ROLES, RX)).rejects.toThrow(/No stock left/);
  });

  it('bills the whole order when the shelf can meet it', async () => {
    const tx = setup(100);
    await dispenseIpPrescription(TENANT, USER, ROLES, RX);
    const line = tx.billItem.create.mock.calls[0][0].data;
    expect(line.quantity).toBe(30);
    expect(line.totalAmount).toBe(150);
    expect(line.description).not.toMatch(/still owed/);
  });

  it('dispenses a PRN prescription line so it can be administered from eMAR', async () => {
    const tx = setup(1, 1, true);
    await dispenseIpPrescription(TENANT, USER, ROLES, RX);
    expect(tx.dispensingRecord.create).toHaveBeenCalledOnce();
    expect(tx.emarSchedule.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT,
        prescriptionItemId: 'item-1',
        status: 'pending',
        drugBatchId: null,
      },
      data: { drugBatchId: 'batch-1', dispensingRecordId: 'rec-1' },
    });
  });
});
