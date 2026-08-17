import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  parseGs1,
  makeInternalBarcode,
  isInternalBarcode,
  gtinVariants,
  isValidGtin,
} from '../../../../src/modules/pharmacy/pharmacy.barcode';
import {
  resolveScan,
  checkSaleCompliance,
  createBatch,
} from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const GS = String.fromCharCode(29);

beforeEach(() => vi.clearAllMocks());

describe('Pharmacy — barcode decoding (GS1 DataMatrix)', () => {
  it('decodes GTIN + expiry + batch from a concatenated element string', () => {
    // (01)08901234567890 (17)280831 (10)CRT8821
    const r = parseGs1('010890123456789017280831' + '10CRT8821');
    expect(r).not.toBeNull();
    expect(r!.gtin).toBe('08901234567890');
    expect(r!.expiryDate).toBe('2028-08-31');
    expect(r!.batchNumber).toBe('CRT8821');
  });

  it('decodes a manufacture date (AI 11) and a GS-delimited variable batch', () => {
    // (11)260601 (10)LOT-9 <GS> (21)SER1
    const r = parseGs1('11260601' + '10LOT-9' + GS + '21SER1');
    expect(r!.manufactureDate).toBe('2026-06-01');
    expect(r!.batchNumber).toBe('LOT-9');
    expect(r!.serial).toBe('SER1');
  });

  it('treats DD=00 as the last day of the month', () => {
    const r = parseGs1('0108901234567890' + '17280200'); // expiry 2028-02-00
    expect(r!.expiryDate).toBe('2028-02-29'); // 2028 is a leap year
  });

  it('strips a leading symbology identifier (]d2)', () => {
    const r = parseGs1(']d2010890123456789017280831');
    expect(r!.gtin).toBe('08901234567890');
  });

  it('returns null for a plain (non-GS1) string', () => {
    expect(parseGs1('JUST-A-BATCH-LABEL')).toBeNull();
    expect(parseGs1('')).toBeNull();
  });

  it('mints a stable internal barcode from a batch id and recognises it', () => {
    const code = makeInternalBarcode('1a2b3c4d-5e6f-7081-9abc-def012345678');
    expect(code).toBe('PHB1A2B3C4D5E6F');
    expect(isInternalBarcode(code)).toBe(true);
    expect(isInternalBarcode('8901234567890')).toBe(false);
  });
});

describe('Pharmacy — GS1 Digital Link (URL / QR)', () => {
  it('decodes GTIN + batch + serial from the path and expiry from the query', () => {
    const r = parseGs1('https://id.gs1.org/01/08901012000014/10/BATCH-A/21/SN123?17=271231');
    expect(r).not.toBeNull();
    expect(r!.gtin).toBe('08901012000014');
    expect(r!.batchNumber).toBe('BATCH-A');
    expect(r!.serial).toBe('SN123');
    expect(r!.expiryDate).toBe('2027-12-31');
  });

  it('ignores a brand-site path prefix before the /01/ primary key', () => {
    const r = parseGs1('https://brand.example.com/products/01/08901012000014/10/L9');
    expect(r!.gtin).toBe('08901012000014');
    expect(r!.batchNumber).toBe('L9');
  });

  it('decodes expiry, mfg and batch all from the query string', () => {
    const r = parseGs1('https://id.gs1.org/01/08901012000014?10=L1&17=281130&11=260101');
    expect(r!.batchNumber).toBe('L1');
    expect(r!.expiryDate).toBe('2028-11-30');
    expect(r!.manufactureDate).toBe('2026-01-01');
  });

  it('percent-decodes qualifier values', () => {
    const r = parseGs1('https://id.gs1.org/01/08901012000014/10/A%2FB%20C');
    expect(r!.batchNumber).toBe('A/B C');
  });

  it('returns null for a URL that carries no GTIN', () => {
    expect(parseGs1('https://example.com/about')).toBeNull();
  });
});

describe('Pharmacy — GTIN normalisation + check digit', () => {
  it('returns both 13- and 14-digit forms so GS1 (14) matches a stored EAN (13)', () => {
    expect(gtinVariants('8901012000014')).toEqual(
      expect.arrayContaining(['8901012000014', '08901012000014']),
    );
    expect(gtinVariants('08901012000014')).toEqual(
      expect.arrayContaining(['08901012000014', '8901012000014']),
    );
  });

  it('validates a correct EAN-13 / GTIN-14 check digit and rejects a typo', () => {
    expect(isValidGtin('8901012000014')).toBe(true); // seeded Crocin GTIN
    expect(isValidGtin('08901012000014')).toBe(true); // same, GTIN-14
    expect(isValidGtin('8901012000015')).toBe(false); // wrong check digit
    expect(isValidGtin('12345')).toBe(false); // wrong length
  });
});

describe('Pharmacy — resolveScan', () => {
  const DRUG = {
    id: 'd1', drugName: 'Crocin Advance 650', genericName: 'Paracetamol', strength: '650mg',
    dosageForm: 'tablet', gtin: '08901234567890', casePackGtin: null, unitsPerCase: null,
    packSize: 15, looseUnitLabel: 'tablet', price: 2, hsnCode: '3004', taxPercent: 12, isRecalled: false,
  };
  const BATCH = {
    id: 'b1', batchNumber: 'CRT8821', expiryDate: new Date('2028-08-31'), manufacturingDate: new Date('2026-06-01'),
    sellingPrice: 3, mrp: 30, quantityInStock: 120, barcode: 'PHBxxxx',
  };

  it('resolves a GS1 scan to drug + the scanned batch + stock', async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue(DRUG);
    (prisma.drugBatch.findFirst as any).mockResolvedValue(BATCH);
    (prisma.drugBatch.aggregate as any).mockResolvedValue({ _sum: { quantityInStock: 200 } });

    const r = await resolveScan(TENANT_ID, '010890123456789017280831' + '10CRT8821');
    expect(r.resolvedVia).toBe('gs1');
    expect(r.drug.id).toBe('d1');
    expect(r.batch?.batchNumber).toBe('CRT8821');
    expect(r.totalStock).toBe(200);
  });

  it('resolves a plain GTIN to the FEFO batch', async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue(DRUG);
    (prisma.drugBatch.findFirst as any).mockResolvedValue(BATCH);
    (prisma.drugBatch.aggregate as any).mockResolvedValue({ _sum: { quantityInStock: 120 } });
    const r = await resolveScan(TENANT_ID, '08901234567890');
    expect(r.resolvedVia).toBe('gtin');
    expect(r.drug.id).toBe('d1');
  });

  it('resolves an internal batch barcode directly to its batch', async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue(null); // no GTIN drug
    (prisma.drugBatch.findFirst as any).mockResolvedValue({ ...BATCH, drug: DRUG });
    (prisma.drugBatch.aggregate as any).mockResolvedValue({ _sum: { quantityInStock: 120 } });
    const r = await resolveScan(TENANT_ID, 'PHB1A2B3C4D5E6F');
    expect(r.drug.id).toBe('d1');
    expect(r.batch?.id).toBe('b1');
  });

  it('throws when nothing matches the scan', async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue(null);
    (prisma.drugBatch.findFirst as any).mockResolvedValue(null);
    await expect(resolveScan(TENANT_ID, 'NOPE-123')).rejects.toThrow('No product matched');
  });

  it('rejects an empty barcode', async () => {
    await expect(resolveScan(TENANT_ID, '  ')).rejects.toThrow('No barcode');
  });
});

describe('Pharmacy — checkSaleCompliance (Schedule H/H1/X + HSN/GST)', () => {
  it('hard-blocks a Schedule X sale with no prescription', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', drug: { drugName: 'Alprazolam', hsnCode: '3004', taxPercent: 12, drugMaster: { schedule: 'X' } } },
    ]);
    const r = await checkSaleCompliance(TENANT_ID, { items: [{ drugBatchId: 'b1' }] });
    expect(r.ok).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/Schedule X/);
  });

  it('allows a Schedule X sale when a prescription is attached', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', drug: { drugName: 'Alprazolam', hsnCode: '3004', taxPercent: 12, drugMaster: { schedule: 'X' } } },
    ]);
    const r = await checkSaleCompliance(TENANT_ID, { items: [{ drugBatchId: 'b1' }], prescriptionId: 'rx1' });
    expect(r.ok).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it('warns (not blocks) for Schedule H without a prescription', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', drug: { drugName: 'Azithromycin', hsnCode: '3004', taxPercent: 12, drugMaster: { schedule: 'H' } } },
    ]);
    const r = await checkSaleCompliance(TENANT_ID, { items: [{ drugBatchId: 'b1' }] });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Schedule H/);
  });

  /**
   * Schedule H2 — the Rule 96(6)-(7) pack check. It is NOT a prescription tier
   * and NOT a rung of the schedule cascade: the notified list holds a pregnancy
   * test and two multivitamins alongside meropenem. So it applies on its own
   * terms, to over-the-counter packs included, and never changes the schedule.
   *
   * Until this existed the flag was classified, filtered and badged, and then
   * nothing at the counter ever read it.
   */
  it('asks for a pack scan on a Schedule H2 formulation', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      {
        id: 'b1',
        drug: {
          drugName: 'Dolo 650', hsnCode: '3004', taxPercent: 12,
          requiresQrScan: true, drugMaster: null,
        },
      },
    ]);
    const r = await checkSaleCompliance(TENANT_ID, { items: [{ drugBatchId: 'b1' }] });
    // Advisory by default — a multivitamin must not be unsellable because
    // nobody scanned it.
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Schedule H2/);
    expect(r.warnings.join(' ')).toMatch(/QR\/barcode/);
  });

  it('stops asking once the counter has scanned the pack', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      {
        id: 'b1',
        drug: {
          drugName: 'Dolo 650', hsnCode: '3004', taxPercent: 12,
          requiresQrScan: true, drugMaster: null,
        },
      },
    ]);
    const r = await checkSaleCompliance(TENANT_ID, {
      items: [{ drugBatchId: 'b1', scannedCode: '8901234567890' }],
    });
    expect(r.warnings.join(' ')).not.toMatch(/Schedule H2/);
  });

  it('says nothing about a drug that is not on the H2 list', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      {
        id: 'b1',
        drug: {
          drugName: 'Paracetamol', hsnCode: '3004', taxPercent: 12,
          requiresQrScan: false, drugMaster: null,
        },
      },
    ]);
    const r = await checkSaleCompliance(TENANT_ID, { items: [{ drugBatchId: 'b1' }] });
    expect(r.warnings.join(' ')).not.toMatch(/H2/);
  });

  it('warns when HSN code or GST rate is missing', async () => {
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', drug: { drugName: 'Vitamin C', hsnCode: null, taxPercent: null, drugMaster: null } },
    ]);
    const r = await checkSaleCompliance(TENANT_ID, { items: [{ drugBatchId: 'b1' }] });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/HSN/);
    expect(r.warnings.join(' ')).toMatch(/GST/);
  });
});

describe('Pharmacy — createBatch mints an internal barcode', () => {
  it('generates a Code-128 internal barcode in the insert when none is supplied', async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', drugName: 'Amox' });
    (prisma.drugBatch.findFirst as any).mockResolvedValue(null); // no duplicate
    const createSpy = (prisma.drugBatch.create as any).mockImplementation((args: any) => ({
      id: args.data.id, barcode: args.data.barcode, batchNumber: 'B1',
    }));

    const r = await createBatch(TENANT_ID, 'user-1', ['pharmacy_admin'], {
      drugId: 'd1', batchNumber: 'B1', expiryDate: '2028-01-01', quantityReceived: 100,
    } as any);

    expect(createSpy.mock.calls[0][0].data.barcode).toMatch(/^PHB/);
    expect(r.barcode).toMatch(/^PHB/);
  });

  it('keeps a supplied (scanned) pack barcode instead of minting one', async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', drugName: 'Amox' });
    (prisma.drugBatch.findFirst as any).mockResolvedValue(null);
    const createSpy = (prisma.drugBatch.create as any).mockImplementation((args: any) => ({
      id: args.data.id, barcode: args.data.barcode, batchNumber: 'B1',
    }));

    await createBatch(TENANT_ID, 'user-1', ['pharmacy_admin'], {
      drugId: 'd1', batchNumber: 'B1', expiryDate: '2028-01-01', quantityReceived: 100, barcode: '8901234567890',
    } as any);

    expect(createSpy.mock.calls[0][0].data.barcode).toBe('8901234567890');
  });
});
