import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { generateJson } from '../../services/ai';
import { assertFeatureEnabled } from '../ai/ai.config.service';

// ============================================================================
// Use Case 4: Document Generation — AI discharge summary (80/20 rule).
//
// The discharge summary is already auto-assembled from the admission record
// (diagnoses, procedures, labs, medications) — that is the 80% static, exact
// data fetched straight from the DB. This adds the ~20% AI layer: it drafts the
// NARRATIVE sections (hospital course, discharge instructions, follow-up advice)
// from that static data. It returns suggestions only — it never overwrites the
// record. The doctor reviews/edits before signing, keeping a human in the loop.
// ============================================================================

interface DischargeNarrative {
  hospitalCourse: string;
  dischargeInstructions: string;
  followUpInstructions: string;
}

export async function generateDischargeNarrative(tenantId: string, id: string) {
  await assertFeatureEnabled('dischargeAi');

  const summary = await prisma.dischargeSummary.findUnique({ where: { id } });
  if (!summary) throw AppError.notFound('Discharge summary not found');

  // Tenant guard via the admission.
  const admission = await prisma.admission.findFirst({
    where: { id: summary.admissionId, tenantId },
    select: { id: true },
  });
  if (!admission) throw AppError.notFound('Discharge summary not found');

  if (summary.status !== 'draft') {
    throw AppError.badRequest('AI narrative can only be generated while the summary is a draft.');
  }

  // The static (80%) facts the narrative must be grounded in.
  const facts = [
    summary.headerSummary && `HEADER:\n${summary.headerSummary}`,
    summary.diagnosesSummary && `DIAGNOSES:\n${summary.diagnosesSummary}`,
    summary.proceduresSummary && `PROCEDURES / COURSE NOTES:\n${summary.proceduresSummary}`,
    summary.keyLabsSummary && `KEY LABS:\n${summary.keyLabsSummary}`,
    summary.labResultsSummary && `LAB RESULTS:\n${summary.labResultsSummary}`,
    summary.medicationReconciliation && `MEDICATIONS:\n${summary.medicationReconciliation}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  if (!facts.trim()) {
    throw AppError.badRequest(
      'There is no admission data to summarise yet. Generate/refresh the summary first.',
    );
  }

  const system = [
    'You are a physician writing the narrative sections of a hospital discharge summary.',
    'Use ONLY the structured admission facts provided. Do not invent diagnoses, medications, lab values, or dates that are not present.',
    'Write in clear, professional clinical prose suitable for a discharge document.',
    'Return strict JSON: {"hospitalCourse": string, "dischargeInstructions": string, "followUpInstructions": string}',
    '- hospitalCourse: a concise paragraph narrating the admission, key findings and treatment given.',
    '- dischargeInstructions: practical advice for the patient at home (activity, diet, medication adherence, warning signs) grounded in the diagnoses/medications.',
    '- followUpInstructions: when and with whom to follow up, and what to monitor.',
  ].join('\n');

  const narrative = await generateJson<DischargeNarrative>({
    system,
    messages: [{ role: 'user', content: `Admission facts:\n\n${facts}` }],
    maxOutputTokens: 1200,
  });

  // Suggestions only — mapped to the editor's narrative fields. Caller decides
  // what to keep.
  return {
    suggestions: {
      proceduresSummary: narrative.hospitalCourse?.trim() ?? '',
      dischargeInstructions: narrative.dischargeInstructions?.trim() ?? '',
      followUpInstructions: narrative.followUpInstructions?.trim() ?? '',
    },
    note: 'AI-drafted narrative. Review and edit before signing.',
  };
}
