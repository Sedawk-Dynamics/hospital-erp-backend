import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { generateJson } from '../../services/ai';
import { assertFeatureEnabled } from '../ai/ai.config.service';

interface DischargeNarrative {
  chiefComplaint: string;
  examination: string;
  investigation: string;
  impression: string;
  hospitalCourse: string;
  dischargeInstructions: string;
  followUpInstructions: string;
}

export async function generateDischargeNarrative(tenantId: string, id: string) {
  await assertFeatureEnabled('dischargeAi', tenantId);

  const summary = await prisma.dischargeSummary.findUnique({ where: { id } });
  if (!summary) throw AppError.notFound('Discharge summary not found');

  // Tenant guard via the admission.
  const admission = await prisma.admission.findFirst({
    where: { id: summary.admissionId, tenantId },
    select: { id: true },
  });
  if (!admission) throw AppError.notFound('Discharge summary not found');

  const progressNote = await prisma.progressNote.findMany({
    where: { admissionId: admission.id },
    select: { id: true,hospitalDay: true, noteType: true, noteTitle: true,content: true,createdAt: true,updatedAt: true },
  });
  const pins = await prisma.progressNotePin.findMany({
  where: { note: { admissionId: admission.id }, dischargeSection: { in: ['chief_complaint','examination','investigation','impression'] } },
  select: { dischargeSection: true, content: true },
});
  const notesByDay = progressNote
  .map((n) => {
    const day = n.hospitalDay != null ? `Day ${n.hospitalDay}` : n.createdAt.toLocaleDateString('en-IN');
    const title = n.noteTitle ? ` — ${n.noteTitle}` : '';
    return `${day} [${n.noteType ?? 'note'}]${title}:\n${n.content}`;
  })
  .join('\n\n');

  const sectionText = pins.map((p) => `${p.dischargeSection.toUpperCase()}:\n${p.content}`).join('\n\n');


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
    'Use ONLY the facts explicitly present in the provided admission data, progress notes and sections. Do NOT invent, assume, generalise, or add any advice, instruction, finding, medication, diagnosis, date or recommendation that is not explicitly documented.',
    'This is a strict summarisation task, not a drafting task: restate and condense ONLY what is documented. Add nothing of your own, including standard or generic clinical advice.',
    'If a section has no documented content, return "" for it. Never fill a gap with typical or expected content.',
    'Write in clear, professional clinical prose suitable for a discharge document.',
    'Return strict JSON: {"chiefComplaint": string, "examination": string, "investigation": string, "impression": string, "hospitalCourse": string, "dischargeInstructions": string, "followUpInstructions": string}',
    '- chiefComplaint: the presenting complaint(s) and reason for admission, grounded in the ADDITIONAL SECTIONS / progress notes. Leave as "" if not documented.',
    '- examination: relevant clinical examination findings. Leave as "" if not documented.',
    '- investigation: significant investigations and their findings. Leave as "" if not documented.',
    '- impression: the clinical impression. Leave as "" if not documented.',
    '- hospitalCourse: FIRST a concise overview paragraph summarising the whole admission (presentation, key findings, treatment, outcome). THEN a blank line, then a day-by-day breakdown built from PROGRESS NOTES BY DAY, in order. Format EACH day as a header line exactly `Day <n> | <note title>` (copy the note\'s title verbatim; use "-" if missing), then on the NEXT line(s) a concise summary of that day\'s events, findings and treatment. Do NOT add a timestamp or note type to the header. Separate day blocks with a blank line.',
    '- dischargeInstructions: restate ONLY the discharge advice/instructions explicitly documented in the notes or sections. Do not add generic advice (diet, activity, warning signs, etc.) that was not written. Leave as "" if none is documented.',
    '- followUpInstructions: restate ONLY the follow-up explicitly documented (when/with whom/what to monitor). Invent nothing. Leave as "" if not documented.',
  ].join('\n');

  const narrative = await generateJson<DischargeNarrative>(
    {
      system,
      messages: [{ role: 'user', content: `Admission facts:\n\n${facts}` +
  (sectionText ? `\n\nADDITIONAL SECTIONS:\n${sectionText}` : '') +
  (notesByDay ? `\n\nPROGRESS NOTES BY DAY:\n${notesByDay}` : ''),
 }],
      maxOutputTokens: 1200,
    },
    { tenantId },
  );

  // Inject the REAL note timeline into each day header. The AI emits
  // `Day <n> | <title>`; we match the title back to the actual ProgressNote and
  // append its createdAt, so the printed time is exact and never AI-produced.
  // Notes that share a title are consumed in order.
  const enrichHospitalCourse = (text: string): string => {
    if (!text) return text;
    const fmt = (d: Date) =>
      new Date(d).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    const buckets = new Map<string, string[]>();
    for (const n of progressNote) {
      const key = (n.noteTitle ?? '').trim().toLowerCase();
      const arr = buckets.get(key) ?? [];
      arr.push(fmt(n.createdAt));
      buckets.set(key, arr);
    }
    return text
      .split('\n')
      .map((line) => {
        const m = /^Day\s*([^|]*)\|(.*)$/i.exec(line.trim());
        if (!m) return line;
        const title = m[2].trim();
        const arr = buckets.get(title.toLowerCase());
        const timeline = arr && arr.length ? arr.shift()! : '-';
        return `Day ${m[1].trim()} | ${title} | ${timeline}`;
      })
      .join('\n');
  };

  // Suggestions only — mapped to the editor's narrative fields. Caller decides
  // what to keep.
  return {
    suggestions: {
      chiefComplaint: narrative.chiefComplaint?.trim() ?? '',
      examination: narrative.examination?.trim() ?? '',
      investigation: narrative.investigation?.trim() ?? '',
      impression: narrative.impression?.trim() ?? '',
      proceduresSummary: enrichHospitalCourse(narrative.hospitalCourse?.trim() ?? ''),
      dischargeInstructions: narrative.dischargeInstructions?.trim() ?? '',
      followUpInstructions: narrative.followUpInstructions?.trim() ?? '',
    },
    note: 'AI-drafted narrative. Review and edit before signing.',
  };
}
