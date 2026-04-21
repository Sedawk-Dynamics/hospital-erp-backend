/**
 * Curated drug-drug interaction pairs. Each pair is matched against normalised
 * drug/generic names (lowercased, alphanumerics only). Matching is substring-based
 * to cover brand-name variants (e.g. "Augmentin 625" still matches "amoxicillin"
 * when the generic is used).
 *
 * This list is not exhaustive — it captures commonly prescribed combinations
 * that pharmacy + nursing staff should be alerted to. Extend cautiously and
 * only with references.
 */

export type InteractionSeverity = 'contraindicated' | 'major' | 'moderate' | 'minor';

export interface InteractionPairDef {
  /** Each entry is a list of synonymous matchers for that side of the pair.
   *  All matchers in the array are alternatives (OR). */
  a: string[];
  b: string[];
  severity: InteractionSeverity;
  description: string;
}

export const INTERACTION_PAIRS: InteractionPairDef[] = [
  // ── Anticoagulation ─────────────────────────────────────
  {
    a: ['warfarin', 'coumadin'],
    b: ['aspirin', 'asa'],
    severity: 'major',
    description: 'Increased bleeding risk. Monitor INR and signs of bleeding.',
  },
  {
    a: ['warfarin'],
    b: ['nsaid', 'ibuprofen', 'naproxen', 'diclofenac', 'ketorolac'],
    severity: 'major',
    description: 'NSAIDs increase warfarin bleeding risk via platelet inhibition and displacement.',
  },
  {
    a: ['warfarin'],
    b: ['clopidogrel', 'ticagrelor', 'prasugrel'],
    severity: 'major',
    description: 'Combined anticoagulant + antiplatelet markedly increases hemorrhage risk.',
  },
  {
    a: ['warfarin'],
    b: ['amiodarone'],
    severity: 'major',
    description: 'Amiodarone potentiates warfarin; reduce warfarin dose ~30–50% and monitor INR.',
  },

  // ── Cardiac / Bradycardia ───────────────────────────────
  {
    a: ['beta blocker', 'metoprolol', 'atenolol', 'propranolol', 'bisoprolol', 'carvedilol'],
    b: ['verapamil', 'diltiazem'],
    severity: 'major',
    description: 'Combined negative chronotropy → risk of severe bradycardia and heart block.',
  },
  {
    a: ['digoxin'],
    b: ['amiodarone', 'verapamil', 'quinidine'],
    severity: 'major',
    description: 'Doubles digoxin levels. Reduce digoxin dose and monitor toxicity.',
  },

  // ── Renin-angiotensin + potassium ───────────────────────
  {
    a: ['ace inhibitor', 'enalapril', 'ramipril', 'lisinopril', 'captopril', 'perindopril'],
    b: ['arb', 'losartan', 'telmisartan', 'valsartan', 'olmesartan', 'irbesartan'],
    severity: 'major',
    description: 'ACE-I + ARB not recommended: increased hyperkalemia, hypotension, renal failure risk.',
  },
  {
    a: ['ace inhibitor', 'enalapril', 'ramipril', 'lisinopril', 'arb', 'losartan', 'telmisartan'],
    b: ['spironolactone', 'eplerenone', 'potassium chloride', 'kcl'],
    severity: 'major',
    description: 'Risk of hyperkalemia. Monitor serum potassium closely.',
  },

  // ── Serotonergic ────────────────────────────────────────
  {
    a: ['ssri', 'fluoxetine', 'sertraline', 'paroxetine', 'escitalopram', 'citalopram'],
    b: ['mao inhibitor', 'maoi', 'selegiline', 'phenelzine', 'tranylcypromine', 'linezolid'],
    severity: 'contraindicated',
    description: 'Serotonin syndrome — contraindicated. Requires 14-day washout.',
  },
  {
    a: ['tramadol'],
    b: ['ssri', 'fluoxetine', 'sertraline', 'paroxetine', 'escitalopram', 'citalopram', 'venlafaxine'],
    severity: 'moderate',
    description: 'Additive serotonergic effect; seizure and serotonin syndrome risk.',
  },

  // ── QT prolongation ─────────────────────────────────────
  {
    a: ['amiodarone', 'sotalol', 'quinidine'],
    b: ['azithromycin', 'clarithromycin', 'erythromycin', 'ciprofloxacin', 'levofloxacin', 'moxifloxacin', 'ondansetron', 'haloperidol'],
    severity: 'major',
    description: 'Additive QT prolongation — torsades de pointes risk. ECG monitoring advised.',
  },

  // ── Infectious diseases / antibiotics ───────────────────
  {
    a: ['methotrexate'],
    b: ['trimethoprim', 'cotrimoxazole', 'tmp-smx', 'bactrim'],
    severity: 'major',
    description: 'Additive antifolate → pancytopenia risk.',
  },
  {
    a: ['clopidogrel'],
    b: ['omeprazole', 'esomeprazole'],
    severity: 'moderate',
    description: 'CYP2C19 inhibition reduces clopidogrel activation. Prefer pantoprazole.',
  },

  // ── Bleeding / platelet ─────────────────────────────────
  {
    a: ['heparin', 'enoxaparin', 'dalteparin', 'lmwh'],
    b: ['aspirin', 'clopidogrel', 'ticagrelor'],
    severity: 'major',
    description: 'Elevated bleeding risk. Balance ACS indications against bleed risk.',
  },

  // ── CNS / opioid ────────────────────────────────────────
  {
    a: ['opioid', 'morphine', 'fentanyl', 'oxycodone', 'tramadol', 'codeine'],
    b: ['benzodiazepine', 'diazepam', 'lorazepam', 'midazolam', 'alprazolam', 'clonazepam'],
    severity: 'major',
    description: 'Respiratory depression, sedation, coma, death risk. Avoid combination if possible.',
  },

  // ── Hypoglycemia ────────────────────────────────────────
  {
    a: ['insulin', 'glimepiride', 'glipizide', 'glibenclamide', 'sulfonylurea'],
    b: ['beta blocker', 'metoprolol', 'propranolol'],
    severity: 'moderate',
    description: 'Non-selective beta blockers may mask hypoglycemia symptoms.',
  },

  // ── NSAIDs + ACE / diuretics (triple whammy) ────────────
  {
    a: ['nsaid', 'ibuprofen', 'naproxen', 'diclofenac'],
    b: ['ace inhibitor', 'enalapril', 'ramipril', 'lisinopril', 'arb', 'losartan'],
    severity: 'moderate',
    description: 'Reduced renal perfusion → acute kidney injury risk, especially in dehydrated patients.',
  },

  // ── Statins ─────────────────────────────────────────────
  {
    a: ['simvastatin'],
    b: ['clarithromycin', 'erythromycin', 'itraconazole', 'ketoconazole'],
    severity: 'major',
    description: 'Markedly elevated statin levels → rhabdomyolysis risk.',
  },
  {
    a: ['simvastatin', 'atorvastatin'],
    b: ['gemfibrozil'],
    severity: 'major',
    description: 'Increased rhabdomyolysis risk with fibrate combination.',
  },

  // ── Lithium ─────────────────────────────────────────────
  {
    a: ['lithium'],
    b: ['nsaid', 'ibuprofen', 'naproxen', 'diclofenac', 'thiazide', 'hydrochlorothiazide', 'ace inhibitor', 'enalapril'],
    severity: 'major',
    description: 'Reduced lithium clearance → toxicity. Monitor lithium levels.',
  },
];

/** Normalise a drug string for fuzzy substring matching. */
export function normalizeDrug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function drugMatchesAny(drug: string, matchers: string[]): boolean {
  const n = normalizeDrug(drug);
  return matchers.some((m) => n.includes(normalizeDrug(m)));
}
