import { describe, it, expect, vi, beforeEach } from 'vitest';

// Gap 345 — a test sale, end to end, over one in-memory item: POS quote → sale
// → bill line → stock → stock ledger → stock-out history → stock list → receipt
// → return → credit note. Every step must reconcile in BASE units (tablets) and
// print the same words for the same count. Persistence is mocked; the service
// code is the real thing.

vi.mock('../../../../src/modules/gst/gst-document.service', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  issueDocumentForBill: vi.fn(async () => null),
  allotDocumentNumber: vi.fn(async () => ({ invoiceNumber: 'CN/26-27/1', financialYear: '2026-27' })),
}));
vi.mock('../../../../src/modules/inventory/stock-valuation.service', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getStockValuation: vi.fn(async () => ({ lines: [] })),
}));

import { prisma } from '../../../../src/config/database';
import { clearGstMasterCache } from '../../../../src/modules/gst/gst-resolver.service';
import { clearGstSlabCache } from '../../../../src/shared/gst-slabs';
import {
  createPharmacySale, previewPharmacySale, createReturn, getReturnableDispenses, getReturnById, getPharmacySale,
  getDispenseRecords, cancelPharmacySale,
} from '../../../../src/modules/pharmacy/pharmacy.service';
import {
  buildStockLedger, drugOutflowAsStockTransactions, resetDrugStockMovementProbe,
} from '../../../../src/modules/pharmacy/pharmacy.stock-movement';
import { getUnifiedStock } from '../../../../src/modules/inventory/inventory.service';
import { buildGstBlock, gstChargeCells } from '../../../../src/modules/billing/billing.gst-layout';

const T = 'tenant-1';
const U = 'user-1';
const p = prisma as any;

interface Db {
  drug: any; batch: any; bills: any[]; items: any[]; records: any[]; moves: any[]; returns: any[]; notes: any[]; payments: any[];
}
let db: Db;
let seq = 0;
const id = (k: string) => `${k}-${++seq}`;

/** Wire the prisma mock to one drug + one batch held in memory. */
function wire(stock = 100, drug: Record<string, unknown> = {}) {
  db = {
    drug: {
      id: 'd1', drugName: 'Dolo 650', price: 2, packSize: 10, looseUnitLabel: 'Tablet', dosageForm: 'tablet',
      unitOfMeasurement: 'Strip (UQC PAC)', taxPercent: 5, hsnCode: '3004', gstTreatment: null, category: 'drug', ...drug,
    },
    batch: {
      id: 'b1', tenantId: T, drugId: 'd1', batchNumber: 'BN1', quantityInStock: stock, quantityReceived: stock,
      sellingPrice: 2.1, purchasePrice: 1, isExpired: false, isRecalled: false, expiryDate: new Date('2030-12-31'),
      createdAt: new Date('2026-01-01'),
    },
    bills: [], items: [], records: [], moves: [], returns: [], notes: [], payments: [],
  };
  const batchRow = () => ({ ...db.batch, drug: db.drug });
  const move = (d: any) => {
    if (d?.decrement != null) db.batch.quantityInStock -= d.decrement;
    if (d?.increment != null) db.batch.quantityInStock += d.increment;
  };

  p.$transaction.mockImplementation((fn: any) => (typeof fn === 'function' ? fn(p) : Promise.all(fn)));
  p.tenant.findFirst.mockResolvedValue({ themeConfig: { gst: { registered: true, gstin: '27AAPFU0939F1ZV', inpatientCompositeExempt: true } } });
  p.tenant.findUnique.mockResolvedValue({ name: 'Hospital' });
  p.hsnGstRate.findMany.mockResolvedValue([{ hsnCode: '3004', gstRate: 5, treatment: 'taxable', description: 'Medicaments' }]);
  p.gstSlab.findMany.mockResolvedValue(
    [0, 5, 18, 40].map((r) => ({ ratePercent: r, label: `${r}%`, effectiveFrom: new Date('2025-09-22'), effectiveTo: null, note: null })),
  );
  p.patient.findFirst.mockResolvedValue({ id: 'p1', mrn: 'M1', firstName: 'Asha', lastName: 'K' });
  p.patient.findUnique.mockResolvedValue(null);
  p.admission.findFirst.mockResolvedValue(null);
  p.drugFormulary.findFirst.mockImplementation(async () => db.drug);
  p.drugFormulary.findMany.mockImplementation(async () => [db.drug]);

  p.drugBatch.findFirst.mockImplementation(async () => batchRow());
  p.drugBatch.findUnique.mockImplementation(async () => batchRow());
  p.drugBatch.findMany.mockImplementation(async () => [batchRow()]);
  p.drugBatch.update.mockImplementation(async ({ data }: any) => { move(data.quantityInStock); return batchRow(); });
  p.drugBatch.aggregate.mockImplementation(async ({ where }: any) => ({
    _sum: { quantityInStock: where.isExpired ? 0 : db.batch.quantityInStock },
  }));

  p.bill.create.mockImplementation(async ({ data }: any) => { const b = { id: id('bill'), ...data }; db.bills.push(b); return b; });
  p.bill.findFirst.mockImplementation(async ({ where }: any) => {
    if (where?.billNumber && !where.id) return null;
    const b = db.bills.find((x) => x.id === where?.id);
    return b ? { ...b, billItems: db.items.filter((i) => i.billId === b.id), payments: [], patient: { firstName: 'Asha' }, generator: null } : null;
  });
  p.bill.findMany.mockImplementation(async () => db.bills);
  p.bill.update.mockImplementation(async ({ where, data }: any) => Object.assign(db.bills.find((b) => b.id === where.id), data));
  p.billItem.create.mockImplementation(async ({ data }: any) => { const i = { id: id('item'), ...data }; db.items.push(i); return i; });
  p.billItem.findFirst.mockImplementation(async ({ where }: any) => db.items.find((i) => i.referenceId === where.referenceId) ?? null);
  p.billItem.findMany.mockImplementation(async ({ where }: any) => db.items.filter((i) => i.billId === where.billId && (!where.id || where.id.in.includes(i.id))));
  p.billItem.deleteMany.mockImplementation(async ({ where }: any) => { db.items = db.items.filter((i) => i.billId !== where.billId); });
  p.payment.create.mockImplementation(async ({ data }: any) => { const x = { id: id('pay'), ...data }; db.payments.push(x); return x; });
  p.payment.findFirst.mockImplementation(async () => ({ ...db.payments[0], bill: db.bills.find((b) => b.id === db.payments[0].billId) }));
  p.refund.create.mockImplementation(async ({ data }: any) => ({ id: id('refund'), ...data }));

  p.dispensingRecord.create.mockImplementation(async ({ data }: any) => {
    const r = { id: id('rec'), dispensedAt: new Date(), cancelledAt: null, ...data };
    db.records.push(r);
    return r;
  });
  const recRow = (r: any) => ({ ...r, drugBatch: batchRow(), drugReturns: db.returns.filter((x) => x.dispensingRecordId === r.id), dispenser: null });
  p.dispensingRecord.findFirst.mockImplementation(async ({ where }: any) => db.records.find((r) => r.id === where.id) ?? null);
  p.dispensingRecord.findMany.mockImplementation(async () => db.records.map(recRow));
  p.dispensingRecord.updateMany.mockImplementation(async () => { db.records.forEach((r) => { r.cancelledAt = new Date(); }); return { count: db.records.length }; });

  p.drugStockMovement.create.mockImplementation(async ({ data }: any) => {
    const m = { id: id('mv'), createdAt: new Date(), ...data };
    db.moves.push(m);
    return m;
  });
  p.drugStockMovement.findMany.mockImplementation(async ({ where }: any) =>
    db.moves.filter((m) => (where.quantity?.lt !== undefined ? m.quantity < 0 : true)));
  p.drugStockMovement.count.mockImplementation(async () => db.moves.filter((m) => m.quantity < 0).length);
  p.drugStockMovement.aggregate.mockImplementation(async (a: any) =>
    a._min ? { _min: { createdAt: new Date('2026-01-01') } } : { _sum: { quantity: 0 } });

  p.drugReturn.create.mockImplementation(async ({ data }: any) => { const r = { id: id('ret'), ...data }; db.returns.push(r); return { ...r, drugBatch: batchRow() }; });
  p.drugReturn.findFirst.mockImplementation(async ({ where }: any) => {
    const r = db.returns.find((x) => x.id === where.id);
    return r ? { ...r, drugBatch: batchRow(), drug: null, dispensingRecord: db.records.find((x) => x.id === r.dispensingRecordId) ?? null } : null;
  });
  p.drugReturn.findUnique.mockImplementation(async ({ where }: any) => db.returns.find((x) => x.id === where.id));
  p.drugReturn.update.mockImplementation(async ({ where, data }: any) => Object.assign(db.returns.find((x) => x.id === where.id), data));
  p.drugReturn.aggregate.mockImplementation(async ({ where }: any) => ({
    _sum: { quantity: db.returns.filter((r) => r.dispensingRecordId === where.dispensingRecordId).reduce((s, r) => s + r.quantity, 0) },
  }));
  p.drugReturn.count.mockResolvedValue(0);

  p.creditNote.create.mockImplementation(async ({ data }: any) => {
    const n = { id: id('cn'), ...data, items: data.items.create };
    db.notes.push(n);
    return n;
  });
  p.creditNote.findMany.mockImplementation(async () => db.notes);

  p.$queryRaw.mockImplementation(async () => [{
    count: 1, kind: 'drug', ref_id: 'd1', name: db.drug.drugName, code: '3004', category: 'drug', unit: db.drug.looseUnitLabel,
    pack_size: db.drug.packSize, uom: db.drug.unitOfMeasurement, dosage_form: db.drug.dosageForm,
    current_stock: db.batch.quantityInStock, reorder_level: 25, cost_per_unit: 1, selling_price: 2, tracks_batches: true,
    batch_count: 1, nearest_expiry: null, is_recalled: false, composition: null, product_category: null, mapping_names: null,
    schedule: null, controlled_class: null, vault_controlled: false, schedule_reason: null,
  }]);
}

const sell = (items: any[]) => createPharmacySale(T, U, { items, paymentMethod: 'cash' } as any) as any;

/** Everything that shows the item, after the movements so far. */
async function surfaces() {
  const ledger = await buildStockLedger(T, { drugId: 'd1' });
  const out = await drugOutflowAsStockTransactions(T, { take: 50 });
  const list = await getUnifiedStock(T, {} as never);
  return { ledger, out, stock: list.data[0]! };
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  clearGstMasterCache();
  clearGstSlabCache();
  resetDrugStockMovementProbe(true);
});

describe('345 — full pack sale', () => {
  it('quote, bill, stock, ledger, stock-out, stock list and receipt agree', async () => {
    wire(100);
    const line = { drugBatchId: 'b1', quantity: 2, saleUnit: 'pack' as const };
    const quote = await previewPharmacySale(T, { items: [line] });
    expect(quote.lines[0]).toMatchObject({ quantity: 20, quantityText: '2 strips (20 tablets)', availableText: '10 strips (100 tablets)' });

    const sale = await sell([line]);
    const words = '2 strips (20 tablets)';
    // Bill line: base units stored, words printed; price is per tablet.
    expect(db.items[0]).toMatchObject({ quantity: 20, unitPrice: 2.1, totalAmount: 42 });
    expect(db.items[0].description).toContain(`— ${words}`);
    expect(db.records[0]).toMatchObject({ quantityDispensed: 20, saleUnit: 'pack' });
    // Receipt (and any reprint of it).
    expect(sale.bill.billItems[0]).toMatchObject({ quantity: 20, quantityText: words, rateUnit: 'tablet' });
    // Stock and ledger.
    expect(db.batch.quantityInStock).toBe(80);
    const s = await surfaces();
    expect(s.ledger.entries[0]).toMatchObject({ movementType: 'sale', quantityOut: 20, quantityText: words, balance: 80, balanceText: '8 strips (80 tablets)' });
    expect(s.ledger.summary.closingStock).toBe(80);
    expect(s.out.rows[0]).toMatchObject({ quantity: 20, quantityText: words });
    expect(s.stock).toMatchObject({ currentStock: 80, currentStockText: '8 strips (80 tablets)', reorderLevelText: '2 strips + 5 tablets (25 tablets)' });
    // Quote total = billed total.
    expect(quote.totals.totalAmount).toBe(42);
    // Bill PDF: the printed line of the same bill carries the same words.
    const i = db.items[0];
    const line46 = {
      description: i.description, quantity: i.quantity, unitPrice: Number(i.unitPrice), totalAmount: Number(i.totalAmount),
      hsnSac: i.hsnSacCode, gstTreatment: i.gstTreatment, treatmentLabel: 'Taxable', taxRatePercent: 5, taxableValue: 40, taxAmount: 2,
      cgstRate: 2.5, cgstAmount: 1, sgstRate: 2.5, sgstAmount: 1, igstRate: 0, igstAmount: 0, cessAmount: 0,
    };
    const cells = gstChargeCells(buildGstBlock({ registered: true, gstin: null, stateCode: '27' } as never, [], [line46]), line46);
    expect(cells[0]).toContain(words);
    expect(cells).toContain('20');
  });
});

describe('345 — loose sale', () => {
  it('five tablets stay five tablets everywhere', async () => {
    wire(100);
    const line = { drugBatchId: 'b1', quantity: 5, saleUnit: 'loose' as const };
    const quote = await previewPharmacySale(T, { items: [line] });
    const sale = await sell([line]);
    const words = '5 tablets (loose)';
    expect(quote.lines[0]).toMatchObject({ quantity: 5, quantityText: words });
    expect(db.items[0]).toMatchObject({ quantity: 5, totalAmount: 10.5 });
    expect(db.items[0].description).toContain(words);
    expect(sale.bill.billItems[0].quantityText).toBe(words);
    expect(db.batch.quantityInStock).toBe(95);
    const s = await surfaces();
    expect(s.ledger.entries[0]).toMatchObject({ quantityOut: 5, quantityText: words, balanceText: '9 strips + 5 tablets (95 tablets)' });
    expect(s.out.rows[0]!.quantityText).toBe(words);
    expect(s.stock.currentStockText).toBe('9 strips + 5 tablets (95 tablets)');
    const reg = await getDispenseRecords(T, {} as never);
    expect((reg.records[0] as any).quantityText).toBe(words);
  });
});

// #345, client's answer "round off prices", never above MRP.
describe('345 — round-off never takes a loose sale above the MRP', () => {
  const bill = () => db.bills.at(-1);
  it('five loose tablets at Rs 2.10 are Rs 10.50 exactly and the bill rounds down to Rs 10', async () => {
    wire(100);
    await sell([{ drugBatchId: 'b1', quantity: 5, saleUnit: 'loose' }]);
    expect(bill()).toMatchObject({ totalAmount: 10, roundOff: -0.5 });
  });

  it('whole strips still round to the nearest rupee', async () => {
    wire(100, {}, );
    await sell([{ drugBatchId: 'b1', quantity: 2, saleUnit: 'pack' }]);
    expect(bill()).toMatchObject({ totalAmount: 42, roundOff: 0 });
  });

  it('an unregistered hospital rounds too, instead of charging the paise', async () => {
    wire(100);
    p.tenant.findFirst.mockResolvedValue({ themeConfig: { gst: { registered: false } } });
    await sell([{ drugBatchId: 'b1', quantity: 5, saleUnit: 'loose' }]);
    expect(bill()).toMatchObject({ totalAmount: 10, roundOff: -0.5 });
  });
});

describe('345 — mixed sale', () => {
  it('a strip and five tablets on one line', async () => {
    wire(100);
    const sale = await sell([{ drugBatchId: 'b1', quantity: 15, saleUnit: 'loose' }]);
    const words = '1 strip + 5 tablets (15 tablets)';
    expect(sale.bill.billItems[0]).toMatchObject({ quantity: 15, quantityText: words });
    expect(db.items[0].description).toContain(words);
    const s = await surfaces();
    expect(s.ledger.entries[0]!.quantityText).toBe(words);
    expect(s.stock.currentStock).toBe(85);
  });

  it('a strip line and a loose line of the same batch reconcile to one stock figure', async () => {
    wire(100);
    const sale = await sell([
      { drugBatchId: 'b1', quantity: 1, saleUnit: 'pack' },
      { drugBatchId: 'b1', quantity: 5, saleUnit: 'loose' },
    ]);
    expect(sale.bill.billItems.map((i: any) => [i.quantity, i.quantityText])).toEqual([
      [10, '1 strip (10 tablets)'], [5, '5 tablets (loose)'],
    ]);
    expect(db.moves.map((m) => m.quantity)).toEqual([-10, -5]);
    expect(db.batch.quantityInStock).toBe(85);
    const s = await surfaces();
    expect(s.ledger.summary.closingStock).toBe(85);
    expect(s.ledger.summary.openingStock).toBe(100);
  });

  it('two lines of one batch cannot together take more than it holds', async () => {
    wire(12);
    await expect(sell([
      { drugBatchId: 'b1', quantity: 1, saleUnit: 'pack' },
      { drugBatchId: 'b1', quantity: 5, saleUnit: 'loose' },
    ])).rejects.toThrow(
      'Insufficient stock for Dolo 650. Available: 1 strip + 2 tablets (12 tablets) (1 strip (10 tablets) already on this bill), requested: 5 tablets (loose)',
    );
    expect(db.batch.quantityInStock).toBe(12);
    expect(db.items).toHaveLength(0);
  });
});

describe('345 — the clamp', () => {
  it('says the stock in the words the stock list uses', async () => {
    wire(45);
    await expect(sell([{ drugBatchId: 'b1', quantity: 5, saleUnit: 'pack' }])).rejects.toThrow(
      'Insufficient stock for Dolo 650. Available: 4 strips + 5 tablets (45 tablets), requested: 5 strips (50 tablets)',
    );
    const s = await surfaces();
    expect(s.stock.currentStockText).toBe('4 strips + 5 tablets (45 tablets)');
  });

  it('does not round half a strip up to a whole one', async () => {
    wire(100);
    await expect(sell([{ drugBatchId: 'b1', quantity: 1.5, saleUnit: 'pack' }])).rejects.toThrow(
      /whole number of strips.*sell it by the tablet/,
    );
    expect(db.batch.quantityInStock).toBe(100);
  });

  it('keeps a bottle simple — no packs, no "loose"', async () => {
    wire(12, { drugName: 'Ascoril', dosageForm: 'syrup', packSize: null, looseUnitLabel: null, unitOfMeasurement: 'Bottle (UQC BTL)' });
    const sale = await sell([{ drugBatchId: 'b1', quantity: 2, saleUnit: 'pack' }]);
    expect(sale.bill.billItems[0]).toMatchObject({ quantity: 2, quantityText: '2 bottles' });
    const s = await surfaces();
    expect(s.ledger.entries[0]!.quantityText).toBe('2 bottles');
    expect(s.stock.currentStockText).toBe('10 bottles');
  });
});

describe('345 — returns', () => {
  it('three tablets back from two strips: stock, ledger, slip and credit note agree', async () => {
    wire(100);
    await sell([{ drugBatchId: 'b1', quantity: 2, saleUnit: 'pack' }]);
    const rec = db.records[0];

    const pick = await getReturnableDispenses(T, { patientId: 'p1' });
    expect(pick.items[0]).toMatchObject({ remaining: 20, remainingText: '2 strips (20 tablets)' });

    await createReturn(T, U, ['pharmacist'], { returnType: 'patient_return', dispensingRecordId: rec.id, quantity: 3 } as any);
    const words = '3 tablets (loose)';
    expect(db.batch.quantityInStock).toBe(83);
    expect(db.returns[0]).toMatchObject({ quantity: 3, refundAmount: 6.3 });

    const slip = await getReturnById(T, db.returns[0].id);
    expect((slip.return as any).quantityText).toBe(words);

    // Credit note: 3/20 of the line, its own rate, its own words.
    const cn = db.notes[0].items[0];
    expect(cn).toMatchObject({ quantity: -3, taxPercent: 5, quantityText: words });
    expect(cn.description).toContain('returned 3 tablets (loose) of 2 strips (20 tablets)');

    const s = await surfaces();
    expect(s.ledger.entries[0]).toMatchObject({ movementType: 'patient_return', quantityIn: 3, quantityText: words, balance: 83 });
    expect(s.ledger.entries[0]!.balanceText).toBe(s.stock.currentStockText);
    expect(s.stock.currentStockText).toBe('8 strips + 3 tablets (83 tablets)');

    const left = await getReturnableDispenses(T, { patientId: 'p1' });
    expect(left.items[0]!.remainingText).toBe('1 strip + 7 tablets (17 tablets)');
    await expect(
      createReturn(T, U, ['pharmacist'], { returnType: 'patient_return', dispensingRecordId: rec.id, quantity: 18 } as any),
    ).rejects.toThrow('Cannot return 1 strip + 8 tablets (18 tablets) — only 1 strip + 7 tablets (17 tablets) of 2 strips (20 tablets)');
  });

  it('a counter return of two strips restocks twenty tablets, not two', async () => {
    wire(80);
    await createReturn(T, U, ['pharmacist'], {
      returnType: 'counter_return', drugId: 'd1', drugBatchId: 'b1', quantity: 2, saleUnit: 'pack',
    } as any);
    expect(db.returns[0].quantity).toBe(20);
    expect(db.batch.quantityInStock).toBe(100);
    expect(db.moves[0]).toMatchObject({ movementType: 'counter_return', quantity: 20 });
  });

  // QA retest: a vendor return of 2 strips took 2 tablets off the shelf.
  it('a vendor return counts packs as tablets, and no unit still means tablets', async () => {
    const vendor = async (over: object, stock = 165) => {
      wire(stock);
      (prisma.supplier.findFirst as any).mockResolvedValue({ id: 's1', tenantId: T });
      await createReturn(T, U, ['pharmacy_admin'], {
        returnType: 'vendor_return', drugBatchId: 'b1', supplierId: 's1', quantity: 2, ...over,
      } as any);
      return { row: db.returns.at(-1), stock: db.batch.quantityInStock };
    };
    let r = await vendor({ saleUnit: 'pack' });
    expect(r.row).toMatchObject({ quantity: 20, saleUnit: 'pack' });
    expect(r.stock).toBe(145);
    r = await vendor({ saleUnit: 'loose' });
    expect(r.row).toMatchObject({ quantity: 2, saleUnit: 'loose' });
    expect(r.stock).toBe(163);
    r = await vendor({});
    expect(r.row.quantity).toBe(2);
    expect(r.stock).toBe(163);
    // 2 strips is 20 tablets: more than the 15 on the shelf.
    await expect(vendor({ saleUnit: 'pack' }, 15)).rejects.toThrow(/Cannot return 2 strips \(20 tablets\)/);
  });

  it('a patient return counted in packs is bounded and refunded in tablets', async () => {
    wire(100);
    const sale = await sell([{ drugBatchId: 'b1', quantity: 2, saleUnit: 'pack' }]);
    const rec = db.dispenses?.[0] ?? (await getReturnableDispenses(T, { patientId: 'p1' })).items[0];
    expect(sale).toBeTruthy();
    await expect(
      createReturn(T, U, ['pharmacist'], { returnType: 'patient_return', dispensingRecordId: rec.id, quantity: 3, saleUnit: 'pack' } as any),
    ).rejects.toThrow(/Cannot return 3 strips \(30 tablets\)/);
    await createReturn(T, U, ['pharmacist'], { returnType: 'patient_return', dispensingRecordId: rec.id, quantity: 1, saleUnit: 'pack' } as any);
    expect(db.returns.at(-1).quantity).toBe(10);
    expect(db.batch.quantityInStock).toBe(90);
  });

  it('a loose counter return, and a bottle, restock exactly what was typed', async () => {
    wire(80);
    await createReturn(T, U, ['pharmacist'], { returnType: 'counter_return', drugId: 'd1', drugBatchId: 'b1', quantity: 2, saleUnit: 'loose' } as any);
    expect(db.batch.quantityInStock).toBe(82);
    wire(10, { packSize: null, looseUnitLabel: null, unitOfMeasurement: 'Bottle' });
    await createReturn(T, U, ['pharmacist'], { returnType: 'counter_return', drugId: 'd1', drugBatchId: 'b1', quantity: 2, saleUnit: 'pack' } as any);
    expect(db.batch.quantityInStock).toBe(12);
  });

  it('a reprint keeps the words it was sold in after the pack size changes', async () => {
    wire(100);
    const sale = await sell([{ drugBatchId: 'b1', quantity: 2, saleUnit: 'pack' }]);
    db.drug.packSize = 15;
    const again: any = await getPharmacySale(T, sale.bill.id);
    expect(again.bill.billItems[0].quantityText).toBe('2 strips (20 tablets)');
    // Stock follows the drug as it is now.
    expect((await surfaces()).stock.currentStockText).toBe('5 strips + 5 tablets (80 tablets)');
  });

  it('a void puts the same base units back and the ledger reverses the sale', async () => {
    wire(100);
    const sale = await sell([{ drugBatchId: 'b1', quantity: 15, saleUnit: 'loose' }]);
    await cancelPharmacySale(T, U, sale.bill.id, { reason: 'wrong item' } as any);
    expect(db.batch.quantityInStock).toBe(100);
    const cn = db.notes[0].items[0];
    expect(cn).toMatchObject({ quantity: -15, quantityText: '1 strip + 5 tablets (15 tablets)' });
    const s = await surfaces();
    expect(s.ledger.entries.map((e) => [e.movementType, e.quantityText])).toEqual(
      expect.arrayContaining([
        ['sale', '1 strip + 5 tablets (15 tablets)'], ['sale_cancel', '1 strip + 5 tablets (15 tablets)'],
      ]),
    );
    expect(s.ledger.summary.closingStock).toBe(100);
  });
});
