import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import {
  normalizeAdmissionType,
  ADMISSION_TYPE_LABELS,
  type AdmissionType,
} from '../../shared/admission-type';
import type { HospitalBranding } from '../../services/pdf-branding';
import type { PdfTemplate } from '../../services/pdf-template';
import {
  DOCUMENT_TYPE_LABELS,
  GST_TREATMENT_LABELS,
  stateNameForCode,
  type GstDocumentType,
  type GstTreatment,
} from '../../shared/gst';

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

export interface BillDocumentLine {
  description: string;
  category: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  /** 'posted' = on a bill; 'pending' = accrued but not yet billed. */
  status: string;
  at: string;
  /**
   * The line's frozen tax position — what Rule 46 wants printed per line.
   *
   * Null on a pending charge, which has not been priced onto a bill and so has
   * no position yet. The renderers show that as blank rather than as exempt.
   */
  hsnSac: string | null;
  gstTreatment: string | null;
  /**
   * 'Exempt' / 'Nil rated' / 'Taxable' — the word a document prints where a
   * rate would go. Resolved here so both renderers read one map instead of the
   * browser keeping its own copy of it.
   */
  treatmentLabel: string | null;
  /** The line's total GST rate. CGST and SGST are each half of it. */
  taxRatePercent: number;
  taxableValue: number;
  taxAmount: number;
  cgstRate: number;
  cgstAmount: number;
  sgstRate: number;
  sgstAmount: number;
  igstRate: number;
  igstAmount: number;
  cessAmount: number;
}

/** One rate's worth of the bill, for the rate-wise summary Rule 46 asks for. */
export interface BillTaxSummaryRow {
  /** 'Taxable', 'Exempt', 'Nil rated' … — what prints in the rate column. */
  label: string;
  treatment: string;
  ratePercent: number;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  cessAmount: number;
  taxAmount: number;
}

/**
 * Everything the document needs to be a GST document rather than "a bill".
 *
 * Assembled here so BOTH renderers — the dialog and the PDF — read one answer.
 * A layout decision made twice is a layout that drifts.
 */
export interface BillDocumentGst {
  /** False for a hospital not registered under GST: no tax columns at all. */
  registered: boolean;
  /** Read off the bill at finalisation; null while the bill is still a draft. */
  documentType: GstDocumentType | null;
  /** 'Tax Invoice' / 'Bill of Supply' / 'Invoice-cum-Bill of Supply'. */
  documentLabel: string | null;
  /** The consecutive numbers allotted for the financial year. */
  invoiceNumbers: string[];
  financialYear: string | null;
  supplierGstin: string | null;
  supplierStateCode: string | null;
  supplierStateName: string | null;
  recipientGstin: string | null;
  placeOfSupplyStateCode: string | null;
  placeOfSupplyStateName: string | null;
  isInterState: boolean;
  /**
   * Whether any tax was actually charged. Drives the layout: a document with
   * no tax on it is a Bill of Supply and must NOT print tax columns.
   */
  hasTax: boolean;
  /** True once any line carries a classification — legacy bills carry none. */
  hasClassifiedLines: boolean;
  taxSummary: BillTaxSummaryRow[];
  /**
   * The declarations that go under the tax summary — Rule 46(o)'s reverse
   * charge statement and the exemption the untaxed lines rely on.
   *
   * Worded once here so the screen and the paper say the same thing. A
   * declaration that differs between two renderings of one document is worse
   * than one that is missing.
   */
  notes: string[];
  totals: {
    taxableValue: number;
    cgstAmount: number;
    sgstAmount: number;
    igstAmount: number;
    cessAmount: number;
    taxAmount: number;
  };
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
  /** "Final Bill" vs "Interim Bill" — printed as the document title. */
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
 * Collapse the lines into one row per rate — the rate-wise summary a GST
 * document carries under its charges.
 *
 * Grouped by treatment AND rate, because "exempt" and "taxable at 0%" are
 * different answers that happen to carry the same number, and a return reports
 * them in different boxes. A pending line has no position at all and is left
 * out: it has not been billed, so there is nothing to declare for it yet.
 */
export function buildTaxSummary(lines: BillDocumentLine[]): BillTaxSummaryRow[] {
  const rows = new Map<string, BillTaxSummaryRow>();
  for (const l of lines) {
    if (!l.gstTreatment) continue;
    const rate = r2(l.taxRatePercent);
    const key = `${l.gstTreatment}:${rate}`;
    const row = rows.get(key) ?? {
      label: GST_TREATMENT_LABELS[l.gstTreatment as GstTreatment] ?? l.gstTreatment,
      treatment: l.gstTreatment,
      ratePercent: rate,
      taxableValue: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0,
      cessAmount: 0, taxAmount: 0,
    };
    row.taxableValue = r2(row.taxableValue + l.taxableValue);
    row.cgstAmount = r2(row.cgstAmount + l.cgstAmount);
    row.sgstAmount = r2(row.sgstAmount + l.sgstAmount);
    row.igstAmount = r2(row.igstAmount + l.igstAmount);
    row.cessAmount = r2(row.cessAmount + l.cessAmount);
    row.taxAmount = r2(row.taxAmount + l.taxAmount);
    rows.set(key, row);
  }
  // Highest rate first, so the taxed rows lead and the exempt block closes.
  return [...rows.values()].sort(
    (a, b) => b.ratePercent - a.ratePercent || a.treatment.localeCompare(b.treatment),
  );
}

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
          gstDocumentType: true, invoiceNumber: true, financialYear: true,
          supplierGstin: true, supplierStateCode: true, recipientGstin: true,
          placeOfSupplyStateCode: true, isInterState: true,
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
      treatmentLabel: l.gstTreatment
        ? (GST_TREATMENT_LABELS[l.gstTreatment as GstTreatment] ?? l.gstTreatment)
        : null,
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
  //
  // A stay can span more than one bill, and each carries its own allotted
  // number. The identity fields are taken from the first bill that has been
  // issued — they agree across a stay because they all describe the same
  // supplier and the same patient — while the numbers are listed in full, so
  // the paper names every document it consolidates.
  const issued = billHeaders.filter((b) => b.invoiceNumber);
  const primary = issued[0] ?? billHeaders[0] ?? null;
  const allLines = groups.flatMap((g) => g.lines);
  const taxSummary = buildTaxSummary(allLines);
  const gstTotals = allLines.reduce(
    (acc, l) => ({
      taxableValue: r2(acc.taxableValue + l.taxableValue),
      cgstAmount: r2(acc.cgstAmount + l.cgstAmount),
      sgstAmount: r2(acc.sgstAmount + l.sgstAmount),
      igstAmount: r2(acc.igstAmount + l.igstAmount),
      cessAmount: r2(acc.cessAmount + l.cessAmount),
      taxAmount: r2(acc.taxAmount + l.taxAmount),
    }),
    { taxableValue: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, cessAmount: 0, taxAmount: 0 },
  );
  const documentType = (primary?.gstDocumentType as GstDocumentType | null) ?? null;
  const hasTax = gstProfile.registered && gstTotals.taxAmount > 0;
  const notes: string[] = [];
  if (hasTax && (documentType === 'tax_invoice' || documentType === 'invoice_cum_bill_of_supply')) {
    // Rule 46(o) — a tax invoice must say whether the tax is payable on reverse
    // charge. Billing a patient it never is, and an auditor still looks for the
    // sentence.
    notes.push('Tax is not payable on reverse charge basis.');
  }
  if (gstProfile.registered && taxSummary.some((r) => r.treatment !== 'taxable')) {
    notes.push(
      'Exempt lines are healthcare services exempt under Notification 12/2017-Central Tax (Rate).',
    );
  }
  const gst: BillDocumentGst = {
    registered: gstProfile.registered,
    documentType,
    documentLabel: documentType ? (DOCUMENT_TYPE_LABELS[documentType] ?? null) : null,
    invoiceNumbers: issued.map((b) => b.invoiceNumber!),
    financialYear: primary?.financialYear ?? null,
    supplierGstin: primary?.supplierGstin ?? gstProfile.gstin ?? null,
    supplierStateCode: primary?.supplierStateCode ?? gstProfile.stateCode ?? null,
    supplierStateName: stateNameForCode(primary?.supplierStateCode ?? gstProfile.stateCode),
    recipientGstin: primary?.recipientGstin ?? null,
    placeOfSupplyStateCode: primary?.placeOfSupplyStateCode ?? null,
    placeOfSupplyStateName: stateNameForCode(primary?.placeOfSupplyStateCode),
    isInterState: primary?.isInterState ?? false,
    // The layout switch. No tax anywhere means this is a document for exempt
    // supply, and a bill of supply must NOT carry tax columns.
    hasTax,
    hasClassifiedLines: allLines.some((l) => !!l.gstTreatment || !!l.hsnSac),
    taxSummary,
    notes,
    totals: gstTotals,
  };

  // `grandTotal` already has the bill-header concession deducted (see
  // getAdmissionLedger). Item-level tax is already inside each line's
  // totalAmount, so tax must NOT be added again here — it is reported below
  // purely as "of which tax".
  const netPayable = r2(Math.max(0, t.grandTotal - t.insuranceCovered));
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
      netPayable,
      balanceDue,
      refundable,
    },
    generatedAt: new Date().toISOString(),
  };
}
