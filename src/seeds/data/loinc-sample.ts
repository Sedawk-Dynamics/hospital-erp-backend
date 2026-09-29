/**
 * Sample LOINC catalog rows for development.
 *
 * The real catalog is populated by importing the official LOINC release from
 * https://loinc.org/start (the Regenstrief Institute publishes it). Until that
 * bulk import is wired up, these few well-known codes let us build and test the
 * search + select flow. Column values follow the LOINC release fields:
 *   LOINC_NUM → loincCode, LONG_COMMON_NAME → displayName, COMPONENT,
 *   PROPERTY, TIME_ASPCT → timeAspect, SYSTEM, SCALE_TYP → scaleType,
 *   METHOD_TYP → method, STATUS → status.
 *
 * These are genuine LOINC codes (verified from the LOINC reference), covering
 * common lab panels, single analytes and vital signs.
 */

export interface LoincSeed {
  loincCode: string;
  displayName: string;
  component?: string;
  property?: string;
  timeAspect?: string;
  system?: string;
  scaleType?: string;
  method?: string;
  status?: string;
  synonyms?: string[];
  keywords?: string[];
}

export const SAMPLE_LOINC_CATALOG: LoincSeed[] = [
  // ── Panels ──────────────────────────────────────────────────────────
  {
    loincCode: '58410-2',
    displayName: 'CBC panel - Blood by Automated count',
    component: 'Complete blood count panel',
    property: '-',
    timeAspect: 'Pt',
    system: 'Bld',
    scaleType: '-',
    method: 'Automated count',
    status: 'ACTIVE',
    synonyms: ['CBC', 'complete blood count', 'full blood count', 'FBC', 'haemogram', 'hemogram'],
    keywords: ['cbc', 'blood', 'panel', 'count'],
  },
  {
    loincCode: '24323-8',
    displayName: 'Comprehensive metabolic 2000 panel - Serum or Plasma',
    component: 'Comprehensive metabolic panel',
    property: '-',
    timeAspect: 'Pt',
    system: 'Ser/Plas',
    scaleType: '-',
    method: '',
    status: 'ACTIVE',
    synonyms: ['CMP', 'comprehensive metabolic panel', 'metabolic panel'],
    keywords: ['cmp', 'metabolic', 'panel', 'serum'],
  },
  {
    loincCode: '57698-3',
    displayName: 'Lipid panel with direct LDL - Serum or Plasma',
    component: 'Lipid panel',
    property: '-',
    timeAspect: 'Pt',
    system: 'Ser/Plas',
    scaleType: '-',
    method: '',
    status: 'ACTIVE',
    synonyms: ['lipid panel', 'lipid profile', 'cholesterol panel'],
    keywords: ['lipid', 'cholesterol', 'panel', 'profile'],
  },

  // ── Single analytes ─────────────────────────────────────────────────
  {
    loincCode: '718-7',
    displayName: 'Hemoglobin [Mass/volume] in Blood',
    component: 'Hemoglobin',
    property: 'MCnc',
    timeAspect: 'Pt',
    system: 'Bld',
    scaleType: 'Qn',
    method: '',
    status: 'ACTIVE',
    synonyms: ['Hb', 'Hgb', 'haemoglobin', 'hemoglobin'],
    keywords: ['hemoglobin', 'hb', 'hgb', 'blood'],
  },
  {
    loincCode: '6690-2',
    displayName: 'Leukocytes [#/volume] in Blood by Automated count',
    component: 'Leukocytes',
    property: 'NCnc',
    timeAspect: 'Pt',
    system: 'Bld',
    scaleType: 'Qn',
    method: 'Automated count',
    status: 'ACTIVE',
    synonyms: ['WBC', 'white blood cell count', 'leukocytes', 'TLC', 'total leukocyte count'],
    keywords: ['wbc', 'leukocytes', 'white', 'blood', 'count'],
  },
  {
    loincCode: '777-3',
    displayName: 'Platelets [#/volume] in Blood by Automated count',
    component: 'Platelets',
    property: 'NCnc',
    timeAspect: 'Pt',
    system: 'Bld',
    scaleType: 'Qn',
    method: 'Automated count',
    status: 'ACTIVE',
    synonyms: ['platelet count', 'PLT', 'thrombocytes'],
    keywords: ['platelets', 'plt', 'count', 'blood'],
  },
  {
    loincCode: '2345-7',
    displayName: 'Glucose [Mass/volume] in Serum or Plasma',
    component: 'Glucose',
    property: 'MCnc',
    timeAspect: 'Pt',
    system: 'Ser/Plas',
    scaleType: 'Qn',
    method: '',
    status: 'ACTIVE',
    synonyms: ['glucose', 'blood sugar', 'random blood sugar', 'RBS'],
    keywords: ['glucose', 'sugar', 'serum', 'blood'],
  },
  {
    loincCode: '1558-6',
    displayName: 'Fasting glucose [Mass/volume] in Serum or Plasma',
    component: 'Fasting glucose',
    property: 'MCnc',
    timeAspect: 'Pt',
    system: 'Ser/Plas',
    scaleType: 'Qn',
    method: '',
    status: 'ACTIVE',
    synonyms: ['fasting blood glucose', 'FBS', 'fasting blood sugar', 'FBG'],
    keywords: ['fasting', 'glucose', 'fbs', 'sugar'],
  },
  {
    loincCode: '4548-4',
    displayName: 'Hemoglobin A1c/Hemoglobin.total in Blood',
    component: 'Hemoglobin A1c/Hemoglobin.total',
    property: 'MFr',
    timeAspect: 'Pt',
    system: 'Bld',
    scaleType: 'Qn',
    method: '',
    status: 'ACTIVE',
    synonyms: ['HbA1c', 'A1c', 'glycated hemoglobin', 'glycosylated hemoglobin'],
    keywords: ['hba1c', 'a1c', 'glycated', 'diabetes'],
  },
  {
    loincCode: '2160-0',
    displayName: 'Creatinine [Mass/volume] in Serum or Plasma',
    component: 'Creatinine',
    property: 'MCnc',
    timeAspect: 'Pt',
    system: 'Ser/Plas',
    scaleType: 'Qn',
    method: '',
    status: 'ACTIVE',
    synonyms: ['creatinine', 'serum creatinine'],
    keywords: ['creatinine', 'serum', 'kidney', 'renal'],
  },
  {
    loincCode: '3016-3',
    displayName: 'Thyrotropin [Units/volume] in Serum or Plasma',
    component: 'Thyrotropin',
    property: 'ACnc',
    timeAspect: 'Pt',
    system: 'Ser/Plas',
    scaleType: 'Qn',
    method: '',
    status: 'ACTIVE',
    synonyms: ['TSH', 'thyroid stimulating hormone', 'thyrotropin'],
    keywords: ['tsh', 'thyroid', 'thyrotropin'],
  },

  // ── Vital signs ─────────────────────────────────────────────────────
  {
    loincCode: '8867-4',
    displayName: 'Heart rate',
    component: 'Heart rate',
    property: 'NRat',
    timeAspect: 'Pt',
    system: 'XXX',
    scaleType: 'Qn',
    method: '',
    status: 'ACTIVE',
    synonyms: ['heart rate', 'pulse', 'pulse rate', 'HR'],
    keywords: ['heart', 'rate', 'pulse', 'vital'],
  },
  {
    loincCode: '8480-6',
    displayName: 'Systolic blood pressure',
    component: 'Systolic blood pressure',
    property: 'Pres',
    timeAspect: 'Pt',
    system: 'Arterial system',
    scaleType: 'Qn',
    method: '',
    status: 'ACTIVE',
    synonyms: ['systolic BP', 'SBP', 'systolic blood pressure'],
    keywords: ['systolic', 'blood', 'pressure', 'bp', 'vital'],
  },
  {
    loincCode: '8462-4',
    displayName: 'Diastolic blood pressure',
    component: 'Diastolic blood pressure',
    property: 'Pres',
    timeAspect: 'Pt',
    system: 'Arterial system',
    scaleType: 'Qn',
    method: '',
    status: 'ACTIVE',
    synonyms: ['diastolic BP', 'DBP', 'diastolic blood pressure'],
    keywords: ['diastolic', 'blood', 'pressure', 'bp', 'vital'],
  },
  {
    loincCode: '8310-5',
    displayName: 'Body temperature',
    component: 'Body temperature',
    property: 'Temp',
    timeAspect: 'Pt',
    system: 'XXX',
    scaleType: 'Qn',
    method: '',
    status: 'ACTIVE',
    synonyms: ['temperature', 'body temp', 'fever'],
    keywords: ['temperature', 'temp', 'body', 'vital'],
  },
];
