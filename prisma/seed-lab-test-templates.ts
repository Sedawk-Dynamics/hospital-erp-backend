import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  parametersArraySchema,
  type ParameterSpec,
} from '../src/modules/lab/lab.validation';
import {
  buildSearchTokens,
  normaliseAliases,
  normaliseTags,
} from '../src/modules/lab/lab-templates.service';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────
// Platform-wide lab test templates. Owned by the super_admin
// (admin@hospital.com on the __platform__ tenant) and cloned by
// hospital admins into their own LabTestCatalog with one click
// (POST /lab/templates/clone-all) — same model as the patient
// form templates in seed-form-templates.ts.
//
// Each template carries the *full* report layout: the structured
// parameter list (name, unit, reference range, group, decimals),
// optional clinical interpretation, instructions and specimen.
// When a tenant clones, the catalog snapshots the parameters array
// so later super-admin edits never silently mutate the hospital's
// existing report sheets.
//
// Idempotent: matched by `name`; existing templates get their
// schema re-applied so re-running picks up edits made here.
// ─────────────────────────────────────────────────────────────

// Counter resets per-template so each test gets stable p_1, p_2, ... IDs.
let paramCounter = 0;
function pid(): string {
  paramCounter += 1;
  return `p_${paramCounter}`;
}

// Builders – mirror the seed-form-templates style. Most lab parameters are
// numeric with low/high ref ranges; categorical params (Negative/Positive,
// Group A/B/AB/O) use `categorical` and ship an options list.

type NumOpts = {
  refLow?: number;
  refHigh?: number;
  refRangeText?: string;
  decimals?: number;
  unit?: string;
  unitGroupCode?: string;
  group?: string;
  code?: string;
  notes?: string;
};
// Map common units → their seeded unit-group code so the seeded templates
// pre-fill unitGroupCode without having to spell it out on every parameter.
const UNIT_TO_GROUP: Record<string, string> = {
  'mg/dL': 'concentration_mass',
  'g/dL': 'concentration_mass',
  'µg/dL': 'concentration_mass',
  'ng/dL': 'concentration_mass',
  'mg/L': 'concentration_mass',
  'g/L': 'concentration_mass',
  'µg/L': 'concentration_mass',
  'ng/mL': 'concentration_mass',
  'pg/mL': 'concentration_mass',
  'mg%': 'concentration_mass',
  'mmol/L': 'concentration_molar',
  'µmol/L': 'concentration_molar',
  'nmol/L': 'concentration_molar',
  'pmol/L': 'concentration_molar',
  'mEq/L': 'concentration_molar',
  '10^3/µL': 'hematology_counts',
  '10^6/µL': 'hematology_counts',
  '10^9/L': 'hematology_counts',
  '10^12/L': 'hematology_counts',
  'cells/µL': 'hematology_counts',
  'cells/HPF': 'hematology_counts',
  'cells/LPF': 'hematology_counts',
  '/cumm': 'hematology_counts',
  'fL': 'rbc_indices',
  'pg': 'rbc_indices',
  '%': 'percentages_ratios',
  'ratio': 'percentages_ratios',
  'index': 'percentages_ratios',
  'U/L': 'enzymes_activity',
  'IU/L': 'enzymes_activity',
  'IU/mL': 'enzymes_activity',
  'mIU/L': 'enzymes_activity',
  'µIU/mL': 'enzymes_activity',
  'kU/L': 'enzymes_activity',
  'seconds': 'coagulation_rates',
  'mm/hr': 'coagulation_rates',
  'ng/mL FEU': 'coagulation_rates',
  'µg/mL FEU': 'coagulation_rates',
  'mL/min': 'renal_egfr',
  'mL/min/1.73m²': 'renal_egfr',
  'SG': 'sg_ph',
  'pH': 'sg_ph',
  'mmHg': 'pressure_gas',
  'kPa': 'pressure_gas',
  'mL': 'volume',
  'L': 'volume',
  'mL/24h': 'volume',
  'titre': 'titres_serology',
  'COI': 'titres_serology',
  'S/CO': 'titres_serology',
  'AU/mL': 'titres_serology',
};
function num(name: string, opts: NumOpts = {}): ParameterSpec {
  const unitGroupCode = opts.unitGroupCode ?? (opts.unit ? UNIT_TO_GROUP[opts.unit] : null) ?? null;
  return {
    id: pid(),
    name,
    code: opts.code ?? null,
    unit: opts.unit ?? null,
    unitGroupCode,
    refLow: opts.refLow ?? null,
    refHigh: opts.refHigh ?? null,
    refRangeText: opts.refRangeText ?? null,
    decimals: opts.decimals ?? 2,
    group: opts.group ?? null,
    inputType: 'number',
    options: null,
    notes: opts.notes ?? null,
  };
}

type TextOpts = { refRangeText?: string; group?: string; code?: string; notes?: string };
function text(name: string, opts: TextOpts = {}): ParameterSpec {
  return {
    id: pid(),
    name,
    code: opts.code ?? null,
    unit: null,
    unitGroupCode: null,
    refLow: null,
    refHigh: null,
    refRangeText: opts.refRangeText ?? null,
    decimals: null,
    group: opts.group ?? null,
    inputType: 'text',
    options: null,
    notes: opts.notes ?? null,
  };
}

type SelOpts = { refRangeText?: string; group?: string; code?: string; notes?: string };
function sel(
  name: string,
  options: { value: string; label: string }[],
  opts: SelOpts = {},
): ParameterSpec {
  return {
    id: pid(),
    name,
    code: opts.code ?? null,
    unit: null,
    unitGroupCode: null,
    refLow: null,
    refHigh: null,
    refRangeText: opts.refRangeText ?? null,
    decimals: null,
    group: opts.group ?? null,
    inputType: 'select',
    options,
    notes: opts.notes ?? null,
  };
}

const opt = (value: string, label?: string) => ({ value, label: label ?? value });

// Common reaction option set (used by serology / antigen tests).
const REACTIVE_OPTS = [opt('non_reactive', 'Non-reactive'), opt('reactive', 'Reactive'), opt('equivocal', 'Equivocal')];
const POSITIVE_OPTS = [opt('negative', 'Negative'), opt('positive', 'Positive')];

type TemplateSeed = {
  name: string;
  code: string;
  departmentName: string;
  sampleType: string;
  specimen?: string;
  defaultPrice: number;
  turnaroundHours: number;
  instructions?: string;
  description?: string;
  interpretation?: string;
  // Synonyms for the dynamic-search layer — e.g. CBC also matches "FBC" /
  // "Hemogram" / "Full Blood Count". Hospital admins can extend these on
  // their cloned catalog row without touching the master template.
  aliases?: string[];
  // Loose keywords (parameter names, anatomy, indication) that surface the
  // test in dynamic search — e.g. searching "hemoglobin" surfaces CBC.
  tags?: string[];
  parameters: () => ParameterSpec[];
};

const TEMPLATES: TemplateSeed[] = [
  // ─────────────────────────────────────────────────────────────
  // Hematology
  // ─────────────────────────────────────────────────────────────
  {
    name: 'Complete Blood Count (CBC)',
    code: 'CBC',
    departmentName: 'Hematology',
    sampleType: 'Blood',
    specimen: '3 mL EDTA whole blood (purple top)',
    defaultPrice: 350,
    turnaroundHours: 4,
    aliases: ['FBC', 'Full Blood Count', 'Hemogram', 'Haemogram', 'CBC with Differential', 'CBP', 'Complete Blood Picture'],
    tags: ['hemoglobin', 'hgb', 'wbc', 'rbc', 'platelet', 'mcv', 'mch', 'mchc', 'hematocrit', 'pcv', 'differential', 'anemia', 'infection', 'leukocyte'],
    description:
      'Full automated blood count — RBC indices, total + differential WBC count, platelet indices. Screens for anemia, infection, leukemia, marrow disorders and thrombocyte abnormalities.',
    interpretation:
      'Microcytic hypochromic picture suggests iron-deficiency anaemia (correlate with iron studies). Neutrophilia with band forms favours bacterial infection. Lymphocytosis suggests viral aetiology. Thrombocytopenia with petechiae warrants urgent review.',
    parameters: () => [
      // RBC indices
      num('Hemoglobin', { code: 'HGB', unit: 'g/dL', refLow: 13, refHigh: 17, group: 'RBC Indices', decimals: 1, notes: 'Male 13.0-17.0, Female 12.0-15.5' }),
      num('Hematocrit / PCV', { code: 'HCT', unit: '%', refLow: 40, refHigh: 50, group: 'RBC Indices', decimals: 1 }),
      num('RBC Count', { code: 'RBC', unit: '10^6/µL', refLow: 4.5, refHigh: 5.9, group: 'RBC Indices', decimals: 2 }),
      num('MCV', { code: 'MCV', unit: 'fL', refLow: 80, refHigh: 100, group: 'RBC Indices', decimals: 1 }),
      num('MCH', { code: 'MCH', unit: 'pg', refLow: 27, refHigh: 33, group: 'RBC Indices', decimals: 1 }),
      num('MCHC', { code: 'MCHC', unit: 'g/dL', refLow: 32, refHigh: 36, group: 'RBC Indices', decimals: 1 }),
      num('RDW-CV', { code: 'RDW', unit: '%', refLow: 11.5, refHigh: 14.5, group: 'RBC Indices', decimals: 1 }),

      // WBC + differential
      num('WBC / Total Leucocyte Count', { code: 'WBC', unit: '10^3/µL', refLow: 4, refHigh: 11, group: 'WBC', decimals: 2 }),
      num('Neutrophils', { unit: '%', refLow: 40, refHigh: 75, group: 'WBC Differential (%)', decimals: 0 }),
      num('Lymphocytes', { unit: '%', refLow: 20, refHigh: 45, group: 'WBC Differential (%)', decimals: 0 }),
      num('Monocytes', { unit: '%', refLow: 2, refHigh: 10, group: 'WBC Differential (%)', decimals: 0 }),
      num('Eosinophils', { unit: '%', refLow: 1, refHigh: 6, group: 'WBC Differential (%)', decimals: 0 }),
      num('Basophils', { unit: '%', refLow: 0, refHigh: 2, group: 'WBC Differential (%)', decimals: 0 }),

      // Absolute counts
      num('Neutrophils (absolute)', { unit: '10^3/µL', refLow: 2, refHigh: 7, group: 'WBC Absolute Counts', decimals: 2 }),
      num('Lymphocytes (absolute)', { unit: '10^3/µL', refLow: 1, refHigh: 3, group: 'WBC Absolute Counts', decimals: 2 }),
      num('Monocytes (absolute)', { unit: '10^3/µL', refLow: 0.2, refHigh: 0.8, group: 'WBC Absolute Counts', decimals: 2 }),
      num('Eosinophils (absolute)', { unit: '10^3/µL', refLow: 0.04, refHigh: 0.4, group: 'WBC Absolute Counts', decimals: 2 }),
      num('Basophils (absolute)', { unit: '10^3/µL', refLow: 0.01, refHigh: 0.1, group: 'WBC Absolute Counts', decimals: 2 }),

      // Platelets
      num('Platelet Count', { code: 'PLT', unit: '10^3/µL', refLow: 150, refHigh: 410, group: 'Platelets', decimals: 0 }),
      num('MPV', { code: 'MPV', unit: 'fL', refLow: 7.5, refHigh: 11.5, group: 'Platelets', decimals: 1 }),
      num('PDW', { unit: '%', refLow: 9, refHigh: 17, group: 'Platelets', decimals: 1 }),
      num('PCT', { unit: '%', refLow: 0.17, refHigh: 0.35, group: 'Platelets', decimals: 2 }),

      // Smear (descriptive)
      text('Peripheral Smear Comment', { group: 'Peripheral Smear', refRangeText: 'Normocytic normochromic, adequate platelets, no atypical cells' }),
    ],
  },

  {
    name: 'Erythrocyte Sedimentation Rate (ESR)',
    code: 'ESR',
    departmentName: 'Hematology',
    sampleType: 'Blood',
    specimen: '2 mL EDTA whole blood',
    defaultPrice: 100,
    turnaroundHours: 3,
    aliases: ['Sed Rate', 'Westergren ESR', 'BSR', 'Blood Sedimentation Rate'],
    tags: ['inflammation', 'sedimentation', 'westergren', 'rate'],
    description: 'Non-specific marker of inflammation (Westergren method).',
    parameters: () => [
      num('ESR (1 hour)', { unit: 'mm/hr', refLow: 0, refHigh: 20, decimals: 0, notes: 'Male 0-15, Female 0-20' }),
    ],
  },

  {
    name: 'Peripheral Blood Smear',
    code: 'PBS',
    departmentName: 'Hematology',
    sampleType: 'Blood',
    specimen: '2 mL EDTA whole blood',
    defaultPrice: 200,
    turnaroundHours: 6,
    aliases: ['Peripheral Smear', 'PS', 'Blood Film', 'PBF', 'Peripheral Blood Film'],
    tags: ['morphology', 'smear', 'microscopy', 'film', 'rbc morphology'],
    description: 'Microscopic examination of stained blood smear.',
    parameters: () => [
      text('RBC Morphology', { group: 'Morphology', refRangeText: 'Normocytic, normochromic' }),
      text('WBC Morphology', { group: 'Morphology', refRangeText: 'Mature WBCs, no immature forms' }),
      text('Platelet Morphology', { group: 'Morphology', refRangeText: 'Adequate, normal morphology' }),
      text('Parasites', { group: 'Morphology', refRangeText: 'No haemoparasites seen' }),
      text('Impression', { group: 'Impression' }),
    ],
  },

  {
    name: 'Prothrombin Time with INR',
    code: 'PT-INR',
    departmentName: 'Hematology',
    sampleType: 'Blood',
    specimen: '2.7 mL sodium citrate (blue top), 9:1 ratio',
    defaultPrice: 350,
    turnaroundHours: 4,
    aliases: ['PT', 'PT/INR', 'Prothrombin Time', 'INR', 'Warfarin Monitoring'],
    tags: ['coagulation', 'pt', 'inr', 'warfarin', 'bleeding', 'clotting'],
    description: 'Extrinsic + common pathway screen; used to monitor warfarin therapy.',
    parameters: () => [
      num('PT (Test)', { unit: 'seconds', refLow: 11, refHigh: 13.5, decimals: 1, group: 'PT' }),
      num('PT (Control)', { unit: 'seconds', refLow: 11, refHigh: 13.5, decimals: 1, group: 'PT' }),
      num('INR', { refLow: 0.8, refHigh: 1.1, decimals: 2, group: 'PT', notes: 'Therapeutic target on warfarin 2.0-3.0 (most indications)' }),
    ],
  },

  {
    name: 'Activated Partial Thromboplastin Time (APTT)',
    code: 'APTT',
    departmentName: 'Hematology',
    sampleType: 'Blood',
    specimen: '2.7 mL sodium citrate (blue top)',
    defaultPrice: 350,
    turnaroundHours: 4,
    aliases: ['aPTT', 'PTT', 'Partial Thromboplastin Time', 'Heparin Monitoring'],
    tags: ['coagulation', 'aptt', 'ptt', 'heparin', 'clotting'],
    description: 'Intrinsic + common pathway screen; monitors heparin therapy.',
    parameters: () => [
      num('APTT (Test)', { unit: 'seconds', refLow: 25, refHigh: 35, decimals: 1 }),
      num('APTT (Control)', { unit: 'seconds', refLow: 25, refHigh: 35, decimals: 1 }),
      num('Ratio', { refLow: 0.8, refHigh: 1.2, decimals: 2 }),
    ],
  },

  {
    name: 'D-Dimer',
    code: 'DDIMER',
    departmentName: 'Hematology',
    sampleType: 'Blood',
    specimen: '2.7 mL sodium citrate',
    defaultPrice: 950,
    turnaroundHours: 4,
    aliases: ['D Dimer', 'DD', 'Fibrin D-Dimer'],
    tags: ['vte', 'dvt', 'pe', 'thrombosis', 'fibrin', 'embolism'],
    description: 'Fibrin degradation product — sensitive for venous thromboembolism rule-out.',
    parameters: () => [
      num('D-Dimer', { unit: 'ng/mL FEU', refLow: 0, refHigh: 500, decimals: 0, notes: 'Age-adjusted cutoff for >50y: age × 10 ng/mL' }),
    ],
  },

  {
    name: 'Blood Grouping & Rh Typing',
    code: 'BG-RH',
    departmentName: 'Hematology',
    sampleType: 'Blood',
    specimen: '2 mL EDTA whole blood',
    defaultPrice: 150,
    turnaroundHours: 2,
    aliases: ['Blood Group', 'ABO Group', 'ABO Rh', 'BG', 'Blood Type', 'Rh Typing'],
    tags: ['blood group', 'abo', 'rh', 'rhesus', 'typing', 'transfusion'],
    description: 'ABO and Rhesus blood group determination.',
    parameters: () => [
      sel('ABO Group', [opt('A'), opt('B'), opt('AB'), opt('O')], { group: 'Blood Group' }),
      sel('Rh Typing', [opt('positive', 'Rh Positive (+)'), opt('negative', 'Rh Negative (−)')], { group: 'Blood Group' }),
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Biochemistry
  // ─────────────────────────────────────────────────────────────
  {
    name: 'Fasting Blood Sugar (FBS)',
    code: 'FBS',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '2 mL fluoride (grey top)',
    defaultPrice: 120,
    turnaroundHours: 2,
    aliases: ['Fasting Glucose', 'FBG', 'Fasting Sugar', 'Fasting Plasma Glucose', 'FPG'],
    tags: ['glucose', 'sugar', 'diabetes', 'fasting', 'fbs'],
    instructions: 'Patient must fast for 8-12 hours. Water permitted.',
    parameters: () => [
      num('Glucose (Fasting)', { unit: 'mg/dL', refLow: 70, refHigh: 100, decimals: 0, notes: '100-125 = impaired fasting glucose, ≥126 = diabetes' }),
    ],
  },

  {
    name: 'Postprandial Blood Sugar (PPBS)',
    code: 'PPBS',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '2 mL fluoride (grey top)',
    defaultPrice: 150,
    turnaroundHours: 2,
    aliases: ['PP Glucose', 'PPG', '2-Hour Glucose', 'PP Sugar', 'Postprandial Glucose'],
    tags: ['glucose', 'sugar', 'diabetes', 'postprandial', 'ppbs', 'ogtt'],
    instructions: 'Sample to be collected exactly 2 hours after a standard meal.',
    parameters: () => [
      num('Glucose (Postprandial)', { unit: 'mg/dL', refLow: 70, refHigh: 140, decimals: 0, notes: '140-199 = impaired tolerance, ≥200 = diabetes' }),
    ],
  },

  {
    name: 'Random Blood Sugar (RBS)',
    code: 'RBS',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '2 mL fluoride (grey top)',
    defaultPrice: 100,
    turnaroundHours: 2,
    aliases: ['Random Glucose', 'RBG', 'Random Sugar'],
    tags: ['glucose', 'sugar', 'diabetes', 'random', 'rbs'],
    parameters: () => [
      num('Glucose (Random)', { unit: 'mg/dL', refLow: 70, refHigh: 140, decimals: 0 }),
    ],
  },

  {
    name: 'Glycated Hemoglobin (HbA1c)',
    code: 'HBA1C',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '2 mL EDTA whole blood',
    defaultPrice: 550,
    turnaroundHours: 6,
    aliases: ['HbA1c', 'A1c', 'Glycohemoglobin', 'Glycated Hb', 'Hemoglobin A1c', 'GHb', 'HbA1C'],
    tags: ['diabetes', 'hba1c', 'a1c', 'glycemic control', 'sugar control', 'three month'],
    description: 'Reflects average glycaemic control over ~3 months.',
    interpretation:
      '<5.7% Normal | 5.7-6.4% Prediabetes | ≥6.5% Diabetes | <7% Target on therapy for most adults.',
    parameters: () => [
      num('HbA1c', { unit: '%', refLow: 4, refHigh: 5.6, decimals: 1 }),
      num('Estimated Average Glucose (eAG)', { unit: 'mg/dL', refLow: 70, refHigh: 126, decimals: 0, notes: 'Calculated from HbA1c (eAG = 28.7×A1c − 46.7)' }),
    ],
  },

  {
    name: 'Lipid Profile',
    code: 'LIPID',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '3 mL serum (gold/red top)',
    defaultPrice: 700,
    turnaroundHours: 6,
    aliases: ['Lipid Panel', 'Cholesterol Panel', 'Cholesterol Profile', 'Fasting Lipid Profile', 'FLP'],
    tags: ['cholesterol', 'hdl', 'ldl', 'triglycerides', 'vldl', 'lipid', 'cardiac risk', 'cvd'],
    instructions: '9-12 hour fast required (water only). Hold lipid-lowering drugs only if specifically advised.',
    description: 'Cardiovascular risk stratification: TC, HDL, LDL, VLDL, TG and computed ratios.',
    interpretation:
      'LDL targets vary by 10-year ASCVD risk (commonly <100 mg/dL primary prevention, <70 mg/dL secondary). Non-HDL = TC − HDL is a better risk marker than LDL alone when TG is high.',
    parameters: () => [
      num('Total Cholesterol', { unit: 'mg/dL', refLow: 100, refHigh: 200, decimals: 0 }),
      num('HDL Cholesterol', { unit: 'mg/dL', refLow: 40, refHigh: 60, decimals: 0, notes: 'Male >40, Female >50' }),
      num('LDL Cholesterol', { unit: 'mg/dL', refLow: 0, refHigh: 100, decimals: 0 }),
      num('VLDL Cholesterol', { unit: 'mg/dL', refLow: 5, refHigh: 40, decimals: 0 }),
      num('Triglycerides', { unit: 'mg/dL', refLow: 0, refHigh: 150, decimals: 0 }),
      num('Non-HDL Cholesterol', { unit: 'mg/dL', refLow: 0, refHigh: 130, decimals: 0 }),
      num('Total Cholesterol / HDL Ratio', { refLow: 0, refHigh: 5, decimals: 2 }),
      num('LDL / HDL Ratio', { refLow: 0, refHigh: 3, decimals: 2 }),
    ],
  },

  {
    name: 'Liver Function Test (LFT)',
    code: 'LFT',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '3 mL serum',
    defaultPrice: 650,
    turnaroundHours: 6,
    aliases: ['Liver Profile', 'LFTs', 'Liver Panel', 'Hepatic Panel', 'Hepatic Function Panel'],
    tags: ['liver', 'bilirubin', 'sgot', 'sgpt', 'ast', 'alt', 'alp', 'ggt', 'albumin', 'globulin', 'jaundice', 'hepatitis'],
    description: 'Hepatocellular + cholestatic + synthetic-function panel.',
    interpretation:
      'ALT > AST pattern → hepatocellular (viral hepatitis, NAFLD, drug-induced). AST > ALT (ratio > 2) → alcoholic. Disproportionate ALP rise with GGT → cholestasis. Hypoalbuminaemia suggests chronic liver disease.',
    parameters: () => [
      num('Total Bilirubin', { unit: 'mg/dL', refLow: 0.3, refHigh: 1.2, decimals: 2, group: 'Bilirubin' }),
      num('Direct (Conjugated) Bilirubin', { unit: 'mg/dL', refLow: 0, refHigh: 0.3, decimals: 2, group: 'Bilirubin' }),
      num('Indirect (Unconjugated) Bilirubin', { unit: 'mg/dL', refLow: 0.1, refHigh: 0.9, decimals: 2, group: 'Bilirubin' }),
      num('SGOT / AST', { unit: 'U/L', refLow: 5, refHigh: 40, decimals: 0, group: 'Enzymes' }),
      num('SGPT / ALT', { unit: 'U/L', refLow: 5, refHigh: 40, decimals: 0, group: 'Enzymes' }),
      num('Alkaline Phosphatase (ALP)', { unit: 'U/L', refLow: 30, refHigh: 120, decimals: 0, group: 'Enzymes' }),
      num('Gamma GT (GGT)', { unit: 'U/L', refLow: 5, refHigh: 55, decimals: 0, group: 'Enzymes' }),
      num('Total Protein', { unit: 'g/dL', refLow: 6, refHigh: 8.3, decimals: 1, group: 'Proteins' }),
      num('Albumin', { unit: 'g/dL', refLow: 3.5, refHigh: 5.5, decimals: 1, group: 'Proteins' }),
      num('Globulin', { unit: 'g/dL', refLow: 2, refHigh: 3.5, decimals: 1, group: 'Proteins' }),
      num('A / G Ratio', { refLow: 1.1, refHigh: 2.5, decimals: 2, group: 'Proteins' }),
    ],
  },

  {
    name: 'Kidney Function Test (KFT / RFT)',
    code: 'KFT',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '3 mL serum',
    defaultPrice: 600,
    turnaroundHours: 6,
    aliases: ['Renal Function Test', 'RFT', 'KFT', 'Renal Panel', 'Kidney Panel', 'Renal Profile'],
    tags: ['kidney', 'renal', 'creatinine', 'urea', 'bun', 'uric acid', 'sodium', 'potassium', 'chloride', 'electrolytes', 'egfr', 'ckd'],
    description: 'Renal + electrolyte panel.',
    interpretation:
      'BUN/Creatinine ratio > 20:1 suggests pre-renal azotaemia. eGFR < 60 mL/min for ≥3 months defines CKD. Hyperkalaemia >6.0 mEq/L needs urgent management.',
    parameters: () => [
      num('Blood Urea', { unit: 'mg/dL', refLow: 15, refHigh: 45, decimals: 0 }),
      num('Blood Urea Nitrogen (BUN)', { unit: 'mg/dL', refLow: 7, refHigh: 20, decimals: 0 }),
      num('Serum Creatinine', { unit: 'mg/dL', refLow: 0.6, refHigh: 1.3, decimals: 2, notes: 'Male 0.7-1.3, Female 0.6-1.1' }),
      num('Uric Acid', { unit: 'mg/dL', refLow: 2.4, refHigh: 7.0, decimals: 1, notes: 'Male 3.4-7.0, Female 2.4-6.0' }),
      num('Sodium (Na)', { unit: 'mEq/L', refLow: 135, refHigh: 145, decimals: 0, group: 'Electrolytes' }),
      num('Potassium (K)', { unit: 'mEq/L', refLow: 3.5, refHigh: 5.1, decimals: 1, group: 'Electrolytes' }),
      num('Chloride (Cl)', { unit: 'mEq/L', refLow: 98, refHigh: 107, decimals: 0, group: 'Electrolytes' }),
      num('Calcium (Total)', { unit: 'mg/dL', refLow: 8.5, refHigh: 10.5, decimals: 1, group: 'Minerals' }),
      num('Phosphorus', { unit: 'mg/dL', refLow: 2.5, refHigh: 4.5, decimals: 1, group: 'Minerals' }),
      num('eGFR (CKD-EPI)', { unit: 'mL/min/1.73m²', refLow: 90, refHigh: 200, decimals: 0, notes: '≥90 normal, 60-89 mildly ↓, 30-59 moderate, 15-29 severe, <15 kidney failure' }),
    ],
  },

  {
    name: 'Serum Electrolytes',
    code: 'ELEC',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '2 mL serum',
    defaultPrice: 400,
    turnaroundHours: 4,
    aliases: ['Electrolytes', 'Na K Cl', 'Serum Lytes', 'BMP Electrolytes'],
    tags: ['sodium', 'potassium', 'chloride', 'bicarbonate', 'electrolytes', 'na', 'k', 'cl'],
    parameters: () => [
      num('Sodium', { unit: 'mEq/L', refLow: 135, refHigh: 145, decimals: 0 }),
      num('Potassium', { unit: 'mEq/L', refLow: 3.5, refHigh: 5.1, decimals: 1 }),
      num('Chloride', { unit: 'mEq/L', refLow: 98, refHigh: 107, decimals: 0 }),
      num('Bicarbonate (HCO₃)', { unit: 'mEq/L', refLow: 22, refHigh: 29, decimals: 0 }),
    ],
  },

  {
    name: 'Serum Calcium',
    code: 'CA',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '2 mL serum',
    defaultPrice: 200,
    turnaroundHours: 4,
    aliases: ['Calcium', 'Total Calcium', 'Ca'],
    tags: ['calcium', 'ca', 'bone', 'parathyroid', 'mineral'],
    parameters: () => [
      num('Total Calcium', { unit: 'mg/dL', refLow: 8.5, refHigh: 10.5, decimals: 1 }),
      num('Ionised Calcium', { unit: 'mg/dL', refLow: 4.5, refHigh: 5.6, decimals: 2, notes: 'Optional' }),
    ],
  },

  {
    name: 'Iron Studies',
    code: 'IRON',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '3 mL serum (fasting morning sample)',
    defaultPrice: 900,
    turnaroundHours: 12,
    aliases: ['Iron Panel', 'Iron Profile', 'Anemia Workup', 'Ferritin Profile'],
    tags: ['iron', 'ferritin', 'tibc', 'transferrin', 'anemia', 'iron deficiency'],
    instructions: 'Fasting morning sample preferred. Hold iron supplements ≥24 hours.',
    description: 'Iron / TIBC / Transferrin saturation / Ferritin — comprehensive iron-status panel.',
    interpretation:
      'Iron-deficiency anaemia: ↓ Iron, ↑ TIBC, ↓ Saturation, ↓ Ferritin. Anaemia of chronic disease: ↓ Iron, ↓ TIBC, normal/↑ Ferritin. Haemochromatosis: ↑ Iron, ↑ Saturation, ↑↑ Ferritin.',
    parameters: () => [
      num('Serum Iron', { unit: 'µg/dL', refLow: 60, refHigh: 170, decimals: 0 }),
      num('TIBC', { unit: 'µg/dL', refLow: 240, refHigh: 450, decimals: 0 }),
      num('UIBC', { unit: 'µg/dL', refLow: 150, refHigh: 375, decimals: 0 }),
      num('Transferrin Saturation', { unit: '%', refLow: 20, refHigh: 50, decimals: 0 }),
      num('Serum Ferritin', { unit: 'ng/mL', refLow: 20, refHigh: 250, decimals: 0, notes: 'Female 12-150, Male 20-250' }),
    ],
  },

  {
    name: 'Vitamin D (25-OH)',
    code: 'VITD',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '2 mL serum',
    defaultPrice: 1200,
    turnaroundHours: 24,
    aliases: ['Vitamin D', '25(OH)D', '25 Hydroxy Vitamin D', 'Vit D', 'D3', 'Calcidiol'],
    tags: ['vitamin d', 'vit d', 'd3', '25 oh', 'bone', 'calcium'],
    interpretation: '<20 Deficient | 20-29 Insufficient | 30-100 Sufficient | >100 Potential toxicity',
    parameters: () => [
      num('25-Hydroxy Vitamin D', { unit: 'ng/mL', refLow: 30, refHigh: 100, decimals: 1 }),
    ],
  },

  {
    name: 'Vitamin B12',
    code: 'VITB12',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '2 mL serum',
    defaultPrice: 850,
    turnaroundHours: 12,
    aliases: ['B12', 'Cobalamin', 'Cyanocobalamin', 'Vit B12'],
    tags: ['vitamin b12', 'b12', 'cobalamin', 'pernicious anemia', 'megaloblastic'],
    parameters: () => [
      num('Vitamin B12', { unit: 'pg/mL', refLow: 200, refHigh: 900, decimals: 0 }),
    ],
  },

  {
    name: 'C-Reactive Protein (CRP)',
    code: 'CRP',
    departmentName: 'Biochemistry',
    sampleType: 'Blood',
    specimen: '2 mL serum',
    defaultPrice: 400,
    turnaroundHours: 6,
    aliases: ['CRP', 'hs-CRP', 'High Sensitivity CRP', 'C Reactive Protein'],
    tags: ['crp', 'inflammation', 'sepsis', 'infection', 'acute phase'],
    description: 'Acute-phase reactant; non-specific marker of inflammation.',
    parameters: () => [
      num('CRP (Quantitative)', { unit: 'mg/L', refLow: 0, refHigh: 10, decimals: 1, notes: '>40 strongly suggests bacterial infection in adults' }),
    ],
  },

  {
    name: 'Troponin I (Cardiac)',
    code: 'TROP-I',
    departmentName: 'Cardiac Markers',
    sampleType: 'Blood',
    specimen: '2 mL serum',
    defaultPrice: 800,
    turnaroundHours: 2,
    aliases: ['Trop I', 'cTnI', 'Cardiac Troponin', 'Troponin', 'hs-Trop I', 'High Sensitivity Troponin'],
    tags: ['troponin', 'cardiac', 'mi', 'myocardial infarction', 'heart attack', 'acs', 'chest pain'],
    description: 'Cardiac-specific marker of myocardial injury. Repeat at 3-6 hours if first sample negative but suspicion high.',
    parameters: () => [
      num('Troponin I', { unit: 'ng/mL', refLow: 0, refHigh: 0.04, decimals: 3, notes: '>0.04 elevated; >0.5 suggests MI in correct clinical context' }),
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Endocrinology
  // ─────────────────────────────────────────────────────────────
  {
    name: 'Thyroid Profile (T3, T4, TSH)',
    code: 'TFT',
    departmentName: 'Endocrinology',
    sampleType: 'Blood',
    specimen: '3 mL serum',
    defaultPrice: 750,
    turnaroundHours: 8,
    aliases: ['Thyroid Function Test', 'TFT', 'T3 T4 TSH', 'Thyroid Panel'],
    tags: ['thyroid', 't3', 't4', 'tsh', 'hypothyroid', 'hyperthyroid', 'goitre'],
    description: 'Primary thyroid screen.',
    interpretation:
      'Primary hypothyroidism: ↑TSH ↓T4. Primary hyperthyroidism: ↓TSH ↑T4/T3. Subclinical hypothyroid: ↑TSH normal T4. Pregnancy / pituitary disease alters interpretation.',
    parameters: () => [
      num('Total T3', { unit: 'ng/dL', refLow: 80, refHigh: 200, decimals: 0 }),
      num('Total T4', { unit: 'µg/dL', refLow: 4.5, refHigh: 12, decimals: 1 }),
      num('TSH', { unit: 'µIU/mL', refLow: 0.4, refHigh: 4.5, decimals: 2 }),
    ],
  },

  {
    name: 'Free Thyroid Profile (FT3, FT4, TSH)',
    code: 'FTFT',
    departmentName: 'Endocrinology',
    sampleType: 'Blood',
    specimen: '3 mL serum',
    defaultPrice: 900,
    turnaroundHours: 8,
    aliases: ['Free T3 T4 TSH', 'Free Thyroid Profile', 'FT3 FT4 TSH', 'Free Thyroid Panel'],
    tags: ['thyroid', 'ft3', 'ft4', 'tsh', 'free t3', 'free t4', 'hyperthyroid', 'hypothyroid'],
    parameters: () => [
      num('Free T3 (FT3)', { unit: 'pg/mL', refLow: 2.0, refHigh: 4.4, decimals: 2 }),
      num('Free T4 (FT4)', { unit: 'ng/dL', refLow: 0.8, refHigh: 1.8, decimals: 2 }),
      num('TSH', { unit: 'µIU/mL', refLow: 0.4, refHigh: 4.5, decimals: 2 }),
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Microbiology + Microscopy
  // ─────────────────────────────────────────────────────────────
  {
    name: 'Urine Routine & Microscopy',
    code: 'URM',
    departmentName: 'Microbiology',
    sampleType: 'Urine',
    specimen: '10 mL mid-stream urine',
    defaultPrice: 200,
    turnaroundHours: 4,
    aliases: ['Urinalysis', 'UA', 'Urine R/M', 'Urine Routine', 'Urine Examination', 'URE'],
    tags: ['urine', 'urinalysis', 'microscopy', 'dipstick', 'protein', 'sugar', 'ketones', 'wbc', 'rbc', 'uti'],
    instructions: 'Mid-stream urine collected in a clean, dry container. Reach lab within 1 hour of collection.',
    description: 'Physical, chemical and microscopic urinalysis.',
    parameters: () => [
      // Physical
      sel('Colour', [opt('pale_yellow', 'Pale yellow'), opt('yellow', 'Yellow'), opt('dark_yellow', 'Dark yellow'), opt('amber', 'Amber'), opt('red', 'Red'), opt('brown', 'Brown'), opt('colourless', 'Colourless')], { group: 'Physical', refRangeText: 'Pale yellow / Yellow' }),
      sel('Appearance', [opt('clear', 'Clear'), opt('slightly_turbid', 'Slightly turbid'), opt('turbid', 'Turbid')], { group: 'Physical', refRangeText: 'Clear' }),
      num('Specific Gravity', { refLow: 1.005, refHigh: 1.03, decimals: 3, group: 'Physical' }),
      num('pH', { refLow: 4.6, refHigh: 8, decimals: 1, group: 'Physical' }),

      // Chemical (dipstick)
      sel('Protein', [opt('negative', 'Negative'), opt('trace', 'Trace'), opt('1plus', '1+'), opt('2plus', '2+'), opt('3plus', '3+'), opt('4plus', '4+')], { group: 'Chemical (Dipstick)', refRangeText: 'Negative' }),
      sel('Glucose', [opt('negative', 'Negative'), opt('trace', 'Trace'), opt('1plus', '1+'), opt('2plus', '2+'), opt('3plus', '3+'), opt('4plus', '4+')], { group: 'Chemical (Dipstick)', refRangeText: 'Negative' }),
      sel('Ketones', [opt('negative', 'Negative'), opt('trace', 'Trace'), opt('1plus', '1+'), opt('2plus', '2+'), opt('3plus', '3+')], { group: 'Chemical (Dipstick)', refRangeText: 'Negative' }),
      sel('Bilirubin', [opt('negative', 'Negative'), opt('1plus', '1+'), opt('2plus', '2+'), opt('3plus', '3+')], { group: 'Chemical (Dipstick)', refRangeText: 'Negative' }),
      sel('Urobilinogen', [opt('normal', 'Normal'), opt('1plus', '1+'), opt('2plus', '2+'), opt('3plus', '3+')], { group: 'Chemical (Dipstick)', refRangeText: 'Normal' }),
      sel('Blood', [opt('negative', 'Negative'), opt('trace', 'Trace'), opt('1plus', '1+'), opt('2plus', '2+'), opt('3plus', '3+')], { group: 'Chemical (Dipstick)', refRangeText: 'Negative' }),
      sel('Nitrites', [opt('negative', 'Negative'), opt('positive', 'Positive')], { group: 'Chemical (Dipstick)', refRangeText: 'Negative' }),
      sel('Leukocyte Esterase', [opt('negative', 'Negative'), opt('trace', 'Trace'), opt('1plus', '1+'), opt('2plus', '2+'), opt('3plus', '3+')], { group: 'Chemical (Dipstick)', refRangeText: 'Negative' }),

      // Microscopy
      text('Pus Cells (WBC)', { group: 'Microscopy (/HPF)', refRangeText: '0-5 /HPF' }),
      text('Red Blood Cells', { group: 'Microscopy (/HPF)', refRangeText: '0-2 /HPF' }),
      text('Epithelial Cells', { group: 'Microscopy (/HPF)', refRangeText: 'Few' }),
      text('Casts', { group: 'Microscopy (/HPF)', refRangeText: 'None seen' }),
      text('Crystals', { group: 'Microscopy (/HPF)', refRangeText: 'None seen' }),
      text('Bacteria', { group: 'Microscopy (/HPF)', refRangeText: 'None / Occasional' }),
      text('Yeast / Fungi', { group: 'Microscopy (/HPF)', refRangeText: 'None seen' }),
    ],
  },

  {
    name: 'Urine Culture & Sensitivity',
    code: 'UR-CS',
    departmentName: 'Microbiology',
    sampleType: 'Urine',
    specimen: '10 mL mid-stream urine in sterile container',
    defaultPrice: 600,
    turnaroundHours: 72,
    aliases: ['Urine C/S', 'Urine Culture', 'UTI Culture', 'Urine C&S'],
    tags: ['urine', 'culture', 'sensitivity', 'uti', 'antibiotic', 'antibiogram', 'organism', 'cfu'],
    description: 'Aerobic culture with colony count and antimicrobial susceptibility.',
    parameters: () => [
      sel('Growth', [opt('no_growth', 'No growth at 48 hrs'), opt('insignificant', 'Insignificant growth'), opt('significant', 'Significant growth'), opt('mixed_flora', 'Mixed flora — repeat collection')], { group: 'Culture' }),
      text('Organism Isolated', { group: 'Culture', refRangeText: 'No growth' }),
      text('Colony Count', { group: 'Culture', refRangeText: '<10^4 CFU/mL', notes: '>10^5 CFU/mL of single organism = significant' }),
      text('Antibiotic Sensitivity', { group: 'Antibiogram', notes: 'Free text — S/I/R against tested antibiotics (Nitrofurantoin, Cotrimoxazole, Ciprofloxacin, Ceftriaxone, Amikacin, Meropenem etc.)' }),
    ],
  },

  {
    name: 'Stool Routine & Microscopy',
    code: 'STOOL-RM',
    departmentName: 'Microbiology',
    sampleType: 'Stool',
    specimen: 'Fresh stool sample in clean container',
    defaultPrice: 200,
    turnaroundHours: 4,
    aliases: ['Stool R/M', 'Stool Examination', 'Stool Routine', 'Stool R&M'],
    tags: ['stool', 'feces', 'parasites', 'ova', 'cysts', 'diarrhea', 'occult blood'],
    parameters: () => [
      sel('Colour', [opt('brown', 'Brown'), opt('pale', 'Pale'), opt('black', 'Black / Melaena'), opt('green', 'Green'), opt('red', 'Red / Bloody')], { group: 'Physical', refRangeText: 'Brown' }),
      sel('Consistency', [opt('formed', 'Formed'), opt('semi_formed', 'Semi-formed'), opt('loose', 'Loose'), opt('watery', 'Watery'), opt('hard', 'Hard')], { group: 'Physical', refRangeText: 'Formed' }),
      sel('Mucus', [opt('absent', 'Absent'), opt('present', 'Present')], { group: 'Physical', refRangeText: 'Absent' }),
      sel('Blood', [opt('absent', 'Absent'), opt('occult', 'Occult'), opt('frank', 'Frank')], { group: 'Physical', refRangeText: 'Absent' }),
      text('Pus Cells', { group: 'Microscopy', refRangeText: '0-2 /HPF' }),
      text('Red Blood Cells', { group: 'Microscopy', refRangeText: 'None' }),
      text('Ova / Cysts / Parasites', { group: 'Microscopy', refRangeText: 'None seen' }),
      text('Vegetable Cells / Fibres', { group: 'Microscopy', refRangeText: 'Few' }),
    ],
  },

  {
    name: 'Sputum AFB Smear (Ziehl-Neelsen)',
    code: 'AFB',
    departmentName: 'Microbiology',
    sampleType: 'Sputum',
    specimen: 'Early morning sputum, 2-3 mL, in sterile leak-proof container',
    defaultPrice: 250,
    turnaroundHours: 24,
    aliases: ['AFB Smear', 'ZN Stain', 'Ziehl Neelsen', 'TB Smear', 'AFB Sputum'],
    tags: ['afb', 'tuberculosis', 'tb', 'sputum', 'mycobacterium', 'ziehl neelsen', 'cough'],
    instructions: 'Collect three early-morning specimens on consecutive days for screening.',
    parameters: () => [
      sel('AFB Smear Grading', [
        opt('negative', 'Negative'),
        opt('scanty', 'Scanty (1-9 / 100 fields)'),
        opt('1plus', '1+ (10-99 / 100 fields)'),
        opt('2plus', '2+ (1-10 / field)'),
        opt('3plus', '3+ (>10 / field)'),
      ], { group: 'Result', refRangeText: 'Negative' }),
      text('Quality of Specimen', { refRangeText: 'Mucopurulent, adequate' }),
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Serology
  // ─────────────────────────────────────────────────────────────
  {
    name: 'Widal Test',
    code: 'WIDAL',
    departmentName: 'Serology',
    sampleType: 'Blood',
    specimen: '2 mL serum',
    defaultPrice: 250,
    turnaroundHours: 4,
    aliases: ['Widal', 'Typhi Dot', 'Typhoid Serology'],
    tags: ['typhoid', 'salmonella', 'typhi', 'paratyphi', 'widal', 'enteric fever'],
    description: 'Tube agglutination titres for S. typhi and S. paratyphi.',
    interpretation:
      'Titre ≥1:160 of O antigen, or rising titre on paired samples, suggests typhoid. Single high titre may persist after past infection or vaccination.',
    parameters: () => [
      text('S. typhi "O" Antigen', { group: 'Titres', refRangeText: '<1:80' }),
      text('S. typhi "H" Antigen', { group: 'Titres', refRangeText: '<1:80' }),
      text('S. paratyphi "AH"', { group: 'Titres', refRangeText: '<1:80' }),
      text('S. paratyphi "BH"', { group: 'Titres', refRangeText: '<1:80' }),
    ],
  },

  {
    name: 'Dengue NS1 Antigen & IgG/IgM',
    code: 'DEN',
    departmentName: 'Serology',
    sampleType: 'Blood',
    specimen: '2 mL serum',
    defaultPrice: 1100,
    turnaroundHours: 6,
    aliases: ['Dengue Panel', 'Dengue Serology', 'Dengue NS1', 'Dengue IgG IgM', 'Dengue Combo'],
    tags: ['dengue', 'ns1', 'igg', 'igm', 'fever', 'vector borne', 'arbovirus'],
    description: 'NS1 detects current infection (days 1-7); IgM rises after day 4; IgG indicates past / secondary infection.',
    parameters: () => [
      sel('NS1 Antigen', REACTIVE_OPTS, { group: 'Dengue Panel', refRangeText: 'Non-reactive' }),
      sel('Dengue IgM Antibody', REACTIVE_OPTS, { group: 'Dengue Panel', refRangeText: 'Non-reactive' }),
      sel('Dengue IgG Antibody', REACTIVE_OPTS, { group: 'Dengue Panel', refRangeText: 'Non-reactive' }),
    ],
  },

  {
    name: 'Malaria Antigen + Smear',
    code: 'MP',
    departmentName: 'Microbiology',
    sampleType: 'Blood',
    specimen: '2 mL EDTA whole blood',
    defaultPrice: 350,
    turnaroundHours: 3,
    aliases: ['Malarial Parasite', 'MP Smear', 'MP Antigen', 'Malaria Smear', 'MP RDT'],
    tags: ['malaria', 'mp', 'falciparum', 'vivax', 'parasite', 'fever', 'vector borne'],
    parameters: () => [
      sel('P. falciparum Antigen', POSITIVE_OPTS, { group: 'Antigen', refRangeText: 'Negative' }),
      sel('P. vivax Antigen', POSITIVE_OPTS, { group: 'Antigen', refRangeText: 'Negative' }),
      sel('Smear (Thick + Thin)', POSITIVE_OPTS, { group: 'Microscopy', refRangeText: 'No parasites seen' }),
      text('Species Identified', { group: 'Microscopy', refRangeText: 'Not applicable' }),
      text('Parasitaemia %', { group: 'Microscopy', refRangeText: 'NA', notes: 'Express as % of infected RBCs' }),
    ],
  },

  {
    name: 'HIV 1 & 2 Antibody',
    code: 'HIV',
    departmentName: 'Serology',
    sampleType: 'Blood',
    specimen: '2 mL serum',
    defaultPrice: 500,
    turnaroundHours: 8,
    aliases: ['HIV', 'HIV Test', 'AIDS Test', 'HIV 1/2', 'HIV Antibody', 'HIV Screening'],
    tags: ['hiv', 'aids', 'antibody', 'screening', 'sti', 'std'],
    instructions: 'Pre-test counselling per ICTC/NACO protocol where applicable.',
    parameters: () => [
      sel('HIV-1 Antibody', REACTIVE_OPTS, { refRangeText: 'Non-reactive' }),
      sel('HIV-2 Antibody', REACTIVE_OPTS, { refRangeText: 'Non-reactive' }),
      text('Method', { refRangeText: '4th-gen rapid / ELISA' }),
    ],
  },

  {
    name: 'Hepatitis B Surface Antigen (HBsAg)',
    code: 'HBSAG',
    departmentName: 'Serology',
    sampleType: 'Blood',
    specimen: '2 mL serum',
    defaultPrice: 350,
    turnaroundHours: 8,
    aliases: ['HBsAg', 'Hep B', 'Australia Antigen', 'HBV', 'Hepatitis B'],
    tags: ['hbsag', 'hepatitis b', 'hep b', 'hbv', 'australia antigen', 'liver', 'serology'],
    parameters: () => [
      sel('HBsAg', REACTIVE_OPTS, { refRangeText: 'Non-reactive' }),
    ],
  },

  {
    name: 'Hepatitis C Antibody (Anti-HCV)',
    code: 'HCV',
    departmentName: 'Serology',
    sampleType: 'Blood',
    specimen: '2 mL serum',
    defaultPrice: 450,
    turnaroundHours: 8,
    aliases: ['Anti-HCV', 'HCV Antibody', 'Hep C', 'HCV', 'Hepatitis C'],
    tags: ['hcv', 'hepatitis c', 'hep c', 'anti hcv', 'liver', 'serology'],
    parameters: () => [
      sel('Anti-HCV Antibody', REACTIVE_OPTS, { refRangeText: 'Non-reactive' }),
    ],
  },

  {
    name: 'COVID-19 RT-PCR',
    code: 'COVID-PCR',
    departmentName: 'Microbiology',
    sampleType: 'Nasopharyngeal Swab',
    specimen: 'NP + OP swab in viral transport medium',
    defaultPrice: 1200,
    turnaroundHours: 12,
    aliases: ['COVID PCR', 'SARS-CoV-2 PCR', 'Coronavirus PCR', 'COVID', 'COVID-19 RTPCR'],
    tags: ['covid', 'sars cov 2', 'corona', 'pcr', 'respiratory virus'],
    parameters: () => [
      sel('SARS-CoV-2 RT-PCR', POSITIVE_OPTS, { group: 'Result', refRangeText: 'Negative' }),
      text('CT Value (N / ORF1ab / E gene)', { group: 'Result', refRangeText: '>40 (Negative)' }),
      text('Method / Kit', { group: 'Method' }),
    ],
  },

  // ─────────────────────────────────────────────────────────────
  // Cytology
  // ─────────────────────────────────────────────────────────────
  {
    name: 'Pap Smear (Conventional)',
    code: 'PAP',
    departmentName: 'Cytology',
    sampleType: 'Cervical Swab',
    specimen: 'Cervical scrape on slide, fixed in 95% alcohol',
    defaultPrice: 700,
    turnaroundHours: 48,
    aliases: ['Pap Test', 'Cervical Cytology', 'Cervical Smear', 'PAP'],
    tags: ['pap', 'cervical cancer', 'cytology', 'screening', 'bethesda', 'hpv', 'women'],
    description: 'Cervical cytology — Bethesda 2014 classification.',
    parameters: () => [
      sel('Specimen Adequacy', [opt('satisfactory', 'Satisfactory'), opt('unsatisfactory', 'Unsatisfactory')], { group: 'Adequacy' }),
      sel('Interpretation', [
        opt('nilm', 'NILM — Negative for intraepithelial lesion or malignancy'),
        opt('ascus', 'ASC-US — Atypical squamous cells of undetermined significance'),
        opt('asch', 'ASC-H — Atypical squamous cells, cannot exclude HSIL'),
        opt('lsil', 'LSIL — Low-grade squamous intraepithelial lesion'),
        opt('hsil', 'HSIL — High-grade squamous intraepithelial lesion'),
        opt('scc', 'Squamous cell carcinoma'),
        opt('agc', 'AGC — Atypical glandular cells'),
        opt('adenoca', 'Adenocarcinoma'),
      ], { group: 'Interpretation', refRangeText: 'NILM' }),
      text('Microbiology / Reactive Changes', { group: 'Comments' }),
      text('Recommendation', { group: 'Comments' }),
    ],
  },
];

// ─────────────────────────────────────────────────────────────
// Seed runner
// ─────────────────────────────────────────────────────────────

async function seed() {
  console.log(`🌱 Seeding ${TEMPLATES.length} platform lab test templates...\n`);

  const superAdmin = await prisma.user.findFirst({
    where: {
      email: 'admin@hospital.com',
      tenant: { slug: '__platform__' },
    },
    select: { id: true, email: true },
  });

  if (!superAdmin) {
    throw new Error(
      'Super admin (admin@hospital.com on __platform__ tenant) not found. Run `npm run db:seed` first.',
    );
  }
  console.log(`  ↳ owner: ${superAdmin.email}\n`);

  let created = 0;
  let updated = 0;

  for (const tpl of TEMPLATES) {
    paramCounter = 0; // reset so each template's IDs are stable p_1..p_n
    const parsed = parametersArraySchema.parse(tpl.parameters());

    const existing = await prisma.labTestTemplate.findUnique({
      where: { name: tpl.name },
      select: { id: true, version: true },
    });

    const aliases = normaliseAliases(tpl.aliases ?? []);
    const tags = normaliseTags(tpl.tags ?? []);
    const searchTokens = buildSearchTokens({
      name: tpl.name,
      code: tpl.code,
      departmentName: tpl.departmentName,
      sampleType: tpl.sampleType,
      aliases,
      tags,
      parameters: parsed,
    });

    const data = {
      name: tpl.name,
      code: tpl.code,
      departmentName: tpl.departmentName,
      sampleType: tpl.sampleType,
      specimen: tpl.specimen ?? null,
      instructions: tpl.instructions ?? null,
      description: tpl.description ?? null,
      defaultPrice: new Prisma.Decimal(tpl.defaultPrice),
      turnaroundHours: tpl.turnaroundHours,
      parameters: parsed as unknown as Prisma.InputJsonValue,
      interpretation: tpl.interpretation ?? null,
      aliases,
      tags,
      searchTokens,
      isPublished: true,
    };

    if (existing) {
      await prisma.labTestTemplate.update({
        where: { id: existing.id },
        data: { ...data, version: existing.version + 1 },
      });
      updated += 1;
      console.log(`  ✏  updated  ${tpl.name.padEnd(40)} (${parsed.length} params)`);
    } else {
      await prisma.labTestTemplate.create({
        data: { ...data, version: 1, createdById: superAdmin.id },
      });
      created += 1;
      console.log(`  ✓  created  ${tpl.name.padEnd(40)} (${parsed.length} params)`);
    }
  }

  console.log(`\n✅ Done. ${created} created, ${updated} updated, ${TEMPLATES.length} total.`);
}

seed()
  .catch((err) => {
    console.error('❌ Lab test template seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
