// ---------------------------------------------------------------------------
// UQC — the Unit Quantity Codes GSTR-1 Table 12 reports quantities in.
//
// Section 11.2's A-3 column list asks for it by name: "Unit of measurement
// (UQC) — the government's standard code list — TAB, NOS, ML and so on". The
// summary reported a quantity with no unit, and the portal will not accept a
// Table 12 row without one.
//
// The list is fixed by the GST portal; a hospital cannot invent a code. What
// this file does is MAP what the hospital actually records — a loose-unit label
// on a drug, a dosage form, a service line — onto the nearest code on that
// list.
//
// Where nothing maps, the answer is OTH ("Others"), which is a real code on the
// portal's list and the honest one: better a row the portal accepts under
// "Others" than a guess at BOX when the pack might be a strip.
// ---------------------------------------------------------------------------

/** The subset a hospital can plausibly use. Codes are the portal's own. */
export const UQC_CODES: Record<string, string> = {
  TAB: 'Tablets',
  NOS: 'Numbers',
  ML: 'Millilitre',
  LTR: 'Litre',
  GMS: 'Grammes',
  KGS: 'Kilograms',
  BTL: 'Bottles',
  VIA: 'Vials',
  TUB: 'Tubes',
  PAC: 'Packs',
  BOX: 'Box',
  STR: 'Strips',
  CAN: 'Cans',
  UNT: 'Units',
  OTH: 'Others',
};

/**
 * A recorded unit, as the portal's code.
 *
 * Reads the words a hospital actually types — "tablet", "Tablets", "cap",
 * "ml", "vial", "strip of 10" — and maps them. Matched longest-first on the
 * distinctive part, so "capsule" does not fall to "CAN" and "syrup 100ml"
 * finds ML.
 */
export function uqcFor(unit: string | null | undefined, fallback = 'OTH'): string {
  const u = String(unit ?? '').trim().toLowerCase();
  if (!u) return fallback;

  // Already a code the portal knows.
  const upper = u.toUpperCase();
  if (UQC_CODES[upper]) return upper;

  const rules: Array<[RegExp, string]> = [
    [/\btab(let)?s?\b/, 'TAB'],
    [/\bcap(sule)?s?\b/, 'NOS'],
    [/\bstrips?\b/, 'STR'],
    [/\bvials?\b/, 'VIA'],
    [/\bamp(oule)?s?\b/, 'VIA'],
    [/\bbottles?\b|\bbtl\b/, 'BTL'],
    [/\btubes?\b/, 'TUB'],
    [/\bsachets?\b|\bpouch(es)?\b/, 'PAC'],
    [/\bpacks?\b|\bpkt\b/, 'PAC'],
    [/\bbox(es)?\b/, 'BOX'],
    [/\bcans?\b/, 'CAN'],
    [/\bml\b|\bmillilitre?s?\b/, 'ML'],
    [/\bl(itre)?s?\b/, 'LTR'],
    [/\bmg\b|\bg(m|ram)?s?\b/, 'GMS'],
    [/\bkgs?\b|\bkilogram?s?\b/, 'KGS'],
    [/\bunits?\b|\bunt\b/, 'UNT'],
    [/\bnos?\b|\bnumbers?\b|\bpiece?s?\b|\bpcs?\b/, 'NOS'],
  ];
  for (const [re, code] of rules) if (re.test(u)) return code;
  return fallback;
}

/**
 * The UQC for a whole bill line, from what the line knows about itself.
 *
 * A SERVICE has no physical unit — a consultation, an X-ray, a day of room
 * rent — and the portal's convention for those is NOS, one of each. Goods take
 * their own unit where the description carries one.
 */
export function uqcForLine(input: {
  category?: string | null;
  description?: string | null;
  looseUnitLabel?: string | null;
}): string {
  if (input.looseUnitLabel) return uqcFor(input.looseUnitLabel);

  const goods = input.category === 'pharmacy' || input.category === 'consumable';
  if (!goods) return 'NOS';

  // The counter writes the unit into the line: "… — 10 tablet, loose",
  // "… — 2 pack of 10 Tablet". Read the last unit-looking word rather than the
  // first, which is usually the drug's own name.
  const desc = String(input.description ?? '');
  const tail = desc.split('—').pop() ?? desc;
  return uqcFor(tail, 'NOS');
}
