import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/modules/ai/ai.config.service', () => ({
  assertFeatureEnabled: vi.fn(async () => undefined),
}));
vi.mock('../../../../src/modules/ai/ai.context', () => ({
  buildPatientContext: vi.fn(async () => ({
    patient: { id: 'p1', name: 'Asha' },
    text: '## MEDICATIONS\n- Amlodipine 5mg (current)',
    counts: { labResults: 0 },
  })),
}));
vi.mock('../../../../src/services/ai', () => ({
  generateText: vi.fn(async () => ({ text: 'answer', model: 'gemini-2.5-flash', provider: 'gemini' })),
  generateJson: vi.fn(async () => ({})),
}));

import { prisma } from '../../../../src/config/database';
import { patientChat } from '../../../../src/modules/ai/ai.chat.service';
import { generateText } from '../../../../src/services/ai';

/**
 * The doctor's assistant reasons about one patient. When the question names a
 * medicine it should reason from the catalogue's label facts — the composition
 * and interactions this hospital actually dispenses — rather than from the
 * model's recollection of that brand.
 */

const CATALOGUE_ROW = {
  id: 'm1', name: 'Dolo 650 Tablet', type: 'drug', sourceId: 'DRS1', sourceRelease: '2026-06',
  monograph: {}, manufacturer: 'Micro Labs', packSizeLabel: 'strip of 15 tablets',
  productForm: 'Tablet', mrp: '32.13', countryOfOrigin: 'India', storage: 'Store below 25°C',
  isDiscontinued: false, saltComposition: 'Paracetamol (650mg)', rxRequired: false,
  habitForming: false, scheduleResolved: 'OTC', scheduleReason: 'No scheduled substance found.',
  controlledClass: null, vaultControlled: false, therapeuticClass: 'PAIN ANALGESICS',
  chemicalClass: null, actionClass: 'Analgesics', description: 'Pain relief; Treatment of Fever',
  sideEffects: 'Nausea', safetyAdvice: { alcohol: 'unsafe' },
  drugInteractions: { drug: ['Warfarin'], effect: ['Moderate'] },
  salts: [{ strengthValue: 650, strengthUnit: 'mg', perVolumeValue: null, salt: { name: 'Paracetamol' } }],
};

const systemPrompt = () => (generateText as any).mock.calls[0][0].system as string;

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.auditLog.create as any).mockResolvedValue({});
});

describe('the doctor asks about a medicine', () => {
  it('puts the catalogue facts beside the patient record, and says which product', async () => {
    (prisma.drugMaster.findMany as any).mockImplementation(async (args: any) =>
      args?.where?.id?.in ? [CATALOGUE_ROW] : [{ id: 'm1', name: 'Dolo 650 Tablet' }],
    );

    const out = await patientChat('t1', 'u1', ['doctor'], {
      patientId: 'p1',
      message: 'is dolo 650 tablet safe with her current medicines?',
    } as any);

    const system = systemPrompt();
    expect(system).toContain('PATIENT CONTEXT');
    expect(system).toContain('MEDICINE FACTS');
    expect(system).toContain('Composition: Paracetamol (650mg)');
    expect(system).toContain('Interacts with: Warfarin (moderate)');
    expect(out.context.medicines).toEqual([{ id: 'm1', name: 'Dolo 650 Tablet' }]);
  });

  it('leaves the prompt exactly as it was when no medicine is named', async () => {
    (prisma.drugMaster.findMany as any).mockResolvedValue([]);
    (prisma.salt.findFirst as any).mockResolvedValue(null);

    const out = await patientChat('t1', 'u1', ['doctor'], {
      patientId: 'p1',
      message: 'summarise her last consultation',
    } as any);

    expect(systemPrompt()).not.toContain('MEDICINE FACTS');
    expect(out.context.medicines).toEqual([]);
  });
});
