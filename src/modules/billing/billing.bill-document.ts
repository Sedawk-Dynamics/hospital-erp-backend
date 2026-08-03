import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import {
  normalizeAdmissionType,
  ADMISSION_TYPE_LABELS,
  type AdmissionType,
} from '../../shared/admission-type';

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
}

export interface AdmissionBillDocument {
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
  bills: Array<{ billNumber: string; status: string; totalAmount: number }>;
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
  const ledger = await getAdmissionLedger(tenantId, admissionId, actor);

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

  // Discount / tax live on the bill headers, not on the ledger lines.
  const billHeaders = billIds.length
    ? await prisma.bill.findMany({
        where: { id: { in: billIds } },
        select: { discountAmount: true, taxAmount: true },
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

  // The ledger totals its LINE ITEMS, which excludes the bill-header discount
  // and tax — fine for the running ledger, wrong on a printed bill: a stay
  // billed 3500 less a 500 concession and paid 3000 in full would otherwise
  // print as 500 still outstanding, contradicting the receipt in the patient's
  // hand. The document therefore does its own arithmetic, using the same shape
  // as the ledger but with the header adjustments folded in.
  const netPayable = r2(Math.max(0, t.grandTotal - discount + tax - t.insuranceCovered));
  // Money the hospital is holding from this patient (mirrors the ledger).
  const moneyFromPatient = r2(t.cashPaid + t.deposit - t.depositRefunded);
  const balanceDue = r2(Math.max(0, netPayable - moneyFromPatient));
  const surplus = r2(Math.max(0, moneyFromPatient - netPayable));
  const refundable = r2(Math.min(surplus, r2(Math.max(0, t.deposit - t.depositRefunded))));
  const isPaid = balanceDue <= 0;

  return {
    admissionId,
    admissionType,
    admissionTypeLabel: ADMISSION_TYPE_LABELS[admissionType],
    isPaid,
    isDischarged,
    // An undischarged stay is still accruing, so say so on the paper rather
    // than handing the patient something that looks final and is not.
    documentTitle: isDischarged ? 'Final Bill' : 'Interim Bill',
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
    bills: ledger.bills.map((b) => ({
      billNumber: b.billNumber,
      status: b.status,
      totalAmount: b.totalAmount,
    })),
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
      grossCharges: t.grandTotal,
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
