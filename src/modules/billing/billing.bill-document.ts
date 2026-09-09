import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import {
  normalizeAdmissionType,
  ADMISSION_TYPE_LABELS,
  type AdmissionType,
} from '../../shared/admission-type';
import type { HospitalBranding } from '../../services/pdf-branding';
import type { PdfTemplate } from '../../services/pdf-template';
import { roundOffTotal } from '../../shared/gst';
import {
  buildGstBlock,
  treatmentLabelFor,
  type BillDocumentGst,
  type BillTaxSummaryRow,
  type GstLine,
} from './billing.gst-layout';

// Re-exported: these were defined here first, and both PDF renderers and the
// tests import them from this module.
export type { BillDocumentGst, BillTaxSummaryRow };
export { buildTaxSummary } from './billing.gst-layout';

// ============================================================
// Final IP bill document (IP / Emergency / Day Care)
// ============================================================
//
// The printable bill for one admission — the document handed to the patient at
// discharge and reprinted on demand afterwards. All three admission types run
// the same IP flow, so one document serves all of them; only the label differs.
//
// Assembled from the running ledger (the single source of truth for what this
// stay cost) plus the admission, patient and payment records. Deliberately a
// pure read: printing a bill must never post, finalise or mutate anything, so
// an old bill reprints exactly as it was.

export interface BillDocumentLine extends GstLine {
  description: string;
  category: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  /** 'posted' = on a bill; 'pending' = accrued but not yet billed. */
  status: string;
  at: string;
}

export interface AdmissionBillDocument {
  /**
   * Hospital letterhead, carried ON the document rather than fetched by the
   * client. `GET /hospital-branding` is admin-only, so the print view rendered
   * a blank letterhead for every doctor, nurse and front-desk user who opened
   * a bill. The discharge document already embeds branding the same way.
   */
  hospital: HospitalBranding;
  /**
   * The resolved `ip_bill` template from the PDF Builder — page setup,
   * typography, colours, header/footer options, watermark, table style,
   * signature and custom blocks.
   *
   * Carried on the document for the same reason as the letterhead: the print
   * view has to render exactly what the PDF renders, and
   * `GET /hospital-branding/templates` is admin-only. Without it the on-screen
   * bill and the downloaded PDF of the same stay were styled differently.
   */
  template: PdfTemplate;
  admissionId: string;
  admissionType: AdmissionType;
  admissionTypeLabel: string;
  /** True once nothing is left for the patient to pay. */
  isPaid: boolean;
  /** True once the stay is over — a final bill rather than an interim one. */
  isDischarged: boolean;
  /**
   * What the paper calls itself: the GST document's own name once the bill has
   * been issued ("Tax Invoice", "Bill of Supply", "Invoice-cum-Bill of
   * Supply"), and otherwise "Final Bill" or "Interim Bill" from the stay's
   * status. See where it is built for why an issued document keeps its legal
   * name even while the patient is still admitted.
   */
  documentTitle: string;
  patient: {
    id: string;
    name: string;
    mrn: string | null;
    age: string | null;
    gender: string | null;
    phone: string | null;
    address: string | null;
    bloodGroup: string | null;
  };
  admission: {
    ipNumber: string | null;
    admittedOn: string;
    dischargedOn: string | null;
    lengthOfStayDays: number;
    ward: string | null;
    bed: string | null;
    doctor: string | null;
    billingCategory: string;
    reason: string | null;
  };
  bills: Array<{
    billNumber: string;
    status: string;
    totalAmount: number;
    /** The GST document number, once the bill has been finalised and issued. */
    invoiceNumber: string | null;
    gstDocumentType: string | null;
  }>;
  /** The document's GST identity, per-rate summary and layout switches. */
  gst: BillDocumentGst;
  /** Charge lines grouped by category, in the order they should print. */
  groups: Array<{ category: string; label: string; lines: BillDocumentLine[]; total: number }>;
  payments: Array<{
    date: string;
    amount: number;
    method: string;
    type: string;
    reference: string | null;
    receiptNumber: string | null;
  }>;
  totals: {
    grossCharges: number;
    posted: number;
    pending: number;
    discount: number;
    tax: number;
    insuranceCovered: number;
    deposit: number;
    depositApplied: number;
    depositRefunded: number;
    paid: number;
    cashPaid: number;
    /** Section 6.9 — what the grand total was rounded by, 0 when it was not. */
    roundOff: number;
    netPayable: number;
    balanceDue: number;
    refundable: number;
  };
  generatedAt: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  room: 'Room / Bed Charges',
  consultation: 'Consultation & Visits',
  procedure: 'Procedures',
  surgery: 'Surgery / OT',
  lab: 'Laboratory',
  imaging: 'Radiology & Imaging',
  pharmacy: 'Pharmacy & Medicines',
  consumable: 'Consumables',
  nursing: 'Nursing',
  equipment: 'Equipment',
  other: 'Other Charges',
};

// Print order — the sequence a hospital bill conventionally reads in. Anything
// not listed falls to the end, alphabetically.
const CATEGORY_ORDER = [
  'room', 'consultation', 'procedure', 'surgery', 'lab', 'imaging',
  'pharmacy', 'consumable', 'nursing', 'equipment', 'other',
];

function categoryLabel(c: string): string {
  return CATEGORY_LABELS[c] ?? c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function ageFromDob(dob: Date | null): string | null {
  if (!dob) return null;
  const years = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  return years >= 0 ? `${years}Y` : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Build the printable bill for an admission. `getAdmissionLedger` already
 * enforces care-team / billing access and computes the money, so this reuses it
 * rather than recomputing totals a second way — a bill that disagreed with the
 * ledger on screen would be worse than no bill at all.
 */
export async function buildAdmissionBillDocument(
  tenantId: string,
  admissionId: string,
  actor: { userId: string; roles: string[] },
): Promise<AdmissionBillDocument> {
  const { getAdmissionLedger } = await import('./billing.service');
  const { getHospitalBranding, resolvePdfTemplate } = await import(
    '../hospital-branding/hospital-branding.service'
  );
  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const [ledger, branding, template, gstProfile] = await Promise.all([
    getAdmissionLedger(tenantId, admissionId, actor),
    getHospitalBranding(tenantId),
    // Same template the PDF route resolves, so the print view and the PDF are
    // two renderings of one definition rather than two sets of styling.
    resolvePdfTemplate(tenantId, 'ip_bill'),
    // Decides whether this document shows tax at all. An unregistered hospital
    // prints exactly what it printed before any of this existed.
    getGstProfile(tenantId),
  ]);

  const admission = await prisma.admission.findFirst({
    where: { id: admissionId, tenantId },
    select: {
      id: true, admissionDate: true, dischargeDate: true, status: true,
      admissionReason: true, billingCategory: true, visitId: true,
      ward: { select: { name: true } },
      bed: { select: { bedNumber: true } },
      doctor: { select: { user: { select: { firstName: true, lastName: true } } } },
      patient: {
        select: {
          id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true,
          gender: true, phone: true, bloodGroup: true,
          addressLine1: true, city: true, state: true, postalCode: true,
        },
      },
    },
  });
  if (!admission) throw AppError.notFound('Admission not found');

  // admission_type is a raw column (added migration-free).
  const [typeRow] = await prisma.$queryRaw<{ admission_type: string | null }[]>`
    SELECT admission_type FROM admissions WHERE id = ${admissionId} AND tenant_id = ${tenantId}
  `;
  const admissionType = normalizeAdmissionType(typeRow?.admission_type);

  // Payments across every bill on this stay, newest last so the receipt list
  // reads chronologically like a passbook.
  const billIds = ledger.bills.map((b) => b.id);
  const payments = billIds.length
    ? await prisma.payment.findMany({
        where: { tenantId, billId: { in: billIds }, status: { not: 'failed' } },
        orderBy: { paymentDate: 'asc' },
        select: {
          paymentDate: true, amount: true, paymentMethod: true, paymentType: true,
          transactionId: true, status: true,
          receipt: { select: { receiptNumber: true } },
        },
      })
    : [];

  // Discount / tax live on the bill headers, not on the ledger lines. The GST
  // identity does too — the document type and its number are allotted to the
  // BILL at finalisation, never to a line.
  const billHeaders = billIds.length
    ? await prisma.bill.findMany({
        where: { id: { in: billIds } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, discountAmount: true, taxAmount: true,
          gstDocumentType: true, invoiceNumber: true, billOfSupplyNumber: true, financialYear: true,
          supplierGstin: true, supplierStateCode: true, recipientGstin: true,
          placeOfSupplyStateCode: true, isInterState: true,
          // Section 10: the IRN and the signed QR belong on the face of the
          // document once e-invoicing applies. Selected here or the layout
          // would have the fields and never the values.
          irn: true, irnAckNo: true, irnAckDate: true, irnQrPayload: true,
        },
      })
    : [];
  const discount = r2(billHeaders.reduce((s, b) => s + Number(b.discountAmount ?? 0), 0));
  const tax = r2(billHeaders.reduce((s, b) => s + Number(b.taxAmount ?? 0), 0));

  // Group the ledger lines by category in print order.
  const byCategory = new Map<string, BillDocumentLine[]>();
  for (const l of ledger.lines) {
    const arr = byCategory.get(l.category) ?? [];
    arr.push({
      description: l.description,
      category: l.category,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      totalAmount: l.totalAmount,
      status: l.status,
      at: l.at,
      hsnSac: l.hsnSac ?? null,
      gstTreatment: l.gstTreatment ?? null,
      treatmentLabel: treatmentLabelFor(l.gstTreatment),
      taxRatePercent: l.taxRatePercent ?? 0,
      // A pending charge has no taxable value of its own yet; its whole amount
      // stands in for one so the columns still add up on an interim bill.
      taxableValue: l.taxableValue ?? l.totalAmount,
      taxAmount: l.taxAmount ?? 0,
      cgstRate: l.cgstRate ?? 0, cgstAmount: l.cgstAmount ?? 0,
      sgstRate: l.sgstRate ?? 0, sgstAmount: l.sgstAmount ?? 0,
      igstRate: l.igstRate ?? 0, igstAmount: l.igstAmount ?? 0,
      cessAmount: l.cessAmount ?? 0,
    });
    byCategory.set(l.category, arr);
  }
  const groups = [...byCategory.entries()]
    .sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a[0]);
      const ib = CATEGORY_ORDER.indexOf(b[0]);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a[0].localeCompare(b[0]);
    })
    .map(([category, lines]) => ({
      category,
      label: categoryLabel(category),
      lines,
      total: r2(lines.reduce((s, l) => s + l.totalAmount, 0)),
    }));

  const p = admission.patient;
  const address = [p.addressLine1, p.city, p.state, p.postalCode].filter(Boolean).join(', ') || null;

  const admittedOn = admission.admissionDate;
  const dischargedOn = admission.dischargeDate;
  const los = Math.max(
    1,
    Math.ceil(
      ((dischargedOn ?? new Date()).getTime() - admittedOn.getTime()) / (24 * 60 * 60 * 1000),
    ),
  );

  const t = ledger.totals;
  const isDischarged = admission.status === 'discharged';

  // ── The document's GST identity ────────────────────────────────────────────
  // Assembled by the shared builder, so this document, the counter bill and the
  // dialog cannot disagree about what kind of paper this is.
  const allLines = groups.flatMap((g) => g.lines);
  const gst = buildGstBlock(gstProfile, billHeaders, allLines);

  // `grandTotal` already has the bill-header concession deducted (see
  // getAdmissionLedger). Item-level tax is already inside each line's
  // totalAmount, so tax must NOT be added again here — it is reported below
  // purely as "of which tax".
  const exactPayable = r2(Math.max(0, t.grandTotal - t.insuranceCovered));

  // Section 6.9: the grand total rounds to the nearest rupee and the difference
  // shows as its own line, so the arithmetic on the page adds up.
  //
  // Computed here rather than read off a bill row, because this document is a
  // whole STAY and a stay can span several bills — its grand total is not any
  // one of their totals. Each document rounds its own bottom line, which is the
  // only way each page can be internally consistent.
  //
  // Never applied to the tax figures. Those are what get reported.
  const rounding =
    gstProfile.registered && gstProfile.roundOffToRupee
      ? roundOffTotal(exactPayable)
      : { rounded: exactPayable, roundOff: 0 };
  const netPayable = rounding.rounded;
  const roundOff = rounding.roundOff;
  // Money the hospital is holding from this patient (mirrors the ledger).
  const moneyFromPatient = r2(t.cashPaid + t.deposit - t.depositRefunded);
  const balanceDue = r2(Math.max(0, netPayable - moneyFromPatient));
  const surplus = r2(Math.max(0, moneyFromPatient - netPayable));
  const refundable = r2(Math.min(surplus, r2(Math.max(0, t.deposit - t.depositRefunded))));
  const isPaid = balanceDue <= 0;

  return {
    hospital: branding,
    template,
    admissionId,
    admissionType,
    admissionTypeLabel: ADMISSION_TYPE_LABELS[admissionType],
    isPaid,
    isDischarged,
    /**
     * What the paper calls itself.
     *
     * Once a bill is finalised it has been ISSUED as a named GST document — a
     * Tax Invoice, a Bill of Supply, or the mixture Rule 46A allows — and that
     * name goes at the top, whether or not the patient has gone home. A
     * numbered invoice declared in GSTR-1 cannot print titled "Interim Bill";
     * the interim caveat is carried by the banner above the charges, which is
     * about the STAY still accruing, not about what this document is.
     *
     * A hospital that is not registered issues no GST document, so its bill
     * keeps the title it has always had.
     */
    documentTitle:
      gst.registered && gst.documentLabel
        ? gst.documentLabel
        : isDischarged
          ? 'Final Bill'
          : 'Interim Bill',
    patient: {
      id: p.id,
      name: `${p.firstName} ${p.lastName ?? ''}`.trim(),
      mrn: p.mrn,
      age: ageFromDob(p.dateOfBirth),
      gender: p.gender ? String(p.gender) : null,
      phone: p.phone,
      address,
      bloodGroup: p.bloodGroup ? String(p.bloodGroup) : null,
    },
    admission: {
      // There is no ip_number column; the IP lists show this short reference,
      // so the printed bill quotes the same one.
      ipNumber: admissionId.slice(0, 8).toUpperCase(),
      admittedOn: admittedOn.toISOString(),
      dischargedOn: dischargedOn ? dischargedOn.toISOString() : null,
      lengthOfStayDays: los,
      ward: admission.ward?.name ?? null,
      bed: admission.bed?.bedNumber ?? null,
      doctor: admission.doctor?.user
        ? `Dr. ${admission.doctor.user.firstName} ${admission.doctor.user.lastName ?? ''}`.trim()
        : null,
      billingCategory: ledger.billingCategory,
      reason: admission.admissionReason ?? null,
    },
    bills: ledger.bills.map((b) => {
      const header = billHeaders.find((h) => h.id === b.id);
      return {
        billNumber: b.billNumber,
        status: b.status,
        totalAmount: b.totalAmount,
        invoiceNumber: header?.invoiceNumber ?? null,
        gstDocumentType: header?.gstDocumentType ?? null,
      };
    }),
    gst,
    groups,
    payments: payments.map((pay) => ({
      date: pay.paymentDate.toISOString(),
      amount: Number(pay.amount),
      method: String(pay.paymentMethod),
      type: String(pay.paymentType),
      reference: pay.transactionId ?? null,
      receiptNumber: pay.receipt?.receiptNumber ?? null,
    })),
    totals: {
      // Pre-concession, so the printed summary reads gross → discount → net.
      grossCharges: r2(t.grandTotal + discount),
      posted: t.posted,
      pending: t.pending,
      discount,
      tax,
      insuranceCovered: t.insuranceCovered,
      deposit: t.deposit,
      depositApplied: t.depositApplied,
      depositRefunded: t.depositRefunded,
      paid: t.paid,
      cashPaid: t.cashPaid,
      /** Section 6.9 — the difference the grand total was rounded by. */
      roundOff,
      netPayable,
      balanceDue,
      refundable,
    },
    generatedAt: new Date().toISOString(),
  };
}
