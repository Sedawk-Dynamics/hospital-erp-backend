import { prisma } from '../../config/database';
import { ACTIVE_ADMISSION_STATUS } from '../../shared/admission-status';
import { generateJson, generateText } from '../../services/ai';
import { assertFeatureEnabled } from './ai.config.service';
import { retrieveDocs } from './ai.knowledge';
import {
  describeCaller,
  getRoleProfile,
  labelsProse,
  normalizeRoles,
  primaryRole,
  roleLanding,
} from './ai.roles';
import type { PlatformChatInput } from './ai.validation';
import { buildMedicineContext } from './ai.drug-context';

// ============================================================================
// Use Case 3 (Level 1): Platform-wide AI support chatbot — READ-ONLY + ROLE-AWARE.
//
// The assistant knows WHICH ROLE the signed-in user holds and answers in terms
// of that role's portal, modules and workflow. Two capabilities:
//   1. "help"  — answer software how-to / navigation questions (role-scoped RAG
//                over a curated knowledge base).
//   2. "data"  — answer read-only questions about the user's OWN organisation
//                via a strict whitelist of aggregate queries, gated per role.
//
// GUARDRAILS:
//   - Every data query is hard-scoped to the caller's tenantId. There is no
//     code path that reads another organisation's data.
//   - Only whitelisted intents can run; the LLM only PICKS an intent + dates —
//     it never writes or runs raw SQL.
//   - Each intent is additionally gated to the roles allowed to see it (e.g.
//     revenue is finance/admin only; patients get no hospital aggregates).
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

// Which roles may read each aggregate. '*' = any staff role. `admin` and
// `super_admin` always pass. Revenue is restricted to finance/admin; patients
// never receive hospital-wide aggregates (they only see their own portal data).
const INTENT_ACCESS: Record<DataIntent, string[] | '*'> = {
  count_patients_registered: '*',
  count_appointments: '*',
  count_admissions: '*',
  current_inpatients: '*',
  count_visits: '*',
  bed_occupancy: '*',
  total_revenue: ['super_admin', 'admin', 'billing_admin', 'cashier'],
};

function canAccessIntent(intent: DataIntent, roles: string[]): boolean {
  const norm = normalizeRoles(roles);
  if (norm.includes('super_admin') || norm.includes('admin')) return true;
  // A patient (with no staff role) gets no hospital aggregates.
  if (norm.length && norm.every((r) => r === 'patient')) return false;
  const allow = INTENT_ACCESS[intent];
  if (allow === '*') return true;
  return norm.some((r) => allow.includes(r));
}

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
      const n = await prisma.admission.count({ where: { tenantId, status: ACTIVE_ADMISSION_STATUS } });
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
  roles: string[],
  input: PlatformChatInput,
) {
  await assertFeatureEnabled('platformChat', tenantId);

  const today = new Date().toISOString().slice(0, 10);
  const callerBlock = describeCaller(roles);
  const roleLabel = getRoleProfile(primaryRole(roles)).label;

  // --- Step 1: route the question (data vs help) + extract dates. ---
  const planner = await generateJson<PlannerResult>(
    {
      system: [
        'You route a hospital-software support question. Today is ' + today + '.',
        'Decide if the question asks for a COUNT/NUMBER/REVENUE about the user\'s own hospital data ("data"), or a how-to/navigation/support question ("help").',
        'If "data", choose exactly one intent from this list and extract any date range as ISO yyyy-mm-dd (resolve relative/partial dates using today; if no year is given assume the current year):',
        DATA_INTENTS.map((i) => `- ${i}`).join('\n'),
        'Return strict JSON: {"type":"data"|"help","intent":<one of the list or null>,"fromDate":<iso or null>,"toDate":<iso or null>}',
      ].join('\n'),
      messages: [{ role: 'user', content: input.message }],
    },
    { tenantId },
  ).catch(() => ({ type: 'help' as const }));

  // --- Step 2a: data path — run the whitelisted query, then phrase it. ---
  if (planner.type === 'data' && planner.intent && DATA_INTENTS.includes(planner.intent)) {
    // Role gate: some figures (e.g. revenue) are restricted, and patients get
    // no hospital aggregates. Refuse gracefully instead of leaking the number.
    if (!canAccessIntent(planner.intent, roles)) {
      return {
        reply: `That figure isn't available to your role (${roleLabel}). A hospital admin or billing admin can pull it up — please ask them, or I can help you with a how-to question instead.`,
        mode: 'data' as const,
        intent: planner.intent,
        restricted: true,
      };
    }

    const from = parseDate(planner.fromDate);
    const to = parseDate(planner.toDate);
    const result = await runDataIntent(tenantId, planner.intent, from, to);

    const range =
      from || to
        ? ` for ${from ? from.toISOString().slice(0, 10) : 'the start'} to ${to ? to.toISOString().slice(0, 10) : 'now'}`
        : '';

    const { text, model, provider } = await generateText(
      {
        system:
          'You are a hospital software assistant. Phrase the computed answer in one friendly, precise sentence. Do not add extra numbers beyond the data given.',
        messages: [
          {
            role: 'user',
            content: `Question: ${input.message}\nComputed (${result.label}${range}): ${result.value}\nAnswer in one sentence.`,
          },
        ],
        maxOutputTokens: 120,
      },
      { tenantId },
    );

    return {
      reply: text,
      mode: 'data' as const,
      intent: planner.intent,
      data: { label: result.label, value: result.value },
      model,
      provider,
    };
  }

  // --- Step 2b: help path — role-scoped RAG over the how-to knowledge base. ---
  const norm = normalizeRoles(roles);
  const profile = getRoleProfile(primaryRole(roles));
  const docs = retrieveDocs(input.message, roles, 4);
  const topDoc = docs[0];

  // A medicine question is answered from the catalogue whatever the asker's
  // role: what a medicine is and does is reference data, not one role's job.
  // Looked up BEFORE the guard below, or "what is Dolo 650 for?" is refused to
  // a doctor merely because the nearest how-to happens to be a pharmacy one.
  const medicine = await buildMedicineContext(input.message, roles);

  // Out-of-scope guard (deterministic): if the best-matching how-to is written
  // ONLY for other roles, don't hand this role invented steps — tell them
  // plainly that it isn't part of their job and name the role that does it.
  const topIsForMe =
    !topDoc || topDoc.roles.includes('*') || topDoc.roles.some((r) => norm.includes(r));
  if (!medicine && topDoc && !topIsForMe) {
    const who = labelsProse(topDoc.roles.filter((r) => r !== '*').map((r) => getRoleProfile(r).label));
    return {
      reply: `**${profile.label} · ${profile.portal}**\n\nThat isn't part of the ${profile.label} role — “${topDoc.title}” is handled by ${who}. Ask them to help with this. I can walk you through anything in your own area instead (you work in ${profile.modules.slice(0, 3).join(', ')}).`,
      mode: 'help' as const,
      role: roleLabel,
      scope: 'out' as const,
      sources: [topDoc.title],
    };
  }

  const docContext = docs.length
    ? docs.map((d) => `### ${d.title}\n${d.body}`).join('\n\n')
    : 'No specific documentation matched.';

  const { text, model, provider } = await generateText(
    {
      system: [
        'You are the in-app support assistant for a multi-tenant hospital ERP/EMR. Answer the user\'s how-to/navigation question using ONLY the documentation snippets provided.',
        '',
        '=== WHO IS ASKING (tailor the answer to this role) ===',
        callerBlock,
        '',
        'Rules:',
        `- Answer specifically for the ${profile.label}. Begin the steps from their landing screen (${roleLanding(primaryRole(roles))}) and use the exact screen/menu names of THEIR portal.`,
        '- Do NOT restate their role name or portal (the app already shows it) — go straight into the concise, numbered steps.',
        '- If the task is outside this role\'s permissions, say so plainly and name the role that performs it (do not invent steps for them).',
        '- Be concise. If the snippets do not cover it, say you are not sure and suggest contacting your administrator or support.',
        '- You are READ-ONLY: you explain how to do things, you never perform actions or change data.',
        ...(medicine
          ? [
              '- This question names a medicine. Answer it from the MEDICINE FACTS below rather than from the documentation, in the detail this role needs, and name the product you describe.',
            ]
          : []),
        '',
        '=== DOCUMENTATION ===',
        docContext,
        ...(medicine ? ['', medicine.text] : []),
      ].join('\n'),
      messages: [
        ...(input.history ?? []).map((h) => ({ role: h.role, content: h.content })),
        { role: 'user' as const, content: input.message },
      ],
    },
    { tenantId },
  );

  // Deterministic role lead so the answer is visibly tailored to this role even
  // when the underlying workflow is identical across roles.
  return {
    reply: `**${profile.label} · ${profile.portal}** — ${medicine ? 'from the drug catalogue' : "here's how"}:\n\n${text}`,
    mode: 'help' as const,
    role: roleLabel,
    scope: 'in' as const,
    sources: [
      ...(medicine?.products.map((p) => `${p.name} (drug catalogue)`) ?? []),
      ...docs.map((d) => d.title),
    ],
    // Named separately from `sources` so a screen can show what the answer was
    // drawn from without having to parse titles.
    medicines: medicine?.products ?? [],
    model,
    provider,
  };
}
