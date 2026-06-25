import { prisma } from '../../config/database';
import { generateJson, generateText } from '../../services/ai';
import { assertFeatureEnabled } from './ai.config.service';
import { retrieveDocs } from './ai.knowledge';
import type { PlatformChatInput } from './ai.validation';

// ============================================================================
// Use Case 3 (Level 1): Platform-wide AI support chatbot — READ-ONLY.
//
// Two capabilities:
//   1. "help"  — answer software how-to / documentation questions (RAG over a
//                curated knowledge base).
//   2. "data"  — answer read-only questions about the user's OWN organisation
//                via a strict whitelist of aggregate queries.
//
// GUARDRAILS:
//   - Every data query is hard-scoped to the caller's tenantId. There is no
//     code path that reads another organisation's data.
//   - Only the whitelisted intents below can run; the LLM only PICKS an intent
//     and supplies dates — it never writes or runs raw SQL.
//   - No write operations exist here (Level 2 is deliberately out of scope).
// ============================================================================

type DataIntent =
  | 'count_patients_registered'
  | 'count_appointments'
  | 'count_admissions'
  | 'current_inpatients'
  | 'count_visits'
  | 'total_revenue'
  | 'bed_occupancy';

interface PlannerResult {
  type: 'data' | 'help';
  intent?: DataIntent;
  fromDate?: string | null;
  toDate?: string | null;
}

const DATA_INTENTS: DataIntent[] = [
  'count_patients_registered',
  'count_appointments',
  'count_admissions',
  'current_inpatients',
  'count_visits',
  'total_revenue',
  'bed_occupancy',
];

function parseDate(s?: string | null): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

// End-of-day inclusive bound for "to" dates.
function endOfDay(d: Date): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

function rangeWhere(from?: Date, to?: Date) {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: endOfDay(to) } : {}),
  };
}

/** Executes ONE whitelisted, tenant-scoped, read-only aggregate. */
async function runDataIntent(
  tenantId: string,
  intent: DataIntent,
  from?: Date,
  to?: Date,
): Promise<{ label: string; value: string }> {
  const created = rangeWhere(from, to);

  switch (intent) {
    case 'count_patients_registered': {
      const n = await prisma.patient.count({
        where: { tenantId, ...(created ? { createdAt: created } : {}) },
      });
      return { label: 'patients registered', value: String(n) };
    }
    case 'count_appointments': {
      const n = await prisma.appointment.count({
        where: { tenantId, ...(created ? { appointmentDate: created } : {}) },
      });
      return { label: 'appointments', value: String(n) };
    }
    case 'count_admissions': {
      const n = await prisma.admission.count({
        where: { tenantId, ...(created ? { admissionDate: created } : {}) },
      });
      return { label: 'admissions', value: String(n) };
    }
    case 'current_inpatients': {
      const n = await prisma.admission.count({ where: { tenantId, status: 'admitted' } });
      return { label: 'patients currently admitted', value: String(n) };
    }
    case 'count_visits': {
      const n = await prisma.visit.count({
        where: { tenantId, ...(created ? { visitDate: created } : {}) },
      });
      return { label: 'visits', value: String(n) };
    }
    case 'total_revenue': {
      const agg = await prisma.payment.aggregate({
        _sum: { amount: true },
        where: { tenantId, status: 'completed', ...(created ? { paymentDate: created } : {}) },
      });
      return { label: 'total revenue collected', value: `₹${Number(agg._sum.amount ?? 0).toFixed(2)}` };
    }
    case 'bed_occupancy': {
      const [total, occupied] = await Promise.all([
        prisma.bed.count({ where: { tenantId } }),
        prisma.bed.count({ where: { tenantId, status: 'occupied' } }),
      ]);
      return { label: 'bed occupancy', value: `${occupied} occupied of ${total} beds` };
    }
    default:
      return { label: 'unknown', value: '0' };
  }
}

export async function platformChat(
  tenantId: string,
  _userId: string,
  input: PlatformChatInput,
) {
  await assertFeatureEnabled('platformChat');

  const today = new Date().toISOString().slice(0, 10);

  // --- Step 1: route the question (data vs help) + extract dates. ---
  const planner = await generateJson<PlannerResult>({
    system: [
      'You route a hospital-software support question. Today is ' + today + '.',
      'Decide if the question asks for a COUNT/NUMBER/REVENUE about the user\'s own hospital data ("data"), or a how-to/navigation/support question ("help").',
      'If "data", choose exactly one intent from this list and extract any date range as ISO yyyy-mm-dd (resolve relative/partial dates using today; if no year is given assume the current year):',
      DATA_INTENTS.map((i) => `- ${i}`).join('\n'),
      'Return strict JSON: {"type":"data"|"help","intent":<one of the list or null>,"fromDate":<iso or null>,"toDate":<iso or null>}',
    ].join('\n'),
    messages: [{ role: 'user', content: input.message }],
  }).catch(() => ({ type: 'help' as const }));

  // --- Step 2a: data path — run the whitelisted query, then phrase it. ---
  if (planner.type === 'data' && planner.intent && DATA_INTENTS.includes(planner.intent)) {
    const from = parseDate(planner.fromDate);
    const to = parseDate(planner.toDate);
    const result = await runDataIntent(tenantId, planner.intent, from, to);

    const range =
      from || to
        ? ` for ${from ? from.toISOString().slice(0, 10) : 'the start'} to ${to ? to.toISOString().slice(0, 10) : 'now'}`
        : '';

    const { text, model, provider } = await generateText({
      system:
        'You are a hospital software assistant. Phrase the computed answer in one friendly, precise sentence. Do not add extra numbers beyond the data given.',
      messages: [
        {
          role: 'user',
          content: `Question: ${input.message}\nComputed (${result.label}${range}): ${result.value}\nAnswer in one sentence.`,
        },
      ],
      maxOutputTokens: 120,
    });

    return {
      reply: text,
      mode: 'data' as const,
      intent: planner.intent,
      data: { label: result.label, value: result.value },
      model,
      provider,
    };
  }

  // --- Step 2b: help path — RAG over the how-to knowledge base. ---
  const docs = retrieveDocs(input.message, 3);
  const docContext = docs.length
    ? docs.map((d) => `### ${d.title}\n${d.body}`).join('\n\n')
    : 'No specific documentation matched.';

  const { text, model, provider } = await generateText({
    system: [
      'You are the support assistant for a hospital ERP/EMR. Answer the user\'s how-to question using ONLY the documentation snippets provided.',
      'Be concise and give step-by-step navigation when relevant. If the snippets do not cover it, say you are not sure and suggest contacting support.',
      'You are read-only: you cannot perform actions, only explain how to.',
      '',
      '=== DOCUMENTATION ===',
      docContext,
    ].join('\n'),
    messages: [
      ...(input.history ?? []).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user' as const, content: input.message },
    ],
  });

  return {
    reply: text,
    mode: 'help' as const,
    sources: docs.map((d) => d.title),
    model,
    provider,
  };
}
