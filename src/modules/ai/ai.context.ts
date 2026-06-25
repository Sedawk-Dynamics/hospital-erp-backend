import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';

// Aggregates a patient's clinical record into a compact text block for the
// patient AI chatbot (Use Case 2, Level 1 — text only, no radiology image
// processing). Everything is tenant-scoped and recency-bounded to control token
// cost. The same data is also returned structured for the UI's context preview.

function ageFromDob(dob: Date | null): number | null {
  if (!dob) return null;
  const diff = Date.now() - new Date(dob).getTime();
  return Math.floor(diff / (365.25 * 24 * 3600 * 1000));
}

function line(label: string, value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? '' : `${label}: ${value}`;
}

export interface BuiltPatientContext {
  patient: {
    id: string;
    name: string;
    mrn: string;
    age: number | null;
    gender: string | null;
    bloodGroup: string | null;
  };
  /** Compact, model-ready serialization of the record. */
  text: string;
  /** Counts so the UI can show "context: 3 diagnoses, 12 labs…". */
  counts: Record<string, number>;
}

export async function buildPatientContext(
  tenantId: string,
  patientId: string,
): Promise<BuiltPatientContext> {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    include: { allergies: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  // Pull each clinical stream in parallel, recency-bounded.
  const [visits, prescriptions, labResults, imaging, personalHistory, familyHistory, vitals] =
    await Promise.all([
      prisma.visit.findMany({
        where: { patientId, tenantId },
        orderBy: { visitDate: 'desc' },
        take: 8,
        include: { diagnoses: true },
      }),
      prisma.prescription.findMany({
        where: { patientId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: { prescriptionItems: true },
      }),
      prisma.labResult.findMany({
        where: { patientId, labOrder: { tenantId } },
        orderBy: { enteredAt: 'desc' },
        take: 40,
        include: { labOrderItem: { include: { test: { select: { testName: true } } } } },
      }),
      prisma.imagingRequest.findMany({
        where: { patientId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: { imagingResult: { select: { impression: true, status: true } } },
      }),
      prisma.patientPersonalHistory.findUnique({ where: { patientId } }),
      prisma.patientFamilyHistory.findMany({ where: { patientId }, take: 10 }),
      prisma.vital.findMany({
        where: { patientId, visit: { tenantId } },
        orderBy: { recordedAt: 'desc' },
        take: 3,
      }),
    ]);

  const age = ageFromDob(patient.dateOfBirth);
  const name = `${patient.firstName} ${patient.lastName ?? ''}`.trim();

  // --- Build the text block, section by section. Empty sections are dropped. ---
  const sections: string[] = [];

  sections.push(
    [
      '## PATIENT',
      line('Name', name),
      line('MRN', patient.mrn),
      line('Age', age),
      line('Gender', patient.gender),
      line('Blood group', patient.bloodGroup),
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (patient.allergies.length) {
    sections.push(
      '## ALLERGIES\n' +
        patient.allergies
          .map(
            (a) =>
              `- ${a.allergen} (${a.allergyType}${a.severity ? `, ${a.severity}` : ''})${a.reaction ? ` — ${a.reaction}` : ''}`,
          )
          .join('\n'),
    );
  }

  const allDiagnoses = visits.flatMap((v) => v.diagnoses);
  if (allDiagnoses.length) {
    sections.push(
      '## DIAGNOSES\n' +
        allDiagnoses
          .slice(0, 20)
          .map(
            (d) =>
              `- ${d.diagnosisName}${d.icdCode ? ` [${d.icdCode}]` : ''} (${d.diagnosisType})${d.notes ? ` — ${d.notes}` : ''}`,
          )
          .join('\n'),
    );
  }

  if (visits.length) {
    sections.push(
      '## CONSULTATION HISTORY (recent)\n' +
        visits
          .map(
            (v) =>
              `- ${new Date(v.visitDate).toISOString().slice(0, 10)} ${v.visitType}${v.chiefComplaint ? ` — ${v.chiefComplaint}` : ''}`,
          )
          .join('\n'),
    );
  }

  if (prescriptions.length) {
    const meds = prescriptions
      .flatMap((p) => p.prescriptionItems)
      .slice(0, 25)
      .map(
        (i) =>
          `- ${i.drugName} ${i.dosage} ${i.frequency}${i.duration ? ` x${i.duration}` : ''} (${i.route})`,
      );
    if (meds.length) sections.push('## MEDICATIONS (recent prescriptions)\n' + meds.join('\n'));
  }

  if (labResults.length) {
    sections.push(
      '## LAB RESULTS (recent; OCR/structured values)\n' +
        labResults
          .map((r) => {
            const test = r.labOrderItem?.test?.testName ?? 'Lab';
            const flag = r.isAbnormal ? ' **ABNORMAL**' : '';
            return `- ${test} — ${r.parameterName}: ${r.value ?? '?'} ${r.unit ?? ''} (ref ${r.normalRange ?? 'n/a'})${flag}`;
          })
          .join('\n'),
    );
  }

  if (imaging.length) {
    sections.push(
      '## IMAGING (metadata + impression; images not analysed)\n' +
        imaging
          .map(
            (im) =>
              `- ${new Date(im.createdAt).toISOString().slice(0, 10)} ${im.imagingType}${im.bodyPart ? ` ${im.bodyPart}` : ''} [${im.status}]${im.imagingResult?.impression ? ` — Impression: ${im.imagingResult.impression}` : ''}`,
          )
          .join('\n'),
    );
  }

  const histLines = [
    line('Smoking', personalHistory?.smokingStatus),
    line('Alcohol', personalHistory?.alcoholConsumption),
    line('Diet', personalHistory?.diet),
    line('Disorders', personalHistory?.disorders),
  ].filter(Boolean);
  if (histLines.length || familyHistory.length) {
    const fam = familyHistory.map(
      (f) => `- Family (${f.relationSide}${f.relationship ? `/${f.relationship}` : ''}): ${f.conditionName}`,
    );
    sections.push('## MEDICAL HISTORY\n' + [...histLines.map((l) => `- ${l}`), ...fam].join('\n'));
  }

  if (vitals.length) {
    sections.push(
      '## VITALS (latest)\n' +
        vitals
          .map((v) => {
            const bp =
              v.bloodPressureSystolic && v.bloodPressureDiastolic
                ? `BP ${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}`
                : '';
            const parts = [
              bp,
              v.pulseRate ? `HR ${v.pulseRate}` : '',
              v.temperature ? `Temp ${v.temperature}` : '',
              v.oxygenSaturation ? `SpO2 ${v.oxygenSaturation}%` : '',
              v.respiratoryRate ? `RR ${v.respiratoryRate}` : '',
            ].filter(Boolean);
            return `- ${new Date(v.recordedAt).toISOString().slice(0, 10)}: ${parts.join(', ')}`;
          })
          .join('\n'),
    );
  }

  return {
    patient: {
      id: patient.id,
      name,
      mrn: patient.mrn,
      age,
      gender: patient.gender,
      bloodGroup: patient.bloodGroup,
    },
    text: sections.filter(Boolean).join('\n\n'),
    counts: {
      diagnoses: allDiagnoses.length,
      visits: visits.length,
      medications: prescriptions.reduce((n, p) => n + p.prescriptionItems.length, 0),
      labResults: labResults.length,
      imaging: imaging.length,
      allergies: patient.allergies.length,
      vitals: vitals.length,
    },
  };
}
