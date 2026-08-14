import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import type { Response } from 'express';
import { streamAdmissionBillPdf } from '../../../../src/modules/billing/billing.ip-bill-pdf';
import type { AdmissionBillDocument } from '../../../../src/modules/billing/billing.bill-document';
import { DEFAULT_TEMPLATE, mergeTemplate } from '../../../../src/services/pdf-template';
import { DEFAULT_SHOW, type HospitalBranding } from '../../../../src/services/pdf-branding';
import { embeddedFontsAvailable } from '../../../../src/services/pdf-fonts';

// ============================================================
// The bill PDF has to print what the bill dialog shows.
//
// They used to be written independently and had drifted: the dialog had a
// fourteen-field patient card, the PDF had two columns under PATIENT and
// ADMISSION headings; the dialog warned that an interim bill was still
// accruing, the PDF did not; the dialog printed rupees, the PDF printed bare
// numbers because PDFKit's built-in fonts have no glyph for ₹.
//
// The dialog is `frontend/src/components/hospital/billing/
// admission-bill-document.tsx`. Change one, change the other.
// ============================================================

const branding: HospitalBranding = {
  name: 'Green city Hospital',
  tagline: null,
  logoUrl: null,
  showLogo: false,
  headerStyle: 'centered',
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  pincode: null,
  country: null,
  phone: '(+91) 7567202234',
  altPhone: null,
  email: 'hospital1@email.com',
  website: null,
  registrationNo: null,
  gstin: null,
  accreditation: null,
  footerText: null,
  accentColor: '#0f766e',
  show: { ...DEFAULT_SHOW },
};

function makeDoc(over: Partial<AdmissionBillDocument> = {}): AdmissionBillDocument {
  return {
    hospital: branding,
    template: DEFAULT_TEMPLATE,
    admissionId: 'adm-1',
    admissionType: 'ip',
    admissionTypeLabel: 'In-Patient',
    isPaid: false,
    isDischarged: false,
    documentTitle: 'Interim Bill',
    patient: {
      id: 'p1', name: 'user four 4', mrn: 'MRN-20260713-0002', age: '6Y',
      gender: 'male', phone: '+919638529630', address: null, bloodGroup: null,
    },
    admission: {
      ipNumber: 'E7DF4D72', admittedOn: '2026-08-03T00:00:00Z', dischargedOn: null,
      lengthOfStayDays: 12, ward: null, bed: null, doctor: 'Dr. doc 2',
      billingCategory: 'cash', reason: null,
    },
    bills: [{ billNumber: 'BILL-1786437902887', status: 'draft', totalAmount: 2200 }],
    groups: [
      {
        category: 'laboratory', label: 'Laboratory', total: 1700,
        lines: [
          { description: 'Widal Test', category: 'laboratory', quantity: 1, unitPrice: 250, totalAmount: 250, status: 'posted', at: '2026-08-06T00:00:00Z' },
          { description: 'Vitamin D (25-OH)', category: 'laboratory', quantity: 1, unitPrice: 1200, totalAmount: 1200, status: 'pending', at: '2026-08-06T00:00:00Z' },
        ],
      },
      {
        category: 'radiology', label: 'Radiology', total: 500,
        lines: [
          { description: 'XRAY — chest', category: 'radiology', quantity: 1, unitPrice: 500, totalAmount: 500, status: 'posted', at: '2026-08-06T00:00:00Z' },
        ],
      },
    ],
    payments: [{
      date: '2026-08-06T09:17:00Z', amount: 250, method: 'cash',
      type: 'regular', reference: null, receiptNumber: 'RCP-20260806-0007',
    }],
    totals: {
      grossCharges: 2200, posted: 1000, pending: 1200, discount: 0, tax: 0,
      insuranceCovered: 0, deposit: 0, depositApplied: 0, depositRefunded: 0,
      paid: 250, cashPaid: 250, netPayable: 2200, balanceDue: 1950, refundable: 0,
    },
    generatedAt: '2026-08-14T08:00:00Z',
    ...over,
  } as AdmissionBillDocument;
}

/** Render the bill and return the bytes. */
async function render(doc: AdmissionBillDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let resolve!: (b: Buffer) => void;
  const done = new Promise<Buffer>((r) => (resolve = r));
  const sink = new Writable({
    write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); },
    final(cb) { resolve(Buffer.concat(chunks)); cb(); },
  }) as unknown as Response;
  (sink as unknown as { setHeader: () => void }).setHeader = () => {};
  streamAdmissionBillPdf(sink, doc, doc.hospital, doc.template);
  return done;
}

function expectWellFormedPdf(buf: Buffer) {
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(buf.subarray(-1024).toString('latin1')).toContain('%%EOF');
  expect(buf.length).toBeGreaterThan(2000);
}

describe('streamAdmissionBillPdf', () => {
  it('renders a well-formed bill', async () => {
    expectWellFormedPdf(await render(makeDoc()));
  });

  it('renders a discharged, fully paid stay', async () => {
    expectWellFormedPdf(
      await render(
        makeDoc({
          isPaid: true,
          isDischarged: true,
          documentTitle: 'Final Bill',
          admission: { ...makeDoc().admission, dischargedOn: '2026-08-14T00:00:00Z' },
          totals: { ...makeDoc().totals, balanceDue: 0, cashPaid: 2200, paid: 2200 },
        }),
      ),
    );
  });

  it('renders a stay with no charges at all', async () => {
    expectWellFormedPdf(await render(makeDoc({ groups: [], payments: [] })));
  });

  it('renders every deduction line the summary can show', async () => {
    expectWellFormedPdf(
      await render(
        makeDoc({
          totals: {
            grossCharges: 20000, posted: 20000, pending: 0, discount: 1500, tax: 900,
            insuranceCovered: 8000, deposit: 5000, depositApplied: 5000, depositRefunded: 250,
            paid: 5000, cashPaid: 4000, netPayable: 10500, balanceDue: 0, refundable: 750,
          },
          isPaid: true,
        }),
      ),
    );
  });

  it('survives a template that changes every axis at once', async () => {
    const template = mergeTemplate(DEFAULT_TEMPLATE, {
      page: { size: 'A5', orientation: 'landscape', margin: 18 },
      typography: { fontFamily: 'Times', baseFontSize: 11, lineGap: 4 },
      colors: { accent: '#7c3aed' },
      header: { showLetterhead: false, titleOverride: 'TAX INVOICE', showMetaStrip: false },
      footer: { footerTextOverride: 'Subject to Pune jurisdiction.', showGeneratedAt: false },
      watermark: { enabled: true, text: 'DUPLICATE', opacity: 0.3 },
      table: { density: 'comfortable', headerFill: 'muted', zebraRows: false, gridLines: 'all' },
      signature: { enabled: true, labels: ['Billing Officer', 'Patient / Attendant'] },
      blocks: [
        { id: 'a', position: 'before_body', heading: 'Notice', text: 'Carry your policy card.' },
        { id: 'b', position: 'after_body', heading: 'Terms', text: 'Bills once settled are not refundable.' },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expectWellFormedPdf(await render(makeDoc({ template })));
  });

  it('paginates a long itemisation without falling over', async () => {
    const lines = Array.from({ length: 140 }, (_, i) => ({
      description: `Charge line ${i + 1}`, category: 'pharmacy', quantity: 1,
      unitPrice: 100, totalAmount: 100, status: i % 3 === 0 ? 'pending' : 'posted',
      at: '2026-08-06T00:00:00Z',
    }));
    const buf = await render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeDoc({ groups: [{ category: 'pharmacy', label: 'Pharmacy', total: 14000, lines }] as any }),
    );
    expectWellFormedPdf(buf);
  });

  it('can render the rupee sign', () => {
    // The whole reason the fonts are bundled. Without them PDFKit's built-ins
    // give ₹ a width of zero and every amount prints with a hole in it.
    expect(embeddedFontsAvailable()).toBe(true);
  });
});
