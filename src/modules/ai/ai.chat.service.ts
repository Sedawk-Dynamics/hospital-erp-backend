import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { generateText, generateJson } from '../../services/ai';
import type { AiMessage } from '../../services/ai';
import { assertFeatureEnabled } from './ai.config.service';
import { buildPatientContext } from './ai.context';
import { backfillResultsFromAttachments } from '../lab/lab.service';
import { Prisma } from '@prisma/client';
import type { PatientChatInput, BloodReportAnalysisInput } from './ai.validation';

// Best-effort audit of AI usage. Never blocks the response.
async function auditAi(
  tenantId: string,
  userId: string,
  entityId: string,
  description: string,
) {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action: 'read',
        entityType: 'AiPatientChat',
        entityId,
        description: description.slice(0, 500),
      },
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to write AI audit log');
  }
}

const PATIENT_CHAT_SYSTEM = [
  'You are a clinical decision-support assistant embedded in a hospital EMR, helping a licensed doctor reason about ONE patient.',
  'You are given the patient\'s structured record (diagnoses, consultation history, medications, lab results, imaging metadata, allergies, vitals, history) as context.',
  '',
  'Rules:',
  '- Answer the doctor\'s question conversationally and concisely, grounded ONLY in the provided context. If the context lacks the information, say so plainly.',
  '- When you mention a diagnosis, include its ICD code if it is present in the context.',
  '- You receive imaging only as metadata + radiologist impression text — you do NOT see the images. Never claim to have analysed a scan; defer image interpretation to the radiologist.',
  '- Be specific and actionable (suggested investigations, treatment considerations, monitoring, follow-up), but frame them as suggestions for the clinician to confirm.',
  '- Do not invent lab values, medications, or history that are not in the context.',
  '- Keep answers focused; use short paragraphs or bullets. This is decision support, not a final order.',
].join('\n');

export async function patientChat(tenantId: string, userId: string, input: PatientChatInput) {
  await assertFeatureEnabled('patientChat', tenantId);

  const context = await buildPatientContext(tenantId, input.patientId);

  const system = `${PATIENT_CHAT_SYSTEM}\n\n=== PATIENT CONTEXT ===\n${context.text}`;

  const history: AiMessage[] = (input.history ?? []).map((h) => ({
    role: h.role,
    content: h.content,
  }));
  const messages: AiMessage[] = [...history, { role: 'user', content: input.message }];

  const { text, model, provider } = await generateText({ system, messages }, { tenantId });

  void auditAi(tenantId, userId, input.patientId, `Patient chat: ${input.message}`);

  return {
    reply: text,
    model,
    provider,
    context: { patient: context.patient, counts: context.counts },
  };
}

interface BloodReportResult {
  score: number;
  severity: 'normal' | 'mild' | 'moderate' | 'severe';
  summary: string;
  flagged: Array<{ parameter: string; value: string; status: string; note: string }>;
  recommendations: string[];
}

// Use Case 2.2 — blood report (lab) analysis with a score. Works off the
// stored LabResult values, including the ones read off an uploaded report PDF
// or scan — the lab's real workflow is to upload the analyser's printout, not
// to retype every number.
export async function bloodReportAnalysis(
  tenantId: string,
  userId: string,
  input: BloodReportAnalysisInput,
) {
  await assertFeatureEnabled('bloodReport', tenantId);

  // Released reports only — an analysis is written as if the numbers are final,
  // so it must not be built on values still inside the lab's review loop.
  const where: Prisma.LabResultWhereInput = {
    patientId: input.patientId,
    labOrder: { tenantId, labReport: { status: { in: ['published', 'corrected'] } } },
    ...(input.labOrderId ? { labOrderId: input.labOrderId } : {}),
  };
  const include = { labOrderItem: { include: { test: { select: { testName: true } } } } };

  let results = await prisma.labResult.findMany({
    where,
    orderBy: { enteredAt: 'desc' },
    take: 60,
    include,
  });

  // Nothing stored — but the report may exist as an uploaded file that predates
  // the read-on-upload flow. Read those now rather than telling the doctor there
  // is nothing to analyse while the report sits on the same screen.
  if (!results.length) {
    const filled = await backfillResultsFromAttachments(tenantId, input.patientId, userId, {
      labOrderId: input.labOrderId,
    });
    if (filled > 0) {
      results = await prisma.labResult.findMany({ where, orderBy: { enteredAt: 'desc' }, take: 60, include });
    }
  }

  if (!results.length) {
    throw AppError.badRequest(
      'No lab values are available to analyse. If the report was uploaded as a PDF or image, ask the lab to open the order and use "Read values" so the numbers are captured.',
    );
  }

  // Abnormal values first, then the rest. If a panel is large enough that the
  // model has to be selective, the out-of-range figures are the ones that must
  // survive the cut — they are what the analysis is for.
  results.sort((a, b) => Number(b.isAbnormal) - Number(a.isAbnormal));

  const reportText = results
    .map((r) => {
      const test = r.labOrderItem?.test?.testName ?? 'Lab';
      return `${test} — ${r.parameterName}: ${r.value ?? '?'} ${r.unit ?? ''} (ref ${r.normalRange ?? 'n/a'})${r.isAbnormal ? ' [ABNORMAL]' : ''}`;
    })
    .join('\n');

  const system = [
    'You are a clinical lab analyst assisting a doctor. Analyse the blood/lab report below and return a strict JSON object.',
    'Compute an overall health score from 0 (critical) to 100 (all normal) based on how many parameters are abnormal and how far out of range.',
    'Only use the values provided; do not invent parameters.',
    'JSON shape: {"score": number, "severity": "normal"|"mild"|"moderate"|"severe", "summary": string, "flagged": [{"parameter": string, "value": string, "status": "high"|"low"|"abnormal", "note": string}], "recommendations": string[]}',
  ].join('\n');

  const result = await generateJson<BloodReportResult>(
    {
      system,
      messages: [{ role: 'user', content: `Lab report:\n${reportText}` }],
    },
    { tenantId },
  );

  void auditAi(tenantId, userId, input.patientId, 'Blood report analysis');

  // Clamp the score defensively.
  const score = Math.max(0, Math.min(100, Number(result.score) || 0));
  return { ...result, score, resultCount: results.length };
}
