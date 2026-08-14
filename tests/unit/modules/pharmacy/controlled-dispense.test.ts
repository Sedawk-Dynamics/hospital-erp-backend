import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { checkControlledDispense } from '../../../../src/modules/pharmacy/controlled-dispense';

/**
 * The gate that replaced the five hard blocks.
 *
 * Two things matter here and they pull in opposite directions: a hospital that
 * never touches the setting must see EXACTLY today's behaviour, and a hospital
 * that flips it must be able to finish a controlled dispense without leaving
 * the screen. Both are tested against the same drug fixtures.
 */

const TENANT = 'tenant-1';
const USER = 'user-1';

/** The hospital's controlled-drug settings live in Tenant.themeConfig. */
const setMode = (mode: 'legacy_block' | 'inline') =>
  (prisma.tenant.findFirst as any).mockResolvedValue({
    themeConfig: { controlledDrugs: { mode } },
  });

const MORPHINE = {
  drugName: 'Morphine',
  vaultControlled: true,
  controlledClass: 'narcotic',
  schedule: 'H1',
};
const TRAMADOL = {
  drugName: 'Tramadol',
  vaultControlled: false,
  controlledClass: 'psychotropic',
  schedule: 'H1',
};
const PARACETAMOL = { drugName: 'Paracetamol', schedule: 'OTC' };

beforeEach(() => vi.clearAllMocks());

describe('legacy_block — today’s behaviour, unchanged', () => {
  beforeEach(() => setMode('legacy_block'));

  it('still refuses a vault narcotic with the original message', async () => {
    await expect(
      checkControlledDispense(TENANT, MORPHINE, { userId: USER }, 'consumption workflow'),
    ).rejects.toThrow(/is an NDPS narcotic — dispense it via the NDPS \(Form 3E\) consumption workflow/);
  });

  it('still lets tramadol through the counter with no prescription', async () => {
    // It has always sold this way. Turning on classification must not
    // retroactively block 26 SKUs that were fine yesterday.
    const r = await checkControlledDispense(TENANT, TRAMADOL, { userId: USER }, 'workflow');
    expect(r.witnessedById).toBeNull();
  });

  it('does not touch an ordinary drug', async () => {
    const r = await checkControlledDispense(TENANT, PARACETAMOL, { userId: USER }, 'workflow');
    expect(r.requirements.isControlled).toBe(false);
    // An uncontrolled drug should not even cost a settings read.
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });
});

describe('inline — the dispense completes on the same screen', () => {
  beforeEach(() => setMode('inline'));

  it('asks for a prescription instead of ejecting the user', async () => {
    await expect(
      checkControlledDispense(TENANT, TRAMADOL, { userId: USER }, 'workflow'),
    ).rejects.toThrow(/Attach the prescription/);
  });

  it('accepts an in-system prescription', async () => {
    const r = await checkControlledDispense(
      TENANT, TRAMADOL, { userId: USER, prescriptionId: 'rx-1' }, 'workflow',
    );
    expect(r.requirements.registerType).toBe('H1');
    expect(r.witnessedById).toBeNull();
  });

  it('accepts a paper prescription captured at the counter', async () => {
    const r = await checkControlledDispense(
      TENANT, TRAMADOL, { userId: USER, externalPrescriptionId: 'ext-1' }, 'workflow',
    );
    expect(r.requirements.needsRx).toBe(true);
    expect(r.witnessedById).toBeNull();
  });

  it('says where a vault drug actually is, rather than just refusing', async () => {
    // The stock is in the safe, so there is nothing on the shelf to sell. That
    // is a physical fact, not a policy decision, and the message should say so.
    await expect(
      checkControlledDispense(
        TENANT, MORPHINE,
        { userId: USER, prescriptionId: 'rx-1', fromBatchStock: true },
        'workflow',
      ),
    ).rejects.toThrow(/held in the narcotic safe/);
  });

  it('requires a witness for a vault narcotic drawn from the vault', async () => {
    await expect(
      checkControlledDispense(
        TENANT, MORPHINE,
        { userId: USER, prescriptionId: 'rx-1', fromBatchStock: false },
        'workflow',
      ),
    ).rejects.toThrow(/second authorised person/);
  });

  it('refuses a witness who is the person dispensing', async () => {
    // The entire purpose of a witness is that they are somebody else.
    await expect(
      checkControlledDispense(
        TENANT, MORPHINE,
        { userId: USER, prescriptionId: 'rx-1', witnessedById: USER, fromBatchStock: false },
        'workflow',
      ),
    ).rejects.toThrow(/different person/);
  });

  it('records the witness and the moment they co-signed', async () => {
    const r = await checkControlledDispense(
      TENANT, MORPHINE,
      { userId: USER, prescriptionId: 'rx-1', witnessedById: 'user-2', fromBatchStock: false },
      'workflow',
    );
    expect(r.witnessedById).toBe('user-2');
    expect(r.witnessedAt).toBeInstanceOf(Date);
  });

  it('leaves an ordinary drug completely alone', async () => {
    const r = await checkControlledDispense(TENANT, PARACETAMOL, { userId: USER }, 'workflow');
    expect(r.requirements.isControlled).toBe(false);
    expect(r.witnessedById).toBeNull();
  });
});

describe('a failed settings read must not wave a controlled drug through', () => {
  it('falls back to the hard block when the tenant cannot be read', async () => {
    (prisma.tenant.findFirst as any).mockRejectedValue(new Error('db down'));
    await expect(
      checkControlledDispense(TENANT, MORPHINE, { userId: USER }, 'consumption workflow'),
    ).rejects.toThrow(/NDPS narcotic/);
  });
});
