import { describe, it, expect } from 'vitest';
import { parseGstr2b, matchKeyFor } from '../../../../src/modules/gst/gstr2b-parse';

// The shape here is the government's. Every assertion is about a key the
// portal actually writes — a parser that is wrong about one of these produces
// a clean, confident, empty reconciliation.

const invoice = (over: Record<string, unknown> = {}) => ({
  inum: 'SUP/001',
  typ: 'R',
  dt: '05-09-2026',
  val: 1120,
  pos: '27',
  itcavl: 'Y',
  items: [{ num: 1, itm_det: { rt: 12, txval: 1000, igst: 0, cgst: 60, sgst: 60, cess: 0 } }],
  ...over,
});

const file = (docdata: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  data: {
    rtnprd: '092026',
    gstin: '27AAPFU0939F1ZV',
    gendt: '14-10-2026',
    version: '1.0',
    docdata,
    ...over,
  },
});

const b2b = (invoices: unknown[], over: Record<string, unknown> = {}) => [
  { ctin: '27AAAAA1111A1Z5', trdnm: 'Acme Pharma', supfileddt: '11-10-2026', inv: invoices, ...over },
];

describe('matchKeyFor', () => {
  // Suppliers write the same invoice three ways. Matching the raw string
  // leaves a hospital chasing credit it already has.
  it('reads SUP/001, SUP-001 and sup 001 as the same invoice', () => {
    expect(matchKeyFor('SUP/001')).toBe('SUP001');
    expect(matchKeyFor('SUP-001')).toBe('SUP001');
    expect(matchKeyFor('sup 001')).toBe('SUP001');
  });

  it('survives an empty or missing number', () => {
    expect(matchKeyFor('')).toBe('');
    expect(matchKeyFor(undefined as never)).toBe('');
  });
});

describe('parseGstr2b', () => {
  it('reads a supplier invoice and its rate-wise items', () => {
    const r = parseGstr2b(file({ b2b: b2b([invoice()]) }));
    expect(r.returnPeriod).toBe('092026');
    expect(r.gstin).toBe('27AAPFU0939F1ZV');
    expect(r.documents).toHaveLength(1);
    expect(r.documents[0]).toMatchObject({
      supplierGstin: '27AAAAA1111A1Z5',
      supplierName: 'Acme Pharma',
      documentType: 'invoice',
      documentNumber: 'SUP/001',
      matchKey: 'SUP001',
      taxableValue: 1000,
      cgstAmount: 60,
      sgstAmount: 60,
      taxAmount: 120,
      itcAvailable: true,
    });
  });

  // `new Date('05-09-2026')` is NaN. Getting this wrong silently drops every
  // date out of the statement.
  it('reads the portal dd-mm-yyyy date, which Date() cannot', () => {
    const r = parseGstr2b(file({ b2b: b2b([invoice()]) }));
    expect(r.documents[0].documentDate?.toISOString().slice(0, 10)).toBe('2026-09-05');
    expect(r.documents[0].supplierFiledOn?.toISOString().slice(0, 10)).toBe('2026-10-11');
    expect(r.generatedAt?.toISOString().slice(0, 10)).toBe('2026-10-14');
  });

  it('sums a multi-rate invoice across its item block', () => {
    const r = parseGstr2b(
      file({
        b2b: b2b([
          invoice({
            items: [
              { num: 1, itm_det: { rt: 12, txval: 1000, igst: 0, cgst: 60, sgst: 60, cess: 0 } },
              { num: 2, itm_det: { rt: 5, txval: 500, igst: 0, cgst: 12.5, sgst: 12.5, cess: 0 } },
            ],
          }),
        ]),
      }),
    );
    expect(r.documents[0]).toMatchObject({ taxableValue: 1500, taxAmount: 145 });
  });

  it('carries an inter-state invoice as IGST', () => {
    const r = parseGstr2b(
      file({
        b2b: b2b([
          invoice({ pos: '29', items: [{ num: 1, itm_det: { rt: 12, txval: 1000, igst: 120, cgst: 0, sgst: 0 } }] }),
        ]),
      }),
    );
    expect(r.documents[0]).toMatchObject({ igstAmount: 120, cgstAmount: 0, taxAmount: 120, placeOfSupply: '29' });
  });

  // The portal's own verdict. 'N' means the credit is blocked whatever our
  // books say, and no amount of matching changes it.
  it('carries the portal saying the credit is blocked, with its reason', () => {
    const r = parseGstr2b(
      file({ b2b: b2b([invoice({ itcavl: 'N', rsn: 'POS and supplier state are the same' })]) }),
    );
    expect(r.documents[0]).toMatchObject({
      itcAvailable: false,
      itcBlockedReason: 'POS and supplier state are the same',
    });
  });

  // A credit note REDUCES the credit available. Leaving notes out would
  // overstate what may be claimed, which is the expensive direction.
  it('reads a supplier credit note, and tells it from a debit note', () => {
    const r = parseGstr2b(
      file({
        cdnr: [
          {
            ctin: '27AAAAA1111A1Z5', trdnm: 'Acme Pharma',
            nt: [
              { ntnum: 'CN/9', typ: 'C', dt: '20-09-2026', val: 112, items: [{ itm_det: { rt: 12, txval: 100, cgst: 6, sgst: 6 } }] },
              { ntnum: 'DN/3', typ: 'D', dt: '21-09-2026', val: 56, items: [{ itm_det: { rt: 12, txval: 50, cgst: 3, sgst: 3 } }] },
            ],
          },
        ],
      }),
    );
    expect(r.documents.map((d) => d.documentType).sort()).toEqual(['credit_note', 'debit_note']);
  });

  // An amendment is the SAME document with different figures. Counting both
  // would claim the credit twice.
  it('lets an amendment replace the invoice it amends rather than adding to it', () => {
    const r = parseGstr2b(
      file({
        b2b: b2b([invoice()]),
        b2ba: b2b([invoice({ items: [{ itm_det: { rt: 12, txval: 900, cgst: 54, sgst: 54 } }] })]),
      }),
    );
    expect(r.documents).toHaveLength(1);
    expect(r.documents[0]).toMatchObject({ taxableValue: 900, taxAmount: 108, isAmendment: true });
  });

  it('names the sections it did not read rather than dropping them silently', () => {
    const r = parseGstr2b(file({ b2b: b2b([invoice()]), impg: [{ boe: 1 }] }));
    expect(r.skippedSections).toEqual(['impg']);
  });

  // An accountant who uploads the wrong download and gets "0 invoices" would
  // read that as "no supplier has filed" — the opposite of what it means.
  it('refuses a file that is not a GSTR-2B rather than reporting nothing', () => {
    expect(() => parseGstr2b({ data: { rtnprd: '092026' } })).toThrow(/not a GSTR-2B/);
    expect(() => parseGstr2b({ hello: 'world' })).toThrow(/not a GSTR-2B/);
  });

  it('refuses a statement with no return period on it', () => {
    expect(() => parseGstr2b({ data: { docdata: { b2b: [] } } })).toThrow(/no return period/);
  });

  it('skips a row with no supplier GSTIN or no document number', () => {
    const r = parseGstr2b(
      file({ b2b: [{ ctin: '', inv: [invoice()] }, ...b2b([invoice({ inum: '' })])] }),
    );
    expect(r.documents).toHaveLength(0);
  });

  it('reads a file handed over without its outer data wrapper', () => {
    const inner = file({ b2b: b2b([invoice()]) }).data;
    expect(parseGstr2b(inner).documents).toHaveLength(1);
  });
});
