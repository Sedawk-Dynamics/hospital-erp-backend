/**
 * Medicine facts for the assistants.
 *
 * The catalogue holds 744,000 products of vendor label data — what each one is
 * for, how to take it, what it does to you, six safety verdicts, storage,
 * interactions — and no part of the AI could see any of it. Asked "what is
 * Dolo 650 for?", the assistant had only its own general knowledge and the
 * app's how-to documents: nothing from this hospital's catalogue, and nothing
 * it could be held to.
 *
 * So the medicine is looked up here, deterministically — no model call, no
 * embeddings, no SQL written by a model — and the assistant is handed a fact
 * sheet drawn from the database, which its prompt then forbids it to go beyond.
 *
 * WHAT EACH ROLE IS TOLD. The label facts are what is printed on the pack, so
 * everybody gets those. A doctor also gets the composition with strengths, how
 * it works, the classes it belongs to and its interactions; a pharmacist also
 * gets the schedule it sells under and whether it is controlled. A
 * receptionist gets neither — not because the data is secret, but because an
 * answer that opens with NDPS status is a worse answer for them.
 *
 * All of this is reference data about a MEDICINE, never about a patient — the
 * same reasoning that leaves GET /drug-master/:id/monograph open to any
 * authenticated user.
 */
import { prisma } from '../../config/database';
import { normalizeRoles } from './ai.roles';
import {
  MONOGRAPH_SECTIONS,
  renderTemplate,
  plainText,
  type CatalogKind,
} from '../drug-master/drug-catalog.normalize';

/** How much of a medicine a role is told. */
export interface FactTier {
  /** Composition, how it works, therapeutic classes, interactions. */
  clinical: boolean;
  /** The schedule it sells under, controlled status, habit-forming. */
  legal: boolean;
}

const CLINICAL_ROLES = new Set([
  'doctor', 'nurse', 'nurse_admin', 'pharmacist', 'pharmacy_admin', 'admin', 'super_admin',
]);
const LEGAL_ROLES = new Set([
  'doctor', 'pharmacist', 'pharmacy_admin', 'inventory_manager', 'admin', 'super_admin',
]);

export function factTierFor(roles: string[] = []): FactTier {
  const norm = normalizeRoles(roles);
  return {
    clinical: norm.some((r) => CLINICAL_ROLES.has(r)),
    legal: norm.some((r) => LEGAL_ROLES.has(r)),
  };
}

/**
 * Words a question is made of rather than words a medicine is called. Without
 * this, "what is the dose" looks up a product called "dose" — and a catalogue
 * this large almost always has something that matches.
 */
const STOPWORDS = new Set([
  'what', 'whats', 'which', 'who', 'why', 'when', 'where', 'how', 'is', 'are', 'was', 'were',
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'at', 'by', 'with', 'about',
  'can', 'could', 'should', 'would', 'may', 'must', 'do', 'does', 'did', 'have', 'has', 'had',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those',
  'tell', 'give', 'show', 'explain', 'need', 'know', 'please', 'help', 'any', 'there',
  'medicine', 'medicines', 'drug', 'drugs', 'tablet', 'tablets', 'capsule', 'capsules',
  'syrup', 'injection', 'dose', 'dosage', 'doses', 'side', 'effect', 'effects', 'use', 'uses',
  'used', 'usage', 'take', 'takes', 'taking', 'taken', 'safe', 'safety', 'during', 'pregnancy',
  'pregnant', 'breastfeeding', 'lactation', 'alcohol', 'driving', 'drive', 'kidney', 'liver',
  'storage', 'store', 'stored', 'price', 'cost', 'schedule', 'interaction', 'interactions',
  'patient', 'patients', 'prescribe', 'prescribed', 'prescription', 'work', 'works', 'working',
  'information', 'info', 'details', 'detail', 'good', 'bad',
  // The words the app itself is made of. Without them "how do I add a new
  // patient" found a product called "Add App 2mg/5ml Syrup", because "add a"
  // is a prefix of its name.
  'add', 'new', 'create', 'edit', 'update', 'delete', 'remove', 'register', 'book', 'cancel',
  'print', 'upload', 'download', 'search', 'find', 'open', 'close', 'page', 'screen', 'button',
  'module', 'portal', 'login', 'logout', 'password', 'user', 'users', 'staff', 'report',
  'reports', 'bill', 'billing', 'invoice', 'payment', 'stock', 'inventory', 'appointment',
  'appointments', 'admission', 'admissions', 'discharge', 'lab', 'test', 'tests', 'imaging',
  'ward', 'bed', 'beds', 'form', 'forms', 'list', 'where', 'from', 'into', 'here',
]);

/**
 * Phrases worth looking up, longest first — "dolo 650 tablet" is tried before
 * "dolo", so the answer is about the product the person named rather than the
 * first of its siblings alphabetically.
 */
export function candidatePhrases(question: string, maxWords = 4): string[] {
  const words = (question ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9%.\s/-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (let n = Math.min(maxWords, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const slice = words.slice(i, i + n);
      // EVERY word has to look like part of a name. Testing only the first one
      // let "add a" through, and that is a prefix of "Add App 2mg/5ml Syrup" —
      // a catalogue this large always has something that matches a loose
      // phrase.
      if (slice.some((w) => STOPWORDS.has(w))) continue;
      if (n === 1 && slice[0].length < 4) continue;
      out.push(slice.join(' '));
    }
  }
  return out;
}

export interface FoundMedicine {
  id: string;
  name: string;
  /** The phrase in the question that found it. */
  matched: string;
  /** Named outright, or reached through one of its molecules. */
  via: 'name' | 'molecule';
  molecule?: string;
}

/**
 * The medicines a question is about, or none.
 *
 * A product name wins outright. Failing that, a molecule the salt master knows
 * ("what are paracetamol's side effects?") is answered from a product that
 * contains it ALONE, because the vendor writes its label data per product and
 * there is no monograph for a molecule on its own.
 */
export async function findMedicines(question: string, limit = 2): Promise<FoundMedicine[]> {
  const found: FoundMedicine[] = [];
  const seen = new Set<string>();
  // Two rows can carry the same name — one product in a strip of 10 and in a
  // strip of 15. Their facts are identical bar the pack, so the second one
  // would only eat the budget.
  const names = new Set<string>();

  for (const phrase of candidatePhrases(question)) {
    if (found.length >= limit) break;
    if (phrase.length < 4) continue;

    const byName = await prisma.drugMaster.findMany({
      where: {
        isPublished: true,
        isDiscontinued: false,
        name: { startsWith: phrase, mode: 'insensitive' },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: limit + 3,
    });
    for (const p of byName) {
      const key = p.name.trim().toLowerCase();
      if (seen.has(p.id) || names.has(key) || found.length >= limit) continue;
      seen.add(p.id);
      names.add(key);
      found.push({ id: p.id, name: p.name, matched: phrase, via: 'name' });
    }
    if (found.length) break;

    const salt = await prisma.salt.findFirst({
      where: { name: { equals: phrase, mode: 'insensitive' } },
      select: { id: true, name: true },
    });
    if (!salt) continue;
    const rep = await prisma.drugMaster.findFirst({
      where: {
        isPublished: true,
        isDiscontinued: false,
        saltComposition: { startsWith: salt.name, mode: 'insensitive' },
        NOT: { saltComposition: { contains: '+' } },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (rep && !seen.has(rep.id)) {
      seen.add(rep.id);
      found.push({ id: rep.id, name: rep.name, matched: phrase, via: 'molecule', molecule: salt.name });
      break;
    }
  }
  return found.slice(0, limit);
}

const VERDICT_WORDS: Record<string, string> = {
  safe: 'safe',
  safe_if_prescribed: 'safe if prescribed',
  caution: 'caution',
  unsafe: 'unsafe',
  consult_doctor: 'consult a doctor',
  not_relevant: 'not relevant',
};
const TOPIC_WORDS: Record<string, string> = {
  pregnancy: 'pregnancy',
  lactation: 'breastfeeding',
  alcohol: 'alcohol',
  driving: 'driving',
  kidney: 'kidney disease',
  liver: 'liver disease',
};

export interface MedicineFacts {
  id: string;
  name: string;
  kind: CatalogKind;
  sourceId: string | null;
  sourceRelease: string | null;
  manufacturer: string | null;
  packSizeLabel: string | null;
  productForm: string | null;
  mrp: string | null;
  countryOfOrigin: string | null;
  storage: string | null;
  isDiscontinued: boolean;
  saltComposition: string | null;
  salts: string[];
  rxRequired: boolean | null;
  habitForming: boolean | null;
  scheduleResolved: string | null;
  scheduleReason: string | null;
  controlledClass: string | null;
  vaultControlled: boolean;
  therapeuticClass: string | null;
  chemicalClass: string | null;
  actionClass: string | null;
  description: string | null;
  sideEffects: string | null;
  safety: Array<{ topic: string; verdict: string }>;
  interactions: Array<{ with: string; effect: string | null }>;
  sections: Array<{ key: string; title: string; text: string }>;
}

/** Everything a fact sheet can draw on, for a handful of products. */
export async function loadMedicineFacts(ids: string[]): Promise<MedicineFacts[]> {
  if (!ids.length) return [];
  const rows = await prisma.drugMaster.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, name: true, type: true, sourceId: true, sourceRelease: true, monograph: true,
      manufacturer: true, packSizeLabel: true, productForm: true, mrp: true,
      countryOfOrigin: true, storage: true, isDiscontinued: true, saltComposition: true,
      rxRequired: true, habitForming: true, scheduleResolved: true, scheduleReason: true,
      controlledClass: true, vaultControlled: true, therapeuticClass: true,
      chemicalClass: true, actionClass: true, description: true, sideEffects: true,
      safetyAdvice: true, drugInteractions: true,
      salts: {
        select: {
          strengthValue: true, strengthUnit: true, perVolumeValue: true,
          salt: { select: { name: true } },
        },
        orderBy: { position: 'asc' },
      },
    },
  });

  // The long texts live once in drug_texts, pointed at per section, so one
  // query covers every section of every product asked for.
  const refs = new Map<string, Record<string, number>>();
  const textIds = new Set<number>();
  for (const r of rows) {
    const m = (r.monograph && typeof r.monograph === 'object' ? r.monograph : {}) as Record<string, unknown>;
    const mine: Record<string, number> = {};
    for (const [k, v] of Object.entries(m)) {
      if (Number.isInteger(v)) {
        mine[k] = v as number;
        textIds.add(v as number);
      }
    }
    refs.set(r.id, mine);
  }
  const texts = textIds.size
    ? await prisma.drugText.findMany({ where: { id: { in: [...textIds] } }, select: { id: true, body: true } })
    : [];
  const bodies = new Map(texts.map((t) => [t.id, t.body]));

  const order = new Map(ids.map((id, i) => [id, i]));
  return rows
    .slice()
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((r) => {
      const kind: CatalogKind = r.type === 'otc' ? 'otc' : 'drug';
      const advice = (r.safetyAdvice ?? {}) as Record<string, string>;
      const inter = (r.drugInteractions ?? {}) as { drug?: string[]; brand?: string[]; effect?: string[] };
      const withList = [...(inter.drug ?? []), ...(inter.brand ?? [])];
      const sections: MedicineFacts['sections'] = [];
      for (const s of MONOGRAPH_SECTIONS[kind]) {
        const textId = refs.get(r.id)?.[s.key];
        const body = typeof textId === 'number' ? bodies.get(textId) : undefined;
        if (body) {
          sections.push({ key: s.key, title: s.title, text: plainText(renderTemplate(body, r.name)) });
        }
      }
      return {
        id: r.id,
        name: r.name,
        kind,
        sourceId: r.sourceId,
        sourceRelease: r.sourceRelease,
        manufacturer: r.manufacturer,
        packSizeLabel: r.packSizeLabel,
        productForm: r.productForm,
        mrp: r.mrp === null || r.mrp === undefined ? null : String(r.mrp),
        countryOfOrigin: r.countryOfOrigin,
        storage: r.storage,
        isDiscontinued: Boolean(r.isDiscontinued),
        saltComposition: r.saltComposition,
        salts: r.salts.map((s) => {
          const strength =
            s.strengthValue === null || s.strengthValue === undefined
              ? null
              : `${Number(s.strengthValue)}${s.strengthUnit ?? ''}${s.perVolumeValue ? `/${Number(s.perVolumeValue)}ml` : ''}`;
          return strength ? `${s.salt.name} (${strength})` : s.salt.name;
        }),
        rxRequired: r.rxRequired,
        habitForming: r.habitForming,
        scheduleResolved: r.scheduleResolved,
        scheduleReason: r.scheduleReason,
        controlledClass: r.controlledClass,
        vaultControlled: Boolean(r.vaultControlled),
        therapeuticClass: r.therapeuticClass,
        chemicalClass: r.chemicalClass,
        actionClass: r.actionClass,
        description: r.description,
        sideEffects: r.sideEffects,
        safety: Object.entries(advice)
          .filter(([topic, verdict]) => TOPIC_WORDS[topic] && VERDICT_WORDS[verdict])
          .map(([topic, verdict]) => ({ topic: TOPIC_WORDS[topic], verdict: VERDICT_WORDS[verdict] })),
        interactions: withList.map((w, i) => ({ with: w, effect: inter.effect?.[i] ?? null })),
        sections,
      };
    });
}

/** Long vendor prose, cut to size with the cut made visible. */
function trim(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Sections everyone gets, and the two that only a clinician gets. */
const SECTIONS_FOR_EVERYONE = new Set([
  'intro', 'benefits', 'howToUse', 'missedDose',
  'highlights', 'information', 'directions', 'safetyInfo',
]);
const SECTIONS_FOR_CLINICIANS = new Set(['howItWorks', 'ingredients']);

/** One medicine, as facts the assistant may use and nothing more. */
export function renderMedicineFacts(f: MedicineFacts, tier: FactTier, budget = 3200): string {
  const lines: string[] = [];
  const label = [
    f.manufacturer ? `made by ${f.manufacturer}` : null,
    f.packSizeLabel,
    f.productForm,
    f.mrp ? `MRP ₹${f.mrp}` : null,
    f.countryOfOrigin ? `origin ${f.countryOfOrigin}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  lines.push(`### ${f.name}${f.isDiscontinued ? ' (discontinued)' : ''}`);
  if (label) lines.push(`- Pack: ${label}`);
  if (tier.clinical && (f.salts.length || f.saltComposition)) {
    lines.push(`- Composition: ${f.salts.length ? f.salts.join(' + ') : f.saltComposition}`);
  }
  if (f.rxRequired !== null) {
    lines.push(`- The label says prescription only: ${f.rxRequired ? 'yes' : 'no'}`);
  }
  if (tier.legal) {
    if (f.scheduleResolved) {
      const why = trim(f.scheduleReason, 180);
      lines.push(`- Schedule this platform classified it under: ${f.scheduleResolved}${why ? ` (${why})` : ''}`);
    }
    if (f.controlledClass) {
      lines.push(`- Controlled substance: ${f.controlledClass}${f.vaultControlled ? ', kept in the narcotic safe' : ''}`);
    }
    if (f.habitForming !== null) lines.push(`- Habit forming: ${f.habitForming ? 'yes' : 'no'}`);
  }
  if (tier.clinical) {
    const classes = [f.therapeuticClass, f.actionClass, f.chemicalClass].filter(Boolean).join(' · ');
    if (classes) lines.push(`- Class: ${classes}`);
  }
  const used = trim(f.description, 400);
  if (used) lines.push(`- Used for: ${used}`);
  const storage = trim(f.storage, 200);
  if (storage) lines.push(`- Storage: ${storage}`);
  if (f.safety.length) {
    lines.push(`- Safety: ${f.safety.map((s) => `${s.topic} — ${s.verdict}`).join('; ')}`);
  }
  const sideEffects = trim(f.sideEffects, 500);
  if (sideEffects) lines.push(`- Side effects the label lists: ${sideEffects}`);
  if (tier.clinical && f.interactions.length) {
    const shown = f.interactions
      .slice(0, 12)
      .map((i) => `${i.with}${i.effect ? ` (${i.effect.toLowerCase()})` : ''}`)
      .join(', ');
    const more = f.interactions.length > 12 ? `, and ${f.interactions.length - 12} more` : '';
    lines.push(`- Interacts with: ${shown}${more}`);
  }
  for (const s of f.sections) {
    const allowed = SECTIONS_FOR_EVERYONE.has(s.key) || (tier.clinical && SECTIONS_FOR_CLINICIANS.has(s.key));
    if (!allowed) continue;
    const text = trim(s.text, 600);
    if (text) lines.push(`- ${s.title}: ${text}`);
  }

  const out = lines.join('\n');
  return out.length > budget ? `${out.slice(0, budget - 1).trimEnd()}…` : out;
}

export interface MedicineContext {
  text: string;
  products: Array<{ id: string; name: string }>;
}

/**
 * The fact sheet for whatever medicine a question is about, or null when it is
 * not about one — in which case the caller's prompt is left exactly as it was.
 */
export async function buildMedicineContext(
  question: string,
  roles: string[] = [],
  opts: { limit?: number; budget?: number } = {},
): Promise<MedicineContext | null> {
  const found = await findMedicines(question, opts.limit ?? 2);
  if (!found.length) return null;

  const facts = await loadMedicineFacts(found.map((f) => f.id));
  if (!facts.length) return null;

  const tier = factTierFor(roles);
  const byId = new Map(found.map((f) => [f.id, f]));
  const release = facts.find((f) => f.sourceRelease)?.sourceRelease;

  const blocks = facts.map((f) => {
    const hit = byId.get(f.id);
    const lead =
      hit?.via === 'molecule'
        ? `(asked about ${hit.molecule}; these are the facts for one product containing it alone)\n`
        : '';
    return lead + renderMedicineFacts(f, tier, opts.budget ?? 3200);
  });

  return {
    text: [
      `=== MEDICINE FACTS — the hospital's drug catalogue${release ? `, vendor release ${release}` : ''} ===`,
      ...blocks,
      '',
      'Using these facts:',
      '- Answer only from them. If they do not cover what was asked, say the catalogue does not record it rather than filling the gap.',
      '- Name the product you are describing.',
      '- These are label facts, not a prescription: never invent a dose, and send anyone deciding whether to take a medicine to their doctor or pharmacist.',
    ].join('\n'),
    products: facts.map((f) => ({ id: f.id, name: f.name })),
  };
}
