import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import { r2 } from '../../shared/gst';
import { formatDateIST, formatDateTimeIST } from '../../shared/date.utils';
import {
  ewayCancelWindowHours,
  irnCancelWindowHours,
  resolveEInvoiceProvider,
  EINVOICE_SANDBOX_LABEL,
  EWAY_CANCEL_REASONS,
  IRN_CANCEL_REASONS,
  type EInvoiceProvider,
  type EwayBillPayload,
  type EwayCancelReasonCode,
  type IrnCancelReasonCode,
  type IrnPayload,
  type IrnPayloadItem,
  type PortalFailure,
} from '../../services/einvoice';
import { getPortalReadiness, loadPortalCredentials } from './gst-portal.credentials';

// ---------------------------------------------------------------------------
// G-5 (gap #266): actually generating the e-invoice and the e-way bill.
//
//   generate  — a finalised B2B invoice is sent to the IRP through the GSP and
//               the IRN, acknowledgement number and date, and the signed QR are
//               stored on the bill (the printed invoice already reads them).
//   retry     — the same, for a document the portal refused or never answered.
//   cancel    — within the portal's window after the acknowledgement, with a
//               reason; refused after it (a credit note is the remedy then).
//   e-way     — a vendor return (stock going back to the supplier on a road)
//               gets an e-way bill number and date on every line of the return.
//
// Idempotent by construction: a bill holding an IRN is never sent again, and
// the send is claimed with a conditional update so two clicks cannot both go.
// Every attempt — success or failure — is audited, and a failure is stored on
// the bill in the portal's own words, which is what D-2 lists.
// ---------------------------------------------------------------------------

/** A 'pending' claim older than this is treated as abandoned and may be retried. */
export const IRN_PENDING_STALE_MS = 5 * 60 * 1000;

const n = (v: unknown) => r2(Number(v ?? 0));
const PIN = /\b([1-9][0-9]{5})\b/;

function pinFrom(address: string | null | undefined): number | null {
  const m = PIN.exec(address ?? '');
  return m ? Number(m[1]) : null;
}

/** The place name in an address: the last comma part that is not just the PIN. */
function placeFrom(address: string | null | undefined, fallback: string): string {
  const parts = (address ?? '')
    .split(/[,\n]/)
    .map((s) => s.replace(PIN, '').replace(/[-–]\s*$/, '').trim())
    .filter((s) => s.length >= 3);
  return (parts[parts.length - 1] ?? fallback).slice(0, 50);
}

const text = (v: string | null | undefined, max: number, fallback = '') => (v ?? fallback).trim().slice(0, max);

async function profileAndProvider(tenantId: string, kind: 'einvoice' | 'eway') {
  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const profile = await getGstProfile(tenantId);
  const label = kind === 'einvoice' ? 'E-invoicing' : 'E-way bills';
  if (!profile.registered || !profile.gstin) {
    throw AppError.conflict('The hospital is not GST registered in GST settings', 'GST_NOT_REGISTERED');
  }
  const applicable = kind === 'einvoice' ? profile.eInvoiceApplicable : profile.eWayBillApplicable;
  if (!applicable) {
    throw AppError.conflict(`${label} is not switched on in GST settings`, 'EINVOICE_NOT_APPLICABLE');
  }
  const readiness = await getPortalReadiness(tenantId, kind);
  if (!readiness.ready) {
    throw AppError.conflict(`${label} not available: ${readiness.reason}`, 'EINVOICE_NOT_AVAILABLE');
  }
  const { provider } = resolveEInvoiceProvider();
  if (!provider) throw AppError.conflict(`${label} not available: no provider configured`, 'EINVOICE_NOT_AVAILABLE');
  const creds = await loadPortalCredentials(tenantId, kind, profile.gstin);
  return { profile, provider, creds };
}

const sandboxNote = (p: EInvoiceProvider) => (p.sandbox ? ` (${EINVOICE_SANDBOX_LABEL})` : '');

/** Never throws: an adapter exception is a failure like any other. */
async function safely<T>(fn: () => Promise<T | PortalFailure>): Promise<T | PortalFailure> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err: (err as Error)?.name }, 'E-invoice provider threw');
    return { ok: false, code: null, message: 'Unexpected error talking to the GST provider', uncertain: true };
  }
}

// ── IRN payload ─────────────────────────────────────────────────────────────

const billSelect = {
  id: true,
  tenantId: true,
  status: true,
  billDate: true,
  invoiceNumber: true,
  billOfSupplyNumber: true,
  gstDocumentType: true,
  supplierGstin: true,
  supplierStateCode: true,
  recipientGstin: true,
  recipientLegalName: true,
  recipientAddress: true,
  placeOfSupplyStateCode: true,
  isInterState: true,
  roundOff: true,
  irn: true,
  irnAckNo: true,
  irnAckDate: true,
  irnQrPayload: true,
  irnStatus: true,
  irnError: true,
  irnAttemptedAt: true,
  irnCancelledAt: true,
  billItems: {
    select: {
      description: true,
      category: true,
      quantity: true,
      discountAmount: true,
      hsnSacCode: true,
      gstTreatment: true,
      taxableValue: true,
      cgstRate: true,
      cgstAmount: true,
      sgstRate: true,
      sgstAmount: true,
      igstRate: true,
      igstAmount: true,
      cessAmount: true,
    },
  },
} as const;

type BillForIrn = NonNullable<Awaited<ReturnType<typeof loadBill>>>;

function loadBill(tenantId: string, billId: string) {
  return prisma.bill.findFirst({ where: { id: billId, tenantId }, select: billSelect });
}

interface Seller {
  gstin: string;
  legalName: string;
  tradeName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  email: string | null;
}

/** One line of an IRN document, already in positive rupees. */
interface IrnDocLine {
  description: string;
  quantity: number;
  discount: number;
  hsnSacCode: string | null;
  taxableValue: number;
  /** The combined GST rate on the line (IGST, or CGST + SGST). */
  rate: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

/** What any IRN document — invoice, credit note, debit note — is built from. */
interface IrnDoc {
  typ: 'INV' | 'CRN' | 'DBN';
  /** 'invoice' | 'note', for the problem sentences. */
  word: string;
  number: string;
  date: Date;
  supplierGstin: string | null;
  supplierStateCode: string | null;
  buyerGstin: string;
  buyerLegalName: string | null;
  buyerAddress: string | null;
  placeOfSupplyStateCode: string | null;
  /** The document's stored split. Decides the place of supply when none is stored. */
  isInterState: boolean;
  /** Where the buyer details are corrected, for the problem sentences. */
  buyerWhere: string;
  roundOff: number;
  lines: IrnDocLine[];
  /** The invoice a credit / debit note adjusts. */
  ref?: { number: string; date: Date };
}

function buildIrnDocPayload(doc: IrnDoc, seller: Seller): { payload: IrnPayload } | { problems: string[] } {
  const problems: string[] = [];
  const buyerGstin = doc.buyerGstin;
  if (!doc.buyerLegalName?.trim()) problems.push(`the buyer's legal name is missing — set it on ${doc.buyerWhere}`);
  if (!doc.buyerAddress?.trim()) problems.push(`the buyer's address is missing — set it on ${doc.buyerWhere}`);
  const lines = doc.lines;
  if (!lines.length) problems.push(`the ${doc.word} has no lines to register`);

  const items: IrnPayloadItem[] = lines.map((l, i) => {
    const hsn = (l.hsnSacCode ?? '').replace(/\D/g, '');
    if (hsn.length < 4) problems.push(`line ${i + 1} ("${l.description.slice(0, 40)}") has no HSN/SAC code`);
    const assAmt = l.taxableValue;
    const discount = l.discount;
    const qty = Math.max(1, Number(l.quantity) || 1);
    const totAmt = r2(assAmt + discount);
    const igst = l.igst;
    const cgst = l.cgst;
    const sgst = l.sgst;
    const cess = l.cess;
    const rate = l.rate;
    const isService = hsn.startsWith('99');
    return {
      SlNo: String(i + 1),
      PrdDesc: l.description.slice(0, 300),
      IsServc: isService ? 'Y' : 'N',
      HsnCd: hsn,
      Qty: qty,
      Unit: isService ? 'OTH' : 'NOS',
      UnitPrice: r2(totAmt / qty),
      TotAmt: totAmt,
      Discount: discount,
      AssAmt: assAmt,
      GstRt: rate,
      IgstAmt: igst,
      CgstAmt: cgst,
      SgstAmt: sgst,
      CesAmt: cess,
      TotItemVal: r2(assAmt + igst + cgst + sgst + cess),
    };
  });
  // #265: with no place of supply stored, what the tax says — only IGST is
  // elsewhere. The portal refuses a document whose place of supply and tax
  // disagree (IGST inside the state, CGST + SGST outside it); said here, in words.
  const sellerState = doc.supplierStateCode ?? seller.gstin.slice(0, 2);
  const buyerState = buyerGstin.slice(0, 2);
  const pos = doc.placeOfSupplyStateCode ?? (doc.isInterState ? buyerState : sellerState);
  const hasIgst = items.some((i) => i.IgstAmt > 0);
  const hasCgst = items.some((i) => i.CgstAmt > 0 || i.SgstAmt > 0);
  if ((pos === sellerState && hasIgst) || (pos !== sellerState && hasCgst)) {
    problems.push(
      `the place of supply (state ${pos}) does not match the tax on the ${doc.word} (${hasIgst ? 'IGST' : 'CGST + SGST'})`,
    );
  }
  if (problems.length) return { problems };

  const sum = (f: (i: IrnPayloadItem) => number) => r2(items.reduce((t, i) => t + f(i), 0));
  const assVal = sum((i) => i.AssAmt);
  const cgstVal = sum((i) => i.CgstAmt);
  const sgstVal = sum((i) => i.SgstAmt);
  const igstVal = sum((i) => i.IgstAmt);
  const cesVal = sum((i) => i.CesAmt);
  const rnd = doc.roundOff;

  return {
    payload: {
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
      DocDtls: { Typ: doc.typ, No: doc.number, Dt: formatDateIST(doc.date) },
      SellerDtls: {
        Gstin: doc.supplierGstin ?? seller.gstin,
        LglNm: text(seller.legalName, 100),
        ...(seller.tradeName ? { TrdNm: text(seller.tradeName, 100) } : {}),
        Addr1: text(seller.address, 100, seller.city ?? seller.legalName),
        Loc: text(seller.city, 50) || placeFrom(seller.address, seller.state ?? 'NA'),
        Pin: pinFrom(seller.address),
        Stcd: sellerState,
        ...(seller.phone ? { Ph: seller.phone.replace(/\D/g, '').slice(-12) } : {}),
        ...(seller.email ? { Em: text(seller.email, 100) } : {}),
      },
      BuyerDtls: {
        Gstin: buyerGstin,
        LglNm: text(doc.buyerLegalName, 100),
        Addr1: text(doc.buyerAddress, 100),
        Loc: placeFrom(doc.buyerAddress, 'NA'),
        Pin: pinFrom(doc.buyerAddress),
        Stcd: buyerState,
        // #265: the document's own place of supply — the hospital's state for a
        // health service whoever the buyer is.
        Pos: pos,
      },
      ...(doc.ref ? { RefDtls: { PrecDocDtls: [{ InvNo: doc.ref.number, InvDt: formatDateIST(doc.ref.date) }] } } : {}),
      ItemList: items,
      ValDtls: {
        AssVal: assVal,
        CgstVal: cgstVal,
        SgstVal: sgstVal,
        IgstVal: igstVal,
        CesVal: cesVal,
        Discount: 0,
        RndOffAmt: rnd,
        TotInvVal: r2(assVal + cgstVal + sgstVal + igstVal + cesVal + rnd),
      },
    },
  };
}

/**
 * The portal's invoice JSON for a bill, or the reasons it cannot be built.
 * Exported for tests.
 */
export function buildIrnPayload(bill: BillForIrn, seller: Seller): { payload: IrnPayload } | { problems: string[] } {
  // Where the recipient was also owed a bill of supply, the exempt lines are
  // on THAT document; the e-invoice is the tax invoice's lines only.
  const lines = bill.billItems.filter((l) =>
    bill.billOfSupplyNumber ? (l.gstTreatment ?? 'taxable') === 'taxable' : true,
  );
  return buildIrnDocPayload(
    {
      typ: 'INV',
      word: 'invoice',
      number: bill.invoiceNumber!,
      date: bill.billDate,
      supplierGstin: bill.supplierGstin,
      supplierStateCode: bill.supplierStateCode,
      buyerGstin: bill.recipientGstin ?? '',
      buyerLegalName: bill.recipientLegalName,
      buyerAddress: bill.recipientAddress,
      placeOfSupplyStateCode: bill.placeOfSupplyStateCode,
      isInterState: bill.isInterState,
      buyerWhere: "the bill's B2B buyer details",
      // The bill's round-off belongs to the whole bill; only carried when every line is on this document.
      roundOff: lines.length === bill.billItems.length ? n(bill.roundOff) : 0,
      lines: lines.map((l) => ({
        description: l.description,
        quantity: Number(l.quantity),
        discount: n(l.discountAmount),
        hsnSacCode: l.hsnSacCode,
        taxableValue: n(l.taxableValue),
        rate: bill.isInterState ? n(l.igstRate) : r2(n(l.cgstRate) + n(l.sgstRate)),
        igst: n(l.igstAmount),
        cgst: n(l.cgstAmount),
        sgst: n(l.sgstAmount),
        cess: n(l.cessAmount),
      })),
    },
    seller,
  );
}

/** The hospital as seller, from its GST profile and tenant record. */
async function sellerFor(tenantId: string, profile: { gstin: string | null; legalName: string | null; tradeName: string | null }): Promise<Seller> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId },
    select: { name: true, address: true, city: true, state: true, phone: true, email: true },
  });
  return {
    gstin: profile.gstin!,
    legalName: profile.legalName ?? tenant?.name ?? '',
    tradeName: profile.tradeName,
    address: tenant?.address ?? null,
    city: tenant?.city ?? null,
    state: tenant?.state ?? null,
    phone: tenant?.phone ?? null,
    email: tenant?.email ?? null,
  };
}

export interface IrnOutcome {
  billId: string;
  invoiceNumber: string | null;
  status: 'registered' | 'failed' | 'cancelled' | 'pending';
  irn: string | null;
  ackNo: string | null;
  ackDate: string | null;
  signedQrCode: boolean;
  error: string | null;
  /** True when the bill already carried an IRN and nothing was sent. */
  alreadyRegistered: boolean;
  provider: string | null;
  sandbox: boolean;
}

const outcomeOf = (
  b: Pick<BillForIrn, 'id' | 'invoiceNumber' | 'irn' | 'irnAckNo' | 'irnAckDate' | 'irnQrPayload' | 'irnStatus' | 'irnError'>,
  extra: Partial<IrnOutcome> = {},
): IrnOutcome => ({
  billId: b.id,
  invoiceNumber: b.invoiceNumber,
  status: (b.irnStatus as IrnOutcome['status']) ?? (b.irn ? 'registered' : 'failed'),
  irn: b.irn,
  ackNo: b.irnAckNo,
  ackDate: b.irnAckDate ? b.irnAckDate.toISOString() : null,
  signedQrCode: !!b.irnQrPayload,
  error: b.irnError,
  alreadyRegistered: false,
  provider: null,
  sandbox: false,
  ...extra,
});

/**
 * Generate — or, with mode 'retry', re-send — the IRN for one finalised B2B
 * invoice.
 */
export async function generateIrnForBill(
  tenantId: string,
  userId: string,
  billId: string,
  mode: 'generate' | 'retry' = 'generate',
): Promise<IrnOutcome> {
  const bill = await loadBill(tenantId, billId);
  if (!bill) throw AppError.notFound('Bill not found');
  const doc = bill.invoiceNumber ?? bill.id;

  // Idempotency first: a bill holding an IRN is never sent again.
  if (bill.irn && bill.irnStatus !== 'failed') {
    if (bill.irnStatus === 'cancelled' || bill.irnCancelledAt) {
      throw AppError.conflict(
        `The IRN for ${doc} was cancelled. The portal does not accept the same invoice number again — issue a fresh invoice.`,
        'IRN_CANCELLED',
      );
    }
    return outcomeOf(bill, { status: 'registered', alreadyRegistered: true });
  }

  if (bill.status === 'cancelled') throw AppError.conflict(`${doc} is cancelled; a cancelled bill is not registered`, 'BILL_CANCELLED');
  if (!bill.invoiceNumber) {
    throw AppError.conflict('Finalise the bill first: only an issued tax invoice (with an invoice number) can be sent for an IRN', 'BILL_NOT_FINALISED');
  }
  if (!bill.recipientGstin) {
    throw AppError.conflict(`${doc} has no buyer GSTIN: it is a B2C bill and needs no IRN`, 'NOT_B2B');
  }
  if (bill.gstDocumentType === 'bill_of_supply') {
    throw AppError.conflict(`${doc} is a bill of supply; only a tax invoice is registered on the IRP`, 'NOT_TAX_INVOICE');
  }

  const now = new Date();
  const stalePending = bill.irnStatus === 'pending' && (!bill.irnAttemptedAt || now.getTime() - bill.irnAttemptedAt.getTime() > IRN_PENDING_STALE_MS);
  if (bill.irnStatus === 'pending' && !stalePending) {
    throw AppError.conflict(`${doc} is already being sent to the portal — wait for its answer`, 'IRN_IN_FLIGHT');
  }
  if (mode === 'retry' && bill.irnStatus !== 'failed' && !stalePending) {
    throw AppError.conflict(`Nothing to retry: ${doc} has not failed`, 'IRN_NOTHING_TO_RETRY');
  }
  const verb = bill.irnStatus === 'failed' || stalePending ? 'retry' : 'generate';

  const { profile, provider, creds } = await profileAndProvider(tenantId, 'einvoice');

  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId },
    select: { name: true, address: true, city: true, state: true, phone: true, email: true },
  });
  const built = buildIrnPayload(bill, {
    gstin: profile.gstin!,
    legalName: profile.legalName ?? tenant?.name ?? '',
    tradeName: profile.tradeName,
    address: tenant?.address ?? null,
    city: tenant?.city ?? null,
    state: tenant?.state ?? null,
    phone: tenant?.phone ?? null,
    email: tenant?.email ?? null,
  });

  // Claim the send. Only one request can move the bill out of never-sent /
  // failed / abandoned-pending, so a double click cannot register it twice.
  const claimable = {
    id: bill.id,
    tenantId,
    irn: null,
    OR: [
      { irnStatus: null },
      { irnStatus: 'failed' },
      { irnStatus: 'pending', irnAttemptedAt: { lt: new Date(now.getTime() - IRN_PENDING_STALE_MS) } },
      { irnStatus: 'pending', irnAttemptedAt: null },
    ],
  };

  const audit = (description: string, newValues: Record<string, unknown>) =>
    writeAudit({
      tenantId,
      userId,
      action: 'update',
      entityType: 'bill',
      entityId: bill.id,
      description,
      oldValues: { irnStatus: bill.irnStatus, irnError: bill.irnError },
      newValues: { ...newValues, provider: provider.name, sandbox: provider.sandbox, mode: verb },
    });

  if ('problems' in built) {
    // Not sent: the portal would refuse it anyway. Recorded as a failure so
    // D-2 lists it with the reason and a Retry once it is corrected.
    const message = `Not sent to the portal — ${built.problems.join('; ')}`.slice(0, 1000);
    const claimed = await prisma.bill.updateMany({
      where: claimable,
      data: { irnStatus: 'failed', irnError: message, irnAttemptedAt: now },
    });
    if (claimed.count === 0) throw AppError.conflict(`${doc} is already being sent to the portal`, 'IRN_IN_FLIGHT');
    await audit(`IRN ${verb} for invoice ${doc} not sent: ${message}`, { irnStatus: 'failed', irnError: message });
    return outcomeOf({ ...bill, irnStatus: 'failed', irnError: message }, { provider: provider.name, sandbox: provider.sandbox });
  }

  const claimed = await prisma.bill.updateMany({
    where: claimable,
    data: { irnStatus: 'pending', irnAttemptedAt: now, irnError: null },
  });
  if (claimed.count === 0) throw AppError.conflict(`${doc} is already being sent to the portal`, 'IRN_IN_FLIGHT');

  const result = await safely(() => provider.generateIrn(creds, built.payload));

  if (result.ok) {
    const note = result.duplicate
      ? 'The portal already held this invoice and returned its IRN; the signed QR was not resent — download it from the portal if it is needed on the print.'
      : null;
    try {
      await prisma.bill.update({
        where: { id: bill.id },
        data: {
          irn: result.irn,
          irnAckNo: result.ackNo.slice(0, 30),
          irnAckDate: result.ackDate,
          irnQrPayload: result.signedQrCode,
          irnStatus: 'registered',
          irnError: note,
        },
      });
    } catch (err) {
      // The unique IRN column: the same IRN already on another bill means the
      // same invoice was registered twice in this system.
      const message =
        (err as { code?: string })?.code === 'P2002'
          ? `The portal returned IRN ${result.irn}, which is already recorded on another bill`
          : 'The portal registered the invoice but the IRN could not be saved — Retry to recover it';
      await prisma.bill.update({ where: { id: bill.id }, data: { irnStatus: 'failed', irnError: message } });
      await audit(`IRN ${verb} for invoice ${doc}: portal answered but saving failed — ${message}`, { irn: result.irn, irnStatus: 'failed' });
      return outcomeOf({ ...bill, irnStatus: 'failed', irnError: message }, { provider: provider.name, sandbox: provider.sandbox });
    }
    await audit(
      `IRN ${verb === 'retry' ? 'generated on retry' : 'generated'} for invoice ${doc} via ${provider.name}${sandboxNote(provider)}: IRN ${result.irn}, Ack ${result.ackNo} at ${formatDateTimeIST(result.ackDate)} IST${result.duplicate ? ' (duplicate — portal already held it)' : ''}`,
      { irn: result.irn, irnAckNo: result.ackNo, irnAckDate: result.ackDate.toISOString(), irnStatus: 'registered' },
    );
    return outcomeOf(
      {
        ...bill,
        irn: result.irn,
        irnAckNo: result.ackNo,
        irnAckDate: result.ackDate,
        irnQrPayload: result.signedQrCode,
        irnStatus: 'registered',
        irnError: note,
      },
      { provider: provider.name, sandbox: provider.sandbox },
    );
  }

  const message = (
    result.uncertain
      ? `${result.message}. The portal may still have registered it — Retry will pick up the existing IRN.`
      : result.message
  ).slice(0, 1000);
  await prisma.bill.update({ where: { id: bill.id }, data: { irnStatus: 'failed', irnError: message } });
  await audit(`IRN ${verb} for invoice ${doc} failed via ${provider.name}${sandboxNote(provider)}: ${message}`, {
    irnStatus: 'failed',
    irnError: message,
    portalCode: result.code,
  });
  return outcomeOf({ ...bill, irnStatus: 'failed', irnError: message }, { provider: provider.name, sandbox: provider.sandbox });
}

/** Cancel a registered IRN, within the portal's window after the acknowledgement. */
export async function cancelIrnForBill(
  tenantId: string,
  userId: string,
  billId: string,
  input: { reasonCode?: unknown; remark?: unknown },
  now: Date = new Date(),
): Promise<IrnOutcome & { cancelledAt: string | null }> {
  const reasonCode = String(input.reasonCode ?? '') as IrnCancelReasonCode;
  if (!(reasonCode in IRN_CANCEL_REASONS)) {
    throw AppError.badRequest('Choose a cancellation reason: 1 Duplicate, 2 Data entry mistake, 3 Order cancelled, 4 Others');
  }
  const remark = typeof input.remark === 'string' ? input.remark.trim() : '';
  if (remark.length < 3) throw AppError.badRequest('A cancellation remark is required');
  if (remark.length > 100) throw AppError.badRequest('The cancellation remark must be 100 characters or fewer');

  const bill = await loadBill(tenantId, billId);
  if (!bill) throw AppError.notFound('Bill not found');
  const doc = bill.invoiceNumber ?? bill.id;
  if (bill.irnStatus === 'cancelled' || bill.irnCancelledAt) {
    throw AppError.conflict(`The IRN for ${doc} is already cancelled`, 'IRN_ALREADY_CANCELLED');
  }
  if (!bill.irn || bill.irnStatus !== 'registered') {
    throw AppError.conflict(`${doc} has no registered IRN to cancel`, 'IRN_NOT_REGISTERED');
  }
  const hours = irnCancelWindowHours();
  const ack = bill.irnAckDate;
  if (!ack || now.getTime() > ack.getTime() + hours * 60 * 60 * 1000) {
    throw AppError.conflict(
      `The IRN for ${doc} can only be cancelled within ${hours} hours of its acknowledgement` +
        (ack ? ` (acknowledged ${formatDateTimeIST(ack)} IST)` : '') +
        '. Raise a credit note against the invoice instead.',
      'IRN_CANCEL_WINDOW_CLOSED',
    );
  }

  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const profile = await getGstProfile(tenantId);
  // Cancelling must work even if the hospital has since switched e-invoicing
  // off — but only through a provider that is actually there.
  const readiness = await getPortalReadiness(tenantId, 'einvoice');
  if (!readiness.ready) throw AppError.conflict(`E-invoicing not available: ${readiness.reason}`, 'EINVOICE_NOT_AVAILABLE');
  const { provider } = resolveEInvoiceProvider();
  if (!provider) throw AppError.conflict('E-invoicing not available: no provider configured', 'EINVOICE_NOT_AVAILABLE');
  const creds = await loadPortalCredentials(tenantId, 'einvoice', profile.gstin);

  const result = await safely(() => provider.cancelIrn(creds, { irn: bill.irn!, reasonCode, remark }));
  const reasonText = `${IRN_CANCEL_REASONS[reasonCode]} — ${remark}`;

  if (!result.ok) {
    await writeAudit({
      tenantId,
      userId,
      action: 'update',
      entityType: 'bill',
      entityId: bill.id,
      description: `IRN cancellation for invoice ${doc} refused via ${provider.name}${sandboxNote(provider)}: ${result.message}`,
      reason: reasonText,
      newValues: { irn: bill.irn, portalCode: result.code, provider: provider.name, sandbox: provider.sandbox },
    });
    throw new AppError(`The portal did not cancel the IRN: ${result.message}`, 502, 'IRN_CANCEL_FAILED');
  }

  await prisma.bill.updateMany({
    where: { id: bill.id, tenantId, irnStatus: 'registered' },
    data: { irnStatus: 'cancelled', irnCancelledAt: result.cancelledAt },
  });
  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'bill',
    entityId: bill.id,
    description: `IRN ${bill.irn} for invoice ${doc} cancelled via ${provider.name}${sandboxNote(provider)} at ${formatDateTimeIST(result.cancelledAt)} IST`,
    reason: reasonText,
    oldValues: { irnStatus: 'registered' },
    newValues: { irnStatus: 'cancelled', irnCancelledAt: result.cancelledAt.toISOString(), reasonCode, provider: provider.name, sandbox: provider.sandbox },
  });
  return {
    ...outcomeOf({ ...bill, irnStatus: 'cancelled' }, { provider: provider.name, sandbox: provider.sandbox }),
    cancelledAt: result.cancelledAt.toISOString(),
  };
}

// ── Credit and debit notes against a B2B invoice ───────────────────────────
//
// A note raised against an invoice to a REGISTERED buyer is an e-invoice
// document in its own right (document type CRN / DBN), naming the invoice it
// adjusts. Same rules as the invoice: idempotent, claimed before sending,
// every attempt audited, a failure stored in the portal's words for D-2, and
// cancellation only inside the window after the acknowledgement.

const noteSelect = {
  id: true,
  tenantId: true,
  creditNoteNumber: true,
  noteType: true,
  issueDate: true,
  supplierGstin: true,
  placeOfSupplyStateCode: true,
  recipientGstin: true,
  irn: true,
  irnAckNo: true,
  irnAckDate: true,
  irnQrPayload: true,
  irnStatus: true,
  irnError: true,
  irnAttemptedAt: true,
  irnCancelledAt: true,
  items: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      description: true,
      hsnSacCode: true,
      gstTreatment: true,
      quantity: true,
      taxableValue: true,
      taxPercent: true,
      cgstAmount: true,
      sgstAmount: true,
      igstAmount: true,
      cessAmount: true,
    },
  },
  bill: {
    select: {
      id: true,
      invoiceNumber: true,
      billDate: true,
      billOfSupplyNumber: true,
      gstDocumentType: true,
      recipientGstin: true,
      recipientLegalName: true,
      recipientAddress: true,
      supplierStateCode: true,
      placeOfSupplyStateCode: true,
      isInterState: true,
    },
  },
} as const;

type NoteForIrn = NonNullable<Awaited<ReturnType<typeof loadNote>>>;

function loadNote(tenantId: string, noteId: string) {
  return prisma.creditNote.findFirst({ where: { id: noteId, tenantId }, select: noteSelect });
}

const absN = (v: unknown) => Math.abs(n(v));
const noteLabel = (note: { noteType: string | null }) => (note.noteType === 'debit' ? 'debit note' : 'credit note');

/**
 * The portal's JSON for a credit / debit note, or the reasons it cannot be
 * built. The note's lines are stored negative (a credit) — the portal wants the
 * document's own magnitudes, the type saying which way they go. Exported for tests.
 */
export function buildNoteIrnPayload(note: NoteForIrn, seller: Seller): { payload: IrnPayload } | { problems: string[] } {
  const bill = note.bill;
  const lines = note.items.filter((l) => (bill.billOfSupplyNumber ? (l.gstTreatment ?? 'taxable') === 'taxable' : true));
  return buildIrnDocPayload(
    {
      typ: note.noteType === 'debit' ? 'DBN' : 'CRN',
      word: 'note',
      number: note.creditNoteNumber,
      date: note.issueDate,
      supplierGstin: note.supplierGstin,
      supplierStateCode: bill.supplierStateCode,
      buyerGstin: note.recipientGstin ?? '',
      buyerLegalName: bill.recipientLegalName,
      buyerAddress: bill.recipientAddress,
      // A note follows the document it adjusts.
      placeOfSupplyStateCode: note.placeOfSupplyStateCode ?? bill.placeOfSupplyStateCode,
      isInterState: bill.isInterState,
      buyerWhere: `the B2B buyer details of invoice ${bill.invoiceNumber ?? ''}`.trim(),
      roundOff: 0,
      lines: lines.map((l) => {
        const igst = absN(l.igstAmount);
        return {
          description: l.description,
          quantity: Math.abs(Number(l.quantity)),
          discount: 0,
          hsnSacCode: l.hsnSacCode,
          taxableValue: absN(l.taxableValue),
          rate: absN(l.taxPercent),
          igst,
          cgst: absN(l.cgstAmount),
          sgst: absN(l.sgstAmount),
          cess: absN(l.cessAmount),
        };
      }),
      ref: bill.invoiceNumber ? { number: bill.invoiceNumber, date: bill.billDate } : undefined,
    },
    seller,
  );
}

export interface NoteIrnOutcome {
  noteId: string;
  noteNumber: string;
  noteType: 'credit' | 'debit';
  status: 'registered' | 'failed' | 'cancelled' | 'pending';
  irn: string | null;
  ackNo: string | null;
  ackDate: string | null;
  signedQrCode: boolean;
  error: string | null;
  alreadyRegistered: boolean;
  provider: string | null;
  sandbox: boolean;
}

const noteOutcomeOf = (
  c: Pick<NoteForIrn, 'id' | 'creditNoteNumber' | 'noteType' | 'irn' | 'irnAckNo' | 'irnAckDate' | 'irnQrPayload' | 'irnStatus' | 'irnError'>,
  extra: Partial<NoteIrnOutcome> = {},
): NoteIrnOutcome => ({
  noteId: c.id,
  noteNumber: c.creditNoteNumber,
  noteType: c.noteType === 'debit' ? 'debit' : 'credit',
  status: (c.irnStatus as NoteIrnOutcome['status']) ?? (c.irn ? 'registered' : 'failed'),
  irn: c.irn,
  ackNo: c.irnAckNo,
  ackDate: c.irnAckDate ? c.irnAckDate.toISOString() : null,
  signedQrCode: !!c.irnQrPayload,
  error: c.irnError,
  alreadyRegistered: false,
  provider: null,
  sandbox: false,
  ...extra,
});

/**
 * Generate — or, with mode 'retry', re-send — the IRN for a credit or debit
 * note raised against a B2B invoice.
 */
export async function generateIrnForNote(
  tenantId: string,
  userId: string,
  noteId: string,
  mode: 'generate' | 'retry' = 'generate',
): Promise<NoteIrnOutcome> {
  const note = await loadNote(tenantId, noteId);
  if (!note) throw AppError.notFound('Credit / debit note not found');
  const label = noteLabel(note);
  const doc = `${label} ${note.creditNoteNumber}`;

  if (note.irn && note.irnStatus !== 'failed') {
    if (note.irnStatus === 'cancelled' || note.irnCancelledAt) {
      throw AppError.conflict(
        `The IRN for ${doc} was cancelled. The portal does not accept the same note number again — issue a fresh note.`,
        'IRN_CANCELLED',
      );
    }
    return noteOutcomeOf(note, { status: 'registered', alreadyRegistered: true });
  }

  // B2B only: the note's own buyer AND the invoice it adjusts.
  if (!note.recipientGstin) {
    throw AppError.conflict(`${doc} has no buyer GSTIN: it is a B2C note and needs no IRN`, 'NOT_B2B');
  }
  const bill = note.bill;
  if (!bill?.invoiceNumber || !bill.recipientGstin || bill.gstDocumentType === 'bill_of_supply') {
    throw AppError.conflict(
      `${doc} adjusts ${bill?.invoiceNumber ?? 'a document'} which is not a B2B tax invoice; only a note against a B2B invoice is registered on the IRP`,
      'ORIGINAL_NOT_B2B',
    );
  }

  const now = new Date();
  const stalePending =
    note.irnStatus === 'pending' && (!note.irnAttemptedAt || now.getTime() - note.irnAttemptedAt.getTime() > IRN_PENDING_STALE_MS);
  if (note.irnStatus === 'pending' && !stalePending) {
    throw AppError.conflict(`${doc} is already being sent to the portal — wait for its answer`, 'IRN_IN_FLIGHT');
  }
  if (mode === 'retry' && note.irnStatus !== 'failed' && !stalePending) {
    throw AppError.conflict(`Nothing to retry: ${doc} has not failed`, 'IRN_NOTHING_TO_RETRY');
  }
  const verb = note.irnStatus === 'failed' || stalePending ? 'retry' : 'generate';

  const { profile, provider, creds } = await profileAndProvider(tenantId, 'einvoice');
  const built = buildNoteIrnPayload(note, await sellerFor(tenantId, profile));

  const claimable = {
    id: note.id,
    tenantId,
    irn: null,
    OR: [
      { irnStatus: null },
      { irnStatus: 'failed' },
      { irnStatus: 'pending', irnAttemptedAt: { lt: new Date(now.getTime() - IRN_PENDING_STALE_MS) } },
      { irnStatus: 'pending', irnAttemptedAt: null },
    ],
  };
  const sent = { provider: provider.name, sandbox: provider.sandbox };
  const audit = (description: string, newValues: Record<string, unknown>) =>
    writeAudit({
      tenantId,
      userId,
      action: 'update',
      entityType: 'credit_note',
      entityId: note.id,
      description,
      oldValues: { irnStatus: note.irnStatus, irnError: note.irnError },
      newValues: { ...newValues, ...sent, mode: verb, documentType: note.noteType === 'debit' ? 'DBN' : 'CRN' },
    });

  if ('problems' in built) {
    const message = `Not sent to the portal — ${built.problems.join('; ')}`.slice(0, 1000);
    const claimed = await prisma.creditNote.updateMany({
      where: claimable,
      data: { irnStatus: 'failed', irnError: message, irnAttemptedAt: now },
    });
    if (claimed.count === 0) throw AppError.conflict(`${doc} is already being sent to the portal`, 'IRN_IN_FLIGHT');
    await audit(`IRN ${verb} for ${doc} not sent: ${message}`, { irnStatus: 'failed', irnError: message });
    return noteOutcomeOf({ ...note, irnStatus: 'failed', irnError: message }, sent);
  }

  const claimed = await prisma.creditNote.updateMany({
    where: claimable,
    data: { irnStatus: 'pending', irnAttemptedAt: now, irnError: null },
  });
  if (claimed.count === 0) throw AppError.conflict(`${doc} is already being sent to the portal`, 'IRN_IN_FLIGHT');

  const result = await safely(() => provider.generateIrn(creds, built.payload));

  if (result.ok) {
    const dupNote = result.duplicate
      ? 'The portal already held this note and returned its IRN; the signed QR was not resent — download it from the portal if it is needed on the print.'
      : null;
    try {
      await prisma.creditNote.update({
        where: { id: note.id },
        data: {
          irn: result.irn,
          irnAckNo: result.ackNo.slice(0, 30),
          irnAckDate: result.ackDate,
          irnQrPayload: result.signedQrCode,
          irnStatus: 'registered',
          irnError: dupNote,
        },
      });
    } catch (err) {
      const message =
        (err as { code?: string })?.code === 'P2002'
          ? `The portal returned IRN ${result.irn}, which is already recorded on another note`
          : 'The portal registered the note but the IRN could not be saved — Retry to recover it';
      await prisma.creditNote.update({ where: { id: note.id }, data: { irnStatus: 'failed', irnError: message } });
      await audit(`IRN ${verb} for ${doc}: portal answered but saving failed — ${message}`, { irn: result.irn, irnStatus: 'failed' });
      return noteOutcomeOf({ ...note, irnStatus: 'failed', irnError: message }, sent);
    }
    await audit(
      `IRN ${verb === 'retry' ? 'generated on retry' : 'generated'} for ${doc} (against invoice ${bill.invoiceNumber}) via ${provider.name}${sandboxNote(provider)}: IRN ${result.irn}, Ack ${result.ackNo} at ${formatDateTimeIST(result.ackDate)} IST${result.duplicate ? ' (duplicate — portal already held it)' : ''}`,
      { irn: result.irn, irnAckNo: result.ackNo, irnAckDate: result.ackDate.toISOString(), irnStatus: 'registered' },
    );
    return noteOutcomeOf(
      {
        ...note,
        irn: result.irn,
        irnAckNo: result.ackNo,
        irnAckDate: result.ackDate,
        irnQrPayload: result.signedQrCode,
        irnStatus: 'registered',
        irnError: dupNote,
      },
      sent,
    );
  }

  const message = (
    result.uncertain ? `${result.message}. The portal may still have registered it — Retry will pick up the existing IRN.` : result.message
  ).slice(0, 1000);
  await prisma.creditNote.update({ where: { id: note.id }, data: { irnStatus: 'failed', irnError: message } });
  await audit(`IRN ${verb} for ${doc} failed via ${provider.name}${sandboxNote(provider)}: ${message}`, {
    irnStatus: 'failed',
    irnError: message,
    portalCode: result.code,
  });
  return noteOutcomeOf({ ...note, irnStatus: 'failed', irnError: message }, sent);
}

function parseIrnCancelInput(input: { reasonCode?: unknown; remark?: unknown }) {
  const reasonCode = String(input.reasonCode ?? '') as IrnCancelReasonCode;
  if (!(reasonCode in IRN_CANCEL_REASONS)) {
    throw AppError.badRequest('Choose a cancellation reason: 1 Duplicate, 2 Data entry mistake, 3 Order cancelled, 4 Others');
  }
  const remark = typeof input.remark === 'string' ? input.remark.trim() : '';
  if (remark.length < 3) throw AppError.badRequest('A cancellation remark is required');
  if (remark.length > 100) throw AppError.badRequest('The cancellation remark must be 100 characters or fewer');
  return { reasonCode, remark };
}

/** Cancel a note's registered IRN, within the portal's window after the acknowledgement. */
export async function cancelIrnForNote(
  tenantId: string,
  userId: string,
  noteId: string,
  input: { reasonCode?: unknown; remark?: unknown },
  now: Date = new Date(),
): Promise<NoteIrnOutcome & { cancelledAt: string | null }> {
  const { reasonCode, remark } = parseIrnCancelInput(input);
  const note = await loadNote(tenantId, noteId);
  if (!note) throw AppError.notFound('Credit / debit note not found');
  const doc = `${noteLabel(note)} ${note.creditNoteNumber}`;
  if (note.irnStatus === 'cancelled' || note.irnCancelledAt) {
    throw AppError.conflict(`The IRN for ${doc} is already cancelled`, 'IRN_ALREADY_CANCELLED');
  }
  if (!note.irn || note.irnStatus !== 'registered') {
    throw AppError.conflict(`${doc} has no registered IRN to cancel`, 'IRN_NOT_REGISTERED');
  }
  const hours = irnCancelWindowHours();
  const ack = note.irnAckDate;
  if (!ack || now.getTime() > ack.getTime() + hours * 60 * 60 * 1000) {
    throw AppError.conflict(
      `The IRN for ${doc} can only be cancelled within ${hours} hours of its acknowledgement` +
        (ack ? ` (acknowledged ${formatDateTimeIST(ack)} IST)` : '') +
        '. Issue a fresh note to correct it instead.',
      'IRN_CANCEL_WINDOW_CLOSED',
    );
  }

  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const profile = await getGstProfile(tenantId);
  const readiness = await getPortalReadiness(tenantId, 'einvoice');
  if (!readiness.ready) throw AppError.conflict(`E-invoicing not available: ${readiness.reason}`, 'EINVOICE_NOT_AVAILABLE');
  const { provider } = resolveEInvoiceProvider();
  if (!provider) throw AppError.conflict('E-invoicing not available: no provider configured', 'EINVOICE_NOT_AVAILABLE');
  const creds = await loadPortalCredentials(tenantId, 'einvoice', profile.gstin);

  const result = await safely(() => provider.cancelIrn(creds, { irn: note.irn!, reasonCode, remark }));
  const reasonText = `${IRN_CANCEL_REASONS[reasonCode]} — ${remark}`;
  const sent = { provider: provider.name, sandbox: provider.sandbox };

  if (!result.ok) {
    await writeAudit({
      tenantId,
      userId,
      action: 'update',
      entityType: 'credit_note',
      entityId: note.id,
      description: `IRN cancellation for ${doc} refused via ${provider.name}${sandboxNote(provider)}: ${result.message}`,
      reason: reasonText,
      newValues: { irn: note.irn, portalCode: result.code, ...sent },
    });
    throw new AppError(`The portal did not cancel the IRN: ${result.message}`, 502, 'IRN_CANCEL_FAILED');
  }

  await prisma.creditNote.updateMany({
    where: { id: note.id, tenantId, irnStatus: 'registered' },
    data: { irnStatus: 'cancelled', irnCancelledAt: result.cancelledAt },
  });
  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'credit_note',
    entityId: note.id,
    description: `IRN ${note.irn} for ${doc} cancelled via ${provider.name}${sandboxNote(provider)} at ${formatDateTimeIST(result.cancelledAt)} IST`,
    reason: reasonText,
    oldValues: { irnStatus: 'registered' },
    newValues: { irnStatus: 'cancelled', irnCancelledAt: result.cancelledAt.toISOString(), reasonCode, ...sent },
  });
  return {
    ...noteOutcomeOf({ ...note, irnStatus: 'cancelled' }, sent),
    cancelledAt: result.cancelledAt.toISOString(),
  };
}

// ── E-way bill: a vendor return going back to the supplier ─────────────────

const TRANS_MODES = { '1': 'Road', '2': 'Rail', '3': 'Air', '4': 'Ship' } as const;

export interface EwayInput {
  transMode?: unknown;
  distanceKm?: unknown;
  vehicleNo?: unknown;
  transporterId?: unknown;
  transporterName?: unknown;
}

function parseEwayInput(input: EwayInput) {
  const transMode = String(input.transMode ?? '1');
  if (!(transMode in TRANS_MODES)) throw AppError.badRequest('Transport mode must be 1 Road, 2 Rail, 3 Air or 4 Ship');
  const km = Number(input.distanceKm);
  if (!Number.isInteger(km) || km < 1 || km > 4000) throw AppError.badRequest('Distance must be a whole number of kilometres, 1 to 4000');
  const vehicleNo = typeof input.vehicleNo === 'string' ? input.vehicleNo.replace(/[\s-]/g, '').toUpperCase() : '';
  const transporterId = typeof input.transporterId === 'string' ? input.transporterId.trim().toUpperCase() : '';
  const transporterName = typeof input.transporterName === 'string' ? input.transporterName.trim().slice(0, 100) : '';
  if (vehicleNo && !/^[A-Z]{2}[0-9A-Z]{1,6}[0-9]{4}$/.test(vehicleNo)) throw AppError.badRequest('Vehicle number is not in the RTO format (e.g. TN01AB1234)');
  if (transporterId && !/^[0-9]{2}[0-9A-Z]{13}$/.test(transporterId)) throw AppError.badRequest('Transporter ID must be a 15-character GSTIN / TRANSIN');
  if (transMode === '1' && !vehicleNo && !transporterId) {
    throw AppError.badRequest('For road transport give the vehicle number or the transporter ID');
  }
  return { transMode, km, vehicleNo, transporterId, transporterName };
}

/** A vendor return's lines — one e-way bill covers all of them. */
async function loadReturnLines(tenantId: string, returnId: string) {
  const head = await prisma.drugReturn.findFirst({
    where: { id: returnId, tenantId },
    select: { id: true, returnType: true, returnGroupId: true },
  });
  if (!head) throw AppError.notFound('Return not found');
  if (head.returnType !== 'vendor_return') {
    throw AppError.conflict('Only a return of stock to a supplier moves goods on a road and needs an e-way bill', 'NOT_VENDOR_RETURN');
  }
  const lines = await prisma.drugReturn.findMany({
    where: head.returnGroupId ? { tenantId, returnGroupId: head.returnGroupId, returnType: 'vendor_return' } : { id: head.id, tenantId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, createdAt: true, quantity: true, status: true, returnNumber: true, creditAmount: true,
      ewayBillNumber: true, ewayBillDate: true,
      ewayBillStatus: true, ewayBillError: true, ewayBillAttemptedAt: true, ewayBillValidUpto: true,
      ewayBillTransport: true, ewayBillCancelledAt: true, ewayBillCancelReasonCode: true, ewayBillCancelRemark: true,
      inputGstPercent: true, inputTaxableValue: true, inputCgst: true, inputSgst: true, inputIgst: true,
      drug: { select: { drugName: true, hsnCode: true } },
      drugBatch: { select: { purchasePrice: true, drug: { select: { drugName: true, hsnCode: true } } } },
      supplier: { select: { name: true, gstNumber: true, address: true } },
    },
  });
  return { head, lines };
}

type EwayState = 'none' | 'pending' | 'generated' | 'failed' | 'cancelled';

/**
 * The return's e-way state, read across its lines. A number recorded before
 * the status column existed reads as generated.
 */
function ewayStateOf(
  lines: Array<{ ewayBillNumber: string | null; ewayBillStatus?: string | null; ewayBillCancelledAt?: Date | null }>,
): EwayState {
  if (lines.some((l) => l.ewayBillCancelledAt || l.ewayBillStatus === 'cancelled')) return 'cancelled';
  if (lines.some((l) => l.ewayBillNumber)) return 'generated';
  if (lines.some((l) => l.ewayBillStatus === 'pending')) return 'pending';
  if (lines.some((l) => l.ewayBillStatus === 'failed')) return 'failed';
  return 'none';
}

export interface EwayOutcome {
  returnId: string;
  documentNumber: string;
  status: 'generated' | 'failed' | 'cancelled';
  ewayBillNumber: string | null;
  ewayBillDate: string | null;
  validUpto: string | null;
  error: string | null;
  /** True when the return already carried an e-way bill and nothing was sent. */
  alreadyGenerated: boolean;
  /** #266: the cancelled number this one follows, when it is a new one. */
  replaces: string | null;
  provider: string | null;
  sandbox: boolean;
}

function ewayOutcome(
  returnId: string,
  documentNumber: string,
  o: {
    status: EwayOutcome['status'];
    ewayBillNumber?: string | null;
    ewayBillDate?: Date | null;
    validUpto?: Date | null;
    error?: string | null;
    alreadyGenerated?: boolean;
    replaces?: string | null;
    provider?: string | null;
    sandbox?: boolean;
  },
): EwayOutcome {
  return {
    returnId,
    documentNumber,
    status: o.status,
    ewayBillNumber: o.ewayBillNumber ?? null,
    ewayBillDate: o.ewayBillDate?.toISOString() ?? null,
    validUpto: o.validUpto?.toISOString() ?? null,
    error: o.error ?? null,
    alreadyGenerated: o.alreadyGenerated ?? false,
    replaces: o.replaces ?? null,
    provider: o.provider ?? null,
    sandbox: o.sandbox ?? false,
  };
}

/**
 * #266: keep a return's cancelled e-way bill in its history. Written with the
 * cancellation, and again — a no-op the second time — before a new one is
 * generated, so one cancelled before this table existed is kept too.
 */
async function recordEwayHistory(
  db: Pick<typeof prisma, 'ewayBillHistory'>,
  tenantId: string,
  userId: string,
  head: { id: string; returnGroupId: string | null },
  e: {
    returnNumber: string | null; ewayBillNumber: string; ewayBillDate: Date | null; validUpto: Date | null;
    cancelledAt: Date | null; cancelReasonCode: string | null; cancelRemark: string | null; transport: unknown;
  },
) {
  const { transport, ...rest } = e;
  await db.ewayBillHistory.upsert({
    where: { tenantId_ewayBillNumber: { tenantId, ewayBillNumber: e.ewayBillNumber } },
    create: {
      tenantId,
      returnId: head.id,
      returnGroupId: head.returnGroupId,
      ...rest,
      status: 'cancelled',
      ...(transport && typeof transport === 'object' ? { transport: transport as object } : {}),
      recordedBy: userId,
    },
    update: {},
  });
}

/**
 * Generate — or, with mode 'retry', re-send — the e-way bill for a vendor
 * return. Retry may omit the transport details to resend the last ones.
 *
 * #266: after a cancellation, generating again raises a NEW e-way bill. The
 * cancelled one moves to the history, and the claim below is what keeps it to
 * one active bill: the two things happen in one transaction that only one of two
 * clicks can win.
 */
export async function generateEwayBillForReturn(
  tenantId: string,
  userId: string,
  returnId: string,
  input: EwayInput,
  mode: 'generate' | 'retry' = 'generate',
): Promise<EwayOutcome> {
  // Generate validates the transport details before anything is read; Retry
  // may send none and reuse what was sent last time.
  const hasInput = ['transMode', 'distanceKm', 'vehicleNo', 'transporterId', 'transporterName'].some(
    (k) => (input as Record<string, unknown>)?.[k] !== undefined && (input as Record<string, unknown>)[k] !== '',
  );
  let t = mode === 'generate' || hasInput ? parseEwayInput(input) : null;
  const { head, lines } = await loadReturnLines(tenantId, returnId);
  const docNo = lines[0]?.returnNumber ?? head.id.slice(0, 16);
  const first = lines[0];
  const state = ewayStateOf(lines);
  const existing = lines.find((l) => l.ewayBillNumber);
  // #266: a cancelled number is not an active one. Every line must agree it was
  // cancelled — a return with any line still carrying a live number has one.
  const cancelledLine = state === 'cancelled' ? existing : undefined;
  const liveLine = lines.find(
    (l) => l.ewayBillNumber && !l.ewayBillCancelledAt && l.ewayBillStatus !== 'cancelled',
  );
  if (existing && liveLine) {
    // Idempotent: one return, one ACTIVE e-way bill — never a second.
    return ewayOutcome(head.id, docNo, {
      status: 'generated',
      ewayBillNumber: liveLine.ewayBillNumber,
      ewayBillDate: liveLine.ewayBillDate,
      validUpto: liveLine.ewayBillValidUpto ?? null,
      alreadyGenerated: true,
    });
  }
  if (lines.some((l) => l.status === 'rejected')) {
    throw AppError.conflict('A rejected return does not leave the hospital; no e-way bill is needed', 'RETURN_REJECTED');
  }

  const now = new Date();
  const attemptedAt = first?.ewayBillAttemptedAt ?? null;
  const stalePending = state === 'pending' && (!attemptedAt || now.getTime() - attemptedAt.getTime() > IRN_PENDING_STALE_MS);
  if (state === 'pending' && !stalePending) {
    throw AppError.conflict(`Return ${docNo} is already being sent to the e-way bill portal — wait for its answer`, 'EWAY_IN_FLIGHT');
  }
  if (mode === 'retry' && state !== 'failed' && !stalePending) {
    throw AppError.conflict(`Nothing to retry: the e-way bill for return ${docNo} has not failed`, 'EWAY_NOTHING_TO_RETRY');
  }
  if (!t) {
    const last = lines.find((l) => l.ewayBillTransport && typeof l.ewayBillTransport === 'object')?.ewayBillTransport as EwayInput | undefined;
    if (!last) throw AppError.badRequest('Give the transport details: the last attempt did not record any');
    t = parseEwayInput(last);
  }
  const verb = state === 'failed' || stalePending ? 'retry' : 'generate';

  const { profile, provider, creds } = await profileAndProvider(tenantId, 'eway');
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId },
    select: { name: true, address: true, city: true, state: true },
  });
  const supplier = lines[0]?.supplier ?? null;
  const toGstin = (supplier?.gstNumber ?? '').trim().toUpperCase();
  const fromState = Number(profile.gstin!.slice(0, 2));
  const toState = /^[0-9]{2}/.test(toGstin) ? Number(toGstin.slice(0, 2)) : fromState;

  const items = lines.map((l) => {
    const drug = l.drug ?? l.drugBatch?.drug ?? null;
    const taxable =
      l.inputTaxableValue != null
        ? n(l.inputTaxableValue)
        : l.creditAmount != null
          ? n(l.creditAmount)
          : r2(Number(l.drugBatch?.purchasePrice ?? 0) * l.quantity);
    const rate = n(l.inputGstPercent);
    const igst = n(l.inputIgst);
    return {
      line: l,
      item: {
        productName: (drug?.drugName ?? 'Medicine').slice(0, 100),
        hsnCode: (drug?.hsnCode ?? '3004').replace(/\D/g, '') || '3004',
        quantity: l.quantity,
        qtyUnit: 'NOS',
        taxableAmount: taxable,
        cgstRate: igst > 0 ? 0 : r2(rate / 2),
        sgstRate: igst > 0 ? 0 : r2(rate / 2),
        igstRate: igst > 0 ? rate : 0,
        cessRate: 0,
      },
      cgst: n(l.inputCgst),
      sgst: n(l.inputSgst),
      igst,
    };
  });
  const totalValue = r2(items.reduce((s, i) => s + i.item.taxableAmount, 0));
  const cgstValue = r2(items.reduce((s, i) => s + i.cgst, 0));
  const sgstValue = r2(items.reduce((s, i) => s + i.sgst, 0));
  const igstValue = r2(items.reduce((s, i) => s + i.igst, 0));

  const payload: EwayBillPayload = {
    supplyType: 'O',
    subSupplyType: '8',
    subSupplyDesc: 'Purchase return to supplier',
    docType: 'CHL',
    docNo: docNo.slice(0, 16),
    docDate: formatDateIST(lines[0]?.createdAt ?? new Date()),
    fromGstin: profile.gstin!,
    fromTrdName: text(profile.tradeName ?? profile.legalName ?? tenant?.name, 100),
    fromAddr1: text(tenant?.address, 120, tenant?.name ?? ''),
    fromPlace: text(tenant?.city, 50) || placeFrom(tenant?.address, 'NA'),
    fromPincode: pinFrom(tenant?.address),
    fromStateCode: fromState,
    actFromStateCode: fromState,
    toGstin: toGstin || 'URP',
    toTrdName: text(supplier?.name, 100),
    toAddr1: text(supplier?.address, 120),
    toPlace: placeFrom(supplier?.address, 'NA'),
    toPincode: pinFrom(supplier?.address),
    toStateCode: toState,
    actToStateCode: toState,
    transactionType: 1,
    totalValue,
    cgstValue,
    sgstValue,
    igstValue,
    cessValue: 0,
    totInvValue: r2(totalValue + cgstValue + sgstValue + igstValue),
    transMode: t.transMode,
    transDistance: String(t.km),
    ...(t.transporterId ? { transporterId: t.transporterId } : {}),
    ...(t.transporterName ? { transporterName: t.transporterName } : {}),
    ...(t.vehicleNo ? { vehicleNo: t.vehicleNo, vehicleType: 'R' as const } : {}),
    itemList: items.map((i) => i.item),
  };

  const lineIds = lines.map((l) => l.id);
  const transport = {
    transMode: t.transMode,
    distanceKm: t.km,
    ...(t.vehicleNo ? { vehicleNo: t.vehicleNo } : {}),
    ...(t.transporterId ? { transporterId: t.transporterId } : {}),
    ...(t.transporterName ? { transporterName: t.transporterName } : {}),
  };
  const sent = { provider: provider.name, sandbox: provider.sandbox };
  const how = `${TRANS_MODES[t.transMode as keyof typeof TRANS_MODES]}, ${t.km} km`;

  // Claim the send on every line of the return, exactly as the IRN is claimed:
  // only lines with no number that were never sent, failed, or were abandoned
  // mid-send can move to pending — so two clicks cannot raise two bills.
  const inFlight = () =>
    AppError.conflict(`Return ${docNo} is already being sent to the e-way bill portal`, 'EWAY_IN_FLIGHT');
  if (cancelledLine?.ewayBillNumber) {
    // #266: the cancelled number goes to the history and comes off the lines in
    // the same transaction as the claim. The second of two clicks finds no line
    // still carrying it, updates nothing, and is refused — and a failure anywhere
    // rolls both back, so a number can be neither lost nor left active.
    const oldNumber = cancelledLine.ewayBillNumber;
    await prisma.$transaction(async (tx) => {
      const moved = await tx.drugReturn.updateMany({
        where: {
          id: { in: lineIds },
          tenantId,
          ewayBillNumber: oldNumber,
          OR: [{ ewayBillStatus: 'cancelled' }, { ewayBillCancelledAt: { not: null } }],
        },
        data: {
          ewayBillNumber: null, ewayBillDate: null, ewayBillValidUpto: null,
          ewayBillCancelledAt: null, ewayBillCancelReasonCode: null, ewayBillCancelRemark: null,
          ewayBillStatus: 'pending', ewayBillAttemptedAt: now, ewayBillError: null, ewayBillTransport: transport,
        },
      });
      if (moved.count === 0) throw inFlight();
      await recordEwayHistory(tx, tenantId, userId, head, {
        returnNumber: cancelledLine.returnNumber,
        ewayBillNumber: oldNumber,
        ewayBillDate: cancelledLine.ewayBillDate,
        validUpto: cancelledLine.ewayBillValidUpto,
        cancelledAt: cancelledLine.ewayBillCancelledAt,
        cancelReasonCode: cancelledLine.ewayBillCancelReasonCode,
        cancelRemark: cancelledLine.ewayBillCancelRemark,
        transport: cancelledLine.ewayBillTransport,
      });
    });
  } else {
    const claimed = await prisma.drugReturn.updateMany({
      where: {
        id: { in: lineIds },
        tenantId,
        ewayBillNumber: null,
        OR: [
          { ewayBillStatus: null },
          { ewayBillStatus: 'failed' },
          { ewayBillStatus: 'pending', ewayBillAttemptedAt: { lt: new Date(now.getTime() - IRN_PENDING_STALE_MS) } },
          { ewayBillStatus: 'pending', ewayBillAttemptedAt: null },
        ],
      },
      data: { ewayBillStatus: 'pending', ewayBillAttemptedAt: now, ewayBillError: null, ewayBillTransport: transport },
    });
    if (claimed.count === 0) throw inFlight();
  }
  // The cancelled bill this one follows. After a failed regeneration the number
  // is already off the lines, so a retry reads it back from the history.
  const past = (
    await prisma.ewayBillHistory.findMany({
      where: {
        tenantId,
        OR: [{ returnId: { in: lineIds } }, ...(head.returnGroupId ? [{ returnGroupId: head.returnGroupId }] : [])],
      },
      orderBy: { createdAt: 'desc' },
      select: { ewayBillNumber: true },
    })
  ).map((h) => h.ewayBillNumber);
  const replaces = cancelledLine?.ewayBillNumber ?? past[0] ?? null;

  const answer = await safely(() => provider.generateEwayBill(creds, payload, { replaces }));
  // #266: a cancelled number is dead. If the portal (or a gateway's cache) hands
  // one back as if it were new, the goods would move under no valid bill - so it
  // is kept as a failure, never as the active number.
  const result: typeof answer =
    answer.ok && [replaces, ...past].includes(answer.ewayBillNo)
      ? {
          ok: false,
          code: 'EWAY_CANCELLED_NUMBER',
          message:
            `The portal answered with e-way bill ${answer.ewayBillNo}, which was already cancelled. ` +
            'No new e-way bill was recorded - check the e-way bill portal before retrying',
        }
      : answer;

  if (!result.ok) {
    // Kept on the record in the portal's words — D-3 lists it with Retry —
    // rather than only bounced back to whoever clicked.
    const message = (
      result.uncertain
        ? `${result.message}. The portal may still have generated it — check the e-way bill portal before retrying.`
        : result.message
    ).slice(0, 1000);
    await prisma.drugReturn.updateMany({
      where: { id: { in: lineIds }, tenantId, ewayBillNumber: null },
      data: { ewayBillStatus: 'failed', ewayBillError: message },
    });
    await writeAudit({
      tenantId,
      userId,
      action: 'update',
      entityType: 'drug_return',
      entityId: head.id,
      description: `E-way bill ${verb} for vendor return ${docNo} failed via ${provider.name}${sandboxNote(provider)} (${how}): ${message}`,
      oldValues: { ewayBillStatus: state === 'none' ? null : state },
      newValues: { ewayBillStatus: 'failed', ewayBillError: message, portalCode: result.code, replaces, ...sent, mode: verb, lineIds },
    });
    return ewayOutcome(head.id, docNo, { status: 'failed', error: message, replaces, ...sent });
  }

  await prisma.drugReturn.updateMany({
    where: { id: { in: lineIds }, tenantId, ewayBillNumber: null },
    data: {
      ewayBillNumber: result.ewayBillNo.slice(0, 20),
      ewayBillDate: result.ewayBillDate,
      ewayBillValidUpto: result.validUpto,
      ewayBillStatus: 'generated',
      ewayBillError: null,
    },
  });
  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'drug_return',
    entityId: head.id,
    description: `E-way bill ${result.ewayBillNo} ${verb === 'retry' ? 'generated on retry' : replaces ? `generated after cancelled ${replaces}` : 'generated'} for vendor return ${docNo} via ${provider.name}${sandboxNote(provider)} (${how}${result.validUpto ? `, valid until ${formatDateTimeIST(result.validUpto)} IST` : ''})`,
    oldValues: { ewayBillStatus: state === 'none' ? null : state },
    newValues: {
      ewayBillNumber: result.ewayBillNo,
      ewayBillDate: result.ewayBillDate.toISOString(),
      validUpto: result.validUpto?.toISOString() ?? null,
      ewayBillStatus: 'generated',
      replaces,
      ...sent,
      mode: verb,
      lineIds,
    },
  });
  return ewayOutcome(head.id, docNo, {
    status: 'generated',
    ewayBillNumber: result.ewayBillNo,
    ewayBillDate: result.ewayBillDate,
    validUpto: result.validUpto,
    replaces,
    ...sent,
  });
}

/**
 * Cancel a vendor return's e-way bill, within the portal's window after it
 * was generated, with the portal's reason code and a remark. Refused after it:
 * the portal will not take it, and the goods have either moved under it or the
 * bill simply expires.
 */
export async function cancelEwayBillForReturn(
  tenantId: string,
  userId: string,
  returnId: string,
  input: { reasonCode?: unknown; remark?: unknown },
  now: Date = new Date(),
): Promise<EwayOutcome & { cancelledAt: string | null }> {
  const reasonCode = String(input.reasonCode ?? '') as EwayCancelReasonCode;
  if (!(reasonCode in EWAY_CANCEL_REASONS)) {
    throw AppError.badRequest('Choose a cancellation reason: 1 Duplicate, 2 Order cancelled, 3 Data entry mistake, 4 Others');
  }
  const remark = typeof input.remark === 'string' ? input.remark.trim() : '';
  if (remark.length < 3) throw AppError.badRequest('A cancellation remark is required');
  if (remark.length > 100) throw AppError.badRequest('The cancellation remark must be 100 characters or fewer');

  const { head, lines } = await loadReturnLines(tenantId, returnId);
  const docNo = lines[0]?.returnNumber ?? head.id.slice(0, 16);
  const existing = lines.find((l) => l.ewayBillNumber);
  const state = ewayStateOf(lines);
  if (state === 'cancelled') {
    throw AppError.conflict(`The e-way bill for return ${docNo} is already cancelled`, 'EWAY_ALREADY_CANCELLED');
  }
  if (!existing?.ewayBillNumber) {
    throw AppError.conflict(`Return ${docNo} has no generated e-way bill to cancel`, 'EWAY_NOT_GENERATED');
  }
  const ewbNo = existing.ewayBillNumber;
  const hours = ewayCancelWindowHours();
  const at = existing.ewayBillDate;
  if (!at || now.getTime() > at.getTime() + hours * 60 * 60 * 1000) {
    throw AppError.conflict(
      `E-way bill ${ewbNo} can only be cancelled within ${hours} hours of its generation` +
        (at ? ` (generated ${formatDateTimeIST(at)} IST)` : '') +
        '. The portal no longer accepts a cancellation; it lapses at the end of its validity.',
      'EWAY_CANCEL_WINDOW_CLOSED',
    );
  }

  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const profile = await getGstProfile(tenantId);
  // Like an IRN: cancelling must work even if e-way bills were since switched
  // off — but only through a provider and login that are actually there.
  const readiness = await getPortalReadiness(tenantId, 'eway');
  if (!readiness.ready) throw AppError.conflict(`E-way bills not available: ${readiness.reason}`, 'EINVOICE_NOT_AVAILABLE');
  const { provider } = resolveEInvoiceProvider();
  if (!provider) throw AppError.conflict('E-way bills not available: no provider configured', 'EINVOICE_NOT_AVAILABLE');
  const creds = await loadPortalCredentials(tenantId, 'eway', profile.gstin);

  const result = await safely(() => provider.cancelEwayBill(creds, { ewayBillNo: ewbNo, reasonCode, remark }));
  const reasonText = `${EWAY_CANCEL_REASONS[reasonCode]} — ${remark}`;
  const sent = { provider: provider.name, sandbox: provider.sandbox };
  const lineIds = lines.map((l) => l.id);

  if (!result.ok) {
    await writeAudit({
      tenantId,
      userId,
      action: 'update',
      entityType: 'drug_return',
      entityId: head.id,
      description: `Cancellation of e-way bill ${ewbNo} for vendor return ${docNo} refused via ${provider.name}${sandboxNote(provider)}: ${result.message}`,
      reason: reasonText,
      newValues: { ewayBillNumber: ewbNo, portalCode: result.code, ...sent, lineIds },
    });
    throw new AppError(`The portal did not cancel the e-way bill: ${result.message}`, 502, 'EWAY_CANCEL_FAILED');
  }

  // #266: the cancellation and its place in the history are one write.
  await prisma.$transaction(async (tx) => {
    await tx.drugReturn.updateMany({
      where: { id: { in: lineIds }, tenantId, ewayBillNumber: ewbNo },
      data: {
        ewayBillStatus: 'cancelled',
        ewayBillCancelledAt: result.cancelledAt,
        ewayBillCancelReasonCode: reasonCode,
        ewayBillCancelRemark: remark,
      },
    });
    await recordEwayHistory(tx, tenantId, userId, head, {
      returnNumber: existing.returnNumber,
      ewayBillNumber: ewbNo,
      ewayBillDate: existing.ewayBillDate,
      validUpto: existing.ewayBillValidUpto,
      cancelledAt: result.cancelledAt,
      cancelReasonCode: reasonCode,
      cancelRemark: remark,
      transport: existing.ewayBillTransport,
    });
  });
  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'drug_return',
    entityId: head.id,
    description: `E-way bill ${ewbNo} for vendor return ${docNo} cancelled via ${provider.name}${sandboxNote(provider)} at ${formatDateTimeIST(result.cancelledAt)} IST`,
    reason: reasonText,
    oldValues: { ewayBillStatus: state === 'none' ? null : state },
    newValues: { ewayBillStatus: 'cancelled', ewayBillCancelledAt: result.cancelledAt.toISOString(), reasonCode, ...sent, lineIds },
  });
  return {
    ...ewayOutcome(head.id, docNo, {
      status: 'cancelled',
      ewayBillNumber: ewbNo,
      ewayBillDate: existing.ewayBillDate,
      validUpto: existing.ewayBillValidUpto ?? null,
      ...sent,
    }),
    cancelledAt: result.cancelledAt.toISOString(),
  };
}
