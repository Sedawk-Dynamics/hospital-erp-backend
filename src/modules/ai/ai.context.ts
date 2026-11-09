import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { buildDrugHistory } from '../prescriptions/drug-history.service';
import { resolvePersonPatientIds } from '../../shared/patient-identity';
import { UPLOAD_DIR } from '../../services/upload.service';
import path from 'path';
import { PDFParse } from 'pdf-parse';
import fs from 'fs/promises';

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
  /**
   * Critical items a clinician must not miss, pulled as structured data (not
   * left to the model's prose) so the UI can render them as fixed red badges.
   */
  alerts: {
    allergies: string[];
    abnormalLabs: string[];
    abnormalVitals: string[];
  };
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
  const [
    visits,
    prescriptions,
    labResults,
    unreadLabFiles,
    imaging,
    personalHistory,
    familyHistory,
    vitals,
    imagingFiles,
  ] =
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
      // Released reports only. This context is narrated back to the clinician,
      // so quoting a value the lab supervisor has not signed off would put an
      // unapproved number in front of them with the model's authority behind it.
      prisma.labResult.findMany({
        where: {
          patientId,
          labOrder: { tenantId, labReport: { status: { in: ['published', 'corrected'] } } },
        },
        orderBy: { enteredAt: 'desc' },
        take: 40,
        include: { labOrderItem: { include: { test: { select: { testName: true } } } } },
      }),
      prisma.labAttachment.findMany({
        where: {
          tenantId,
          deletedAt: null,
          labOrder: {
            tenantId,
            patientId,
            labReport: { status: { in: ['published', 'corrected'] } },
            labOrderItems: { some: { labResults: { none: {} } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          fileName: true,
          createdAt: true,
          fileUrl: true,
          labOrder: {
            select: { labOrderItems: { select: { test: { select: { testName: true } } } } },
          },
        },
      }),
      prisma.imagingRequest.findMany({
        where: { patientId, tenantId },
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: { imagingResult: { select: { impression: true, status: true } } },
      }),
      // Across the person's rows, matching where upsertPersonalHistory writes.
      // A findUnique on this row alone hands the model an empty history for a
      // patient who has one, which is worse than no context: it reads as
      // "no risk factors recorded" rather than "not looked up".
      prisma.patientPersonalHistory
        .findMany({
          where: { patientId: { in: await resolvePersonPatientIds(patientId) } },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        })
        .then((r) => r[0] ?? null),
      prisma.patientFamilyHistory.findMany({ where: { patientId }, take: 10 }),
      prisma.vital.findMany({
        where: { patientId, visit: { tenantId } },
        orderBy: { recordedAt: 'desc' },
        take: 3,
      }),

      prisma.imagingAttachment.findMany({
        where: {
          tenantId,
          deletedAt: null,
          category:'report_pdf',
          imagingRequest: { patientId, tenantId},
          imagingResult:{is:null}
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          fileName: true,
          createdAt: true,
          fileUrl: true,
          imagingRequest: {
            select: { imagingType: true, bodyPart: true },
          },
        },
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
    // The newest visit is the encounter in progress; label it so the model
    // reasons about *this* visit against the ones before it instead of
    // treating the whole list as undifferentiated history.
    const [currentVisit, ...priorVisits] = visits;

    const describeVisit = (v: (typeof visits)[number]) => {
      let out = `- ${new Date(v.visitDate).toISOString().slice(0, 10)} ${v.visitType}`;
      if (v.chiefComplaint) out += ` — ${v.chiefComplaint}`;
      const dx = v.diagnoses
        .map((d) => `${d.diagnosisName}${d.icdCode ? ` [${d.icdCode}]` : ''}`)
        .join(', ');
      if (dx) out += `\n  Dx: ${dx}`;
      return out;
    };

    sections.push('## CURRENT VISIT\n' + describeVisit(currentVisit));

    if (priorVisits.length) {
      sections.push(
        '## PAST VISIT HISTORY (most recent first)\n' +
          priorVisits.map(describeVisit).join('\n'),
      );
    }


    if(imagingFiles.length){
      const fileLinks = await Promise.all(imagingFiles.map(async (a) => {
        const filePath = path.join(UPLOAD_DIR, a.fileUrl.replace(/^\/uploads\//, ''));
        let text=''
        try {
          const buffer = await fs.readFile(filePath);
          const parser = new PDFParse({ data: buffer });
          const result = await parser.getText();
          text = result.text?.trim() ?? '';
        } catch (err) {
          text = '(could not read file)';
        }
        return `- ${new Date(a.createdAt).toISOString().slice(0, 10)} ${a.imagingRequest.imagingType}${a.imagingRequest.bodyPart ? ` ${a.imagingRequest.bodyPart}` : ''} — ${a.fileName} (file: ${text})`;
      }
      ));
      sections.push('## IMAGING REPORTS ON FILE (extracted from uploaded files)\n' + fileLinks.join('\n\n'));
    }
  }

  // Medications split the same way the doctor's Drug History panel splits them,
  // so the assistant stops presenting a finished course as "current medication"
  // (and vice-versa) — both views now read from one source of truth.
  const drugHistory = await buildDrugHistory({ patientIds: [patientId], tenantId, limit: 50 });

  const formatMed = (i: {
    drugName: string;
    dosage?: string | null;
    frequency?: string | null;
    duration?: string | null;
    route?: string | null;
  }) =>
    `- ${i.drugName}${i.dosage ? ` ${i.dosage}` : ''}${i.frequency ? ` ${i.frequency}` : ''}` +
    `${i.duration ? ` x${i.duration}` : ''}${i.route ? ` (${i.route})` : ''}`;

  if (drugHistory.current.length) {
    sections.push(
      '## CURRENT MEDICATIONS (patient is still on these)\n' +
        drugHistory.current.slice(0, 25).map(formatMed).join('\n'),
    );
  }

  if (drugHistory.past.length) {
    sections.push(
      '## PAST MEDICATIONS (course finished or replaced by a newer script)\n' +
        drugHistory.past.slice(0, 25).map(formatMed).join('\n'),
    );
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

  if (unreadLabFiles.length) {
    const fileLinks = await Promise.all(unreadLabFiles.map(async (a) => {
      const filePath = path.join(UPLOAD_DIR, a.fileUrl.replace(/^\/uploads\//, ''));
      let text=''
      try {
        const buffer = await fs.readFile(filePath);
        const parser = new PDFParse({ data: buffer });
        const result = await parser.getText();
        text = result.text?.trim() ?? '';
      } catch (err) {
        text = '(could not read file)';
      }

      return `- ${new Date(a.createdAt).toISOString().slice(0, 10)} ${a.labOrder.labOrderItems
        .map((it) => it.test?.testName)
        .filter(Boolean)
        .join(', ') || 'Lab order'} — ${a.fileName} (file: ${text})`;
    }));
      sections.push('## LAB REPORTS ON FILE (extracted from uploaded files)\n' + fileLinks.join('\n\n'));
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

  // --- Structured alerts (data, not prose) for the UI's red badge row. ---
  const allergyAlerts = patient.allergies.map(
    (a) =>
      `${a.allergen} (${a.allergyType}${a.severity ? `, ${a.severity}` : ''})${a.reaction ? ` — ${a.reaction}` : ''}`,
  );

  const abnormalLabAlerts = labResults
    .filter((r) => r.isAbnormal)
    .map((r) => {
      const test = r.labOrderItem?.test?.testName ?? 'Lab';
      return `${test} — ${r.parameterName}: ${r.value ?? '?'} ${r.unit ?? ''}`.trim() +
        (r.normalRange ? ` (ref ${r.normalRange})` : '');
    });

  // Vitals carry no isAbnormal flag, so flag the latest reading with
  // conservative, widely-accepted thresholds. Temperature is accepted in either
  // scale (°F readings are ≥ 50 numerically, °C are not).
  const abnormalVitalAlerts: string[] = [];
  const latestVital = vitals[0];
  if (latestVital) {
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const sys = num(latestVital.bloodPressureSystolic);
    const dia = num(latestVital.bloodPressureDiastolic);
    if (sys && dia) {
      if (sys >= 140 || dia >= 90) abnormalVitalAlerts.push(`BP ${sys}/${dia} mmHg (elevated)`);
      else if (sys < 90 || dia < 60) abnormalVitalAlerts.push(`BP ${sys}/${dia} mmHg (low)`);
    }
    const spo2 = num(latestVital.oxygenSaturation);
    if (spo2 && spo2 < 94) abnormalVitalAlerts.push(`SpO2 ${spo2}% (low)`);
    const hr = num(latestVital.pulseRate);
    if (hr && hr > 100) abnormalVitalAlerts.push(`HR ${hr} bpm (tachycardia)`);
    else if (hr && hr < 60) abnormalVitalAlerts.push(`HR ${hr} bpm (bradycardia)`);
    const temp = num(latestVital.temperature);
    if (temp) {
      const fever = temp >= 50 ? temp >= 100.4 : temp >= 38;
      if (fever) abnormalVitalAlerts.push(`Temp ${temp}° (fever)`);
    }
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
    alerts: {
      allergies: allergyAlerts,
      abnormalLabs: abnormalLabAlerts,
      abnormalVitals: abnormalVitalAlerts,
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



















