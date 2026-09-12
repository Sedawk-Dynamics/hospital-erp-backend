import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  candidatePhrases,
  factTierFor,
  renderMedicineFacts,
  findMedicines,
  buildMedicineContext,
  type MedicineFacts,
} from '../../../../src/modules/ai/ai.drug-context';

/**
 * The assistant may only say what the catalogue says, and only as much of it as
 * the person asking should be led with. These pin both halves: the lookup is
 * deterministic (a model never picks the medicine), and the fact sheet is
 * shaped by role — a receptionist is not opened with NDPS status, a doctor is
 * not denied the composition.
 */

const FACTS: MedicineFacts = {
  id: 'm1',
  name: 'Dolo 650 Tablet',
  kind: 'drug',
  sourceId: 'DRS1',
  sourceRelease: '2026-06',
  manufacturer: 'Micro Labs',
  packSizeLabel: 'strip of 15 tablets',
  productForm: 'Tablet',
  mrp: '32.13',
  countryOfOrigin: 'India',
  storage: 'Store below 30°C',
  isDiscontinued: false,
  saltComposition: 'Paracetamol (650mg)',
  salts: ['Paracetamol (650mg)'],
  rxRequired: true,
  habitForming: false,
  scheduleResolved: 'H',
  scheduleReason: 'Schedule H — matched Paracetamol.',
  controlledClass: 'psychotropic',
  vaultControlled: false,
  therapeuticClass: 'PAIN ANALGESICS',
  chemicalClass: 'Aniline derivative',
  actionClass: 'Analgesics',
  description: 'Used for fever and mild to moderate pain.',
  sideEffects: 'Nausea, vomiting.',
  safety: [
    { topic: 'pregnancy', verdict: 'consult a doctor' },
    { topic: 'alcohol', verdict: 'caution' },
  ],
  interactions: [{ with: 'Tacrolimus', effect: 'Severe' }],
  sections: [
    { key: 'howToUse', title: 'How to use', text: 'Take it as your doctor advises.' },
    { key: 'howItWorks', title: 'How it works', text: 'Blocks prostaglandin synthesis.' },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('who is told what', () => {
  it('reads the tier off the caller\'s roles', () => {
    expect(factTierFor(['doctor'])).toEqual({ clinical: true, legal: true });
    expect(factTierFor(['nurse'])).toEqual({ clinical: true, legal: false });
    expect(factTierFor(['pharmacy_admin'])).toEqual({ clinical: true, legal: true });
    expect(factTierFor(['receptionist'])).toEqual({ clinical: false, legal: false });
    expect(factTierFor([])).toEqual({ clinical: false, legal: false });
  });

  it('gives a non-clinical role the label facts and nothing clinical or legal', () => {
    const sheet = renderMedicineFacts(FACTS, { clinical: false, legal: false });

    expect(sheet).toContain('Used for: Used for fever');
    expect(sheet).toContain('Safety: pregnancy — consult a doctor');
    expect(sheet).toContain('Side effects');
    expect(sheet).toContain('Storage');
    expect(sheet).toContain('How to use');
    // Not for them: composition, schedule, controlled status, interactions,
    // and the pharmacology of how it works.
    expect(sheet).not.toContain('Composition');
    expect(sheet).not.toContain('Schedule this platform');
    expect(sheet).not.toContain('Controlled substance');
    expect(sheet).not.toContain('Interacts with');
    expect(sheet).not.toContain('How it works');
  });

  it('gives a doctor the clinical and legal facts too', () => {
    const sheet = renderMedicineFacts(FACTS, { clinical: true, legal: true });

    expect(sheet).toContain('Composition: Paracetamol (650mg)');
    expect(sheet).toContain('Schedule this platform classified it under: H');
    expect(sheet).toContain('Controlled substance: psychotropic');
    expect(sheet).toContain('Habit forming: no');
    expect(sheet).toContain('Interacts with: Tacrolimus (severe)');
    expect(sheet).toContain('How it works');
  });

  it('keeps the sheet inside its budget, and shows where it cut', () => {
    const long = { ...FACTS, description: 'x'.repeat(5000) };
    const sheet = renderMedicineFacts(long, { clinical: true, legal: true }, 600);
    expect(sheet.length).toBeLessThanOrEqual(600);
    expect(sheet.endsWith('…')).toBe(true);
  });
});

describe('finding the medicine in the question', () => {
  it('tries the longest phrase first, so a product beats its own prefix', () => {
    const phrases = candidatePhrases('what are the side effects of dolo 650 tablet');
    expect(phrases.indexOf('dolo 650 tablet')).toBeLessThan(phrases.indexOf('dolo'));
  });

  it('builds phrases only out of name-like words', () => {
    // "add a" is a prefix of a real product ("Add App 2mg/5ml Syrup"), so a
    // phrase containing a word the app itself is made of must never be tried.
    const phrases = candidatePhrases('how do I add a new patient');
    expect(phrases).not.toContain('add a');
    expect(phrases).not.toContain('add a new patient');
    for (const p of candidatePhrases('what is the dose of this medicine')) {
      expect(['what', 'is', 'the', 'of', 'this', 'dose', 'medicine']).not.toContain(p);
    }
  });

  it('stops at a product name without falling through to molecules', async () => {
    (prisma.drugMaster.findMany as any).mockResolvedValue([{ id: 'm1', name: 'Dolo 650 Tablet' }]);

    const found = await findMedicines('what is dolo 650 tablet for');

    expect(found[0]).toMatchObject({ id: 'm1', via: 'name' });
    expect(prisma.salt.findFirst).not.toHaveBeenCalled();
  });

  it('answers a molecule question from a product of that molecule alone', async () => {
    (prisma.drugMaster.findMany as any).mockResolvedValue([]);
    (prisma.salt.findFirst as any).mockResolvedValue({ id: 's1', name: 'Paracetamol' });
    (prisma.drugMaster.findFirst as any).mockResolvedValue({ id: 'm9', name: 'Calpol 500 Tablet' });

    const found = await findMedicines('side effects of paracetamol');

    expect(found[0]).toMatchObject({ id: 'm9', via: 'molecule', molecule: 'Paracetamol' });
    // "alone" is the point: a combination would describe the wrong molecules.
    const where = (prisma.drugMaster.findFirst as any).mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('+');
  });

  it('leaves a question that names no medicine alone', async () => {
    (prisma.drugMaster.findMany as any).mockResolvedValue([]);
    (prisma.salt.findFirst as any).mockResolvedValue(null);

    expect(await buildMedicineContext('how do I add a new patient', ['doctor'])).toBeNull();
  });
});

describe('the block handed to the assistant', () => {
  beforeEach(() => {
    (prisma.drugMaster.findMany as any).mockImplementation(async (args: any) => {
      if (args?.where?.id?.in) {
        return [
          {
            id: 'm1', name: 'Dolo 650 Tablet', type: 'drug', sourceId: 'DRS1', sourceRelease: '2026-06',
            monograph: {}, manufacturer: 'Micro Labs', packSizeLabel: 'strip of 15 tablets',
            productForm: 'Tablet', mrp: '32.13', countryOfOrigin: 'India', storage: 'Store below 30°C',
            isDiscontinued: false, saltComposition: 'Paracetamol (650mg)', rxRequired: true,
            habitForming: false, scheduleResolved: 'H', scheduleReason: 'Schedule H — matched Paracetamol.',
            controlledClass: null, vaultControlled: false, therapeuticClass: 'PAIN ANALGESICS',
            chemicalClass: null, actionClass: 'Analgesics', description: 'Used for fever.',
            sideEffects: 'Nausea.', safetyAdvice: { pregnancy: 'consult_doctor', alcohol: 'caution' },
            drugInteractions: { drug: ['Tacrolimus'], effect: ['Severe'] },
            salts: [{ strengthValue: 650, strengthUnit: 'mg', perVolumeValue: null, salt: { name: 'Paracetamol' } }],
          },
        ];
      }
      return [{ id: 'm1', name: 'Dolo 650 Tablet' }];
    });
  });

  it('cites the product and tells the assistant not to go beyond the facts', async () => {
    const ctx = await buildMedicineContext('what is dolo 650 tablet used for', ['doctor']);

    expect(ctx?.products).toEqual([{ id: 'm1', name: 'Dolo 650 Tablet' }]);
    expect(ctx?.text).toContain('MEDICINE FACTS');
    expect(ctx?.text).toContain('vendor release 2026-06');
    expect(ctx?.text).toContain('Answer only from them');
    expect(ctx?.text).toContain('never invent a dose');
  });

  it('shapes that block by role', async () => {
    const doctor = await buildMedicineContext('what is dolo 650 tablet used for', ['doctor']);
    const frontDesk = await buildMedicineContext('what is dolo 650 tablet used for', ['receptionist']);

    expect(doctor?.text).toContain('Composition: Paracetamol (650mg)');
    expect(frontDesk?.text).not.toContain('Composition');
    expect(frontDesk?.text).toContain('Used for: Used for fever.');
  });
});
