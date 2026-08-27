import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  resolveTransferCustody,
  assertTransferCustody,
} from '../../../../src/modules/inventory/transfer-custody';

/**
 * The transfer board used to have NO controlled-drug handling whatsoever, while
 * the NDPS challan screen required a second person for every narcotic move.
 * Merging the two screens without this would have made the board the way round
 * the statutory chain of custody. These pin the rule.
 */

const VAULT = { drugName: 'Morphine Inj', controlledClass: 'narcotic', vaultControlled: true };
const CONTROLLED = { drugName: 'Tramadol', controlledClass: 'psychotropic', vaultControlled: false };
const ORDINARY = { drugName: 'Paracetamol', controlledClass: null, vaultControlled: false };

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.user.findFirst as any).mockResolvedValue({ id: 'u2' });
});

describe('resolveTransferCustody', () => {
  it('demands a second person for a vault narcotic', () => {
    const r = resolveTransferCustody(VAULT);
    expect(r.isControlled).toBe(true);
    expect(r.needsCustodian).toBe(true);
    expect(r.reason).toMatch(/cannot be you/);
  });

  it('records a controlled but un-vaulted drug without demanding one', () => {
    // Tramadol is psychotropic and belongs in the register, but it is dispensed
    // normally — vaulting every tramadol SKU is the exact mistake the two-axis
    // design exists to avoid.
    const r = resolveTransferCustody(CONTROLLED);
    expect(r.isControlled).toBe(true);
    expect(r.needsCustodian).toBe(false);
  });

  it('says nothing about an ordinary drug', () => {
    expect(resolveTransferCustody(ORDINARY)).toMatchObject({
      isControlled: false, needsCustodian: false, reason: null,
    });
  });

  it('is safe on a transfer that carries no drug at all', () => {
    // A generic inventory item transfer has no drug — it must not throw.
    expect(resolveTransferCustody(null).needsCustodian).toBe(false);
  });
});

describe('assertTransferCustody', () => {
  it('refuses to move a narcotic with nobody named', async () => {
    await expect(
      assertTransferCustody('t1', VAULT, { dispatcherId: 'u1', custodianId: null }),
    ).rejects.toThrow(/name the person receiving it/i);
  });

  it('refuses to let one person co-sign their own hand-over', async () => {
    // The entire point of a witness is that it is somebody else.
    await expect(
      assertTransferCustody('t1', VAULT, { dispatcherId: 'u1', custodianId: 'u1' }),
    ).rejects.toThrow(/cannot be the person dispatching/i);
  });

  it('refuses a custodian from outside the hospital', async () => {
    (prisma.user.findFirst as any).mockResolvedValue(null);
    await expect(
      assertTransferCustody('t1', VAULT, { dispatcherId: 'u1', custodianId: 'u2' }),
    ).rejects.toThrow(/not a user of this hospital/i);
  });

  it('accepts a proper hand-over and stamps when custody passed', async () => {
    const r = await assertTransferCustody('t1', VAULT, { dispatcherId: 'u1', custodianId: 'u2' });
    expect(r.custodianId).toBe('u2');
    expect(r.custodyAt).toBeInstanceOf(Date);
  });

  it('lets an ordinary drug move with no custodian and no lookup', async () => {
    const r = await assertTransferCustody('t1', ORDINARY, { dispatcherId: 'u1' });
    expect(r.custodianId).toBeNull();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('still records a custodian when one is named for a non-vault drug', async () => {
    const r = await assertTransferCustody('t1', CONTROLLED, { dispatcherId: 'u1', custodianId: 'u2' });
    expect(r.custodianId).toBe('u2');
  });
});
