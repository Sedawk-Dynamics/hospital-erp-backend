import { describe, it, expect } from 'vitest';
import {
  resolveControlRequirements,
  mergeControlledDrugSettings,
  DEFAULT_CONTROLLED_DRUG_SETTINGS,
} from '../../../src/shared/controlled-drug';

/**
 * The policy that decides what a controlled drug needs before it can be handed
 * over. It replaced five separate hard-coded checks, so the point of these
 * tests is that one answer now serves the counter, ward stock, ward indents and
 * OT kits — and that the answer is right for each tier.
 */

const drug = (over: Record<string, unknown> = {}) => ({
  drugName: 'Test Drug',
  isNarcotic: false,
  schedule: null,
  controlledClass: null,
  vaultControlled: false,
  ...over,
});

describe('resolveControlRequirements', () => {
  it('lets an ordinary medicine through untouched', () => {
    const r = resolveControlRequirements(drug({ schedule: 'H' }));
    expect(r.isControlled).toBe(false);
    expect(r.needsRx).toBe(false);
    expect(r.needsWitness).toBe(false);
  });

  it('leaves an OTC drug alone', () => {
    expect(resolveControlRequirements(drug({ schedule: 'OTC' })).isControlled).toBe(false);
  });

  it('asks a vault narcotic for a prescription, a witness and safe custody', () => {
    const r = resolveControlRequirements(drug({ drugName: 'Morphine', vaultControlled: true, controlledClass: 'narcotic' }));
    expect(r).toMatchObject({
      isControlled: true,
      needsRx: true,
      needsWitness: true,
      needsVaultCustody: true,
      registerType: 'NDPS',
    });
  });

  it('still honours a hospital that ticked isNarcotic by hand', () => {
    // The manual flag predates the classifier, so a drug an admin flagged must
    // never be quietly downgraded by a classification that disagrees.
    const r = resolveControlRequirements(drug({ isNarcotic: true, schedule: 'OTC' }));
    expect(r.needsVaultCustody).toBe(true);
    expect(r.registerType).toBe('NDPS');
  });

  it('asks Schedule X for a prescription but not a witness', () => {
    // Schedule X is a paperwork and storage regime, not a two-person one.
    const r = resolveControlRequirements(drug({ drugName: 'Alprazolam', schedule: 'X' }));
    expect(r).toMatchObject({ needsRx: true, needsWitness: false, registerType: 'X' });
    expect(r.reason).toMatch(/duplicate/i);
  });

  it('keeps tramadol on the counter — prescription and register, no witness, no vault', () => {
    // The case the whole design turns on: 26 SKUs in this formulary.
    const r = resolveControlRequirements(
      drug({ drugName: 'Tramadol', schedule: 'H1', controlledClass: 'psychotropic' }),
    );
    expect(r).toMatchObject({
      isControlled: true,
      needsRx: true,
      needsWitness: false,
      needsVaultCustody: false,
      registerType: 'H1',
    });
  });

  it('treats a plain Schedule H1 drug the same way', () => {
    const r = resolveControlRequirements(drug({ drugName: 'Cefixime', schedule: 'H1' }));
    expect(r).toMatchObject({ needsRx: true, needsVaultCustody: false, registerType: 'H1' });
  });

  it('catches a controlled drug even when its schedule is missing', () => {
    // A drug the classifier could not schedule but the NDPS list names must not
    // slip through as ordinary stock.
    const r = resolveControlRequirements(drug({ controlledClass: 'psychotropic' }));
    expect(r.isControlled).toBe(true);
    expect(r.needsRx).toBe(true);
  });

  it('always explains itself to whoever is dispensing', () => {
    for (const d of [
      drug({ vaultControlled: true }),
      drug({ schedule: 'X' }),
      drug({ schedule: 'H1' }),
    ]) {
      expect(resolveControlRequirements(d).reason?.length ?? 0).toBeGreaterThan(20);
    }
  });
});

describe('controlled-drug settings', () => {
  it('defaults to the old hard block, so merging the code changes nothing', () => {
    expect(DEFAULT_CONTROLLED_DRUG_SETTINGS.mode).toBe('legacy_block');
  });

  it('accepts a switch to inline', () => {
    expect(mergeControlledDrugSettings(DEFAULT_CONTROLLED_DRUG_SETTINGS, { mode: 'inline' }).mode).toBe('inline');
  });

  it('ignores a mode it does not recognise rather than guessing', () => {
    expect(mergeControlledDrugSettings(DEFAULT_CONTROLLED_DRUG_SETTINGS, { mode: 'off' }).mode).toBe('legacy_block');
    expect(mergeControlledDrugSettings(DEFAULT_CONTROLLED_DRUG_SETTINGS, null).mode).toBe('legacy_block');
    expect(mergeControlledDrugSettings(DEFAULT_CONTROLLED_DRUG_SETTINGS, 'nonsense').mode).toBe('legacy_block');
  });

  it('refuses to leave the witness list empty', () => {
    // An empty list would make every witnessed transaction impossible and lock
    // the hospital out of its own narcotics.
    const r = mergeControlledDrugSettings(DEFAULT_CONTROLLED_DRUG_SETTINGS, { witnessRoles: [] });
    expect(r.witnessRoles.length).toBeGreaterThan(0);
  });

  it('takes a narrowed witness list', () => {
    const r = mergeControlledDrugSettings(DEFAULT_CONTROLLED_DRUG_SETTINGS, {
      witnessRoles: ['nurse_admin', 'doctor'],
    });
    expect(r.witnessRoles).toEqual(['nurse_admin', 'doctor']);
  });
});
