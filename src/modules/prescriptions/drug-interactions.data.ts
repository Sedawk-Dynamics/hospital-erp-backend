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

  // ── Nitrates + PDE5 inhibitors ──────────────────────────
  {
    a: ['nitroglycerin', 'nitrate', 'isosorbide', 'sorbitrate'],
    b: ['sildenafil', 'tadalafil', 'vardenafil'],
    severity: 'contraindicated',
    description: 'Profound refractory hypotension — contraindicated. Separate by 24–48 hours.',
  },

  // ── Anti-tubercular (rifampicin is a potent CYP inducer) ─
  {
    a: ['rifampicin', 'rifampin'],
    b: ['warfarin'],
    severity: 'major',
    description: 'Rifampicin induces warfarin metabolism → loss of anticoagulation. Monitor INR closely.',
  },
  {
    a: ['rifampicin', 'rifampin'],
    b: ['oral contraceptive', 'ethinyl estradiol', 'levonorgestrel', 'norethisterone'],
    severity: 'major',
    description: 'Rifampicin reduces contraceptive efficacy — advise alternative/barrier contraception.',
  },
  {
    a: ['rifampicin', 'rifampin'],
    b: ['glimepiride', 'glipizide', 'glibenclamide', 'sulfonylurea', 'pioglitazone'],
    severity: 'moderate',
    description: 'Rifampicin lowers sulfonylurea levels → loss of glycemic control.',
  },
  {
    a: ['isoniazid', 'inh'],
    b: ['phenytoin', 'carbamazepine'],
    severity: 'major',
    description: 'Isoniazid inhibits anticonvulsant metabolism → toxicity (ataxia, nystagmus). Monitor levels.',
  },

  // ── Immunosuppressants / chemo ──────────────────────────
  {
    a: ['allopurinol', 'febuxostat'],
    b: ['azathioprine', 'mercaptopurine', '6-mp'],
    severity: 'contraindicated',
    description: 'Xanthine-oxidase inhibition → fatal myelosuppression. Reduce thiopurine to 25% if unavoidable.',
  },
  {
    a: ['methotrexate'],
    b: ['nsaid', 'ibuprofen', 'naproxen', 'diclofenac', 'aspirin'],
    severity: 'major',
    description: 'NSAIDs reduce methotrexate clearance → marrow + hepatic toxicity, esp. high-dose MTX.',
  },
  {
    a: ['tacrolimus', 'cyclosporine', 'ciclosporin'],
    b: ['fluconazole', 'ketoconazole', 'itraconazole', 'voriconazole', 'clarithromycin', 'erythromycin'],
    severity: 'major',
    description: 'CYP3A4 inhibition elevates immunosuppressant levels → nephrotoxicity. Monitor trough levels.',
  },

  // ── Anticonvulsants ─────────────────────────────────────
  {
    a: ['valproate', 'valproic', 'sodium valproate', 'divalproex'],
    b: ['meropenem', 'imipenem', 'ertapenem', 'carbapenem'],
    severity: 'major',
    description: 'Carbapenems drop valproate levels up to 90% within days → seizure breakthrough.',
  },
  {
    a: ['carbamazepine'],
    b: ['clarithromycin', 'erythromycin', 'fluconazole', 'isoniazid'],
    severity: 'major',
    description: 'CYP3A4 inhibition → carbamazepine toxicity (diplopia, ataxia, arrhythmia).',
  },
  {
    a: ['phenytoin'],
    b: ['fluconazole', 'omeprazole', 'amiodarone'],
    severity: 'moderate',
    description: 'Raised phenytoin levels — narrow therapeutic index. Monitor levels and toxicity signs.',
  },

  // ── DOACs ───────────────────────────────────────────────
  {
    a: ['rivaroxaban', 'apixaban', 'dabigatran', 'edoxaban'],
    b: ['nsaid', 'ibuprofen', 'naproxen', 'diclofenac', 'aspirin', 'clopidogrel', 'ticagrelor'],
    severity: 'major',
    description: 'DOAC + antiplatelet/NSAID markedly increases GI and intracranial bleeding risk.',
  },
  {
    a: ['rivaroxaban', 'apixaban'],
    b: ['ketoconazole', 'itraconazole', 'ritonavir'],
    severity: 'major',
    description: 'Strong CYP3A4/P-gp inhibition raises DOAC exposure → bleeding. Avoid combination.',
  },

  // ── Antimalarials / QT (regional relevance) ─────────────
  {
    a: ['chloroquine', 'hydroxychloroquine', 'quinine'],
    b: ['azithromycin', 'moxifloxacin', 'amiodarone', 'sotalol', 'haloperidol', 'ondansetron'],
    severity: 'major',
    description: 'Additive QT prolongation — torsades risk. ECG monitoring advised.',
  },

  // ── Theophylline (still common in Indian respiratory Rx) ─
  {
    a: ['theophylline', 'deriphyllin', 'aminophylline'],
    b: ['ciprofloxacin', 'erythromycin', 'clarithromycin'],
    severity: 'major',
    description: 'CYP1A2 inhibition → theophylline toxicity (seizures, arrhythmias). Narrow index — monitor levels.',
  },

  // ── Colchicine ──────────────────────────────────────────
  {
    a: ['colchicine'],
    b: ['clarithromycin', 'erythromycin', 'ketoconazole', 'itraconazole', 'cyclosporine'],
    severity: 'contraindicated',
    description: 'Fatal colchicine toxicity reported with CYP3A4/P-gp inhibitors, esp. in renal impairment.',
  },

  // ── Endocrine / oncology ────────────────────────────────
  {
    a: ['tamoxifen'],
    b: ['paroxetine', 'fluoxetine', 'bupropion'],
    severity: 'major',
    description: 'Strong CYP2D6 inhibition blocks tamoxifen activation → reduced breast-cancer efficacy. Prefer venlafaxine/escitalopram.',
  },
  {
    a: ['levothyroxine', 'thyroxine'],
    b: ['calcium carbonate', 'ferrous', 'iron', 'sucralfate'],
    severity: 'moderate',
    description: 'Chelation reduces levothyroxine absorption — separate doses by ≥ 4 hours.',
  },

  // ── Metformin + alcohol ─────────────────────────────────
  {
    a: ['metformin'],
    b: ['alcohol', 'ethanol'],
    severity: 'moderate',
    description: 'Alcohol potentiates lactic acidosis risk with metformin, esp. binge use or hepatic disease.',
  },

  // ── Antiplatelet duplication ────────────────────────────
  {
    a: ['clopidogrel', 'ticagrelor', 'prasugrel'],
    b: ['nsaid', 'ibuprofen', 'naproxen', 'diclofenac', 'ketorolac'],
    severity: 'moderate',
    description: 'Additive GI bleeding risk; co-prescribe PPI if combination is necessary.',
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
