import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { generateText, generateJson } from '../../services/ai';
import type { AiMessage } from '../../services/ai';
import { assertFeatureEnabled } from './ai.config.service';
import { backfillResultsFromAttachments } from '../lab/lab.service';
import { Prisma } from '@prisma/client';
import type { PatientChatInput, BloodReportAnalysisInput } from './ai.validation';
import { buildMedicineContext } from './ai.drug-context';
import { getOrBuildContext } from './ai.context-version';
import { embedText } from './cdss.embed';

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

export const PATIENT_CHAT_SYSTEM = [
  'You are a clinical decision-support assistant embedded in a hospital EMR, helping a licensed doctor reason about ONE patient.',
  'You are given the patient\'s structured record (diagnoses, consultation history, medications, lab results, imaging metadata, allergies, vitals, history) as context.',
  '',
  'Rules:',

  '- Answer the doctor\'s question conversationally and concisely, grounded ONLY in the provided context. If the context lacks the information, say so plainly.',
  '- Medications are split into "Current" and "Past". Use only what is listed — do not assume a drug is taken unless it appears, and do not invent drugs or doses. You may point out when the SAME drug appears multiple times (possible duplicate) and suggest the doctor reconcile/confirm the current medication list. Flag a suitability concern ONLY when a condition that warrants it is present in the context (e.g. a drug with a known caution in a diagnosis already recorded for this patient); otherwise do not speculate.',
  '- Lab results are labelled "Current encounter" vs "Previous (historical)". Treat only current-encounter labs as newly obtained. If the context says "No lab results from the current encounter", state that and do not present old results as new; cite a previous abnormal lab only when relevant to the current presentation, always with its date.',
  '- Vitals are labelled "Current encounter" vs "Previous (historical)". Treat only current-encounter vitals as present findings; cite previous vitals only with their date and as historical. If the context says "Current encounter vital signs not recorded", state that plainly and never substitute previous vitals as current.',
  '- When you mention a diagnosis, include its ICD code if it is present in the context.',
  '- You receive imaging only as metadata + radiologist impression text — you do NOT see the images. Never claim to have analysed a scan; defer image interpretation to the radiologist.',
  '- Be specific and actionable (suggested investigations, treatment considerations, monitoring, follow-up), but frame them as suggestions for the clinician to confirm.',
  '- Do not invent lab values, medications, or history that are not in the context.',
  '- Keep answers focused; use short paragraphs or bullets. This is decision support, not a final order.',
].join('\n');

export async function patientChat(
  tenantId: string,
  userId: string,
  roles: string[],
  input: PatientChatInput,
) {
  await assertFeatureEnabled('patientChat', tenantId);

  const context = await getOrBuildContext(tenantId, input.patientId);
  const medicine = await buildMedicineContext(input.message, roles);

  // Guideline RAG is optional: it needs the embedding service (Ollama) and the
  // ingested cdss_chunks. If either is missing (e.g. in an environment where
  // Ollama isn't hosted yet), we skip it and answer from patient context alone,
  // rather than failing the whole request. Set CDSS_RAG_ENABLED=false to turn it
  // off explicitly and avoid a failing network call per request.
  let guidelines = '';
  let sources: { n: number; label: string; url: string }[] = [];
  if (process.env.CDSS_RAG_ENABLED !== 'false') {
    try {
      const queryVector = await embedText(input.message);
      const guidelineRows = await prisma.$queryRaw<
        { sourceId: string; fileName: string; specialty: string | null; page: number; chunkText: string }[]
      >`
      SELECT p.source_id as "sourceId", p.file_name AS "fileName", p.specialty, p.page, c.chunk_text AS "chunkText"
      FROM cdss_chunks c JOIN cdss_pages p ON p.id = c.page_id
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${`[${queryVector.join(',')}]`}::vector LIMIT 5`;

      guidelines = guidelineRows.map((r, i) => `[[${i + 1}]][${r.specialty ?? 'Guideline'} — ${r.fileName}, p.${r.page}]\n${r.chunkText}`).join('\n\n');
      sources = guidelineRows.map((r, i) => ({
        n: i + 1,
        label: `${r.specialty ?? 'Guideline'} — ${r.fileName}, p.${r.page}`,
        url: `/api/v1/ai/cdss/source/${r.sourceId}#page=${r.page}`,
      }));
    } catch (err) {
      logger.warn({ err }, 'Guideline RAG unavailable — continuing without guidelines');
    }
  }

  const system = [
    PATIENT_CHAT_SYSTEM,
    ...(guidelines
      ? [
          '',
          '=== CLINICAL GUIDELINES (prefer these; cite inline using the number in double brackets, e.g. [[1]]. Use only the numbers shown.) ===',
          guidelines,
        ]
      : []),
    '',
    '=== PATIENT CONTEXT ===',
    context.text,
    ...(medicine ? ['', medicine.text] : []),
  ].join('\n');

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
    sources,
    context: {
      patient: context.patient,
      counts: context.counts,
      medicines: medicine?.products ?? [],
    },
  };
}

interface BloodReportResult {
  score: number;
  severity: 'normal' | 'mild' | 'moderate' | 'severe';
  summary: string;
  flagged: Array<{ parameter: string; value: string; status: string; note: string }>;
  recommendations: string[];
}

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
































































