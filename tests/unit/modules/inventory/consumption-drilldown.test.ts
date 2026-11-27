import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';

vi.mock('../../../../src/modules/inventory/inventory.reports.service', () => ({
  getExpiryWasteReport: vi.fn().mockResolvedValue({ summary: {}, expiringBatches: [] }),
  getDepartmentConsumptionReport: vi.fn().mockResolvedValue({ departments: [] }),
}));
vi.mock('../../../../src/modules/inventory/stock-valuation.service', () => ({
  getStockValuation: vi.fn().mockResolvedValue({
    basis: 'purchase_cost', basisLabel: '', asOf: '', itemCount: 0, units: 0, costValue: 0, retailValue: 0, byCategory: [],
  }),
}));

import {
  getInventoryDetailedReport,
  getConsumptionTransactions,
} from '../../../../src/modules/inventory/inventory.detailed-report.service';
import { resetDrugStockMovementProbe } from '../../../../src/modules/pharmacy/pharmacy.stock-movement';

const TENANT = 'tenant-1';
const DRUG = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const range = { fromDate: '2026-11-01', toDate: '2026-11-20' };
const at = (d: string) => new Date(`${d}T06:00:00Z`);

// Gap 349: Top consumed items must open their supporting transactions, and the
// rows must reconcile to the aggregate for the same filters.
describe('Inventory Detailed Analysis — consumption drill-down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDrugStockMovementProbe(true);
    const moves = [
      { id: 'm1', drugId: DRUG, drugBatchId: 'b1', movementType: 'sale', quantity: -3, unitCost: 1.25, referenceType: 'pharmacy_sale', referenceId: 'bill-1', notes: 'PH-20261110-0001', party: null, createdAt: at('2026-11-10') },
      { id: 'm2', drugId: DRUG, drugBatchId: 'b2', movementType: 'transfer_out', quantity: -4, unitCost: 2, referenceType: 'stock_transfer', referenceId: 'tr-1', notes: 'TRF-0001', party: 'Ward A', createdAt: at('2026-11-11') },
      { id: 'm3', drugId: DRUG, drugBatchId: 'b1', movementType: 'sale', quantity: -1, unitCost: null, referenceType: 'pharmacy_sale', referenceId: 'bill-2', notes: null, party: null, createdAt: at('2026-11-12') },
      // Not consumption: a correction, a receipt and a voided sale put back.
      { id: 'm4', drugId: DRUG, drugBatchId: 'b1', movementType: 'adjustment', quantity: -1, unitCost: 1, referenceType: 'stock_adjustment', referenceId: 'b1', notes: null, party: null, createdAt: at('2026-11-12') },
      { id: 'm5', drugId: DRUG, drugBatchId: 'b1', movementType: 'receipt', quantity: 10, unitCost: 1, referenceType: 'drug_batch', referenceId: 'b1', notes: null, party: null, createdAt: at('2026-11-02') },
    ];
    (prisma.drugStockMovement.findMany as any).mockResolvedValue(moves);
    (prisma.drugFormulary.findMany as any).mockResolvedValue([{ id: DRUG, drugName: 'Paracetamol 500 mg', category: 'tablet' }]);
    (prisma.drugFormulary.findFirst as any).mockResolvedValue({ drugName: 'Paracetamol 500 mg' });
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', batchNumber: 'BN-1' },
      { id: 'b2', batchNumber: 'BN-2' },
    ]);
    (prisma.bill.findMany as any).mockResolvedValue([
      { id: 'bill-1', billNumber: 'PH-20261110-0001' },
      { id: 'bill-2', billNumber: 'PH-20261112-0004' },
    ]);
    (prisma.stockTransfer.findMany as any).mockResolvedValue([{ id: 'tr-1', transferNumber: 'TRF-20261111-0001', status: 'received', quantityTransferred: 4 }]);
    (prisma.stockTransaction.findMany as any).mockResolvedValue([
      { id: 't1', transactionType: 'stock_out', quantity: 3, unitCost: 0.333, totalCost: null, createdAt: at('2026-11-05'), batchNumber: 'G-1', referenceType: null, referenceId: null, notes: 'Issued', department: { name: 'OT' }, inventoryItem: { id: ITEM, itemName: 'Gauze', category: 'consumable' } },
      { id: 't2', transactionType: 'stock_out', quantity: 2, unitCost: null, totalCost: 5, createdAt: at('2026-11-06'), batchNumber: null, referenceType: 'stock_transfer', referenceId: 'tr-1', notes: null, department: null, inventoryItem: { id: ITEM, itemName: 'Gauze', category: 'consumable' } },
    ]);
  });

  it('the drug rows reconcile to the Top-consumed aggregate and carry batch/date/document', async () => {
    const report = await getInventoryDetailedReport(TENANT, range);
    const agg = report.topConsumed.find((t) => t.kind === 'drug' && t.refId === DRUG)!;
    expect(agg).toMatchObject({ qty: 8, transactions: 3 });

    const drill = await getConsumptionTransactions(TENANT, { ...range, kind: 'drug', refId: DRUG });
    expect(drill.totals.qty).toBe(agg.qty);
    expect(drill.totals.value).toBe(agg.value);
    expect(drill.rows).toHaveLength(3);
    expect(drill.rows[0]).toMatchObject({ batchNumber: 'BN-1', documentNumber: 'PH-20261110-0001', quantity: 3, value: 3.75 });
    expect(drill.rows[1]).toMatchObject({ batchNumber: 'BN-2', documentNumber: 'TRF-20261111-0001', quantity: 4, value: 8 });
    expect(drill.rows.every((r) => r.date instanceof Date)).toBe(true);
  });

  it('the item rows reconcile to the aggregate too', async () => {
    const report = await getInventoryDetailedReport(TENANT, range);
    const agg = report.topConsumed.find((t) => t.kind === 'item' && t.refId === ITEM)!;
    const drill = await getConsumptionTransactions(TENANT, { ...range, kind: 'item', refId: ITEM });
    expect(drill.totals).toMatchObject({ qty: agg.qty, value: agg.value, transactions: agg.transactions });
    expect(drill.rows[1].documentNumber).toBe('TRF-20261111-0001');
  });
});
