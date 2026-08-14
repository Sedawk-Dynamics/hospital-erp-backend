import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  checkControlledReturn,
  QUARANTINE_PREFIX,
} from '../../../../src/modules/pharmacy/controlled-dispense';

/**
 * A returned Schedule X or narcotic item cannot simply go back on the sellable
 * shelf — it has to be held and accounted for, and usually destroyed under
 * witness. But returns have always been allowed for every drug, so this must
 * not turn into a new hard block on a working flow: it only bites once the
 * hospital switches controlled dispensing to inline mode.
 */

const TENANT = 'tenant-1';
const USER = 'user-1';

const setMode = (mode: 'legacy_block' | 'inline') =>
  (prisma.tenant.findFirst as any).mockResolvedValue({ themeConfig: { controlledDrugs: { mode } } });

const MORPHINE = { drugName: 'Morphine', vaultControlled: true, controlledClass: 'narcotic', schedule: 'H1' };
const TRAMADOL = { drugName: 'Tramadol', vaultControlled: false, controlledClass: 'psychotropic', schedule: 'H1' };
const PARACETAMOL = { drugName: 'Paracetamol', schedule: 'OTC' };

beforeEach(() => vi.clearAllMocks());

describe('legacy_block — returns keep working exactly as they did', () => {
  beforeEach(() => setMode('legacy_block'));

  it('restocks a narcotic return without demanding anything', async () => {
    const r = await checkControlledReturn(TENANT, MORPHINE, { userId: USER, returnType: 'patient_return' });
    expect(r.quarantine).toBe(false);
  });

  it('restocks a Schedule H1 return', async () => {
    const r = await checkControlledReturn(TENANT, TRAMADOL, { userId: USER, returnType: 'patient_return' });
    expect(r.quarantine).toBe(false);
  });
});

describe('inline — a controlled return is held, not resold', () => {
  beforeEach(() => setMode('inline'));

  it('quarantines a Schedule H1 return', async () => {
    const r = await checkControlledReturn(TENANT, TRAMADOL, { userId: USER, returnType: 'patient_return' });
    expect(r.quarantine).toBe(true);
  });

  it('needs a witness before accepting a narcotic back', async () => {
    await expect(
      checkControlledReturn(TENANT, MORPHINE, { userId: USER, returnType: 'patient_return' }),
    ).rejects.toThrow(/second authorised person must witness/);
  });

  it('refuses a witness who is the person accepting the return', async () => {
    await expect(
      checkControlledReturn(TENANT, MORPHINE, {
        userId: USER, witnessedById: USER, returnType: 'patient_return',
      }),
    ).rejects.toThrow(/different person/);
  });

  it('accepts a witnessed narcotic return and quarantines it', async () => {
    const r = await checkControlledReturn(TENANT, MORPHINE, {
      userId: USER, witnessedById: 'user-2', returnType: 'patient_return',
    });
    expect(r).toMatchObject({ quarantine: true, witnessedById: 'user-2' });
  });

  it('leaves an ordinary drug alone — it restocks as always', async () => {
    const r = await checkControlledReturn(TENANT, PARACETAMOL, { userId: USER, returnType: 'patient_return' });
    expect(r.quarantine).toBe(false);
    // An uncontrolled return should not even cost a settings read.
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });

  it('exempts a vendor return — that stock is leaving, not coming back', async () => {
    const r = await checkControlledReturn(TENANT, MORPHINE, { userId: USER, returnType: 'vendor_return' });
    expect(r.quarantine).toBe(false);
  });

  it('handles a return whose drug could not be resolved', async () => {
    const r = await checkControlledReturn(TENANT, null, { userId: USER, returnType: 'patient_return' });
    expect(r.quarantine).toBe(false);
  });
});

describe('quarantine mechanics', () => {
  it('uses a distinctive batch prefix', () => {
    // Both the recalls report and the register key off this prefix to tell a
    // quarantine apart from a real recall or a real receipt.
    expect(QUARANTINE_PREFIX).toBe('QUAR-');
  });
});
