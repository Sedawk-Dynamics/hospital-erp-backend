import { prisma } from '../../config/database';
import { parseInteractions } from '../drug-master/drug-catalog.normalize';
import { normalizeDrug, type InteractionSeverity } from './drug-interactions.data';

/**
 * Drug-drug interactions read from the drug catalogue.
 *
 * The curated list in `drug-interactions.data.ts` holds 41 clinician-written
 * pairs. The catalogue holds the vendor's own interaction data on 175,216
 * products — and until now nothing read it, so a prescription of two drugs the
 * vendor explicitly flags against each other raised no alert unless one of the
 * 41 happened to cover it.
 *
 * Both sources now run. They answer different questions and neither replaces
 * the other: the curated pairs are CLASS rules ("an ACE inhibitor with an ARB"),
 * which no amount of molecule matching reproduces; the catalogue is per-product
 * and names specific molecules.
 *
 * ── The one deliberate limit ────────────────────────────────────────────────
 * Catalogue severity is capped at 'major'. A 'contraindicated' pair BLOCKS a
 * prescription, and 123,412 catalogue entries say "life-threatening" — turning
 * those into blockers would stop prescribing across the hospital overnight, on
 * data nobody here has reviewed, with no clinician in the loop. So the
 * catalogue warns and the curated list blocks. The vendor's own word is kept in
 * the message, so a life-threatening pair still reads as one.
 */

/** What the catalogue says, before it is mapped onto our four levels. */
const VENDOR_SEVERITY: Record<string, InteractionSeverity> = {
  'life-threatening': 'major',
  severe: 'major',
  moderate: 'moderate',
  mild: 'minor',
};

/**
 * An entry with no severity word. 3.7% of them, and their advice is often
 * "concurrent use should be avoided" — too important to file under 'minor'.
 */
const UNRATED_SEVERITY: InteractionSeverity = 'moderate';

const SEVERITY_ORDER: InteractionSeverity[] = ['contraindicated', 'major', 'moderate', 'minor'];

export function severityRank(s: InteractionSeverity): number {
  const i = SEVERITY_ORDER.indexOf(s);
  return i === -1 ? SEVERITY_ORDER.length : i;
}

export interface CataloguePair {
  drugs: [string, string];
  severity: InteractionSeverity;
  description: string;
}

/** What the caller already knows about a drug, so we don't look it up twice. */
export interface CatalogueHint {
  drugMasterId?: string | null;
  drugName?: string | null;
  saltsJson?: unknown;
}

interface VendorEntry {
  /** The name as the catalogue wrote it — a molecule ("Phenytoin") or a brand. */
  entry: string;
  norm: string;
  /** The vendor's word, or null when the column left it blank. */
  vendorSeverity: string | null;
  severity: InteractionSeverity;
  advice: string | null;
}

interface ResolvedDrug {
  /** Exactly the string the caller passed, so alerts name what was typed. */
  input: string;
  /** Normalised names this drug answers to: what was typed, the formulary's
   *  spelling, the catalogue's spelling. */
  names: Set<string>;
  /** Normalised molecule names in this product. */
  molecules: Set<string>;
  entries: VendorEntry[];
}

type SaltsJson = Array<{ norm?: string | null; raw?: string | null }>;

function moleculeNames(saltsJson: unknown): string[] {
  if (!Array.isArray(saltsJson)) return [];
  return (saltsJson as SaltsJson)
    .map((s) => normalizeDrug(String(s?.norm ?? s?.raw ?? '')))
    .filter(Boolean);
}

function mapSeverity(word: string | null | undefined): {
  severity: InteractionSeverity;
  vendorSeverity: string | null;
} {
  const w = (word ?? '').trim();
  if (!w) return { severity: UNRATED_SEVERITY, vendorSeverity: null };
  return { severity: VENDOR_SEVERITY[w.toLowerCase()] ?? UNRATED_SEVERITY, vendorSeverity: w };
}

/**
 * Resolve each name to a catalogue product. The caller's hints (a matched
 * formulary row) win — that is the hospital's own mapping, and it is already
 * loaded. Anything left is matched on the catalogue's name, exactly: a drug
 * history says "Dolo 650 Tablet", and a loose match here would attach one
 * product's interaction list to a different molecule.
 */
async function resolveDrugs(
  drugs: string[],
  hints: Map<string, CatalogueHint>,
): Promise<ResolvedDrug[]> {
  const resolved: ResolvedDrug[] = drugs.map((input) => {
    const hint = hints.get(input.toLowerCase()) ?? {};
    const names = new Set([normalizeDrug(input)]);
    if (hint.drugName) names.add(normalizeDrug(hint.drugName));
    return {
      input,
      names,
      molecules: new Set(moleculeNames(hint.saltsJson)),
      entries: [],
    };
  });

  // Which catalogue row belongs to which input.
  const masterIdByIndex = new Map<number, string>();
  drugs.forEach((input, i) => {
    const id = hints.get(input.toLowerCase())?.drugMasterId;
    if (id) masterIdByIndex.set(i, id);
  });

  const unresolved = drugs
    .map((input, i) => ({ input, i }))
    .filter(({ i }) => !masterIdByIndex.has(i));

  if (unresolved.length) {
    const rows = await prisma.drugMaster.findMany({
      where: {
        isPublished: true,
        isDiscontinued: false,
        OR: unresolved.map(({ input }) => ({ name: { equals: input.trim(), mode: 'insensitive' as const } })),
      },
      select: { id: true, name: true, drugInteractions: true },
      orderBy: { id: 'asc' },
    });

    // One name, two rows: the same product in two pack sizes. Only one of them
    // usually carries the interaction list, so picking arbitrarily loses the
    // alert — "Dolo 650 Tablet" resolved to the pack with an empty list and its
    // interactions vanished. Prefer a row that has the data, then lowest id so
    // the same question always gets the same answer.
    const byName = new Map<string, { id: string; hasData: boolean }>();
    for (const r of rows) {
      const key = normalizeDrug(r.name);
      const hasData = r.drugInteractions != null;
      const current = byName.get(key);
      if (!current || (hasData && !current.hasData)) byName.set(key, { id: r.id, hasData });
    }
    for (const { input, i } of unresolved) {
      const found = byName.get(normalizeDrug(input));
      if (found) masterIdByIndex.set(i, found.id);
    }
  }

  const ids = [...new Set(masterIdByIndex.values())];
  if (!ids.length) return resolved;

  const masters = await prisma.drugMaster.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, saltsJson: true, drugInteractions: true, monograph: true },
  });
  const masterById = new Map(masters.map((m) => [m.id, m]));

  // The severity column says how bad; the monograph says what to do about it.
  const textIds = masters
    .map((m) => (m.monograph as Record<string, number> | null)?.interactions)
    .filter((id): id is number => typeof id === 'number');
  const adviceByMaster = new Map<string, Map<string, string>>();
  if (textIds.length) {
    const texts = await prisma.drugText.findMany({
      where: { id: { in: [...new Set(textIds)] } },
      select: { id: true, body: true },
    });
    const bodyById = new Map(texts.map((t) => [t.id, t.body]));
    for (const m of masters) {
      const textId = (m.monograph as Record<string, number> | null)?.interactions;
      const body = typeof textId === 'number' ? bodyById.get(textId) : undefined;
      if (!body) continue;
      const perDrug = new Map<string, string>();
      for (const i of parseInteractions(body, m.name)) {
        const advice = i.advice?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (advice) perDrug.set(normalizeDrug(i.drug), advice);
      }
      adviceByMaster.set(m.id, perDrug);
    }
  }

  for (const [i, masterId] of masterIdByIndex) {
    const m = masterById.get(masterId);
    if (!m) continue;
    const r = resolved[i];
    r.names.add(normalizeDrug(m.name));
    for (const mol of moleculeNames(m.saltsJson)) r.molecules.add(mol);

    const raw = (m.drugInteractions ?? null) as { drug?: string[]; effect?: string[] } | null;
    const advice = adviceByMaster.get(masterId);
    r.entries = (raw?.drug ?? []).map((entry, k) => {
      const norm = normalizeDrug(entry);
      return { entry, norm, advice: advice?.get(norm) ?? null, ...mapSeverity(raw?.effect?.[k]) };
    });
  }

  return resolved;
}

/** Does `holder`'s interaction list name `other`? Returns the worst match. */
function findEntry(holder: ResolvedDrug, other: ResolvedDrug): VendorEntry | null {
  let best: VendorEntry | null = null;
  for (const e of holder.entries) {
    if (!e.norm) continue;
    // A molecule name is matched against molecules and a brand name against
    // brands — both exactly. Substring matching here would pair "Nise" with
    // "Nisoldipine" and put a wrong alert in front of a prescriber.
    if (!other.molecules.has(e.norm) && !other.names.has(e.norm)) continue;
    if (!best || severityRank(e.severity) < severityRank(best.severity)) best = e;
  }
  return best;
}

function describe(entry: VendorEntry): string {
  const level = entry.vendorSeverity ? `${entry.vendorSeverity.toLowerCase()}` : 'an unrated';
  const article = entry.vendorSeverity ? 'a ' : '';
  const head = `Drug catalogue: ${article}${level} interaction with ${entry.entry}.`;
  return entry.advice ? `${head} ${entry.advice}` : head;
}

/**
 * Cross-check every pair of drugs against the catalogue's interaction lists.
 * Checked in BOTH directions: only one side of a pair usually records it.
 */
export async function catalogueInteractionPairs(
  drugs: string[],
  hints: Map<string, CatalogueHint> = new Map(),
): Promise<CataloguePair[]> {
  if (drugs.length < 2) return [];

  const resolved = await resolveDrugs(drugs, hints);
  const pairs: CataloguePair[] = [];

  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];
      // Same product listed twice under two names — not an interaction.
      if ([...a.names].some((n) => b.names.has(n))) continue;

      const fromA = findEntry(a, b);
      const fromB = findEntry(b, a);
      const best =
        fromA && fromB
          ? severityRank(fromA.severity) <= severityRank(fromB.severity)
            ? fromA
            : fromB
          : (fromA ?? fromB);
      if (!best) continue;

      pairs.push({
        drugs: [a.input, b.input],
        severity: best.severity,
        description: describe(best),
      });
    }
  }

  return pairs;
}
