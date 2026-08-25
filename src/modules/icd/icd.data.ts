// Curated common ICD-10 codes for the platform reference catalog. This is a
// pragmatic starter set covering the diagnoses an OPD/IPD hospital sees most;
// the super-admin can extend it from the panel and hospitals can add custom
// codes.
//
// Since the full WHO ICD-10 release is seeded alongside this (seeds/icd-claml.ts),
// this set's real job is no longer coverage — it is the everyday slang WHO
// never prints: "flu", "heart attack", "cad", "loose motions". Those keywords
// are what the search ranks on, and the WHO seed deliberately never rewrites
// them.

export interface SeedIcdCode {
  code: string;
  title: string;
  category: string;
  chapter?: string;
  keywords?: string[];
}

export const SEED_ICD_CODES: SeedIcdCode[] = [
  // --- Symptoms / general (R) ---
  { code: 'R50.9', title: 'Fever, unspecified', category: 'Symptoms & signs', keywords: ['pyrexia', 'temperature', 'febrile'] },
  { code: 'R51.9', title: 'Headache, unspecified', category: 'Symptoms & signs', keywords: ['cephalalgia'] },
  { code: 'R05.9', title: 'Cough, unspecified', category: 'Symptoms & signs' },
  { code: 'R06.02', title: 'Shortness of breath', category: 'Symptoms & signs', keywords: ['dyspnea', 'breathlessness'] },
  { code: 'R07.9', title: 'Chest pain, unspecified', category: 'Symptoms & signs' },
  { code: 'R10.9', title: 'Abdominal pain, unspecified', category: 'Symptoms & signs', keywords: ['stomach pain', 'belly pain'] },
  { code: 'R11.2', title: 'Nausea with vomiting, unspecified', category: 'Symptoms & signs' },
  { code: 'R42', title: 'Dizziness and giddiness', category: 'Symptoms & signs', keywords: ['vertigo', 'lightheaded'] },
  { code: 'R53.83', title: 'Fatigue', category: 'Symptoms & signs', keywords: ['tiredness', 'weakness', 'malaise'] },
  { code: 'R56.9', title: 'Convulsions, unspecified', category: 'Symptoms & signs', keywords: ['seizure', 'fits'] },
  { code: 'R63.0', title: 'Anorexia', category: 'Symptoms & signs', keywords: ['loss of appetite'] },
  { code: 'R60.9', title: 'Edema, unspecified', category: 'Symptoms & signs', keywords: ['swelling'] },
  { code: 'R21', title: 'Rash and other nonspecific skin eruption', category: 'Symptoms & signs', keywords: ['skin rash'] },

  // --- Infectious (A/B) ---
  { code: 'A09', title: 'Infectious gastroenteritis and colitis, unspecified', category: 'Infectious', keywords: ['diarrhea', 'diarrhoea', 'loose motions', 'stomach infection'] },
  { code: 'A90', title: 'Dengue fever [classical dengue]', category: 'Infectious', keywords: ['dengue'] },
  { code: 'A91', title: 'Dengue hemorrhagic fever', category: 'Infectious', keywords: ['dengue'] },
  { code: 'B54', title: 'Unspecified malaria', category: 'Infectious', keywords: ['malaria', 'plasmodium'] },
  { code: 'A01.0', title: 'Typhoid fever', category: 'Infectious', keywords: ['enteric fever', 'salmonella typhi'] },
  { code: 'A15.9', title: 'Respiratory tuberculosis unspecified', category: 'Infectious', keywords: ['tb', 'tuberculosis', 'koch'] },
  { code: 'B34.9', title: 'Viral infection, unspecified', category: 'Infectious', keywords: ['viral fever'] },
  { code: 'U07.1', title: 'COVID-19', category: 'Infectious', keywords: ['covid', 'sars-cov-2', 'coronavirus'] },
  { code: 'J11.1', title: 'Influenza with other respiratory manifestations', category: 'Infectious', keywords: ['flu', 'influenza'] },

  // --- Respiratory (J) ---
  { code: 'J00', title: 'Acute nasopharyngitis [common cold]', category: 'Respiratory', keywords: ['common cold', 'cold'] },
  { code: 'J02.9', title: 'Acute pharyngitis, unspecified', category: 'Respiratory', keywords: ['sore throat'] },
  { code: 'J03.90', title: 'Acute tonsillitis, unspecified', category: 'Respiratory', keywords: ['tonsillitis'] },
  { code: 'J06.9', title: 'Acute upper respiratory infection, unspecified', category: 'Respiratory', keywords: ['uri', 'urti'] },
  { code: 'J18.9', title: 'Pneumonia, unspecified organism', category: 'Respiratory', keywords: ['pneumonia', 'chest infection'] },
  { code: 'J45.909', title: 'Unspecified asthma, uncomplicated', category: 'Respiratory', keywords: ['asthma', 'wheezing'] },
  { code: 'J44.9', title: 'Chronic obstructive pulmonary disease, unspecified', category: 'Respiratory', keywords: ['copd'] },

  // --- Circulatory (I) ---
  { code: 'I10', title: 'Essential (primary) hypertension', category: 'Circulatory', keywords: ['hypertension', 'high blood pressure', 'htn', 'bp'] },
  { code: 'I20.9', title: 'Angina pectoris, unspecified', category: 'Circulatory', keywords: ['angina', 'chest pain cardiac'] },
  { code: 'I21.9', title: 'Acute myocardial infarction, unspecified', category: 'Circulatory', keywords: ['heart attack', 'mi', 'stemi'] },
  { code: 'I25.10', title: 'Atherosclerotic heart disease of native coronary artery', category: 'Circulatory', keywords: ['cad', 'coronary artery disease', 'ihd'] },
  { code: 'I48.91', title: 'Unspecified atrial fibrillation', category: 'Circulatory', keywords: ['afib', 'atrial fibrillation'] },
  { code: 'I50.9', title: 'Heart failure, unspecified', category: 'Circulatory', keywords: ['heart failure', 'chf', 'cardiac failure'] },
  { code: 'I63.9', title: 'Cerebral infarction, unspecified', category: 'Circulatory', keywords: ['stroke', 'cva', 'brain stroke'] },

  // --- Endocrine / metabolic (E) ---
  { code: 'E11.9', title: 'Type 2 diabetes mellitus without complications', category: 'Endocrine', keywords: ['diabetes', 'dm', 't2dm', 'sugar'] },
  { code: 'E10.9', title: 'Type 1 diabetes mellitus without complications', category: 'Endocrine', keywords: ['diabetes', 't1dm', 'iddm'] },
  { code: 'E03.9', title: 'Hypothyroidism, unspecified', category: 'Endocrine', keywords: ['hypothyroid', 'thyroid'] },
  { code: 'E05.90', title: 'Thyrotoxicosis, unspecified', category: 'Endocrine', keywords: ['hyperthyroid', 'thyrotoxicosis'] },
  { code: 'E78.5', title: 'Hyperlipidemia, unspecified', category: 'Endocrine', keywords: ['high cholesterol', 'dyslipidemia', 'lipid'] },
  { code: 'E86.0', title: 'Dehydration', category: 'Endocrine', keywords: ['dehydration', 'volume depletion'] },
  { code: 'E66.9', title: 'Obesity, unspecified', category: 'Endocrine', keywords: ['obesity', 'overweight'] },

  // --- Digestive (K) ---
  { code: 'K21.9', title: 'Gastro-esophageal reflux disease without esophagitis', category: 'Digestive', keywords: ['gerd', 'acidity', 'reflux'] },
  { code: 'K29.70', title: 'Gastritis, unspecified, without bleeding', category: 'Digestive', keywords: ['gastritis', 'acidity'] },
  { code: 'K30', title: 'Functional dyspepsia', category: 'Digestive', keywords: ['indigestion', 'dyspepsia'] },
  { code: 'K35.80', title: 'Unspecified acute appendicitis', category: 'Digestive', keywords: ['appendicitis'] },
  { code: 'K52.9', title: 'Noninfective gastroenteritis and colitis, unspecified', category: 'Digestive', keywords: ['gastroenteritis'] },
  { code: 'K80.20', title: 'Calculus of gallbladder without cholecystitis', category: 'Digestive', keywords: ['gallstones', 'cholelithiasis'] },

  // --- Genitourinary (N) ---
  { code: 'N39.0', title: 'Urinary tract infection, site not specified', category: 'Genitourinary', keywords: ['uti', 'urine infection'] },
  { code: 'N18.9', title: 'Chronic kidney disease, unspecified', category: 'Genitourinary', keywords: ['ckd', 'kidney disease', 'renal failure'] },
  { code: 'N20.0', title: 'Calculus of kidney', category: 'Genitourinary', keywords: ['kidney stone', 'renal calculus'] },

  // --- Musculoskeletal (M) ---
  { code: 'M54.5', title: 'Low back pain', category: 'Musculoskeletal', keywords: ['back pain', 'lumbago'] },
  { code: 'M54.2', title: 'Cervicalgia', category: 'Musculoskeletal', keywords: ['neck pain'] },
  { code: 'M25.50', title: 'Pain in unspecified joint', category: 'Musculoskeletal', keywords: ['joint pain', 'arthralgia'] },
  { code: 'M17.9', title: 'Osteoarthritis of knee, unspecified', category: 'Musculoskeletal', keywords: ['osteoarthritis', 'knee oa'] },

  // --- Mental / neuro (F/G) ---
  { code: 'F32.9', title: 'Major depressive disorder, single episode, unspecified', category: 'Mental health', keywords: ['depression'] },
  { code: 'F41.9', title: 'Anxiety disorder, unspecified', category: 'Mental health', keywords: ['anxiety'] },
  { code: 'F03.90', title: 'Unspecified dementia without behavioral disturbance', category: 'Mental health', keywords: ['dementia', 'memory loss'] },
  { code: 'G40.909', title: 'Epilepsy, unspecified, not intractable, without status epilepticus', category: 'Nervous system', keywords: ['epilepsy', 'seizure disorder'] },
  { code: 'G43.909', title: 'Migraine, unspecified, not intractable', category: 'Nervous system', keywords: ['migraine'] },

  // --- Skin (L) ---
  { code: 'L23.9', title: 'Allergic contact dermatitis, unspecified cause', category: 'Skin', keywords: ['skin allergy', 'allergic dermatitis', 'allergy'] },
  { code: 'L50.9', title: 'Urticaria, unspecified', category: 'Skin', keywords: ['hives', 'urticaria', 'itching', 'allergy'] },
  { code: 'L30.9', title: 'Dermatitis, unspecified', category: 'Skin', keywords: ['eczema', 'dermatitis', 'skin rash'] },
  { code: 'L03.90', title: 'Cellulitis, unspecified', category: 'Skin', keywords: ['cellulitis', 'skin infection'] },

  // --- Blood (D) ---
  { code: 'D50.9', title: 'Iron deficiency anemia, unspecified', category: 'Blood', keywords: ['anemia', 'anaemia', 'iron deficiency'] },
  { code: 'D64.9', title: 'Anemia, unspecified', category: 'Blood', keywords: ['anemia', 'anaemia', 'low hemoglobin'] },

  // --- Injury (S/T) ---
  { code: 'S06.0X0A', title: 'Concussion without loss of consciousness, initial encounter', category: 'Injury', keywords: ['head injury', 'concussion'] },
  { code: 'T78.40XA', title: 'Allergy, unspecified, initial encounter', category: 'Injury & external', keywords: ['allergy', 'allergic reaction'] },

  // --- Pregnancy / general encounter (Z) ---
  { code: 'Z00.00', title: 'Encounter for general adult medical exam without abnormal findings', category: 'Health status', keywords: ['health checkup', 'general examination'] },
  { code: 'Z34.90', title: 'Encounter for supervision of normal pregnancy, unspecified', category: 'Pregnancy', keywords: ['antenatal', 'pregnancy checkup'] },

  // The five illustrative numeric codes from the TRMS CDSS Level document used
  // to live here so the document's worked example resolved. They were removed
  // once the real WHO catalogue landed: `100 Fever` and `103 Malaria` carry
  // curated keywords, so they outranked R50.9 and B54 and became the top hit
  // for the two commonest OPD searches — while being codes no claim or
  // morbidity return would accept. See seeds/icd-retire-demo-codes.ts.
];
