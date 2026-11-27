// ---------------------------------------------------------------------------
// E-invoice (IRP) and e-way bill portal integration (gap #266, GST bug G-5).
//
// A hospital reaches the Invoice Registration Portal and the e-way bill system
// through a GSP. This module is the seam: one result shape whatever provider
// answered, mirroring src/services/gstin-verification.
//
// Two rules hold for every adapter:
//   - a credential never appears in a log line, an error message or a result;
//   - every failure is a RESULT (ok: false) carrying the portal's own words,
//     never an exception a caller could mistake for success.
// ---------------------------------------------------------------------------

export type GstPortal = 'einvoice' | 'eway';
export const GST_PORTALS: readonly GstPortal[] = ['einvoice', 'eway'] as const;

/** The hospital's login on a portal, decrypted server-side only. */
export interface PortalCredentials {
  username: string;
  password: string;
  clientId: string | null;
  clientSecret: string | null;
  /** The hospital's GSTIN the API user is registered against. */
  gstin: string | null;
}

export interface PortalFailure {
  ok: false;
  /** The portal's error code where it gave one, e.g. "2150". */
  code: string | null;
  /** The portal's own words. Reported verbatim on D-2. */
  message: string;
  /**
   * True when the request may have reached the portal and been accepted
   * (timeout, dropped connection). A retry must then expect a duplicate.
   */
  uncertain?: boolean;
}

export interface TestConnectionOk {
  ok: true;
  message: string;
}

export interface IrnGenerated {
  ok: true;
  irn: string;
  ackNo: string;
  ackDate: Date;
  /** The signed QR string as the portal returned it. Null only for a duplicate the portal did not resend. */
  signedQrCode: string | null;
  /** The portal said this document was already registered and returned its IRN. */
  duplicate: boolean;
}

export interface IrnCancelled {
  ok: true;
  irn: string;
  cancelledAt: Date;
}

export interface EwayBillGenerated {
  ok: true;
  ewayBillNo: string;
  ewayBillDate: Date;
  validUpto: Date | null;
}

export interface EwayBillCancelled {
  ok: true;
  ewayBillNo: string;
  cancelledAt: Date;
}

export type PortalResult<T> = T | PortalFailure;

/** E-way bill cancellation reasons, as the e-way bill portal numbers them (not the same order as IRN's). */
export const EWAY_CANCEL_REASONS = {
  '1': 'Duplicate',
  '2': 'Order cancelled',
  '3': 'Data entry mistake',
  '4': 'Others',
} as const;
export type EwayCancelReasonCode = keyof typeof EWAY_CANCEL_REASONS;

/** IRN cancellation reasons, as the portal numbers them. */
export const IRN_CANCEL_REASONS = {
  '1': 'Duplicate',
  '2': 'Data entry mistake',
  '3': 'Order cancelled',
  '4': 'Others',
} as const;
export type IrnCancelReasonCode = keyof typeof IRN_CANCEL_REASONS;

export interface EInvoiceProvider {
  readonly name: string;
  readonly sandbox: boolean;
  testConnection(portal: GstPortal, creds: PortalCredentials): Promise<PortalResult<TestConnectionOk>>;
  /** `payload` is the portal's invoice JSON (schema version 1.1). */
  generateIrn(creds: PortalCredentials, payload: IrnPayload): Promise<PortalResult<IrnGenerated>>;
  cancelIrn(
    creds: PortalCredentials,
    input: { irn: string; reasonCode: IrnCancelReasonCode; remark: string },
  ): Promise<PortalResult<IrnCancelled>>;
  /**
   * `replaces` is the cancelled e-way bill this one follows, if any. It is not
   * part of what is sent: the portal issues its own number and knows which ones
   * it cancelled. Only the sandbox, which remembers nothing, needs telling.
   */
  generateEwayBill(
    creds: PortalCredentials,
    payload: EwayBillPayload,
    context?: { replaces?: string | null },
  ): Promise<PortalResult<EwayBillGenerated>>;
  cancelEwayBill(
    creds: PortalCredentials,
    input: { ewayBillNo: string; reasonCode: EwayCancelReasonCode; remark: string },
  ): Promise<PortalResult<EwayBillCancelled>>;
}

/** What the settings screen is told about the provider. */
export interface EInvoiceProviderInfo {
  configured: boolean;
  provider: string | null;
  sandbox: boolean;
  /** Why it is not configured, when it is not. */
  reason: string | null;
}

/** The label every sandbox result carries, on screen and on paper. */
export const EINVOICE_SANDBOX_LABEL = 'SANDBOX — not registered with the government portal';

// ── Payload shapes (the portal's own field names) ──────────────────────────

export interface IrnPayloadItem {
  SlNo: string;
  PrdDesc: string;
  IsServc: 'Y' | 'N';
  HsnCd: string;
  Qty: number;
  Unit: string;
  UnitPrice: number;
  TotAmt: number;
  Discount: number;
  AssAmt: number;
  GstRt: number;
  IgstAmt: number;
  CgstAmt: number;
  SgstAmt: number;
  CesAmt: number;
  TotItemVal: number;
}

export interface IrnParty {
  Gstin: string;
  LglNm: string;
  TrdNm?: string;
  Addr1: string;
  Loc: string;
  Pin: number | null;
  Stcd: string;
  Pos?: string;
  Ph?: string;
  Em?: string;
}

export interface IrnPayload {
  Version: '1.1';
  TranDtls: { TaxSch: 'GST'; SupTyp: 'B2B'; RegRev: 'N'; IgstOnIntra: 'N' };
  /** Dt is dd/mm/yyyy in IST. */
  DocDtls: { Typ: 'INV' | 'CRN' | 'DBN'; No: string; Dt: string };
  SellerDtls: IrnParty;
  BuyerDtls: IrnParty & { Pos: string };
  /**
   * A credit / debit note names the invoice it adjusts here. InvDt is
   * dd/mm/yyyy in IST.
   */
  RefDtls?: { PrecDocDtls: Array<{ InvNo: string; InvDt: string }> };
  ItemList: IrnPayloadItem[];
  ValDtls: {
    AssVal: number;
    CgstVal: number;
    SgstVal: number;
    IgstVal: number;
    CesVal: number;
    Discount: number;
    RndOffAmt: number;
    TotInvVal: number;
  };
}

export interface EwayBillPayload {
  supplyType: 'O';
  /** 8 = Others (a purchase return to the supplier). */
  subSupplyType: string;
  subSupplyDesc: string;
  docType: 'CHL' | 'INV' | 'OTH';
  docNo: string;
  /** dd/mm/yyyy in IST. */
  docDate: string;
  fromGstin: string;
  fromTrdName: string;
  fromAddr1: string;
  fromPlace: string;
  fromPincode: number | null;
  fromStateCode: number;
  actFromStateCode: number;
  toGstin: string;
  toTrdName: string;
  toAddr1: string;
  toPlace: string;
  toPincode: number | null;
  toStateCode: number;
  actToStateCode: number;
  /** 1 Regular. */
  transactionType: number;
  totalValue: number;
  cgstValue: number;
  sgstValue: number;
  igstValue: number;
  cessValue: number;
  totInvValue: number;
  /** 1 Road, 2 Rail, 3 Air, 4 Ship. */
  transMode: string;
  transDistance: string;
  transporterId?: string;
  transporterName?: string;
  vehicleNo?: string;
  /** R Regular. */
  vehicleType?: 'R';
  itemList: Array<{
    productName: string;
    hsnCode: string;
    quantity: number;
    qtyUnit: string;
    taxableAmount: number;
    cgstRate: number;
    sgstRate: number;
    igstRate: number;
    cessRate: number;
  }>;
}
