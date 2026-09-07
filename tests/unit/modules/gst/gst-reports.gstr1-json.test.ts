import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { buildGstr1Json, returnPeriod } from '../../../../src/modules/gst/gst-reports.gstr1-json';

const TENANT = 'tenant-1';
const GSTIN = '27AAPFU0939F1ZV';

// The shape here is the government's, not ours. Every assertion is about a
// key or a value the offline utility reads — a file that is wrong in these
// uploads cleanly and declares the wrong thing.

function billWith(items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return {
    id: over.id ?? 'bill-1',
    billNumber: 'BILL-1',
    invoiceNumber: 'TI/2026-27/000001',
    gstDocumentType: 'tax_invoice',
    billDate: new Date('2026-09-03T00:00:00Z'),
    status: 'paid',
    financialYear: '2026-27',
    admissionId: null,
    recipientGstin: null,
    placeOfSupplyStateCode: '27',
    isInterState: false,
    patient: { id: 'p1', mrn: 'M', firstName: 'Asha', lastName: 'Rao' },
    billItems: items.map((o, i) => ({
      id: `it-${i}`, description: 'Consultation', category: 'consultation',
      quantity: 1, unitPrice: 100, discountAmount: 0, taxPercent: 0,
      taxableValue: 100, taxAmount: 0, cgstAmount: 0, sgstAmount: 0,
      igstAmount: 0, cessAmount: 0, totalAmount: 100,
      hsnSacCode: '999311', gstTreatment: 'exempt',
      rateSource: 'sac_master', requiresTaxResolution: false,
      createdAt: new Date('2026-09-03T00:00:00Z'), ...o,
    })),
    ...over,
  };
}

const TAXED = {
  description: 'Deluxe room', category: 'room', unitPrice: 8000, taxPercent: 5,
  taxableValue: 8000, taxAmount: 400, cgstAmount: 200, sgstAmount: 200,
  totalAmount: 8400, hsnSacCode: '996311', gstTreatment: 'taxable',
};

function seed(bills: unknown[], notes: unknown[] = [], registered = true) {
  (prisma.bill.findMany as any).mockResolvedValue(bills);
  (prisma.creditNote.findMany as any).mockResolvedValue(notes);
  (prisma.payment.findMany as any).mockResolvedValue([]);
  (prisma.tenant.findFirst as any).mockResolvedValue({
    themeConfig: registered ? { gst: { registered: true, gstin: GSTIN } } : {},
  });
}

const PERIOD = { from: '2026-09-01', to: '2026-09-30' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('returnPeriod', () => {
  it('is MMYYYY, taken from the start of the period', () => {
    expect(returnPeriod('2026-09-01', '2026-09-30')).toBe('092026');
    expect(returnPeriod('2027-01-01', '2027-01-31')).toBe('012027');
  });
});

describe('buildGstr1Json', () => {
  it('identifies the file by the hospital GSTIN and the return period', async () => {
    seed([billWith([TAXED])]);
    const { json } = await buildGstr1Json(TENANT, PERIOD);
    expect(json.gstin).toBe(GSTIN);
    expect(json.fp).toBe('092026');
  });

  it('puts a supply to a registered recipient in b2b, under their GSTIN', async () => {
    seed([billWith([TAXED], { recipientGstin: '29AAPFU0939F1ZV' })]);
    const { json } = await buildGstr1Json(TENANT, PERIOD);
    const b2b = json.b2b as any[];
    expect(b2b[0].ctin).toBe('29AAPFU0939F1ZV');
    // The ALLOTTED number, never the internal bill number: it is what the
    // recipient matches their credit against.
    expect(b2b[0].inv[0]).toMatchObject({ inum: 'TI/2026-27/000001', idt: '03-09-2026', val: 8400, pos: '27' });
    expect(b2b[0].inv[0].itms[0].itm_det).toMatchObject({ rt: 5, txval: 8000, camt: 200, samt: 200 });
    expect(json.b2cs).toBeUndefined();
  });

  it('summarises an ordinary patient into b2cs by place of supply and rate', async () => {
    seed([billWith([TAXED])]);
    const { json } = await buildGstr1Json(TENANT, PERIOD);
    const b2cs = json.b2cs as any[];
    expect(b2cs[0]).toMatchObject({ sply_ty: 'INTRA', pos: '27', typ: 'OE', rt: 5, txval: 8000, camt: 200 });
    expect(json.b2b).toBeUndefined();
  });

  it('lists a large inter-state B2C invoice separately in b2cl', async () => {
    seed([
      billWith(
        [{ ...TAXED, unitPrice: 300000, taxableValue: 300000, taxAmount: 15000, cgstAmount: 0, sgstAmount: 0, igstAmount: 15000, totalAmount: 315000 }],
        { isInterState: true, placeOfSupplyStateCode: '29' },
      ),
    ]);
    const { json } = await buildGstr1Json(TENANT, PERIOD);
    expect((json.b2cl as any[])[0].pos).toBe('29');
    expect((json.b2cl as any[])[0].inv[0].val).toBe(315000);
    // Reported invoice-wise, so it must NOT also be summarised into b2cs.
    expect(json.b2cs).toBeUndefined();
  });

  // The rule that makes a hospital's return look different from a shop's.
  // Exempt turnover in b2cs would declare tax on it.
  it('puts exempt turnover in nil, never in b2cs', async () => {
    seed([billWith([{}])]);
    const { json } = await buildGstr1Json(TENANT, PERIOD);
    expect(json.b2cs).toBeUndefined();
    expect((json.nil as any).inv[0]).toMatchObject({ sply_ty: 'INTRAB2C', expt_amt: 100 });
  });

  it('separates nil-rated and non-GST from exempt inside nil', async () => {
    seed([billWith([{}, { gstTreatment: 'nil_rated', totalAmount: 50, taxableValue: 50 }, { gstTreatment: 'non_gst', totalAmount: 30, taxableValue: 30 }])]);
    const { json } = await buildGstr1Json(TENANT, PERIOD);
    expect((json.nil as any).inv[0]).toMatchObject({ expt_amt: 100, nil_amt: 50, ngsup_amt: 30 });
  });

  it('reports a credit note against the invoice number it reverses', async () => {
    seed([billWith([TAXED])], [
      {
        id: 'cn1', creditNoteNumber: 'CN/2026-27/000001', issueDate: new Date('2026-09-10T00:00:00Z'),
        financialYear: '2026-27', reason: 'refund', reasonNote: null, patientId: 'p1',
        recipientGstin: null, placeOfSupplyStateCode: '27',
        taxableValue: 1000, cgstAmount: 25, sgstAmount: 25, igstAmount: 0, cessAmount: 0,
        taxAmount: 50, totalAmount: 1050, withinTimeLimit: true, items: [],
        bill: { billNumber: 'BILL-1', invoiceNumber: 'TI/2026-27/000001', gstDocumentType: 'tax_invoice', billDate: new Date('2026-09-03T00:00:00Z') },
        patient: null, issuer: null,
      },
    ]);
    const { json } = await buildGstr1Json(TENANT, PERIOD);
    expect((json.cdnur as any[])[0]).toMatchObject({
      ntty: 'C', nt_num: 'CN/2026-27/000001', nt_dt: '10-09-2026', inum: 'TI/2026-27/000001',
    });
  });

  it('fills table 12 from the HSN summary at the required digit length', async () => {
    seed([billWith([{ ...TAXED, hsnSacCode: '99631100' }])]);
    const { json } = await buildGstr1Json(TENANT, PERIOD);
    expect((json.hsn as any).data[0]).toMatchObject({ hsn_sc: '9963', rt: 5, txval: 8000, qty: 1 });
    const six = await buildGstr1Json(TENANT, { ...PERIOD, sixDigit: true });
    expect(((six.json.hsn as any).data[0]).hsn_sc).toBe('996311');
  });

  // A present-but-empty section tells the utility "I am declaring nothing
  // here", which is a different statement from not having reached it.
  it('omits a section it has nothing for', async () => {
    seed([billWith([{}])]);
    const { json } = await buildGstr1Json(TENANT, PERIOD);
    expect(Object.keys(json)).not.toContain('b2b');
    expect(Object.keys(json)).not.toContain('cdnur');
  });

  it('warns that an unregistered hospital cannot upload this at all', async () => {
    seed([billWith([{}])], [], false);
    const { warnings } = await buildGstr1Json(TENANT, PERIOD);
    expect(warnings[0]).toMatch(/not registered/);
  });

  it('warns when lines are missing from the file, rather than filing quietly', async () => {
    seed([billWith([{ hsnSacCode: null }, { gstTreatment: null, hsnSacCode: null }])]);
    const { warnings } = await buildGstr1Json(TENANT, PERIOD);
    expect(warnings.join(' ')).toMatch(/no HSN or SAC/);
    expect(warnings.join(' ')).toMatch(/no tax treatment/);
  });
});
