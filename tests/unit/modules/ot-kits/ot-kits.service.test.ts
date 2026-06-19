import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  issueKit,
  reconcileKit,
  cancelKitIssue,
  createKitTemplate,
} from '../../../../src/modules/ot-kits/ot-kits.service';

const TENANT = 'tenant-1';
const USER = 'user-1';
const ADMIN = ['pharmacy_admin'];

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
});

describe('OT Kits — issue (Virtual OT Ledger transit-lock)', () => {
  it('issues a kit FEFO, decrements stock, and does NOT bill yet', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
    (prisma.drugBatch.findFirst as any).mockResolvedValue({
      id: 'b1', batchNumber: 'BATCH1', sellingPrice: 50, drug: { drugName: 'Suture', price: 50, taxPercent: 12 },
    });
    (prisma.drugBatch.update as any).mockResolvedValue({});
    (prisma.otKitIssue.create as any).mockImplementation((args: any) => ({ id: 'issue-1', status: args.data.status, items: [] }));

    const issue = await issueKit(TENANT, USER, ADMIN, {
      patientId: 'p1', surgeryName: 'Hernia repair', items: [{ drugFormularyId: 'd1', quantity: 4 }],
    });
    expect(issue.status).toBe('issued');
    // stock decremented for the issued line
    expect(prisma.drugBatch.update).toHaveBeenCalledWith(expect.objectContaining({ data: { quantityInStock: { decrement: 4 } } }));
    // no bill created at issue time (virtual ledger)
    expect(prisma.bill.create).not.toHaveBeenCalled();
    expect(prisma.billItem.create).not.toHaveBeenCalled();
  });

  it('refuses to issue when no single batch has enough stock', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue({ id: 'p1' });
    (prisma.drugBatch.findFirst as any).mockResolvedValue(null);
    (prisma.drugFormulary.findUnique as any).mockResolvedValue({ drugName: 'Mesh' });
    await expect(
      issueKit(TENANT, USER, ADMIN, { patientId: 'p1', surgeryName: 'X', items: [{ drugFormularyId: 'd1', quantity: 99 }] }),
    ).rejects.toThrow(/Insufficient stock/);
  });
});

describe('OT Kits — reconcile (Issued − Returned = Consumed)', () => {
  it('reverses returned stock and bills only the consumed quantity', async () => {
    (prisma.otKitIssue.findFirst as any).mockResolvedValue({
      id: 'issue-1', tenantId: TENANT, patientId: 'p1', status: 'issued',
      items: [
        { id: 'it1', drugBatchId: 'b1', issuedQty: 4, unitPrice: 50, taxPercent: 12, drug: { drugName: 'Suture' }, drugBatch: { batchNumber: 'B1' } },
        { id: 'it2', drugBatchId: 'b2', issuedQty: 3, unitPrice: 20, taxPercent: 12, drug: { drugName: 'Gloves' }, drugBatch: { batchNumber: 'B2' } },
      ],
    });
    (prisma.drugBatch.update as any).mockResolvedValue({});
    (prisma.otKitIssueItem.update as any).mockResolvedValue({});
    (prisma.bill.findFirst as any).mockResolvedValue(null);
    (prisma.bill.create as any).mockResolvedValue({ id: 'bill-1', billNumber: 'OT-1', subtotal: 0, taxAmount: 0, totalAmount: 0, patientPayableAmount: 0, balanceDue: 0 });
    (prisma.billItem.create as any).mockResolvedValue({});
    (prisma.bill.update as any).mockResolvedValue({});
    (prisma.bill.count as any).mockResolvedValue(0);
    (prisma.otKitIssue.update as any).mockImplementation((args: any) => ({ id: 'issue-1', status: args.data.status, billId: args.data.billId }));

    // Return 1 of the 4 sutures (consume 3) and 0 of the 3 gloves (consume 3).
    const res = await reconcileKit(TENANT, USER, ADMIN, 'issue-1', { returns: [{ itemId: 'it1', returnedQty: 1 }] });

    // suture: restock 1; gloves: nothing returned
    expect(prisma.drugBatch.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { quantityInStock: { increment: 1 } } });
    // consumed total = 3×50 + 3×20 = 210
    expect(res.consumedTotal).toBe(210);
    expect(res.issue.status).toBe('reconciled');
    // two consumed bill lines created
    expect(prisma.billItem.create).toHaveBeenCalledTimes(2);
  });

  it('reconciles with no bill when everything is returned', async () => {
    (prisma.otKitIssue.findFirst as any).mockResolvedValue({
      id: 'issue-2', tenantId: TENANT, patientId: 'p1', status: 'issued',
      items: [{ id: 'it1', drugBatchId: 'b1', issuedQty: 2, unitPrice: 50, taxPercent: 12, drug: { drugName: 'Suture' }, drugBatch: { batchNumber: 'B1' } }],
    });
    (prisma.drugBatch.update as any).mockResolvedValue({});
    (prisma.otKitIssueItem.update as any).mockResolvedValue({});
    (prisma.otKitIssue.update as any).mockImplementation((args: any) => ({ id: 'issue-2', status: args.data.status, billId: args.data.billId }));

    const res = await reconcileKit(TENANT, USER, ADMIN, 'issue-2', { returns: [{ itemId: 'it1', returnedQty: 2 }] });
    expect(res.consumedTotal).toBe(0);
    expect(res.billId).toBeNull();
    expect(prisma.bill.create).not.toHaveBeenCalled();
  });

  it('refuses to reconcile an already-reconciled kit', async () => {
    (prisma.otKitIssue.findFirst as any).mockResolvedValue({ id: 'issue-3', status: 'reconciled', items: [] });
    await expect(reconcileKit(TENANT, USER, ADMIN, 'issue-3', {})).rejects.toThrow(/already reconciled/);
  });
});

describe('OT Kits — cancel', () => {
  it('reverses all issued stock back', async () => {
    (prisma.otKitIssue.findFirst as any).mockResolvedValue({
      id: 'issue-1', status: 'issued', items: [{ id: 'it1', drugBatchId: 'b1', issuedQty: 4 }],
    });
    (prisma.drugBatch.update as any).mockResolvedValue({});
    (prisma.otKitIssue.update as any).mockImplementation((args: any) => ({ id: 'issue-1', status: args.data.status }));
    const res = await cancelKitIssue(TENANT, USER, ADMIN, 'issue-1');
    expect(res.status).toBe('cancelled');
    expect(prisma.drugBatch.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { quantityInStock: { increment: 4 } } });
  });
});

describe('OT Kits — template', () => {
  it('creates a kit template with items (admin)', async () => {
    (prisma.surgicalKitTemplate.create as any).mockImplementation((args: any) => ({ id: 'tpl-1', name: args.data.name, items: [] }));
    const tpl = await createKitTemplate(TENANT, ADMIN, { name: "Dr Sharma's Hernia Kit", items: [{ drugFormularyId: 'd1', quantity: 4 }] });
    expect(tpl.name).toBe("Dr Sharma's Hernia Kit");
  });

  it('blocks a non-privileged user', async () => {
    await expect(createKitTemplate(TENANT, ['pharmacist'], { name: 'X', items: [{ drugFormularyId: 'd1', quantity: 1 }] })).rejects.toThrow();
  });
});
