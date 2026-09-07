import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { reconcileGstr2b, importGstr2b } from '../../../../src/modules/gst/gst-reports.reconcile';

const TENANT = 'tenant-1';
const SUPPLIER = '27AAAAA1111A1Z5';
const OURS = '27AAPFU0939F1ZV';
const PERIOD = { from: '2026-09-01', to: '2026-09-30' };

/** One purchase batch as the register reads it. */
function batch(over: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    batchNumber: 'B-1',
    invoiceNumber: 'SUP/001',
    invoiceDate: new Date('2026-09-05T00:00:00Z'),
    createdAt: new Date('2026-09-06T00:00:00Z'),
    quantityReceived: 100,
    freeQuantity: 0,
    purchasePrice: 10,
    purchaseDiscountPercent: 0,
    gstPercent: 12,
    drug: { drugName: 'Paracetamol', hsnCode: '30049099' },
    supplier: { id: 's1', name: 'Acme Pharma', gstNumber: SUPPLIER },
    ...over,
  };
}

/** One row out of an imported statement. */
function portalRow(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    supplierGstin: SUPPLIER,
    supplierName: 'Acme Pharma',
    documentType: 'invoice',
    documentNumber: 'SUP/001',
    matchKey: 'SUP001',
    documentDate: new Date('2026-09-05T00:00:00Z'),
    taxableValue: 1000,
    taxAmount: 120,
    itcAvailable: true,
    itcBlockedReason: null,
    supplierFiledOn: new Date('2026-10-11T00:00:00Z'),
    ...over,
  };
}

function seed(batches: unknown[], rows: unknown[] | null) {
  (prisma.drugBatch.findMany as any).mockResolvedValue(batches);
  (prisma.gstr2bImport.findFirst as any).mockResolvedValue(
    rows === null
      ? null
      : {
          id: 'imp-1', gstin: OURS, generatedAt: new Date('2026-10-14T00:00:00Z'),
          fileName: '2B_092026.json', importedAt: new Date('2026-10-15T00:00:00Z'),
          invoiceCount: rows.length, rows,
          importer: { firstName: 'Book', lastName: 'Keeper' },
        },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reconcileGstr2b (B-5)', () => {
  it('matches a purchase to the invoice the supplier declared', async () => {
    seed([batch()], [portalRow()]);
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.totals.matched.count).toBe(1);
    expect(r.matched[0]).toMatchObject({
      invoiceNumber: 'SUP/001',
      booksTaxAmount: 120,
      portalTaxAmount: 120,
      taxDifference: 0,
    });
    expect(r.totals.inBooksOnly.count).toBe(0);
    expect(r.totals.inPortalOnly.count).toBe(0);
  });

  // A supplier invoice covers many batches. Matching batch-to-invoice would
  // report a five-line delivery as four missing invoices.
  it('groups our batches to the invoice before matching', async () => {
    seed(
      [batch(), batch({ id: 'b2', batchNumber: 'B-2', purchasePrice: 5 })],
      [portalRow({ taxableValue: 1500, taxAmount: 180 })],
    );
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.totals.matched.count).toBe(1);
    expect(r.matched[0]).toMatchObject({ lines: 2, booksTaxableValue: 1500, booksTaxAmount: 180 });
  });

  it('reads SUP-001 in our books and SUP/001 on the portal as one invoice', async () => {
    seed([batch({ invoiceNumber: 'sup-001' })], [portalRow()]);
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.totals.matched.count).toBe(1);
  });

  // Suppliers round at the line and we round at the batch. An exact rule would
  // put half the genuinely-matched invoices in the mismatch bucket.
  it('treats a rupee of rounding as matched, and more as a mismatch', async () => {
    seed([batch()], [portalRow({ taxAmount: 119.4, taxableValue: 999.5 })]);
    expect((await reconcileGstr2b(TENANT, PERIOD)).totals.matched.count).toBe(1);

    seed([batch()], [portalRow({ taxAmount: 100 })]);
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.totals.mismatched.count).toBe(1);
    expect(r.mismatched[0].taxDifference).toBe(20);
  });

  // The expensive bucket: we recorded it, the supplier has not filed it, and
  // the credit cannot be claimed until they do.
  it('reports a purchase the supplier has not declared as credit at risk', async () => {
    seed([batch()], []);
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.totals.inBooksOnly).toEqual({ count: 1, taxAmount: 120 });
    expect(r.totals.creditAtRisk).toBe(120);
  });

  it('reports an invoice the portal has and our books do not', async () => {
    seed([], [portalRow()]);
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.totals.inPortalOnly).toEqual({ count: 1, taxAmount: 120 });
    expect(r.inPortalOnly[0].invoiceNumber).toBe('SUP/001');
  });

  it('keeps a purchase we cannot match on out of the missing bucket', async () => {
    seed([batch({ supplier: { id: 's9', name: 'Cash Traders', gstNumber: null } })], [portalRow()]);
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.totals.unmatchable.count).toBe(1);
    expect(r.unmatchable[0].problem).toMatch(/No supplier GSTIN/);
    // The fault is on our side of the desk, so it is not credit at risk.
    expect(r.totals.inBooksOnly.count).toBe(0);
  });

  it('says which purchase has no invoice number recorded', async () => {
    seed([batch({ invoiceNumber: null })], []);
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.unmatchable[0].problem).toMatch(/No supplier invoice number/);
  });

  // Claiming our own figure where the two disagree is how a notice starts.
  it('claims the PORTAL figure, and only where the portal allows it', async () => {
    seed([batch()], [portalRow({ taxAmount: 119.5 })]);
    expect((await reconcileGstr2b(TENANT, PERIOD)).totals.claimable).toBe(119.5);

    seed([batch()], [portalRow({ itcAvailable: false, itcBlockedReason: 'Blocked under 17(5)' })]);
    const blocked = await reconcileGstr2b(TENANT, PERIOD);
    expect(blocked.totals.matched.count).toBe(1);
    expect(blocked.totals.claimable).toBe(0);
    expect(blocked.matched[0].itcBlockedReason).toBe('Blocked under 17(5)');
  });

  // A credit note takes credit AWAY. Adding it on would overstate the claim.
  it('nets a supplier credit note off what can be claimed', async () => {
    seed(
      [batch()],
      [portalRow(), portalRow({ id: 'p2', documentType: 'credit_note', documentNumber: 'CN/9', matchKey: 'CN9', taxAmount: 20 })],
    );
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.supplierNotes[0].taxAmount).toBe(-20);
    expect(r.totals.claimable).toBe(100);
    // A note has no goods receipt behind it, so it is never forced into a bucket.
    expect(r.totals.inPortalOnly.count).toBe(0);
  });

  it('adds a supplier debit note rather than subtracting it', async () => {
    seed(
      [batch()],
      [portalRow(), portalRow({ id: 'p2', documentType: 'debit_note', documentNumber: 'DN/3', matchKey: 'DN3', taxAmount: 20 })],
    );
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.totals.claimable).toBe(140);
  });

  // Without a statement everything looks unfiled, which is alarming and wrong.
  // The report has to say the statement is missing rather than imply the
  // suppliers are.
  it('says plainly when no statement has been imported for the period', async () => {
    seed([batch()], null);
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.statement).toBeNull();
    expect(r.notes[0]).toMatch(/No GSTR-2B has been imported for 092026/);
    expect(r.totals.inBooksOnly.count).toBe(1);
  });

  it('names the statement it reconciled against', async () => {
    seed([batch()], [portalRow()]);
    const r = await reconcileGstr2b(TENANT, PERIOD);
    expect(r.statement).toMatchObject({ fileName: '2B_092026.json', importedBy: 'Book Keeper' });
    expect(r.returnPeriod).toBe('092026');
  });
});

describe('importGstr2b', () => {
  const file = {
    data: {
      rtnprd: '092026',
      gstin: OURS,
      docdata: {
        b2b: [
          {
            ctin: SUPPLIER, trdnm: 'Acme Pharma', supfileddt: '11-10-2026',
            inv: [{ inum: 'SUP/001', dt: '05-09-2026', val: 1120, pos: '27', itcavl: 'Y',
                    items: [{ itm_det: { rt: 12, txval: 1000, cgst: 60, sgst: 60 } }] }],
          },
        ],
      },
    },
  };

  beforeEach(() => {
    (prisma.tenant.findFirst as any).mockResolvedValue({
      themeConfig: { gst: { registered: true, gstin: OURS } },
    });
    (prisma.$transaction as any).mockImplementation(async (fn: any) =>
      fn({
        gstr2bImport: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          create: vi.fn().mockResolvedValue({ id: 'imp-1' }),
        },
        gstr2bDocument: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      }),
    );
  });

  it('stores the statement and reports what it read', async () => {
    const out = await importGstr2b(TENANT, 'u1', { file, fileName: '2B.json' });
    expect(out).toMatchObject({ returnPeriod: '092026', documents: 1, taxTotal: 120 });
  });

  // Importing another hospital's 2B would reconcile our purchases against
  // their suppliers and report every invoice we hold as unfiled — a false
  // alarm across the whole month.
  it('refuses a statement generated for a different GSTIN', async () => {
    const other = { data: { ...file.data, gstin: '29ZZZZZ9999Z1Z9' } };
    await expect(importGstr2b(TENANT, 'u1', { file: other })).rejects.toThrow(
      /generated for 29ZZZZZ9999Z1Z9/,
    );
  });

  it('warns when the statement carries no supplier invoices at all', async () => {
    const empty = { data: { ...file.data, docdata: { b2b: [] } } };
    const out = await importGstr2b(TENANT, 'u1', { file: empty });
    expect(out.warnings.join(' ')).toMatch(/no supplier invoices/);
  });

  it('warns about the sections it did not read', async () => {
    const withImports = {
      data: { ...file.data, docdata: { ...file.data.docdata, impg: [{ boe: 1 }] } },
    };
    const out = await importGstr2b(TENANT, 'u1', { file: withImports });
    expect(out.warnings.join(' ')).toMatch(/Sections not read: impg/);
  });
});
