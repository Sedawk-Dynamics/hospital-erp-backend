import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  classifyFormularyItem,
  overrideFormularySchedule,
  inheritedScheduleFields,
  invalidateScheduleRuleCache,
  affectsClassification,
  classifyDrugMasterItem,
} from '../../../../src/modules/drug-master/drug-schedule.service';

/**
 * These cover the safety promises the classifier's write path makes, rather than
 * the classification logic itself (which has its own suite):
 *
 *  - a pharmacist's manual override is permanent
 *  - a classification failure can never fail the drug it was labelling
 *  - a catalog-linked drug inherits, so one product cannot carry two different
 *    schedules in two hospitals
 */

const RULES = [
  { scheduleCode: 'H1', matchType: 'salt', matchValue: 'Tramadol', matchNorm: 'tramadol', aliases: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  invalidateScheduleRuleCache();
  (prisma.drugScheduleRule.findMany as any).mockResolvedValue(RULES);
});

describe('classifyFormularyItem', () => {
  it('refuses to touch a row a pharmacy admin set manually', async () => {
    (prisma.drugFormulary.findUnique as any).mockResolvedValue({
      id: 'd1',
      drugName: 'Dolo-T',
      genericName: 'Tramadol (37.5mg)',
      composition: null,
      dosageForm: 'tablet',
      drugMasterId: null,
      scheduleSource: 'manual',
      drugMaster: null,
    });

    const patch = await classifyFormularyItem('d1');

    expect(patch).toBeNull();
    expect(prisma.drugFormulary.update).not.toHaveBeenCalled();
  });

  it('classifies an own-formulary drug from its own composition', async () => {
    (prisma.drugFormulary.findUnique as any).mockResolvedValue({
      id: 'd2',
      drugName: 'Dolo-T',
      genericName: 'Tramadol (37.5mg) + Paracetamol (325mg)',
      composition: null,
      dosageForm: 'tablet',
      drugMasterId: null,
      scheduleSource: null,
      drugMaster: null,
    });

    const patch = await classifyFormularyItem('d2');

    expect(patch).toMatchObject({ schedule: 'H1', scheduleSource: 'auto' });
    // The empty composition column is filled from the parsed salts, strengths
    // included — this column is what the classifier reads on the next run.
    expect(patch).toMatchObject({ composition: 'Tramadol (37.5mg) + Paracetamol (325mg)' });
    expect(prisma.drugFormulary.update).toHaveBeenCalled();
  });

  it('inherits the platform decision for a catalog-linked drug', async () => {
    (prisma.drugFormulary.findUnique as any).mockResolvedValue({
      id: 'd3',
      drugName: 'Some Brand',
      genericName: 'Tramadol (50mg)',
      composition: null,
      dosageForm: 'tablet',
      drugMasterId: 'm1',
      scheduleSource: null,
      drugMaster: {
        scheduleResolved: 'H1',
        scheduleReason: 'Schedule H1 — matched Tramadol.',
        controlledClass: 'psychotropic',
        vaultControlled: false,
        requiresQrScan: false,
        saltsJson: [],
      },
    });

    const patch = await classifyFormularyItem('d3');

    expect(patch).toMatchObject({ schedule: 'H1', scheduleSource: 'inherited' });
  });

  it('never lets a failure escape — the drug survives an unclassifiable row', async () => {
    (prisma.drugFormulary.findUnique as any).mockRejectedValue(new Error('db exploded'));
    await expect(classifyFormularyItem('d4')).resolves.toBeNull();
  });

  it('does nothing when the schedule rules have not been seeded', async () => {
    (prisma.drugScheduleRule.findMany as any).mockResolvedValue([]);
    (prisma.drugFormulary.findUnique as any).mockResolvedValue({
      id: 'd5', drugName: 'X', genericName: 'Tramadol (50mg)', composition: null,
      dosageForm: 'tablet', drugMasterId: null, scheduleSource: null, drugMaster: null,
    });

    await expect(classifyFormularyItem('d5')).resolves.toBeNull();
    expect(prisma.drugFormulary.update).not.toHaveBeenCalled();
  });
});

describe('overrideFormularySchedule', () => {
  it('marks the row manual so no re-run can undo it', async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue({
      id: 'd1', drugName: 'Dolo-T', schedule: 'H1',
    });
    (prisma.drugFormulary.update as any).mockResolvedValue({ id: 'd1', schedule: 'X' });

    await overrideFormularySchedule('t1', 'd1', 'u1', { schedule: 'X', reason: 'Local policy' });

    const arg = (prisma.drugFormulary.update as any).mock.calls[0][0];
    expect(arg.data).toMatchObject({
      schedule: 'X',
      scheduleSource: 'manual',
      scheduleReason: 'Local policy',
      scheduleOverriddenById: 'u1',
    });
  });

  it('writes a default explanation when none is given', async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue({ id: 'd1', drugName: 'X', schedule: 'H' });
    (prisma.drugFormulary.update as any).mockResolvedValue({ id: 'd1' });

    await overrideFormularySchedule('t1', 'd1', 'u1', { schedule: 'H1' });

    const arg = (prisma.drugFormulary.update as any).mock.calls[0][0];
    expect(arg.data.scheduleReason).toMatch(/Manually set to Schedule H1/);
  });

  it('returns null for a drug outside this hospital', async () => {
    (prisma.drugFormulary.findFirst as any).mockResolvedValue(null);
    await expect(
      overrideFormularySchedule('t1', 'other', 'u1', { schedule: 'X' }),
    ).resolves.toBeNull();
    expect(prisma.drugFormulary.update).not.toHaveBeenCalled();
  });
});

describe('inheritedScheduleFields', () => {
  it('carries the catalog decision into a bulk insert', () => {
    expect(
      inheritedScheduleFields({
        scheduleResolved: 'X',
        scheduleReason: 'why',
        controlledClass: 'psychotropic',
        vaultControlled: true,
        requiresQrScan: false,
      }),
    ).toMatchObject({ schedule: 'X', scheduleSource: 'inherited', vaultControlled: true });
  });

  it('writes nothing for a catalog row that was never classified', () => {
    expect(inheritedScheduleFields({ scheduleResolved: null })).toEqual({});
  });
});

describe('affectsClassification', () => {
  /**
   * Re-classification is gated on this, so it has to name every field the
   * classifier reads. A field missing here means an edit silently leaves the
   * old schedule standing — and nothing else would revisit it, because the row
   * is already at the current classifier version.
   */
  it('fires for every field the classifier actually reads', () => {
    for (const k of ['name', 'drugName', 'genericName', 'composition', 'saltComposition', 'dosageForm']) {
      expect(affectsClassification({ [k]: 'x' }), k).toBe(true);
    }
  });

  it('does not fire for an ordinary edit', () => {
    // A price or stock change must not cost a re-classification.
    expect(affectsClassification({ price: 10, minStock: 5, taxPercent: 12 })).toBe(false);
    expect(affectsClassification({})).toBe(false);
  });

  it('fires even when the field was cleared rather than set', () => {
    // Removing a composition changes the answer just as much as adding one.
    expect(affectsClassification({ composition: null })).toBe(true);
  });
});

describe('classifyDrugMasterItem', () => {
  it('labels a catalog drug a super admin just added', async () => {
    (prisma.drugMaster.findUnique as any).mockResolvedValue({
      id: 'm1', name: 'Dolo-T', genericName: 'Tramadol (37.5mg)',
      saltComposition: null, dosageForm: 'tablet',
    });
    await classifyDrugMasterItem('m1');

    const arg = (prisma.drugMaster.update as any).mock.calls[0][0];
    // The fixture holds only the Schedule H1 salt rule, no NDPS overlay row —
    // so H1 with no controlled class is exactly right here.
    expect(arg.data).toMatchObject({ scheduleResolved: 'H1', controlledClass: null });
    expect(arg.data.classifierVersion).toBeGreaterThanOrEqual(1);
  });

  it('never writes the legacy schedule column', async () => {
    // The counter's compliance check reads that one; filling it would switch
    // enforcement on for this drug in every hospital.
    (prisma.drugMaster.findUnique as any).mockResolvedValue({
      id: 'm1', name: 'Dolo-T', genericName: 'Tramadol (37.5mg)',
      saltComposition: null, dosageForm: 'tablet',
    });
    await classifyDrugMasterItem('m1');
    expect((prisma.drugMaster.update as any).mock.calls[0][0].data).not.toHaveProperty('schedule');
  });

  it('passes the decision on to the hospitals that inherit it, never a manual one', async () => {
    // The counter reads the formulary row. A decision that stopped at the
    // catalogue — a super admin's edit, a molecule decided in the salt review —
    // reached no hospital until the next classifier version.
    (prisma.drugMaster.findUnique as any).mockResolvedValue({
      id: 'm1', name: 'Dolo-T', genericName: 'Tramadol (37.5mg)',
      saltComposition: null, dosageForm: 'tablet',
    });
    await classifyDrugMasterItem('m1');

    const arg = (prisma.drugFormulary.updateMany as any).mock.calls[0][0];
    expect(arg.where.drugMasterId).toBe('m1');
    expect(JSON.stringify(arg.where)).toContain('manual');
    expect(arg.data).toMatchObject({ schedule: 'H1', scheduleSource: 'inherited' });
  });

  it('leaves the drug saved when classification fails', async () => {
    (prisma.drugMaster.findUnique as any).mockRejectedValue(new Error('db exploded'));
    await expect(classifyDrugMasterItem('m1')).resolves.toBeUndefined();
  });
});

describe('adding a drug whose composition names an unknown molecule', () => {
  /**
   * The case that matters most when a NEW drug arrives: a molecule the salt
   * master has never seen.
   *
   * It used to be dropped twice over. The link was skipped, so the drug was
   * classified from a partial composition — and then the derived composition,
   * built from the molecules that HAD resolved, was written back over the
   * stored one. "Paracetamol (500mg) + Zyxomorphine (10mg)" became
   * "Paracetamol (500mg)": the system deleted the ingredient it did not
   * recognise, which is the ingredient a person most needed to look at.
   */
  it('never lets a derived composition drop a molecule the text named', async () => {
    (prisma.drugMaster.findUnique as any).mockResolvedValue({
      id: 'm1', name: 'Novel', genericName: 'Paracetamol (500mg) + Zyxomorphine (10mg)',
      saltComposition: null, dosageForm: 'tablet',
    });
    // The salt master resolves only one of the two molecules.
    (prisma.salt.findMany as any).mockResolvedValue([
      { id: 's1', name: 'Paracetamol', norm: 'paracetamol', scheduleCode: 'OTC',
        controlledClass: null, narcoticClass: null, vaultControlled: false,
        exemptIfCombination: false, maxPerUnitMg: null, maxConcentrationPercent: null,
        fallbackSchedule: null, topicalExempt: false, synonyms: [], classes: [] },
    ]);
    (prisma.salt.create as any).mockRejectedValue(new Error('cannot create'));
    (prisma.salt.findUnique as any).mockResolvedValue(null);
    (prisma.drugSalt.findMany as any).mockResolvedValue([
      { saltId: 's1', strengthValue: 500, strengthUnit: 'mg', perVolumeValue: null },
    ]);

    await classifyDrugMasterItem('m1');

    const data = (prisma.drugMaster.update as any).mock.calls[0][0].data;
    // One molecule resolved out of two, so the derived string is short — it
    // must not be written over what the pharmacist typed.
    expect(data).not.toHaveProperty('saltComposition');
  });
});
