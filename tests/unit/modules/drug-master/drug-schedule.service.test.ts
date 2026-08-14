import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  classifyFormularyItem,
  overrideFormularySchedule,
  inheritedScheduleFields,
  invalidateScheduleRuleCache,
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
    // The empty composition column is filled from the parsed salts.
    expect(patch).toMatchObject({ composition: 'Tramadol + Paracetamol' });
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
