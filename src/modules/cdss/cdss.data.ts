/**
 * CDSS rule data — curated panic-value ranges, dosage limits, and ICD-based
 * order suggestions. Lives in code rather than DB so the rules can evolve
 * with backend deploys; once a clinical content team owns these, migrate
 * them into per-tenant Prisma tables.
 */

// ---------------------------------------------------------------
// Critical (panic) value thresholds — by parameter name (lowercased).
// Matches against LabResult.parameterName via substring.
// ---------------------------------------------------------------

export interface PanicRange {
  /** Substring match against parameterName (lowercased) */
  parameter: string;
  unit?: string;
  /** Critical if value < low OR value > high. Use null for one-sided. */
  low: number | null;
  high: number | null;
  /** Human-readable message for the alert */
  message: string;
}

export const PANIC_RANGES: PanicRange[] = [
  { parameter: 'potassium', unit: 'mmol/L', low: 2.8, high: 6.2, message: 'Critical potassium — cardiac arrhythmia risk' },
  { parameter: 'sodium', unit: 'mmol/L', low: 120, high: 160, message: 'Critical sodium — neurological risk' },
  { parameter: 'glucose', unit: 'mg/dL', low: 50, high: 500, message: 'Critical glucose — hypo/hyperglycemic emergency' },
  { parameter: 'calcium', unit: 'mg/dL', low: 6.5, high: 13.5, message: 'Critical calcium — tetany / cardiac risk' },
  { parameter: 'hemoglobin', unit: 'g/dL', low: 6.5, high: null, message: 'Critical low hemoglobin — severe anemia' },
  { parameter: 'hgb', unit: 'g/dL', low: 6.5, high: null, message: 'Critical low hemoglobin — severe anemia' },
  { parameter: 'platelet', unit: '/uL', low: 20000, high: 1000000, message: 'Critical platelet count — bleeding/clotting risk' },
  { parameter: 'wbc', unit: '/uL', low: 1500, high: 50000, message: 'Critical WBC — infection / leukemia workup' },
  { parameter: 'inr', low: null, high: 5.0, message: 'Critical INR — major bleeding risk' },
  { parameter: 'troponin', unit: 'ng/mL', low: null, high: 0.5, message: 'Critical troponin — possible MI' },
  { parameter: 'creatinine', unit: 'mg/dL', low: null, high: 5.0, message: 'Critical creatinine — AKI / CKD progression' },
  { parameter: 'bilirubin', unit: 'mg/dL', low: null, high: 15, message: 'Critical bilirubin — hepatic decompensation' },
  { parameter: 'lactate', unit: 'mmol/L', low: null, high: 4.0, message: 'Critical lactate — sepsis / shock' },
  { parameter: 'ph', low: 7.2, high: 7.6, message: 'Critical pH — acidosis / alkalosis' },
  { parameter: 'magnesium', unit: 'mg/dL', low: 1.0, high: 4.9, message: 'Critical magnesium — arrhythmia risk' },
  { parameter: 'phosphate', unit: 'mg/dL', low: 1.0, high: 8.0, message: 'Critical phosphate — refeeding / cardiac risk' },
  { parameter: 'urea', unit: 'mg/dL', low: null, high: 150, message: 'Critical urea — uremia / dialysis evaluation' },
  { parameter: 'ammonia', unit: 'µmol/L', low: null, high: 100, message: 'Critical ammonia — hepatic encephalopathy risk' },
  { parameter: 'bicarbonate', unit: 'mmol/L', low: 10, high: 40, message: 'Critical bicarbonate — severe acid-base disturbance' },
  { parameter: 'hco3', unit: 'mmol/L', low: 10, high: 40, message: 'Critical bicarbonate — severe acid-base disturbance' },
  { parameter: 'po2', unit: 'mmHg', low: 40, high: null, message: 'Critical pO2 — severe hypoxemia' },
  { parameter: 'pco2', unit: 'mmHg', low: 20, high: 70, message: 'Critical pCO2 — ventilatory failure risk' },
  { parameter: 'aptt', unit: 's', low: null, high: 100, message: 'Critical aPTT — major bleeding risk' },
  { parameter: 'fibrinogen', unit: 'mg/dL', low: 100, high: null, message: 'Critical low fibrinogen — DIC / bleeding risk' },
  { parameter: 'neutrophil', unit: '/uL', low: 500, high: null, message: 'Critical neutropenia — infection precautions' },
  { parameter: 'anc', unit: '/uL', low: 500, high: null, message: 'Critical neutropenia — infection precautions' },
  { parameter: 'lipase', unit: 'U/L', low: null, high: 1000, message: 'Critical lipase — acute pancreatitis' },
  { parameter: 'digoxin', unit: 'ng/mL', low: null, high: 2.0, message: 'Critical digoxin level — toxicity' },
  { parameter: 'lithium', unit: 'mmol/L', low: null, high: 2.0, message: 'Critical lithium level — toxicity' },
  { parameter: 'phenytoin', unit: 'µg/mL', low: null, high: 40, message: 'Critical phenytoin level — toxicity' },
];

/**
 * Short keys ("ph", "anc", "wbc") must match as whole tokens, otherwise
 * "ph" substring-matches "phosphate" and fires false pH panics.
 */
function panicKeyMatches(param: string, key: string): boolean {
  if (key.length <= 4) {
    return new RegExp(`(^|[^a-z0-9])${key}([^a-z0-9]|$)`).test(param);
  }
  return param.includes(key);
}

/**
 * Evaluate a single result. Returns the matching panic range or null.
 */
export function evaluatePanic(
  parameterName: string,
  value: string | number | null | undefined,
): PanicRange | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (Number.isNaN(num)) return null;

  const param = parameterName.toLowerCase();
  for (const range of PANIC_RANGES) {
    if (!panicKeyMatches(param, range.parameter)) continue;
    if (range.low !== null && num < range.low) return range;
    if (range.high !== null && num > range.high) return range;
  }
  return null;
}

// ---------------------------------------------------------------
// Dosage limits — by drug name substring. mg/kg/day for weight-based,
// or absolute mg/day for adult dosing. Used to flag prescriptions
// that exceed safe limits.
// ---------------------------------------------------------------

export interface AgeBandLimit {
  /** Band applies when minAgeYears <= age < maxAgeYears (null = open-ended). */
  minAgeYears: number;
  maxAgeYears: number | null;
  maxDailyMg?: number;
  maxPerDoseMg?: number;
  maxMgPerKgDay?: number;
  note?: string;
}

export interface DosageLimit {
  drug: string; // lowercased substring match
  maxDailyMg?: number;
  maxPerDoseMg?: number;
  /** Weight-based: max mg/kg/day */
  maxMgPerKgDay?: number;
  /** Drug should not be prescribed below this age at all (hard warning). */
  minAgeYearsAllowed?: number;
  /** Age-specific caps; the first matching band overrides the adult defaults. */
  ageBands?: AgeBandLimit[];
  note: string;
}

export const DOSAGE_LIMITS: DosageLimit[] = [
  {
    drug: 'paracetamol', maxDailyMg: 4000, maxPerDoseMg: 1000, maxMgPerKgDay: 75,
    ageBands: [
      { minAgeYears: 0, maxAgeYears: 12, maxMgPerKgDay: 60, maxPerDoseMg: 500, note: 'Pediatric: 15 mg/kg/dose, max 60 mg/kg/day.' },
      { minAgeYears: 65, maxAgeYears: null, maxDailyMg: 3000, note: 'Elderly / low body weight: cap at 3 g/day.' },
    ],
    note: 'Hepatotoxicity risk above 4g/day adult / 75 mg/kg/day pediatric.',
  },
  {
    drug: 'acetaminophen', maxDailyMg: 4000, maxPerDoseMg: 1000, maxMgPerKgDay: 75,
    ageBands: [
      { minAgeYears: 0, maxAgeYears: 12, maxMgPerKgDay: 60, maxPerDoseMg: 500 },
      { minAgeYears: 65, maxAgeYears: null, maxDailyMg: 3000, note: 'Elderly: cap at 3 g/day.' },
    ],
    note: 'Hepatotoxicity risk above 4g/day adult.',
  },
  {
    drug: 'ibuprofen', maxDailyMg: 2400, maxPerDoseMg: 800, maxMgPerKgDay: 40,
    ageBands: [
      { minAgeYears: 0, maxAgeYears: 12, maxMgPerKgDay: 30, maxPerDoseMg: 400, note: 'Pediatric: 10 mg/kg/dose q6-8h, max 30 mg/kg/day.' },
    ],
    note: 'GI/renal risk; cap at 2.4g/day adult, 40 mg/kg/day pediatric.',
  },
  { drug: 'aspirin', maxDailyMg: 4000, minAgeYearsAllowed: 16, note: 'Reye syndrome risk under 16y; antiplatelet dose 75–150 mg/day.' },
  { drug: 'diclofenac', maxDailyMg: 150, maxPerDoseMg: 75, maxMgPerKgDay: 3, note: 'GI/CV risk; max 150 mg/day adult, 3 mg/kg/day pediatric.' },
  { drug: 'naproxen', maxDailyMg: 1000, maxPerDoseMg: 500, note: 'Max 1 g/day maintenance; GI/renal risk.' },
  { drug: 'metformin', maxDailyMg: 2550, maxPerDoseMg: 1000, note: 'Max 2.55 g/day adult; lactic acidosis risk if renal impairment.' },
  { drug: 'glimepiride', maxDailyMg: 8, note: 'Max 8 mg/day; hypoglycemia risk in elderly/renal impairment.' },
  { drug: 'warfarin', maxPerDoseMg: 15, note: 'Use INR-guided dosing; rarely > 10 mg/day.' },
  {
    drug: 'morphine', maxPerDoseMg: 30,
    ageBands: [{ minAgeYears: 65, maxAgeYears: null, maxPerDoseMg: 15, note: 'Elderly: start at half adult dose.' }],
    note: 'Respiratory depression; opioid-naive patients start ≤ 5 mg.',
  },
  {
    drug: 'tramadol', maxDailyMg: 400, minAgeYearsAllowed: 12,
    ageBands: [{ minAgeYears: 75, maxAgeYears: null, maxDailyMg: 300, note: 'Over 75y: cap at 300 mg/day.' }],
    note: 'Seizure risk above 400 mg/day; contraindicated under 12y.',
  },
  { drug: 'codeine', maxDailyMg: 240, minAgeYearsAllowed: 12, note: 'Respiratory depression in ultra-rapid CYP2D6 metabolizers; contraindicated under 12y.' },
  { drug: 'amoxicillin', maxDailyMg: 4000, maxMgPerKgDay: 90, note: 'High-dose for resistant infection; otherwise 1.5g/day adult.' },
  { drug: 'azithromycin', maxDailyMg: 500, maxMgPerKgDay: 12, note: 'Typical 500 mg OD; QT prolongation risk.' },
  { drug: 'ciprofloxacin', maxDailyMg: 1500, maxPerDoseMg: 750, minAgeYearsAllowed: 18, note: 'Fluoroquinolone — tendinopathy; avoid in children unless no alternative.' },
  { drug: 'levofloxacin', maxDailyMg: 750, minAgeYearsAllowed: 18, note: 'Fluoroquinolone — QT + tendinopathy risk.' },
  { drug: 'ceftriaxone', maxDailyMg: 4000, maxMgPerKgDay: 100, note: 'Max 4 g/day adult, 100 mg/kg/day pediatric.' },
  { drug: 'cefixime', maxDailyMg: 400, maxMgPerKgDay: 8, note: 'Max 400 mg/day adult, 8 mg/kg/day pediatric.' },
  {
    drug: 'ondansetron', maxDailyMg: 24, maxPerDoseMg: 8,
    note: 'QT prolongation above 16 mg single IV dose; max 24 mg/day oral.',
  },
  { drug: 'domperidone', maxDailyMg: 30, note: 'QT risk; max 10 mg TDS, lowest effective dose.' },
  { drug: 'metoclopramide', maxDailyMg: 30, maxMgPerKgDay: 0.5, note: 'Extrapyramidal risk, esp. children; max 0.5 mg/kg/day.' },
  { drug: 'pantoprazole', maxDailyMg: 80, note: 'Max 80 mg/day; review long-term use.' },
  { drug: 'omeprazole', maxDailyMg: 80, note: 'Max 80 mg/day; CYP2C19 interactions (clopidogrel).' },
  { drug: 'amlodipine', maxDailyMg: 10, note: 'Max 10 mg/day; pedal edema dose-related.' },
  { drug: 'atenolol', maxDailyMg: 100, note: 'Max 100 mg/day; renally cleared — reduce in CKD.' },
  { drug: 'metoprolol', maxDailyMg: 400, note: 'Max 400 mg/day immediate-release.' },
  { drug: 'atorvastatin', maxDailyMg: 80, note: 'Max 80 mg/day; myopathy risk with CYP3A4 inhibitors.' },
  { drug: 'rosuvastatin', maxDailyMg: 40, note: 'Max 40 mg/day; start 5 mg in Asian patients.' },
  { drug: 'gabapentin', maxDailyMg: 3600, note: 'Max 3.6 g/day; reduce in renal impairment.' },
  { drug: 'pregabalin', maxDailyMg: 600, note: 'Max 600 mg/day; sedation, dependence potential.' },
  {
    drug: 'cetirizine', maxDailyMg: 10,
    ageBands: [{ minAgeYears: 2, maxAgeYears: 6, maxDailyMg: 5, note: '2–6y: max 5 mg/day.' }],
    note: 'Max 10 mg/day adult.',
  },
  {
    drug: 'amitriptyline', maxDailyMg: 300,
    ageBands: [{ minAgeYears: 65, maxAgeYears: null, maxDailyMg: 75, note: 'Elderly: anticholinergic burden — keep ≤ 75 mg/day.' }],
    note: 'Cardiotoxicity in OD; elderly start low.',
  },
  { drug: 'sertraline', maxDailyMg: 200, note: 'Max 200 mg/day; titrate from 50.' },
  {
    drug: 'diazepam', maxDailyMg: 40, maxPerDoseMg: 10,
    ageBands: [{ minAgeYears: 65, maxAgeYears: null, maxDailyMg: 10, maxPerDoseMg: 5, note: 'Elderly: falls/sedation — halve doses.' }],
    note: 'Sedation, dependence; avoid with opioids.',
  },
  {
    drug: 'digoxin', maxDailyMg: 0.25,
    ageBands: [{ minAgeYears: 65, maxAgeYears: null, maxDailyMg: 0.125, note: 'Elderly: 0.125 mg/day; narrow therapeutic index.' }],
    note: 'Narrow therapeutic index; monitor levels + potassium.',
  },
  { drug: 'albendazole', maxDailyMg: 400, note: 'Single 400 mg dose for routine deworming.' },
];

/**
 * Resolve the effective caps for a patient's age. Age bands override the
 * adult defaults field-by-field; null age returns the defaults unchanged.
 */
export function resolveDosageLimit(
  limit: DosageLimit,
  ageYears: number | null,
): Pick<DosageLimit, 'maxDailyMg' | 'maxPerDoseMg' | 'maxMgPerKgDay'> & { note: string } {
  const base = {
    maxDailyMg: limit.maxDailyMg,
    maxPerDoseMg: limit.maxPerDoseMg,
    maxMgPerKgDay: limit.maxMgPerKgDay,
    note: limit.note,
  };
  if (ageYears === null || !limit.ageBands) return base;
  const band = limit.ageBands.find(
    (b) => ageYears >= b.minAgeYears && (b.maxAgeYears === null || ageYears < b.maxAgeYears),
  );
  if (!band) return base;
  return {
    maxDailyMg: band.maxDailyMg ?? base.maxDailyMg,
    maxPerDoseMg: band.maxPerDoseMg ?? base.maxPerDoseMg,
    maxMgPerKgDay: band.maxMgPerKgDay ?? base.maxMgPerKgDay,
    note: band.note ? `${base.note} ${band.note}` : base.note,
  };
}

/**
 * Extract milligrams from a free-text dosage string.
 * "500 mg", "1g", "1 g BD" → returns mg as number, or null.
 */
export function parseDoseMg(dosage: string): number | null {
  if (!dosage) return null;
  const m = dosage.match(/(\d+(?:\.\d+)?)\s*(mg|g|mcg|µg)/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === 'mg') return value;
  if (unit === 'g') return value * 1000;
  if (unit === 'mcg' || unit === 'µg') return value / 1000;
  return null;
}

/**
 * Parse a frequency string into doses-per-day. Conservative defaults.
 */
export function parseFrequencyToDosesPerDay(frequency: string): number {
  if (!frequency) return 1;
  const f = frequency.toLowerCase();
  if (/\bonce|\bod\b|\bqd\b|\bdaily\b|\bhs\b/.test(f)) return 1;
  if (/\btwice|\bbd\b|\bbid\b|\bb\.i\.d\b/.test(f)) return 2;
  if (/\bthrice|\btds\b|\btid\b|\bt\.i\.d\b/.test(f)) return 3;
  if (/\bqid\b|\bqds\b|\bq6h\b|four times/.test(f)) return 4;
  if (/\bq8h\b/.test(f)) return 3;
  if (/\bq4h\b/.test(f)) return 6;
  if (/\bq12h\b/.test(f)) return 2;
  // Try numeric
  const m = f.match(/(\d+)\s*times|x\s*(\d+)/);
  if (m) return Number(m[1] ?? m[2]);
  return 1;
}

export function findDosageLimit(drugName: string): DosageLimit | null {
  const name = drugName.toLowerCase();
  return DOSAGE_LIMITS.find((d) => name.includes(d.drug)) ?? null;
}

// ---------------------------------------------------------------
// ICD-10 (-ish) → standard order suggestions. Substring-matches the
// ICD code OR the diagnosis name. Returns a set of recommended labs
// and imaging.
// ---------------------------------------------------------------

export interface OrderSuggestion {
  /** Matches against ICD code (prefix) OR diagnosis name (substring) */
  matchIcd?: string[];
  matchDiagnosis?: string[];
  labs: string[];
  imaging: string[];
  note: string;
}

export const ORDER_SUGGESTIONS: OrderSuggestion[] = [
  {
    matchIcd: ['I21', 'I22', 'I25'],
    matchDiagnosis: ['myocardial infarction', 'mi', 'acute coronary'],
    labs: ['Troponin', 'CK-MB', 'CBC', 'Lipid Profile', 'BNP', 'Creatinine', 'Potassium'],
    imaging: ['ECG (12-lead)', 'Chest X-ray', 'Echocardiogram'],
    note: 'ACS workup — serial troponins, ECG monitoring',
  },
  {
    matchIcd: ['E10', 'E11', 'E13'],
    matchDiagnosis: ['diabetes', 'dm'],
    labs: ['HbA1c', 'Fasting Glucose', 'Lipid Profile', 'Creatinine', 'Microalbumin', 'Liver Function'],
    imaging: [],
    note: 'Diabetes baseline + complication screen',
  },
  {
    matchIcd: ['J18', 'J15', 'J12', 'J14'],
    matchDiagnosis: ['pneumonia', 'pneumon'],
    labs: ['CBC', 'CRP', 'Procalcitonin', 'Blood Culture', 'Sputum Culture', 'Electrolytes'],
    imaging: ['Chest X-ray', 'Chest CT (if severe)'],
    note: 'Pneumonia workup — severity per CURB-65',
  },
  {
    matchIcd: ['I63', 'I64', 'G45'],
    matchDiagnosis: ['stroke', 'cerebrovascular'],
    labs: ['CBC', 'INR/PT', 'Glucose', 'Lipid Profile', 'HbA1c'],
    imaging: ['CT Head (non-contrast)', 'MRI Brain', 'Carotid Doppler'],
    note: 'Stroke imaging within 4.5 hr if thrombolysis candidate',
  },
  {
    matchIcd: ['A41', 'R65'],
    matchDiagnosis: ['sepsis', 'septic shock'],
    labs: ['CBC', 'Procalcitonin', 'Lactate', 'Blood Culture x2', 'Liver Function', 'Creatinine', 'Coagulation'],
    imaging: ['Chest X-ray'],
    note: 'Sepsis bundle — within 1 hour',
  },
  {
    matchIcd: ['N17', 'N18', 'N19'],
    matchDiagnosis: ['acute kidney', 'aki', 'ckd', 'renal failure'],
    labs: ['Creatinine', 'Urea', 'Electrolytes', 'Urinalysis', 'CBC', 'eGFR'],
    imaging: ['Renal Ultrasound'],
    note: 'Renal failure workup',
  },
  {
    matchIcd: ['K70', 'K71', 'K72', 'K73', 'K74', 'K75'],
    matchDiagnosis: ['hepatitis', 'cirrhosis', 'liver failure'],
    labs: ['Liver Function', 'INR/PT', 'Hepatitis B/C Serology', 'Ammonia', 'Albumin'],
    imaging: ['Liver Ultrasound', 'Liver CT (if mass)'],
    note: 'Hepatic decompensation screen',
  },
  {
    matchIcd: ['O80', 'O81', 'O82', 'O83'],
    matchDiagnosis: ['delivery', 'labour', 'labor'],
    labs: ['CBC', 'Coagulation', 'Blood Group + Cross-match'],
    imaging: ['Obstetric Ultrasound'],
    note: 'Pre-delivery workup',
  },
  {
    matchIcd: ['J45', 'J46'],
    matchDiagnosis: ['asthma'],
    labs: ['ABG (if severe)', 'CBC'],
    imaging: ['Chest X-ray'],
    note: 'Asthma exacerbation — peak flow + ABG if needed',
  },
  {
    matchIcd: ['I10', 'I11', 'I12', 'I13', 'I15'],
    matchDiagnosis: ['hypertension', 'htn'],
    labs: ['Electrolytes', 'Creatinine', 'Lipid Profile', 'Urinalysis', 'HbA1c'],
    imaging: ['ECG'],
    note: 'New HTN — end-organ damage screen',
  },
];

export function getOrderSuggestions(
  icdCode: string | null | undefined,
  diagnosisName: string | null | undefined,
): OrderSuggestion[] {
  const matches: OrderSuggestion[] = [];
  const icd = icdCode?.toUpperCase() ?? '';
  const name = diagnosisName?.toLowerCase() ?? '';
  for (const s of ORDER_SUGGESTIONS) {
    let hit = false;
    if (s.matchIcd && icd) {
      hit = s.matchIcd.some((code) => icd.startsWith(code));
    }
    if (!hit && s.matchDiagnosis && name) {
      hit = s.matchDiagnosis.some((kw) => name.includes(kw));
    }
    if (hit) matches.push(s);
  }
  return matches;
}
