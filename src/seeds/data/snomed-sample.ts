/**
 * Sample SNOMED CT data — a tiny hand-authored stand-in for the real RF2
 * release (SNOMED International, distributed in India via NRCeS/MLDS).
 *
 * The shape here mirrors the two RF2 source files exactly, so when the licensed
 * data arrives it drops straight into the same tables with no code change:
 *   • SAMPLE_SNOMED_DESCRIPTIONS  ← sct2_Description_Snapshot.txt   (search)
 *   • SAMPLE_SNOMED_ICD_MAPS      ← der2_...ExtendedMapSnapshot.txt (cross-map)
 *
 * ICD targets use ICD-10 to match the existing `icd_codes` catalog. The map
 * rows deliberately cover every engine scenario:
 *   1. Exact 1-to-1        (mapRule "TRUE")
 *   2. Rule-based          (age/gender context)
 *   3. Dual coding         (two mapGroups fire together)
 *   4. Candidate choices   (mapAdvice asks the UI to specify, e.g. laterality)
 *   5. Unmappable          (mapTarget null, mapAdvice "MAPPING NOT POSSIBLE")
 *
 * SNOMED concept IDs below are real; the codes/synonyms are illustrative.
 */

// RF2 typeId constants (from the SNOMED metadata concept space).
const FSN = '900000000000003001'; // Fully Specified Name
const SYN = '900000000000013009'; // Synonym

export interface SnomedDescriptionSeed {
  descriptionId: string;
  conceptId: string;
  term: string;
  typeId: string;
  active?: boolean;
}

export interface SnomedIcdMapSeed {
  refsetMemberId: string;
  referencedComponentId: string;
  mapGroup: number;
  mapPriority: number;
  mapRule: string | null;
  mapAdvice: string | null;
  mapTarget: string | null;
  active?: boolean;
}

// ── Descriptions (search vocabulary) ────────────────────────────────────────
// One row per term; a concept has its FSN plus every synonym so slang/shorthand
// still resolves to the same concept.
export const SAMPLE_SNOMED_DESCRIPTIONS: SnomedDescriptionSeed[] = [
  // 44054006 — Diabetes mellitus type 2  (scenario 1: 1-to-1)
  { descriptionId: '2530654013', conceptId: '44054006', term: 'Diabetes mellitus type 2 (disorder)', typeId: FSN },
  { descriptionId: '2530655012', conceptId: '44054006', term: 'Type 2 diabetes mellitus', typeId: SYN },
  { descriptionId: '2530656011', conceptId: '44054006', term: 'T2DM', typeId: SYN },
  { descriptionId: '2530657014', conceptId: '44054006', term: 'Adult-onset diabetes', typeId: SYN },

  // 59621000 — Essential hypertension  (scenario 1: 1-to-1)
  { descriptionId: '101291013', conceptId: '59621000', term: 'Essential hypertension (disorder)', typeId: FSN },
  { descriptionId: '101292018', conceptId: '59621000', term: 'Essential hypertension', typeId: SYN },
  { descriptionId: '101293011', conceptId: '59621000', term: 'High blood pressure', typeId: SYN },

  // 74929003 — Gastritis with bleeding  (scenario 1: 1-to-1)
  { descriptionId: '124981017', conceptId: '74929003', term: 'Acute gastritis with hemorrhage (disorder)', typeId: FSN },
  { descriptionId: '124982012', conceptId: '74929003', term: 'Gastritis with bleeding', typeId: SYN },

  // 22298006 — Myocardial infarction  (scenario 1: 1-to-1)
  { descriptionId: '751689013', conceptId: '22298006', term: 'Myocardial infarction (disorder)', typeId: FSN },
  { descriptionId: '751690019', conceptId: '22298006', term: 'Heart attack', typeId: SYN },
  { descriptionId: '751691010', conceptId: '22298006', term: 'MI', typeId: SYN },

  // 197927001 — Recurrent urinary tract infection  (scenario 2: gender rule)
  { descriptionId: '303270015', conceptId: '197927001', term: 'Recurrent urinary tract infection (disorder)', typeId: FSN },
  { descriptionId: '303271016', conceptId: '197927001', term: 'Recurrent UTI', typeId: SYN },

  // 421895002 — Diabetic cataract  (scenario 3: dual coding)
  { descriptionId: '2632310017', conceptId: '421895002', term: 'Cataract due to diabetes mellitus (disorder)', typeId: FSN },
  { descriptionId: '2632311018', conceptId: '421895002', term: 'Diabetic cataract', typeId: SYN },

  // 65966004 — Fracture of radius  (scenario 4: candidate choices / laterality)
  { descriptionId: '110210014', conceptId: '65966004', term: 'Fracture of radius (disorder)', typeId: FSN },
  { descriptionId: '110211015', conceptId: '65966004', term: 'Fractured radius', typeId: SYN },
  { descriptionId: '110212013', conceptId: '65966004', term: 'Broken forearm bone', typeId: SYN },

  // 300916003 — Latex allergy  (scenario 5: unmappable)
  { descriptionId: '446120018', conceptId: '300916003', term: 'Latex allergy (disorder)', typeId: FSN },
  { descriptionId: '446121017', conceptId: '300916003', term: 'Allergy to latex', typeId: SYN },
];

// ── Cross-map rows (SNOMED → ICD-10) ────────────────────────────────────────
export const SAMPLE_SNOMED_ICD_MAPS: SnomedIcdMapSeed[] = [
  // Scenario 1 — exact 1-to-1
  {
    refsetMemberId: 'map-44054006-1',
    referencedComponentId: '44054006',
    mapGroup: 1,
    mapPriority: 1,
    mapRule: 'TRUE',
    mapAdvice: 'ALWAYS E11',
    mapTarget: 'E11',
  },
  {
    refsetMemberId: 'map-59621000-1',
    referencedComponentId: '59621000',
    mapGroup: 1,
    mapPriority: 1,
    mapRule: 'TRUE',
    mapAdvice: 'ALWAYS I10',
    mapTarget: 'I10',
  },
  {
    refsetMemberId: 'map-74929003-1',
    referencedComponentId: '74929003',
    mapGroup: 1,
    mapPriority: 1,
    mapRule: 'TRUE',
    mapAdvice: 'ALWAYS K29.0',
    mapTarget: 'K29.0',
  },
  {
    refsetMemberId: 'map-22298006-1',
    referencedComponentId: '22298006',
    mapGroup: 1,
    mapPriority: 1,
    mapRule: 'TRUE',
    mapAdvice: 'ALWAYS I21.9',
    mapTarget: 'I21.9',
  },

  // Scenario 2 — rule-based (gender context). Priority 1 fires for the matching
  // sex; priority 2 is the OTHERWISE-TRUE fallback.
  {
    refsetMemberId: 'map-197927001-1',
    referencedComponentId: '197927001',
    mapGroup: 1,
    mapPriority: 1,
    mapRule: 'IFA 248152002 | Female |',
    mapAdvice: 'IF FEMALE CHOOSE N39.0',
    mapTarget: 'N39.0',
  },
  {
    refsetMemberId: 'map-197927001-2',
    referencedComponentId: '197927001',
    mapGroup: 1,
    mapPriority: 2,
    mapRule: 'OTHERWISE TRUE',
    mapAdvice: 'OTHERWISE N39.0',
    mapTarget: 'N39.0',
  },

  // Scenario 3 — dual coding: two groups both fire, saving two ICD codes.
  {
    refsetMemberId: 'map-421895002-1',
    referencedComponentId: '421895002',
    mapGroup: 1,
    mapPriority: 1,
    mapRule: 'TRUE',
    mapAdvice: 'ALWAYS E11.3',
    mapTarget: 'E11.3',
  },
  {
    refsetMemberId: 'map-421895002-2',
    referencedComponentId: '421895002',
    mapGroup: 2,
    mapPriority: 1,
    mapRule: 'TRUE',
    mapAdvice: 'ALWAYS H28',
    mapTarget: 'H28',
  },

  // Scenario 4 — candidate choices: same group, the UI must pick laterality.
  {
    refsetMemberId: 'map-65966004-1',
    referencedComponentId: '65966004',
    mapGroup: 1,
    mapPriority: 1,
    mapRule: 'TRUE',
    mapAdvice: 'MAP REQUIRES SPECIFICATION OF LATERALITY | LEFT',
    mapTarget: 'S52.31',
  },
  {
    refsetMemberId: 'map-65966004-2',
    referencedComponentId: '65966004',
    mapGroup: 1,
    mapPriority: 2,
    mapRule: 'TRUE',
    mapAdvice: 'MAP REQUIRES SPECIFICATION OF LATERALITY | RIGHT',
    mapTarget: 'S52.32',
  },
  {
    refsetMemberId: 'map-65966004-3',
    referencedComponentId: '65966004',
    mapGroup: 1,
    mapPriority: 3,
    mapRule: 'OTHERWISE TRUE',
    mapAdvice: 'UNSPECIFIED LATERALITY FALLBACK',
    mapTarget: 'S52.30',
  },

  // Scenario 5 — unmappable: no ICD target exists.
  {
    refsetMemberId: 'map-300916003-1',
    referencedComponentId: '300916003',
    mapGroup: 1,
    mapPriority: 1,
    mapRule: 'TRUE',
    mapAdvice: 'MAPPING NOT POSSIBLE',
    mapTarget: null,
  },
];
