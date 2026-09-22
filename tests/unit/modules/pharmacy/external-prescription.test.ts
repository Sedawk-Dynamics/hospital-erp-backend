import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  computeRetainUntil,
  normalizePrescribedDate,
  parsePrescriptionJson,
  createExternalPrescription,
} from '../../../../src/modules/pharmacy/external-prescription.service';
import { checkSaleCompliance } from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

beforeEach(() => vi.clearAllMocks());

describe('outside prescriptions — statutory retention', () => {
  it('keeps a Schedule H1 sale for three years', () => {
    const from = new Date('2026-08-14T00:00:00Z');
    expect(computeRetainUntil(['H1'], from).getFullYear()).toBe(2029);
  });

  it('never falls below three years, whatever the schedule', () => {
    const from = new Date('2026-08-14T00:00:00Z');
    // Schedule X's own rule is two years, but a mixed cart could also hold an
    // H1 line, so the floor is the longest ordinary period rather than the
    // shortest — destroying a record early is the unrecoverable mistake.
    expect(computeRetainUntil(['X'], from).getFullYear()).toBe(2029);
    expect(computeRetainUntil([], from).getFullYear()).toBe(2029);
    expect(computeRetainUntil(['OTC'], from).getFullYear()).toBe(2029);
  });
});

describe('outside prescriptions — date parsing', () => {
  it('reads the dd/mm/yyyy Indian prescriptions are written in', () => {
    expect(normalizePrescribedDate('14/08/2026')).toBe('2026-08-14');
    expect(normalizePrescribedDate('1-8-26')).toBe('2026-08-01');
    expect(normalizePrescribedDate('14.08.2026')).toBe('2026-08-14');
  });

  it('passes an ISO date through', () => {
    expect(normalizePrescribedDate('2026-08-14')).toBe('2026-08-14');
  });

  it('returns null rather than guessing at nonsense', () => {
    expect(normalizePrescribedDate('yesterday')).toBeNull();
    expect(normalizePrescribedDate('45/45/2026')).toBeNull();
    expect(normalizePrescribedDate(null)).toBeNull();
    expect(normalizePrescribedDate('')).toBeNull();
  });
});

describe('outside prescriptions — OCR parsing', () => {
  it('pulls the prescriber, patient and medicines out of the model response', () => {
    const r = parsePrescriptionJson(`Sure! Here you go:
      {"patientName":"Ramesh Kumar","patientAge":42,"patientSex":"Male","patientAddress":"12 MG Road",
       "prescriberName":"A. Gaur","prescriberRegNo":"NMC-9875","prescriberQualification":"MBBS, MD",
       "hospitalName":"City Clinic","prescribedDate":"12/08/2026",
       "medicines":["Tramadol 50mg 1-0-1 x 5 days","Pan 40 1-0-0"]}`);
    expect(r.prescriberName).toBe('A. Gaur');
    expect(r.prescriberRegNo).toBe('9875');
    expect(r.patientSex).toBe('male');
    expect(r.prescribedDate).toBe('2026-08-12');
    expect(r.medicines).toHaveLength(2);
  });

  it('strips a label the model kept on the registration number', () => {
    // Prescriptions print the label and its separator every which way, and a
    // leftover hyphen would corrupt the number the register is keyed on.
    expect(parsePrescriptionJson('{"prescriberRegNo":"Reg. No. 12345","medicines":[]}').prescriberRegNo).toBe('12345');
    expect(parsePrescriptionJson('{"prescriberRegNo":"NMC-9875","medicines":[]}').prescriberRegNo).toBe('9875');
    expect(parsePrescriptionJson('{"prescriberRegNo":"MCI: 999","medicines":[]}').prescriberRegNo).toBe('999');
    expect(parsePrescriptionJson('{"prescriberRegNo":"NMC 42","medicines":[]}').prescriberRegNo).toBe('42');
  });

  it('does not blank a bare number that carries no label', () => {
    expect(parsePrescriptionJson('{"prescriberRegNo":"88123","medicines":[]}').prescriberRegNo).toBe('88123');
  });

  it('treats an unreadable field as absent rather than inventing one', () => {
    const r = parsePrescriptionJson('{"prescriberName":"null","patientAge":"abc","medicines":[]}');
    expect(r.prescriberName).toBeNull();
    expect(r.patientAge).toBeNull();
  });

  it('rejects a response with no JSON in it', () => {
    expect(() => parsePrescriptionJson('I cannot read this image.')).toThrow();
  });

  it('ignores an implausible age', () => {
    expect(parsePrescriptionJson('{"patientAge":900,"medicines":[]}').patientAge).toBeNull();
  });
});

describe('outside prescriptions — creation', () => {
  it('requires the prescriber, since the record is worthless without one', async () => {
    await expect(
      createExternalPrescription(TENANT_ID, USER_ID, { prescriberName: '   ' }),
    ).rejects.toThrow(/prescriber/i);
    expect(prisma.externalPrescription.create).not.toHaveBeenCalled();
  });

  it('records a walk-in with no patient row at all', async () => {
    (prisma.externalPrescription.create as any).mockResolvedValue({ id: 'x1' });
    await createExternalPrescription(TENANT_ID, USER_ID, {
      prescriberName: 'Dr Gaur',
      prescriberRegNo: 'NMC-1',
      patientNameRaw: 'Walk-in Ramesh',
    });
    const arg = (prisma.externalPrescription.create as any).mock.calls[0][0];
    expect(arg.data.patientId).toBeNull();
    expect(arg.data.patientNameRaw).toBe('Walk-in Ramesh');
    expect(arg.data.capturedById).toBe(USER_ID);
    expect(arg.data.retainUntil).toBeInstanceOf(Date);
  });

  it('refuses a patient from another hospital', async () => {
    (prisma.patient.findFirst as any).mockResolvedValue(null);
    await expect(
      createExternalPrescription(TENANT_ID, USER_ID, {
        prescriberName: 'Dr Gaur',
        patientId: 'someone-elses-patient',
      }),
    ).rejects.toThrow(/Patient not found/);
  });
});

describe('compliance — an outside prescription counts as a prescription', () => {
  // The schedule comes off the formulary row, which is what the classifier
  // writes and what the sale itself enforces. It used to be read from
  // drugMaster.schedule — deliberately left NULL — so this pre-check was blind
  // to schedules while the sale refused them, and a cashier would confirm a
  // warnings dialog only to be refused a moment later.
  const scheduleXBatch = [
    { id: 'b1', drug: { drugName: 'Alprazolam', hsnCode: '3004', taxPercent: 12, schedule: 'X' } },
  ];
  const setMode = (mode: 'legacy_block' | 'inline') =>
    (prisma.tenant.findFirst as any).mockResolvedValue({ themeConfig: { controlledDrugs: { mode } } });

  it('blocks a Schedule X sale with no prescription of either kind', async () => {
    setMode('inline');
    (prisma.drugBatch.findMany as any).mockResolvedValue(scheduleXBatch);
    const r = await checkSaleCompliance(TENANT_ID, { items: [{ drugBatchId: 'b1' }] });
    expect(r.ok).toBe(false);
    // Schedule X keeps its original wording — that blocker predates the
    // enforcement setting and is not conditional on it.
    expect(r.blockers[0]).toMatch(/Schedule X/);
  });

  it('allows it once a paper prescription is attached', async () => {
    setMode('inline');
    (prisma.drugBatch.findMany as any).mockResolvedValue(scheduleXBatch);
    const r = await checkSaleCompliance(TENANT_ID, {
      items: [{ drugBatchId: 'b1' }],
      externalPrescriptionId: 'ext-1',
    });
    expect(r.ok).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it('still allows it with an in-system prescription', async () => {
    setMode('inline');
    (prisma.drugBatch.findMany as any).mockResolvedValue(scheduleXBatch);
    const r = await checkSaleCompliance(TENANT_ID, {
      items: [{ drugBatchId: 'b1' }],
      prescriptionId: 'rx-1',
    });
    expect(r.ok).toBe(true);
  });

  it('only advises on Schedule H1 while the hospital is on the old block', async () => {
    // The pre-check must never be stricter than the sale. Schedule H1 has
    // always sold at the counter, so until enforcement is switched on this is
    // a warning. (Schedule X is the exception — it has always been a blocker,
    // and that predates the setting.)
    setMode('legacy_block');
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', drug: { drugName: 'Tramadol', hsnCode: '3004', taxPercent: 12, schedule: 'H1' } },
    ]);
    const r = await checkSaleCompliance(TENANT_ID, { items: [{ drugBatchId: 'b1' }] });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => /Schedule H1/.test(w))).toBe(true);
  });

  it('blocks that same H1 drug once enforcement is on', async () => {
    setMode('inline');
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      { id: 'b1', drug: { drugName: 'Tramadol', hsnCode: '3004', taxPercent: 12, schedule: 'H1' } },
    ]);
    const r = await checkSaleCompliance(TENANT_ID, { items: [{ drugBatchId: 'b1' }] });
    expect(r.ok).toBe(false);
    expect(r.blockers[0]).toMatch(/needs a prescription/i);
  });

  it('allows a narcotic sale with a prescription and no witness', async () => {
    setMode('inline');
    (prisma.drugBatch.findMany as any).mockResolvedValue([
      {
        id: 'b1',
        drug: {
          drugName: 'Morphine', hsnCode: '3004', taxPercent: 5,
          schedule: 'H1', isNarcotic: true, vaultControlled: true,
          controlledClass: 'narcotic',
        },
      },
    ]);
    const r = await checkSaleCompliance(TENANT_ID, {
      items: [{ drugBatchId: 'b1' }],
      prescriptionId: 'rx-1',
    });
    expect(r.ok).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });
});
