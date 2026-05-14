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
];

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
    if (!param.includes(range.parameter)) continue;
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

export interface DosageLimit {
  drug: string; // lowercased substring match
  maxDailyMg?: number;
  maxPerDoseMg?: number;
  /** Weight-based: max mg/kg/day */
  maxMgPerKgDay?: number;
  note: string;
}

export const DOSAGE_LIMITS: DosageLimit[] = [
  { drug: 'paracetamol', maxDailyMg: 4000, maxPerDoseMg: 1000, maxMgPerKgDay: 75, note: 'Hepatotoxicity risk above 4g/day adult / 75 mg/kg/day pediatric.' },
  { drug: 'acetaminophen', maxDailyMg: 4000, maxPerDoseMg: 1000, maxMgPerKgDay: 75, note: 'Hepatotoxicity risk above 4g/day adult.' },
  { drug: 'ibuprofen', maxDailyMg: 2400, maxPerDoseMg: 800, maxMgPerKgDay: 40, note: 'GI/renal risk; cap at 2.4g/day adult, 40 mg/kg/day pediatric.' },
  { drug: 'aspirin', maxDailyMg: 4000, note: 'Reye risk in children; antiplatelet dose 75–150 mg/day.' },
  { drug: 'metformin', maxDailyMg: 2550, note: 'Max 2.55 g/day adult; lactic acidosis risk if renal impairment.' },
  { drug: 'warfarin', maxPerDoseMg: 15, note: 'Use INR-guided dosing; rarely > 10 mg/day.' },
  { drug: 'morphine', maxPerDoseMg: 30, note: 'Respiratory depression; opioid-naive patients start ≤ 5 mg.' },
  { drug: 'tramadol', maxDailyMg: 400, note: 'Seizure risk above 400 mg/day.' },
  { drug: 'amoxicillin', maxDailyMg: 4000, maxMgPerKgDay: 90, note: 'High-dose for resistant infection; otherwise 1.5g/day adult.' },
  { drug: 'amitriptyline', maxDailyMg: 300, note: 'Cardiotoxicity in OD; elderly start low.' },
  { drug: 'sertraline', maxDailyMg: 200, note: 'Max 200 mg/day; titrate from 50.' },
];

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
