import { SANDBOX_LABEL, type GstinProvider, type GstinVerifyResult } from './types';

// ---------------------------------------------------------------------------
// The QA sandbox (gap #311).
//
// No GST provider is configured on this project, so without this the Verify
// flow could not be exercised end to end at all. It answers from fixed
// fixtures and NEVER calls out. It is only reachable when
// GSTIN_VERIFY_PROVIDER=sandbox is set explicitly, it is refused in
// production, and every result it produces is flagged `sandbox: true` so the
// screen, the reports and the PDFs can label it as not a real check.
// ---------------------------------------------------------------------------

/** Each passes the local checks (check digit included) so QA can save it. PAN part AAACS260xK. */
export const SANDBOX_FIXTURES = {
  /** Active registration. */
  active: '33AAACS2601K1ZR',
  /** Registration cancelled. */
  inactive: '33AAACS2602K1ZQ',
  /** Simulates the provider being down. */
  error: '33AAACS2603K1ZP',
} as const;

export const SANDBOX_LEGAL_NAME = 'SANDBOX TEST HOSPITAL PRIVATE LIMITED';

export function createSandboxProvider(): GstinProvider {
  const name = 'sandbox';
  return {
    name,
    sandbox: true,
    async verify(gstin: string): Promise<GstinVerifyResult> {
      const g = gstin.trim().toUpperCase();
      const base = {
        gstin: g,
        checkedAt: new Date(),
        provider: name,
        sandbox: true,
        stateCode: g.slice(0, 2),
        tradeName: null as string | null,
      };
      if (g === SANDBOX_FIXTURES.active) {
        return {
          ...base,
          status: 'verified',
          legalName: SANDBOX_LEGAL_NAME,
          tradeName: 'SANDBOX TEST HOSPITAL',
          registrationStatus: 'Active',
          error: null,
          raw: { note: SANDBOX_LABEL },
        };
      }
      if (g === SANDBOX_FIXTURES.inactive) {
        return {
          ...base,
          status: 'inactive',
          legalName: SANDBOX_LEGAL_NAME,
          registrationStatus: 'Cancelled',
          error: `Registration status is "Cancelled" (${SANDBOX_LABEL})`,
          raw: { note: SANDBOX_LABEL },
        };
      }
      if (g === SANDBOX_FIXTURES.error) {
        return {
          ...base,
          status: 'error',
          legalName: null,
          registrationStatus: null,
          error: `Simulated provider outage (${SANDBOX_LABEL})`,
        };
      }
      return {
        ...base,
        status: 'not_found',
        stateCode: null,
        legalName: null,
        registrationStatus: null,
        error: `Not found (${SANDBOX_LABEL})`,
      };
    },
  };
}
