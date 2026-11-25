import { createHash } from 'crypto';
import {
  EINVOICE_SANDBOX_LABEL,
  type EInvoiceProvider,
  type EwayBillPayload,
  type IrnPayload,
} from './types';

// ---------------------------------------------------------------------------
// The QA sandbox for the e-invoice / e-way bill flow (gap #266).
//
// No GSP is contracted on this project, so without this nothing past "Not
// available" could be exercised end to end. It answers from deterministic
// fixtures and NEVER calls out. It is reachable only when
// EINVOICE_PROVIDER=sandbox is set explicitly, it is refused in production
// (see index.ts), and everything it returns says SANDBOX — the IRN is a real
// SHA-256 of the document identity, so it looks right, but the signed QR is
// plainly marked as not signed by the portal.
// ---------------------------------------------------------------------------

export const EINVOICE_SANDBOX_FIXTURES = {
  /** A buyer GSTIN the sandbox portal refuses (fixture shared with the GSTIN sandbox's "outage" number). */
  rejectBuyerGstin: '33AAACS2603K1ZP',
  /** A password the sandbox treats as wrong. */
  badPassword: 'sandbox-wrong-password',
  /** A cancellation remark the sandbox e-way portal refuses (as if the bill were verified in transit). */
  refuseCancelRemark: 'sandbox-refuse-cancel',
} as const;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Digits from a hash, so the same document always gets the same number. */
function digitsFrom(hash: string, length: number): string {
  const n = BigInt(`0x${hash.slice(0, 24)}`) % BigInt(10) ** BigInt(length - 1);
  return `1${n.toString().padStart(length - 1, '0')}`;
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function sandboxIrn(p: IrnPayload): string {
  // The real IRN is SHA-256 over supplier GSTIN + financial year + doc type +
  // doc number; the date stands in for the financial year here.
  return sha256(`${p.SellerDtls.Gstin}|${p.DocDtls.Dt}|${p.DocDtls.Typ}|${p.DocDtls.No.toUpperCase()}`);
}

export function createEInvoiceSandboxProvider(): EInvoiceProvider {
  return {
    name: 'sandbox',
    sandbox: true,

    async testConnection(portal, creds) {
      if (!creds.username || !creds.password) {
        return { ok: false, code: 'AUTH', message: `Username and password are required (${EINVOICE_SANDBOX_LABEL})` };
      }
      if (creds.password === EINVOICE_SANDBOX_FIXTURES.badPassword) {
        return { ok: false, code: 'AUTH', message: `Invalid username or password (${EINVOICE_SANDBOX_LABEL})` };
      }
      return {
        ok: true,
        message: `Connected to the ${portal === 'einvoice' ? 'e-invoice' : 'e-way bill'} ${EINVOICE_SANDBOX_LABEL}`,
      };
    },

    async generateIrn(_creds, payload) {
      if (payload.BuyerDtls.Gstin === EINVOICE_SANDBOX_FIXTURES.rejectBuyerGstin) {
        return {
          ok: false,
          code: '3028',
          message: `3028: GSTIN - ${payload.BuyerDtls.Gstin} is not present in invoice registration portal (${EINVOICE_SANDBOX_LABEL})`,
        };
      }
      const irn = sandboxIrn(payload);
      const ackNo = digitsFrom(sha256(`ack|${irn}`), 15);
      const ackDate = new Date();
      // Shaped like the portal's signed JWT so the printed QR is realistic, but
      // the signature part says outright that nobody signed it.
      const qr = [
        b64url(JSON.stringify({ alg: 'none', typ: 'SANDBOX' })),
        b64url(
          JSON.stringify({
            data: JSON.stringify({
              SellerGstin: payload.SellerDtls.Gstin,
              BuyerGstin: payload.BuyerDtls.Gstin,
              DocNo: payload.DocDtls.No,
              DocTyp: payload.DocDtls.Typ,
              DocDt: payload.DocDtls.Dt,
              TotInvVal: payload.ValDtls.TotInvVal,
              ItemCnt: payload.ItemList.length,
              MainHsnCode: payload.ItemList[0]?.HsnCd ?? '',
              Irn: irn,
              IrnDt: ackDate.toISOString(),
              Note: EINVOICE_SANDBOX_LABEL,
            }),
            iss: 'SANDBOX',
          }),
        ),
        'SANDBOX-NOT-SIGNED',
      ].join('.');
      return { ok: true, irn, ackNo, ackDate, signedQrCode: qr, duplicate: false };
    },

    async cancelIrn(_creds, input) {
      if (!/^[0-9a-f]{64}$/i.test(input.irn)) {
        return { ok: false, code: '2140', message: `2140: Invalid IRN (${EINVOICE_SANDBOX_LABEL})` };
      }
      return { ok: true, irn: input.irn, cancelledAt: new Date() };
    },

    async generateEwayBill(_creds, payload: EwayBillPayload) {
      const km = Number(payload.transDistance);
      if (!Number.isFinite(km) || km <= 0) {
        return { ok: false, code: '721', message: `721: Distance must be greater than zero (${EINVOICE_SANDBOX_LABEL})` };
      }
      if (payload.toGstin === EINVOICE_SANDBOX_FIXTURES.rejectBuyerGstin) {
        return { ok: false, code: '238', message: `238: Invalid consignee GSTIN (${EINVOICE_SANDBOX_LABEL})` };
      }
      const now = new Date();
      // One day of validity per 200 km (or part), as for an ordinary cargo.
      const days = Math.max(1, Math.ceil(km / 200));
      return {
        ok: true,
        ewayBillNo: digitsFrom(sha256(`ewb|${payload.fromGstin}|${payload.docNo}|${payload.docDate}`), 12),
        ewayBillDate: now,
        validUpto: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
      };
    },

    async cancelEwayBill(_creds, input) {
      if (!/^\d{12}$/.test(input.ewayBillNo)) {
        return { ok: false, code: '312', message: `312: Invalid e-way bill number (${EINVOICE_SANDBOX_LABEL})` };
      }
      if (input.remark === EINVOICE_SANDBOX_FIXTURES.refuseCancelRemark) {
        return {
          ok: false,
          code: '315',
          message: `315: The e-way bill cannot be cancelled as it has been verified by an officer (${EINVOICE_SANDBOX_LABEL})`,
        };
      }
      return { ok: true, ewayBillNo: input.ewayBillNo, cancelledAt: new Date() };
    },
  };
}
