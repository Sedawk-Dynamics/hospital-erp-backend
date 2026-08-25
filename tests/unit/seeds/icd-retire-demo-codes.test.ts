import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../src/config/database';
import { retireDemoIcdCodes } from '../../../src/seeds/icd-retire-demo-codes';

/**
 * This step writes to clinical records, so what it does NOT do matters as much
 * as what it does.
 *
 * The five TRMS demo codes were seeded so a CDSS document's worked example
 * resolved. Once the full WHO catalogue landed they became the top hit for
 * "fever" and "malaria" — codes no claim would accept, ranked above R50.9 and
 * B54 — so they are removed and the diagnoses recorded against them re-coded.
 */

const findFirst = vi.mocked(prisma.icdCode.findFirst);
const findMany = vi.mocked(prisma.icdCode.findMany);
const deleteMany = vi.mocked(prisma.icdCode.deleteMany);
const updateMany = vi.mocked(prisma.diagnosis.updateMany);
const groupBy = vi.mocked(prisma.diagnosis.groupBy);

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue({ code: 'R50.9' } as never);
  findMany.mockResolvedValue([{ code: '100' }, { code: '101' }] as never);
  deleteMany.mockResolvedValue({ count: 2 } as never);
  updateMany.mockResolvedValue({ count: 3 } as never);
  groupBy.mockResolvedValue([] as never);
});

const run = () => retireDemoIcdCodes(prisma as never);

describe('retiring the TRMS demo ICD codes', () => {
  it('re-codes both fever codes to R50.9', async () => {
    // WHO ICD-10 has no distinct code for fever with chills, and fever is the
    // presenting finding in both, so R50.9 is right for each.
    await run();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { icdCode: '100' }, data: { icdCode: 'R50.9' } }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { icdCode: '101' }, data: { icdCode: 'R50.9' } }),
    );
  });

  it('never touches what the clinician actually wrote', async () => {
    // `diagnosisName` is what every screen displays. "Fever with Chills" is a
    // real observation and says more than "Fever, unspecified" — re-coding must
    // correct the classification, not overwrite the record.
    await run();

    for (const call of updateMany.mock.calls) {
      expect(Object.keys((call[0] as { data: object }).data)).toEqual(['icdCode']);
    }
  });

  it('refuses to point a record at a code that is not in the catalogue', async () => {
    findFirst.mockResolvedValue(null as never);

    await run();

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('deletes only platform rows carrying the demo category', async () => {
    // Scoped so a hospital's own custom codes can never be caught by it.
    await run();

    expect(deleteMany).toHaveBeenCalledWith({
      where: { tenantId: null, category: 'TRMS demo' },
    });
  });

  it('does not guess a mapping for the codes that have no agreed one', async () => {
    // Diarrhoea splits on whether it is infectious; "Skin Allergy" could be any
    // of several codes. Guessing on someone's record is not a seed's job.
    await run();

    const remapped = updateMany.mock.calls.map((c) => (c[0] as { where: { icdCode: string } }).where.icdCode);
    expect(remapped).not.toContain('102');
    expect(remapped).not.toContain('103');
    expect(remapped).not.toContain('104');
  });

  it('reports diagnoses left on an unmapped demo code instead of hiding them', async () => {
    groupBy.mockResolvedValue([{ icdCode: '104', _count: { _all: 2 } }] as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run();

    expect(log.mock.calls.flat().join(' ')).toContain('104');
    log.mockRestore();
  });

  it('is a no-op once the catalogue rows are gone', async () => {
    findMany.mockResolvedValue([] as never);

    await run();

    expect(deleteMany).not.toHaveBeenCalled();
  });
});
