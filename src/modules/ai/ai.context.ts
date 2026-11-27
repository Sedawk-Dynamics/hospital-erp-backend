import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { buildDrugHistory } from '../prescriptions/drug-history.service';
import { resolvePersonPatientIds } from '../../shared/patient-identity';
import { UPLOAD_DIR } from '../../services/upload.service';
import { getPacsProvider } from '../imaging/pacs';
import { callGeminiVisionImages } from '../../services/gemini-vision';
import { logger } from '../../config/logger';
import path from 'path';
import { PDFParse } from 'pdf-parse';
import fs from 'fs/promises';

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
  text: string;
  counts: Record<string, number>;
  alerts: {
    allergies: string[];
    abnormalLabs: string[];
    abnormalVitals: string[];
  };
}

export async function buildPatientContext(
  tenantId: string,
  patientId: string,
  visitId: string,
): Promise<BuiltPatientContext> {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    include: { allergies: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

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
    currentVisit,
    specialitiesData,
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
      prisma.labResult.findMany({
        where: {
          patientId,
          labOrder: { tenantId, labReport: { status: { in: ['published', 'corrected'] } } },
        },
        orderBy: { enteredAt: 'desc' },
        take: 40,
        include: {
          labOrderItem: { include: { test: { select: { testName: true } } } },
          labOrder: { select: { visitId: true } },
        },
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
          category: 'report_pdf',
          imagingRequest: { patientId, tenantId },
          imagingResult: { is: null }
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

      visitId
        ? prisma.visit.findFirst({
          where: { id: visitId, patientId, tenantId },
          include: {
            diagnoses: true,
            vitals: { orderBy: { recordedAt: 'desc' } },
          },
        })
        : Promise.resolve(null),

      visitId ? prisma.consultationSpecialtyData.findFirst({ where: { tenantId, visitId, patientId }, select: { data: true, speciality: true } }) : Promise.resolve(null),
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

  // CURRENT VISIT — today's reason for the encounter. Placed near the top and
  // clearly marked as the FOCUS so the model answers the present complaint
  // instead of re-summarising the whole record. Everything below is background.
  if (currentVisit) {
    const complaint = currentVisit.chiefComplaint || currentVisit.nurseChiefComplaint || null;
    const v = currentVisit.vitals[0];
    const vitalStr = v
      ? [
        v.bloodPressureSystolic && v.bloodPressureDiastolic
          ? `BP ${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}`
          : '',
        v.pulseRate ? `HR ${v.pulseRate}` : '',
        v.temperature ? `Temp ${v.temperature}` : '',
        v.oxygenSaturation ? `SpO2 ${v.oxygenSaturation}%` : '',
        v.respiratoryRate ? `RR ${v.respiratoryRate}` : '',
      ]
        .filter(Boolean)
        .join(', ')
      : '';
    const dx = currentVisit.diagnoses.map((d) => d.diagnosisName).filter(Boolean);

    const currentLines = [
      '## CURRENT VISIT (today — FOCUS the response on this)',
      line('Date', new Date(currentVisit.visitDate).toISOString().slice(0, 10)),
      line('Type', currentVisit.visitType),
      line('Chief complaint', complaint),
      line("Today's vitals", vitalStr),
      dx.length ? `Working diagnosis (this visit): ${dx.join(', ')}` : '',
    ].filter(Boolean);

    // Only emit the section if there's something beyond the date/type scaffold.
    if (complaint || vitalStr || dx.length) {
      sections.push(currentLines.join('\n'));
    }
  }

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
    const describeVisit = (v: (typeof visits)[number]) => {
      let out = `- ${new Date(v.visitDate).toISOString().slice(0, 10)} ${v.visitType}`;
      if (v.chiefComplaint) out += ` — ${v.chiefComplaint}`;
      const dx = v.diagnoses
        .map((d) => `${d.diagnosisName}${d.icdCode ? ` [${d.icdCode}]` : ''}`)
        .join(', ');
      if (dx) out += `\n  Dx: ${dx}`;
      return out;
    };

    // Everything here is PAST history. Today's encounter is already shown above
    // as the CURRENT VISIT focus block, so exclude it here — otherwise it gets
    // a second "CURRENT VISIT" heading and the model treats old visits as today.
    const priorVisits = currentVisit
      ? visits.filter((v) => v.id !== currentVisit.id)
      : visits;

    if (priorVisits.length) {
      sections.push(
        '## PAST VISIT HISTORY (most recent first)\n' +
        priorVisits.map(describeVisit).join('\n'),
      );
    }


    if (imagingFiles.length) {
      const fileLinks = await Promise.all(imagingFiles.map(async (a) => {
        const filePath = path.join(UPLOAD_DIR, a.fileUrl.replace(/^\/uploads\//, ''));
        let text = ''
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
    const stamp = (d: Date | string) =>
      new Date(d).toISOString().slice(0, 16).replace('T', ' ');

    const line = (r: (typeof labResults)[number]) => {
      const test = r.labOrderItem?.test?.testName ?? 'Lab';
      const flag = r.isAbnormal ? ' **ABNORMAL**' : '';
      return `- ${stamp(r.enteredAt)} ${test} — ${r.parameterName}: ${r.value ?? '?'} ${r.unit ?? ''} (ref ${r.normalRange ?? 'n/a'})${flag}`;
    };

    // "Current visit" = results tied to THIS visit, not merely the same calendar
    // day. Several encounters can happen on one day, so day-matching would wrongly
    // flag an earlier visit's labs (e.g. an old pneumonia CRP) as current.
    const current = visitId ? labResults.filter((r) => r.labOrder?.visitId === visitId) : [];
    const previous = labResults.filter((r) => !current.includes(r));
    let text = '## LAB RESULTS\n';
    text += current.length
      ? `Current visit:\n${current.map(line).join('\n')}\n`
      : 'No lab results from the current visit.\n';
    if (previous.length) text += `Previous (historical):\n${previous.map(line).join('\n')}`;

    sections.push(text.trim());
  }

  if (unreadLabFiles.length) {
    const fileLinks = await Promise.all(unreadLabFiles.map(async (a) => {
      const filePath = path.join(UPLOAD_DIR, a.fileUrl.replace(/^\/uploads\//, ''));
      let text = ''
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
    const stampDt = (d: Date | string) =>
      new Date(d).toISOString().slice(0, 16).replace('T', ' ');
    sections.push(
      '## IMAGING (metadata + impression; images not analysed)\n' +
      imaging
        .map((im) => {
          // Tag each study by encounter so an old study (e.g. the pneumonia
          // chest X-ray) is not read as part of today's visit.
          const scope = visitId && im.visitId === visitId ? ' (this visit)' : ' (past study)';
          return `- ${stampDt(im.createdAt)}${scope} ${im.imagingType}${im.bodyPart ? ` ${im.bodyPart}` : ''} [${im.status}]${im.imagingResult?.impression ? ` — Impression: ${im.imagingResult.impression}` : ''}`;
        })
        .join('\n'),
    );
  }

  try {
    const xrayStudy = await prisma.dicomStudy.findFirst({
      where: { tenantId, patientId, modality: { in: ['CR', 'DX', 'XR'] } },
      orderBy: { studyDate: 'desc' },
      include: {
        instances: true,
        imagingResult: {
          select: {
            impression: true,
            imagingRequest: { select: { clinicalIndication: true, bodyPart: true, imagingType: true } },
          },
        },
      },
    });

    if (xrayStudy && xrayStudy.instances.length) {
      const provider = getPacsProvider();
      const frames: Buffer[] = [];
      for (const inst of xrayStudy.instances) {
        const png = await provider?.getInstancePreview?.(inst.sopInstanceUid);
        if (png) frames.push(png);
      }

      if (frames.length) {
        const imagingReportResult = xrayStudy.imagingResult;
        const req = imagingReportResult?.imagingRequest;
        const ctxLines = [
          req?.imagingType ? `Study type: ${String(req.imagingType).replace(/_/g, ' ')}` : null,
          req?.bodyPart ? `Body part: ${req.bodyPart}` : null,
          req?.clinicalIndication ? `Clinical indication (why ordered): ${req.clinicalIndication}` : null,
          imagingReportResult?.impression ? `Radiologist's impression / findings: ${imagingReportResult.impression}` : null,
        ].filter(Boolean) as string[];

        const clinicalContext = ctxLines.length
          ? `\n\nCLINICAL CONTEXT PROVIDED BY THE HOSPITAL (background only — do NOT assume it is correct; still base your visual findings on the image itself and explicitly note any agreement or disagreement with the radiologist's note):\n${ctxLines.map((l) => `- ${l}`).join('\n')}`
          : '';

        const xrayPrompt = `You are an experienced radiologist reviewing the X-ray image(s) provided.

STRICT RULES:
- Base your report ONLY on what is visibly present in the supplied image(s). Do not assume, infer, or invent any finding that is not clearly visible.
- If the image quality, projection, or field of view does not allow a confident assessment, say so explicitly ("not assessable" / "limited by…").
- Any clinical context below is background only — do not treat it as confirmed and do not simply repeat it. Form your own read of the image, then note where you agree or disagree with it.
- If no abnormality is visible, state "No acute abnormality detected" — do not manufacture findings.
- This is decision support only, not a final diagnosis.

Produce a concise report with Findings and an Impression. If clinical context was provided, add one line on whether your read agrees with it. End with: "AI-generated from images only; correlate clinically and confirm with a radiologist."${clinicalContext}`;

        const { text } = await callGeminiVisionImages({
          prompt: xrayPrompt,
          images: frames.map((b) => ({ data: b, mimetype: 'image/png' })),
          feature: 'Imaging report analysis',
          fallbackHint: 'Review the X-ray manually.',
        });

        if (text?.trim()) {
          sections.push('## X-RAY AI ANALYSIS (latest study; decision support only)\n' + text.trim());
        }
      }
    }
  } catch (err) {
    logger.warn({ err, patientId }, 'X-ray AI analysis skipped in context build');
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
    const stamp = (d: Date | string) =>
      new Date(d).toISOString().slice(0, 16).replace('T', ' ');

    const line = (v: (typeof vitals)[number]) => {
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
      return `- ${stamp(v.recordedAt)}: ${parts.join(', ')}`;
    };

    // Scope by visit, not by calendar day — same-day readings from an earlier
    // encounter must not be blended into the current visit's vitals.
    const current = visitId ? vitals.filter((v) => v.visitId === visitId) : [];
    const previous = vitals.filter((v) => !current.includes(v));

    let text = '## VITALS\n';
    text += current.length
      ? `Current visit:\n${current.map(line).join('\n')}\n`
      : 'Current visit vital signs not recorded.\n';
    if (previous.length) text += `Previous (historical):\n${previous.map(line).join('\n')}`;

    sections.push(text.trim());
  }

  const specData = specialitiesData?.data as Record<string, unknown> | undefined;
  if (specData && Object.keys(specData).length) {
    const fmt = (v: any): string => {
      if (v == null || v === '') return '';
      if (typeof v === 'boolean') return v ? 'Yes' : '';
      if (Array.isArray(v)) return v.map(fmt).filter(Boolean).join(' | ');
      if (typeof v === 'object')
        return 'value' in v
          ? `${v.value}${v.unit ? ` ${v.unit}` : ''}`
          : Object.entries(v).map(([k, val]) => `${k}: ${fmt(val)}`).join(', ');
      return String(v);
    };
    const body = Object.entries(specData)
      .map(([k, v]) => (fmt(v) ? `- ${k}: ${fmt(v)}` : ''))
      .filter(Boolean)
      .join('\n');
    if (body) sections.push('## SPECIALTY CONSULTATION (this visit)\n' + body);
  }


  // --- Structured alerts (data, not prose) for the UI's red badge row. ---
  const allergyAlerts = patient.allergies.map(
    (a) =>
      `${a.allergen} (${a.allergyType}${a.severity ? `, ${a.severity}` : ''})${a.reaction ? ` — ${a.reaction}` : ''}`,
  );

  // Abnormal labs from the MOST RECENT lab session — not only today's. An
  // abnormal HbA1c/SGPT stays clinically relevant after the day it was entered,
  // so the alert must not vanish when the calendar day rolls over. labResults is
  // ordered by enteredAt desc, so the first row is the latest session's date.
  const latestLabDate = labResults.length
    ? new Date(labResults[0]!.enteredAt).toISOString().slice(0, 10)
    : null;
  const abnormalLabAlerts = labResults
    .filter(
      (r) =>
        r.isAbnormal &&
        latestLabDate !== null &&
        new Date(r.enteredAt).toISOString().slice(0, 10) === latestLabDate,
    )
    .map((r) => {
      const test = r.labOrderItem?.test?.testName ?? 'Lab';
      return `${test} — ${r.parameterName}: ${r.value ?? '?'} ${r.unit ?? ''}`.trim() +
        (r.normalRange ? ` (ref ${r.normalRange})` : '');
    });


  const abnormalVitalAlerts: string[] = [];
  // The most recent vital, whenever it was recorded — not only today's. An
  // elevated BP from yesterday must still alert today. vitals is ordered by
  // recordedAt desc, so the first row is the latest reading.
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







































