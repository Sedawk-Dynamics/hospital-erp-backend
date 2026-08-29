import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getControlledRegister } from '../../../../src/modules/pharmacy/controlled-register.service';

/**
 * The register is what a drug inspector reads, so the properties that matter
 * are: every movement appears exactly once, the running balance is arithmetic
 * an auditor can follow line by line, and a transfer never looks like stock
 * appearing or disappearing.
 */

const TENANT = 'tenant-1';
const DRUG = 'drug-1';

const DRUGS = [{
  id: DRUG, drugName: 'Morphine 10mg', composition: 'Morphine', genericName: 'Morphine (10mg)',
  strength: '10mg', schedule: 'H1', controlledClass: 'narcotic',
}];

/** Live stock, which the opening balance is derived backwards from. */
const setLiveStock = (n: number) =>
  (prisma.$queryRawUnsafe as any).mockResolvedValue([{ live: n }]);

const noMovementSince = () => {
  (prisma.drugBatch.aggregate as any).mockResolvedValue({ _sum: { quantityReceived: 0 } });
  (prisma.dispensingRecord.aggregate as any).mockResolvedValue({ _sum: { quantityDispensed: 0 } });
  (prisma.drugReturn.aggregate as any).mockResolvedValue({ _sum: { quantity: 0 } });
  (prisma.ndpsTransaction.aggregate as any).mockResolvedValue({ _sum: { quantity: 0 } });
  (prisma.stockTransfer.aggregate as any).mockResolvedValue({ _sum: { quantityTransferred: 0 } });
  (prisma.wardStockLedger.groupBy as any).mockResolvedValue([]);
};

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.drugFormulary.findMany as any).mockResolvedValue(DRUGS);
  (prisma.drugBatch.findMany as any).mockResolvedValue([]);
  (prisma.drugReturn.findMany as any).mockResolvedValue([]);
  (prisma.dispensingRecord.findMany as any).mockResolvedValue([]);
  (prisma.ndpsTransaction.findMany as any).mockResolvedValue([]);
  (prisma.auditLog.findMany as any).mockResolvedValue([]);
  (prisma.user.findMany as any).mockResolvedValue([]);
  (prisma.patient.findMany as any).mockResolvedValue([]);
  (prisma.ndpsLocation.findMany as any).mockResolvedValue([]);
  (prisma.stockTransfer.findMany as any).mockResolvedValue([]);
  (prisma.wardStockLedger.findMany as any).mockResolvedValue([]);
  (prisma.ward.findMany as any).mockResolvedValue([]);
  setLiveStock(0);
  noMovementSince();
});


/**
 * drugBatch.findMany serves three different questions here: the receipts inside
 * the window, the batches an audit row points at, and the batches a ward row
 * points at. Only the first is a movement, and the receipts query is the one
 * carrying a createdAt window — so route on that rather than handing the same
 * array to all three and turning a lookup into a phantom receipt.
 */
const mockBatchLookups = (rows: unknown[]) =>
  (prisma.drugBatch.findMany as any).mockImplementation((args: any) =>
    args?.where?.createdAt ? [] : rows);

describe('scope', () => {
  it('covers controlled stock, never the whole formulary', async () => {
    await getControlledRegister(TENANT, {});
    const where = (prisma.drugFormulary.findMany as any).mock.calls[0][0].where;
    // An unfiltered run must still be a CONTROLLED-drug register.
    expect(where.OR).toBeDefined();
    expect(JSON.stringify(where.OR)).toMatch(/controlledClass|isNarcotic|vaultControlled/);
  });

  it('narrows to the NDPS list when asked', async () => {
    await getControlledRegister(TENANT, { scheduleType: 'NDPS' });
    const where = (prisma.drugFormulary.findMany as any).mock.calls[0][0].where;
    expect(JSON.stringify(where.OR)).not.toMatch(/schedule/);
  });

  it('narrows to a single schedule code', async () => {
    await getControlledRegister(TENANT, { scheduleType: 'X' });
    expect((prisma.drugFormulary.findMany as any).mock.calls[0][0].where.schedule).toBe('X');
  });

  it('returns an empty register rather than failing when no drug qualifies', async () => {
    (prisma.drugFormulary.findMany as any).mockResolvedValue([]);
    const r = await getControlledRegister(TENANT, {});
    expect(r.rows).toEqual([]);
    expect(r.summary.closingBalance).toBe(0);
  });
});

describe('movements', () => {
  it('reads a Form 3C receipt from the batch it created, not twice', async () => {
    // Form 3C inward creates a DrugBatch, so counting the NdpsTransaction too
    // would double every narcotic receipt.
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', drugId: DRUG, batchNumber: '3C-991', expiryDate: new Date('2028-05-31'),
        quantityReceived: 10, quantityInStock: 10, createdAt: new Date('2026-08-01'), supplier: null },
    ]);
    const r = await getControlledRegister(TENANT, {});
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].txnType).toBe('Form 3C Inward');
    expect(r.rows[0].qtyIn).toBe(10);

    const ndpsWhere = (prisma.ndpsTransaction.findMany as any).mock.calls[0][0].where;
    expect(ndpsWhere.entryType.in).not.toContain('inward');
  });

  it('labels an ordinary vendor receipt as a GRN', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', drugId: DRUG, batchNumber: 'FEN-B901', expiryDate: new Date('2028-05-31'),
        quantityReceived: 10, quantityInStock: 10, createdAt: new Date('2026-08-01'),
        supplier: { name: 'Acme Distributors' } },
    ]);
    const r = await getControlledRegister(TENANT, {});
    expect(r.rows[0].txnType).toBe('Receipt (GRN)');
    expect(r.rows[0].patientOrDept).toBe('Acme Distributors');
  });

  it('shows the prescriber and the witness on a dispense', async () => {
    (prisma.dispensingRecord.findMany as any).mockResolvedValue([
      {
        id: 'd1', billId: 'bill-1234', dispensedAt: new Date('2026-08-02'), quantityDispensed: 2,
        drugBatch: { batchNumber: 'FEN-B901', expiryDate: new Date('2028-05-31'), drugId: DRUG },
        patient: { mrn: 'IPD-907', firstName: 'Kumar', lastName: '' },
        dispenser: { firstName: 'Asha', lastName: 'R' },
        witness: { firstName: 'Priyam', lastName: 'N' },
        externalPrescription: null,
        prescription: { doctor: { licenseNumber: 'NMC-9875', user: { firstName: 'Gaur', lastName: '' } } },
      },
    ]);
    const r = await getControlledRegister(TENANT, {});
    expect(r.rows[0]).toMatchObject({
      txnType: 'Patient Disp.', qtyOut: 2,
      patientOrDept: 'Kumar (IPD-907)', prescriber: 'Gaur, NMC-9875', verification: 'Priyam N',
    });
  });

  it('takes the prescriber from an outside prescription when there is one', async () => {
    (prisma.dispensingRecord.findMany as any).mockResolvedValue([
      {
        id: 'd1', billId: null, dispensedAt: new Date('2026-08-02'), quantityDispensed: 1,
        drugBatch: { batchNumber: 'B1', expiryDate: null, drugId: DRUG },
        patient: null, dispenser: { firstName: 'Asha', lastName: '' }, witness: null,
        externalPrescription: { prescriberName: 'A. Gaur', prescriberRegNo: '9875' },
        prescription: null,
      },
    ]);
    const r = await getControlledRegister(TENANT, {});
    expect(r.rows[0].prescriber).toBe('A. Gaur, 9875');
    // Falls back to the dispenser when nobody witnessed it.
    expect(r.rows[0].verification).toBe('Asha');
  });

  it('reports a transfer in its own column, never as stock lost', async () => {
    (prisma.ndpsTransaction.findMany as any).mockResolvedValue([
      { id: 't1', drugFormularyId: DRUG, entryType: 'transfer', quantity: 5,
        occurredAt: new Date('2026-08-03'), fromLocationId: 'L1', toLocationId: 'L2',
        batchNumber: null, expiryDate: null, recordedById: 'u1', counterpartyId: 'u2',
        coSignById: null, patientId: null, doctorRegNo: null },
    ]);
    (prisma.ndpsLocation.findMany as any).mockResolvedValue([
      { id: 'L1', name: 'Central Vault' }, { id: 'L2', name: 'OT Cart' },
    ]);
    (prisma.user.findMany as any).mockResolvedValue([
      { id: 'u1', firstName: 'A', lastName: '' }, { id: 'u2', firstName: 'B', lastName: '' },
    ]);
    setLiveStock(100);

    const r = await getControlledRegister(TENANT, {});
    expect(r.rows[0]).toMatchObject({ txnType: 'Internal Transfer', transferQty: 5, qtyOut: 0, qtyIn: 0 });
    expect(r.rows[0].patientOrDept).toBe('Central Vault → OT Cart');
    // Hospital-wide a transfer nets to zero, so the balance must not move.
    expect(r.summary.closingBalance).toBe(r.summary.openingStock);
  });
});

describe('opening-balance batches are not receipts', () => {
  /** The prefixes of batches that stand for something other than a receipt. */
  const excludedPrefixes = (where: any): string[] =>
    (where.NOT?.OR ?? []).map((c: any) => c.batchNumber.startsWith);

  it('excludes synthetic batches from the ledger', async () => {
    // NDPS-OPENING stands for stock the hospital ALREADY held, dated the day the
    // migration ran; QUAR- holds a controlled return the return row already
    // records. Counted as receipts, the first pushes the opening balance
    // negative — the exact symptom seen on real data — and the second shows the
    // same stock coming back twice.
    await getControlledRegister(TENANT, {});
    const prefixes = excludedPrefixes((prisma.drugBatch.findMany as any).mock.calls[0][0].where);
    expect(prefixes).toContain('NDPS-OPENING-');
    expect(prefixes).toContain('QUAR-');
  });

  it('excludes them from the balance walk-back too', async () => {
    await getControlledRegister(TENANT, {});
    const prefixes = excludedPrefixes((prisma.drugBatch.aggregate as any).mock.calls[0][0].where);
    expect(prefixes).toContain('NDPS-OPENING-');
    expect(prefixes).toContain('QUAR-');
  });

  it('never reports a negative opening balance from ordinary movement', async () => {
    setLiveStock(50);
    (prisma.drugBatch.aggregate as any).mockResolvedValue({ _sum: { quantityReceived: 20 } });
    (prisma.dispensingRecord.aggregate as any).mockResolvedValue({ _sum: { quantityDispensed: 5 } });
    const r = await getControlledRegister(TENANT, {});
    // 50 now, +20 −5 since the window opened ⇒ it opened at 35.
    expect(r.summary.openingStock).toBe(35);
  });
});

describe('running balance', () => {
  it('walks opening → closing so an auditor can follow it line by line', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', drugId: DRUG, batchNumber: 'B1', expiryDate: null, quantityReceived: 10,
        quantityInStock: 10, createdAt: new Date('2026-08-01T10:00:00Z'), supplier: null },
    ]);
    (prisma.dispensingRecord.findMany as any).mockResolvedValue([
      { id: 'd1', billId: null, dispensedAt: new Date('2026-08-02T10:00:00Z'), quantityDispensed: 3,
        drugBatch: { batchNumber: 'B1', expiryDate: null, drugId: DRUG },
        patient: null, dispenser: null, witness: null, externalPrescription: null, prescription: null },
    ]);
    setLiveStock(27);
    // 27 now, +10 −3 inside the window ⇒ the window opened at 20.
    (prisma.drugBatch.aggregate as any).mockResolvedValue({ _sum: { quantityReceived: 10 } });
    (prisma.dispensingRecord.aggregate as any).mockResolvedValue({ _sum: { quantityDispensed: 3 } });

    const r = await getControlledRegister(TENANT, {});
    expect(r.summary.openingStock).toBe(20);
    expect(r.rows[0]).toMatchObject({ opening: 20, qtyIn: 10, closing: 30 });
    expect(r.rows[1]).toMatchObject({ opening: 30, qtyOut: 3, closing: 27 });
    // The closing balance has to land back on what is actually on the shelf.
    expect(r.summary.closingBalance).toBe(27);
  });

  it('orders the ledger chronologically, whatever order the sources returned', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', drugId: DRUG, batchNumber: 'B1', expiryDate: null, quantityReceived: 5,
        quantityInStock: 5, createdAt: new Date('2026-08-05'), supplier: null },
    ]);
    (prisma.dispensingRecord.findMany as any).mockResolvedValue([
      { id: 'd1', billId: null, dispensedAt: new Date('2026-08-01'), quantityDispensed: 1,
        drugBatch: { batchNumber: 'B1', expiryDate: null, drugId: DRUG },
        patient: null, dispenser: null, witness: null, externalPrescription: null, prescription: null },
    ]);
    const r = await getControlledRegister(TENANT, {});
    expect(r.rows.map((x) => x.txnType)).toEqual(['Patient Disp.', 'Receipt (GRN)']);
  });
});

describe('filters', () => {
  beforeEach(() => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', drugId: DRUG, batchNumber: 'FEN-B901', expiryDate: null, quantityReceived: 10,
        quantityInStock: 10, createdAt: new Date('2026-08-01'), supplier: null },
    ]);
    (prisma.dispensingRecord.findMany as any).mockResolvedValue([
      { id: 'd1', billId: null, dispensedAt: new Date('2026-08-02'), quantityDispensed: 2,
        drugBatch: { batchNumber: 'OTHER-1', expiryDate: null, drugId: DRUG },
        patient: { mrn: 'IPD-907', firstName: 'Kumar', lastName: '' },
        dispenser: null, witness: null, externalPrescription: null, prescription: null },
    ]);
  });

  it('finds a row by batch number', async () => {
    const r = await getControlledRegister(TENANT, { search: 'FEN-B901' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].batchNumber).toBe('FEN-B901');
  });

  it('finds a row by patient MRN', async () => {
    const r = await getControlledRegister(TENANT, { search: 'IPD-907' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].txnType).toBe('Patient Disp.');
  });

  it('splits inward from outward', async () => {
    expect((await getControlledRegister(TENANT, { reportType: 'inward' })).rows).toHaveLength(1);
    expect((await getControlledRegister(TENANT, { reportType: 'outward' })).rows).toHaveLength(1);
    expect((await getControlledRegister(TENANT, { reportType: 'transfer' })).rows).toHaveLength(0);
  });

  it('prints the active ingredient, which is what an inspector cross-references', async () => {
    const r = await getControlledRegister(TENANT, {});
    expect(r.rows[0].apiStrength).toBe('Morphine 10mg');
  });
});

describe('a stock-transfer dispatch really does leave the pharmacy', () => {
  /**
   * The two kinds of transfer behave differently and the balance has to know.
   *
   * An NDPS challan moved NdpsStockBalance between locations and never touched
   * a batch, so it changes nothing here. A stock-transfer dispatch decrements
   * quantityInStock — the stock left the pool this balance is over. Treating
   * both as weightless put the opening balance out by exactly the amount
   * transferred: on a live run it came back as MINUS FIVE, which is not a
   * number a register can print.
   */
  const dispatched = (qty: number) => [{
    id: 'st-1', transferNumber: 'ST-1', quantityTransferred: qty, quantityRequested: qty,
    dispatchedAt: new Date('2026-08-10T09:00:00Z'), createdAt: new Date('2026-08-10T09:00:00Z'),
    fromLocation: 'Pharmacy', toLocation: null, fromDepartment: null,
    toDepartment: { name: 'ICU' },
    custodian: { firstName: 'Nurse', lastName: 'One' },
    dispatcher: { firstName: 'Pharm', lastName: 'Admin' },
    drugBatch: { drugId: DRUG, batchNumber: 'B1', expiryDate: new Date('2027-01-01') },
  }];

  it('subtracts the dispatch from the balance while showing it as a transfer', async () => {
    setLiveStock(95); // 100 received, 5 dispatched away
    (prisma.drugBatch.aggregate as any).mockResolvedValue({ _sum: { quantityReceived: 100 } });
    (prisma.stockTransfer.aggregate as any).mockResolvedValue({ _sum: { quantityTransferred: 5 } });
    (prisma.stockTransfer.findMany as any).mockResolvedValue(dispatched(5));
    (prisma.drugBatch.findMany as any).mockResolvedValue([{
      id: 'b1', drugId: DRUG, batchNumber: 'B1', quantityReceived: 100,
      expiryDate: new Date('2027-01-01'), createdAt: new Date('2026-08-09T09:00:00Z'),
      supplier: { name: 'Acme' },
    }]);

    const r = await getControlledRegister(TENANT, { fromDate: '2026-08-01', toDate: '2026-08-31' });

    // The opening balance must be possible.
    expect(r.summary.openingStock).toBe(0);
    expect(r.summary.openingStock).toBeGreaterThanOrEqual(0);
    // It is still presented as custody, not as stock dispensed.
    const xfer = r.rows.find((x) => x.txnType === 'Internal Transfer')!;
    expect(xfer.transferQty).toBe(5);
    expect(xfer.qtyOut).toBe(0);
    // But the balance felt it leave, and closing matches live stock.
    expect(r.summary.transferredOut).toBe(5);
    expect(r.summary.closingBalance).toBe(95);
    expect(
      r.summary.openingStock + r.summary.inward - r.summary.outward - r.summary.transferredOut,
    ).toBe(r.summary.closingBalance);
  });

  it('leaves an NDPS challan weightless, because it never touched a batch', async () => {
    setLiveStock(100);
    (prisma.drugBatch.aggregate as any).mockResolvedValue({ _sum: { quantityReceived: 100 } });
    (prisma.ndpsTransaction.findMany as any).mockResolvedValue([{
      id: 'ndps-1', drugFormularyId: DRUG, entryType: 'transfer', quantity: 5,
      occurredAt: new Date('2026-08-10T09:00:00Z'), batchNumber: 'B1',
      expiryDate: new Date('2027-01-01'), fromLocationId: 'v1', toLocationId: 'icu',
      recordedById: 'u1', counterpartyId: 'u2', patientId: null, doctorRegNo: null,
    }]);
    (prisma.drugBatch.findMany as any).mockResolvedValue([{
      id: 'b1', drugId: DRUG, batchNumber: 'B1', quantityReceived: 100,
      expiryDate: new Date('2027-01-01'), createdAt: new Date('2026-08-09T09:00:00Z'),
      supplier: { name: 'Acme' },
    }]);

    const r = await getControlledRegister(TENANT, { fromDate: '2026-08-01', toDate: '2026-08-31' });

    expect(r.summary.internalTransfer).toBe(5);
    expect(r.summary.transferredOut).toBe(0); // nothing left the pharmacy
    expect(r.summary.closingBalance).toBe(100);
  });
});


/**
 * A ward shelf is a second inventory, and the register had never been told
 * about it. Stock leaves the pharmacy's batch and is given to patients from the
 * ward, and none of it writes a DispensingRecord — so a Schedule H1
 * psychotropic could be handed over at a bedside and appear nowhere on the
 * register. A vault narcotic never reaches that path, which is why it held.
 */
describe('ward movements', () => {
  const wardRow = (over: Record<string, unknown> = {}) => ({
    id: 'wl-000001-aaaa', tenantId: TENANT, wardId: 'ward-1', drugId: DRUG,
    drugBatchId: 'batch-1', movementType: 'dispensed', quantity: 5,
    patientId: 'pat-1', admissionId: null, billId: 'bill-1', performedBy: 'user-1',
    reason: null, createdAt: new Date('2026-08-20T06:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    (prisma.ward.findMany as any).mockResolvedValue([{ id: 'ward-1', name: 'ICU 1' }]);
    mockBatchLookups([{ id: 'batch-1', batchNumber: 'MOR-9', expiryDate: new Date('2027-01-31'), drugId: DRUG }]);
    (prisma.patient.findMany as any).mockResolvedValue([
      { id: 'pat-1', mrn: 'MRN-7', firstName: 'A', lastName: 'B' },
    ]);
  });

  it('shows a dose given from a ward shelf, naming the patient', async () => {
    (prisma.wardStockLedger.findMany as any).mockResolvedValue([wardRow()]);
    const out = await getControlledRegister(TENANT, {});
    const row = out.rows.find((r) => r.txnType === 'Ward Admin.');
    expect(row).toBeDefined();
    expect(row!.qtyOut).toBe(5);
    expect(row!.patientOrDept).toContain('MRN-7');
  });

  it('does not take a ward dose off the balance twice', async () => {
    // The stock left the pharmacy's batch when it was ISSUED to the ward.
    // Counting the dose against the batch too would remove it a second time.
    (prisma.wardStockLedger.findMany as any).mockResolvedValue([wardRow()]);
    setLiveStock(100);
    const out = await getControlledRegister(TENANT, {});
    expect(out.rows.find((r) => r.txnType === 'Ward Admin.')!.stockDelta).toBe(0);
    expect(out.summary.closingBalance).toBe(out.summary.openingStock);
  });

  it('counts an issue to a ward as stock leaving the pharmacy', async () => {
    (prisma.wardStockLedger.findMany as any).mockResolvedValue([
      wardRow({ movementType: 'received', quantity: 30, patientId: null, billId: null }),
    ]);
    const out = await getControlledRegister(TENANT, {});
    const row = out.rows.find((r) => r.txnType === 'Ward Issue')!;
    // Shown as custody moving, but it really did leave the dispensable pool.
    expect(row.transferQty).toBe(30);
    expect(row.stockDelta).toBe(-30);
    expect(row.qtyOut).toBe(0);
  });

  it('puts a ward return back', async () => {
    (prisma.wardStockLedger.findMany as any).mockResolvedValue([
      wardRow({ movementType: 'returned', quantity: 8, patientId: null, billId: null }),
    ]);
    const out = await getControlledRegister(TENANT, {});
    const row = out.rows.find((r) => r.txnType === 'Ward Return')!;
    expect(row.qtyIn).toBe(8);
    expect(row.stockDelta).toBe(8);
  });

  it('walks the opening balance back over ward issues, so a move today does not rewrite last week', async () => {
    // The opening balance is derived — today's stock less everything that has
    // moved since. A ward issue that is not in that set silently changes what
    // the register says the hospital held before the window opened.
    setLiveStock(70);
    (prisma.wardStockLedger.groupBy as any).mockResolvedValue([
      { movementType: 'received', _sum: { quantity: 30 } },
    ]);
    const out = await getControlledRegister(TENANT, {});
    expect(out.summary.openingStock).toBe(100);
  });
});

/**
 * Count corrections were shown as rows but were missing from the walk-back that
 * derives the opening balance, so the closing balance came out wrong by exactly
 * the net correction.
 */
describe('stock corrections', () => {
  it('counts a correction when deriving the opening balance', async () => {
    setLiveStock(94);
    (prisma.auditLog.findMany as any).mockResolvedValue([
      { id: 'a1', entityId: 'batch-1', createdAt: new Date('2026-08-20T06:00:00Z'),
        newValues: { type: 'stock_adjustment', delta: -6, reason: 'spillage' } },
    ]);
    mockBatchLookups([{ id: 'batch-1', batchNumber: 'MOR-9', expiryDate: new Date('2027-01-31'), drugId: DRUG }]);
    const out = await getControlledRegister(TENANT, {});
    // 100 before the spillage, 94 on the shelf now.
    expect(out.summary.openingStock).toBe(100);
    // And the closing balance is the stock actually there.
    expect(out.summary.closingBalance).toBe(94);
  });

  it('ignores a correction to some other drug', async () => {
    setLiveStock(50);
    (prisma.auditLog.findMany as any).mockResolvedValue([
      { id: 'a1', entityId: 'batch-elsewhere', createdAt: new Date('2026-08-20T06:00:00Z'),
        newValues: { type: 'stock_adjustment', delta: -6 } },
    ]);
    // The batch lookup is scoped to the drugs in this report and finds nothing.
    mockBatchLookups([]);
    const out = await getControlledRegister(TENANT, {});
    expect(out.summary.openingStock).toBe(50);
  });
});
