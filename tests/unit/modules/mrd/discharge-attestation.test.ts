import { describe, it, expect } from 'vitest';
import {
  dischargeAttestation,
  signerDisplayName,
  withProfileContact,
} from '../../../../src/modules/mrd/discharge-summary-pdf';

describe('discharge summary sign-off and contact (gap 363)', () => {
  it('attestation comes from the signing doctor and signed time', () => {
    const a = dischargeAttestation({ signerName: 'Asha Rao', signedAt: '2026-11-19T05:00:00.000Z' });
    expect(a).toMatch(/^Electronically signed by Dr\. Asha Rao on /);
    expect(a).toContain('2026');
    expect(dischargeAttestation({ signerName: 'Asha Rao', signedAt: null })).toBeNull();
    expect(signerDisplayName('Dr. Asha Rao')).toBe('Dr. Asha Rao');
  });

  it('hospital profile contact overrides a stale letterhead copy', () => {
    const branding = {
      name: 'H', email: 'old@sample.com', phone: '000', addressLine1: 'Old St', addressLine2: null,
      city: null, state: null, country: null,
    } as any;
    const out = withProfileContact(branding, { email: 'desk@hospital.in', phone: '+91 99', address: '12 MG Road', city: 'Pune' });
    expect(out).toMatchObject({ email: 'desk@hospital.in', phone: '+91 99', addressLine1: '12 MG Road', addressLine2: null, city: 'Pune' });
    expect(withProfileContact(branding, { email: null }).email).toBe('old@sample.com');
  });
});
