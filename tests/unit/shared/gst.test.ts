import { describe, it, expect } from 'vitest';
import {
  r2,
  roundOffTotal,
  splitTax,
  computeLineTax,
  scaleInclusiveTax,
  resolveDocumentType,
  checkGstin,
  isInterState,
  stateNameForCode,
  normalizeHsnSac,
  hsnForReturn,
  treatmentAllowsTax,
  isGstTreatment,
} from '../../../src/shared/gst';

describe('rounding', () => {
  it('rounds to paise', () => {
    expect(r2(95.238095)).toBe(95.24);
    expect(r2(0.005)).toBe(0.01);
    expect(r2(2.675)).toBe(2.68); // the classic float case that rounds down naively
  });

  it('survives a non-number', () => {
    expect(r2(NaN)).toBe(0);
    expect(r2(Infinity)).toBe(0);
  });

  it('rounds the grand total to the rupee and keeps the difference visible', () => {
    expect(roundOffTotal(1200.4)).toEqual({ rounded: 1200, roundOff: -0.4 });
    expect(roundOffTotal(1200.6)).toEqual({ rounded: 1201, roundOff: 0.4 });
    expect(roundOffTotal(1200)).toEqual({ rounded: 1200, roundOff: 0 });
  });
});

describe('splitTax', () => {
  it('halves an intra-state tax into CGST and SGST', () => {
    expect(splitTax(900, false)).toEqual({ cgst: 450, sgst: 450, igst: 0 });
  });

  it('puts the whole of an inter-state tax into IGST', () => {
    expect(splitTax(900, true)).toEqual({ cgst: 0, sgst: 0, igst: 900 });
  });

  // The halves are reported separately, so they must add back to the tax
  // exactly — a stray paisa is a return that does not balance.
  it('gives an odd paisa to CGST and still sums to the tax', () => {
    const s = splitTax(11.43, false);
    expect(s.cgst).toBe(5.72);
    expect(s.sgst).toBe(5.71);
    expect(r2(s.cgst + s.sgst)).toBe(11.43);
  });

  it('splits nothing when there is no tax', () => {
    expect(splitTax(0, false)).toEqual({ cgst: 0, sgst: 0, igst: 0 });
    expect(splitTax(0, true)).toEqual({ cgst: 0, sgst: 0, igst: 0 });
  });
});

describe('computeLineTax — tax added on top (services, rooms)', () => {
  it('adds the rate to the price', () => {
    const l = computeLineTax({
      unitPrice: 6000,
      quantity: 3,
      ratePercent: 5,
      treatment: 'taxable',
      taxInclusive: false,
    });
    expect(l.taxableValue).toBe(18000);
    expect(l.taxAmount).toBe(900);
    expect(l.totalAmount).toBe(18900);
    expect(l.cgst).toBe(450);
    expect(l.sgst).toBe(450);
  });

  it('charges tax on the value after discount', () => {
    const l = computeLineTax({
      unitPrice: 1000,
      quantity: 1,
      discountAmount: 200,
      ratePercent: 18,
      treatment: 'taxable',
      taxInclusive: false,
    });
    expect(l.taxableValue).toBe(800);
    expect(l.taxAmount).toBe(144);
    expect(l.totalAmount).toBe(944);
  });
});

describe('computeLineTax — tax already inside the price (MRP)', () => {
  // A ₹100 strip must stay ₹100 on the bill. Adding the rate on top of an MRP
  // is what made the same medicine cost more on an IP bill than at the counter.
  it('digs the tax out of the price and leaves the total untouched', () => {
    const l = computeLineTax({
      unitPrice: 20,
      quantity: 2,
      ratePercent: 5,
      treatment: 'taxable',
      taxInclusive: true,
    });
    expect(l.totalAmount).toBe(40);
    expect(l.taxableValue).toBe(38.1);
    expect(l.taxAmount).toBe(1.9);
    expect(r2(l.taxableValue + l.taxAmount)).toBe(40);
  });

  it('handles the 18% supplement case', () => {
    const l = computeLineTax({
      unitPrice: 850,
      quantity: 1,
      ratePercent: 18,
      treatment: 'taxable',
      taxInclusive: true,
    });
    expect(l.totalAmount).toBe(850);
    expect(l.taxableValue).toBe(720.34);
    expect(l.taxAmount).toBe(129.66);
    expect(r2(l.taxableValue + l.taxAmount)).toBe(850);
  });

  it('discounts the MRP before digging the tax out', () => {
    const l = computeLineTax({
      unitPrice: 210,
      quantity: 1,
      discountAmount: 10,
      ratePercent: 5,
      treatment: 'taxable',
      taxInclusive: true,
    });
    expect(l.totalAmount).toBe(200);
    expect(l.taxableValue).toBe(190.48);
    expect(l.taxAmount).toBe(9.52); // 200 − 190.48
    expect(r2(l.taxableValue + l.taxAmount)).toBe(200);
    // The halves the invoice will print.
    expect(l.cgst).toBe(4.76);
    expect(l.sgst).toBe(4.76);
  });
});

describe('computeLineTax — the zeroes', () => {
  it.each(['exempt', 'nil_rated', 'non_gst', 'zero_rated'] as const)(
    'charges nothing on a %s line even when a rate is passed',
    (treatment) => {
      const l = computeLineTax({
        unitPrice: 500,
        quantity: 1,
        ratePercent: 18,
        treatment,
        taxInclusive: false,
      });
      expect(l.ratePercent).toBe(0);
      expect(l.taxAmount).toBe(0);
      expect(l.totalAmount).toBe(500);
      expect(l.taxableValue).toBe(500);
    },
  );

  it('treats a taxable line at nil rate as taxable-but-zero', () => {
    const l = computeLineTax({
      unitPrice: 22,
      quantity: 5,
      ratePercent: 0,
      treatment: 'taxable',
      taxInclusive: true,
    });
    expect(l.taxAmount).toBe(0);
    expect(l.taxableValue).toBe(110);
    expect(l.totalAmount).toBe(110);
  });
});

describe('computeLineTax — guards', () => {
  it('never lets a discount take a line below zero', () => {
    const l = computeLineTax({
      unitPrice: 100,
      quantity: 1,
      discountAmount: 500,
      ratePercent: 5,
      treatment: 'taxable',
      taxInclusive: false,
    });
    expect(l.discountAmount).toBe(100);
    expect(l.taxableValue).toBe(0);
    expect(l.totalAmount).toBe(0);
  });

  it('ignores a negative discount', () => {
    const l = computeLineTax({
      unitPrice: 100,
      quantity: 1,
      discountAmount: -50,
      ratePercent: 0,
      treatment: 'taxable',
      taxInclusive: false,
    });
    expect(l.discountAmount).toBe(0);
    expect(l.totalAmount).toBe(100);
  });

  it('ignores a negative rate', () => {
    const l = computeLineTax({
      unitPrice: 100,
      quantity: 1,
      ratePercent: -5,
      treatment: 'taxable',
      taxInclusive: false,
    });
    expect(l.taxAmount).toBe(0);
  });

  it('routes the whole tax to IGST when the supply crosses a state line', () => {
    const l = computeLineTax({
      unitPrice: 1000,
      quantity: 1,
      ratePercent: 18,
      treatment: 'taxable',
      taxInclusive: false,
      interState: true,
    });
    expect(l.igst).toBe(180);
    expect(l.cgst).toBe(0);
    expect(l.sgst).toBe(0);
  });
});

describe('scaleInclusiveTax', () => {
  it('brings the embedded tax down with a bill-level discount', () => {
    expect(scaleInclusiveTax(141.08, 0.9)).toBe(126.97);
  });

  it('never scales tax upward', () => {
    expect(scaleInclusiveTax(100, 1.5)).toBe(100);
  });

  it('treats nonsense as no tax', () => {
    expect(scaleInclusiveTax(100, -1)).toBe(0);
    expect(scaleInclusiveTax(100, NaN)).toBe(0);
  });
});

describe('resolveDocumentType', () => {
  it('calls an all-exempt bill a Bill of Supply', () => {
    expect(resolveDocumentType({ hasTaxable: false, hasExempt: true })).toEqual({
      documentType: 'bill_of_supply',
      requiresSeparateBillOfSupply: false,
    });
  });

  it('calls an empty bill a Bill of Supply rather than a tax invoice', () => {
    expect(resolveDocumentType({ hasTaxable: false, hasExempt: false }).documentType).toBe(
      'bill_of_supply',
    );
  });

  it('calls an all-taxable bill a Tax Invoice', () => {
    expect(resolveDocumentType({ hasTaxable: true, hasExempt: false }).documentType).toBe(
      'tax_invoice',
    );
  });

  // The ordinary hospital bill: a taxable room and an exempt surgery together,
  // for a patient who has no GSTIN.
  it('calls a mixed bill for an unregistered patient an Invoice-cum-Bill of Supply', () => {
    expect(resolveDocumentType({ hasTaxable: true, hasExempt: true })).toEqual({
      documentType: 'invoice_cum_bill_of_supply',
      requiresSeparateBillOfSupply: false,
    });
  });

  // Rule 46A only permits the combined document for an unregistered recipient.
  it('tells the caller a registered recipient is owed two documents', () => {
    expect(
      resolveDocumentType({ hasTaxable: true, hasExempt: true, recipientIsRegistered: true }),
    ).toEqual({ documentType: 'tax_invoice', requiresSeparateBillOfSupply: true });
  });
});

describe('checkGstin', () => {
  it('accepts a well-formed GSTIN and reads its state', () => {
    const c = checkGstin('27AAPFU0939F1ZV');
    expect(c.valid).toBe(true);
    expect(c.stateCode).toBe('27');
    expect(c.stateName).toBe('Maharashtra');
    expect(c.normalized).toBe('27AAPFU0939F1ZV');
  });

  it('normalises case and stray spaces', () => {
    expect(checkGstin('  27aapfu0939f1zv ').valid).toBe(true);
  });

  // A GSTIN one character wrong passes a regex, looks right on a purchase
  // invoice, and then silently fails to match anything in GSTR-2B.
  it('rejects a GSTIN whose check digit is wrong', () => {
    const c = checkGstin('27AAPFU0939F1ZA');
    expect(c.valid).toBe(false);
    expect(c.reason).toBe('Check digit does not match');
  });

  it('rejects an unknown state code', () => {
    expect(checkGstin('55AAPFU0939F1ZV').reason).toContain('not a GST state code');
  });

  it('rejects the wrong length', () => {
    expect(checkGstin('27AAPFU0939F1Z').reason).toContain('15 characters');
  });

  it('rejects a shape that is not a GSTIN', () => {
    expect(checkGstin('ABCDEFGHIJKLMNO').reason).toBe('Does not match the GSTIN format');
  });

  it('reports a missing GSTIN rather than throwing', () => {
    expect(checkGstin(null).reason).toBe('No GSTIN provided');
    expect(checkGstin('   ').reason).toBe('No GSTIN provided');
  });
});

describe('isInterState', () => {
  it('is inter-state when the codes differ', () => {
    expect(isInterState('27', '29')).toBe(true);
  });

  it('is intra-state when they match, however they were padded', () => {
    expect(isInterState('27', '27')).toBe(false);
    expect(isInterState('7', '07')).toBe(false);
  });

  // Charging IGST to a walk-in who cannot claim it takes money from them;
  // CGST+SGST in the wrong place is a correctable misclassification.
  it('assumes intra-state when either side is unknown', () => {
    expect(isInterState(null, '29')).toBe(false);
    expect(isInterState('27', undefined)).toBe(false);
  });
});

describe('state codes and HSN helpers', () => {
  it('names a state from its code', () => {
    expect(stateNameForCode('29')).toBe('Karnataka');
    expect(stateNameForCode('9')).toBe('Uttar Pradesh');
    expect(stateNameForCode('88')).toBeNull();
    expect(stateNameForCode(null)).toBeNull();
  });

  it('strips punctuation out of an HSN code', () => {
    expect(normalizeHsnSac('3004.90.99')).toBe('30049099');
    expect(normalizeHsnSac('3004 9099')).toBe('30049099');
    expect(normalizeHsnSac('abc')).toBeNull();
    expect(normalizeHsnSac(null)).toBeNull();
  });

  it('truncates a code to the width the return asks for', () => {
    expect(hsnForReturn('30049099', true)).toBe('300490');
    expect(hsnForReturn('30049099', false)).toBe('3004');
    expect(hsnForReturn('3004', true)).toBe('3004');
    expect(hsnForReturn(null, true)).toBeNull();
  });
});

describe('treatments', () => {
  it('lets only a taxable line carry a rate', () => {
    expect(treatmentAllowsTax('taxable')).toBe(true);
    expect(treatmentAllowsTax('exempt')).toBe(false);
    expect(treatmentAllowsTax('nil_rated')).toBe(false);
  });

  it('recognises its own treatment strings and nothing else', () => {
    expect(isGstTreatment('exempt')).toBe(true);
    expect(isGstTreatment('EXEMPT')).toBe(false);
    expect(isGstTreatment(0)).toBe(false);
  });
});
