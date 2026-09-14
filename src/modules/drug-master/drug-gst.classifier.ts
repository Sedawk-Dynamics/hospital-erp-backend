/**
 * GST defaults for the vendor medicine catalogue.
 *
 * The June 2026 vendor files contain product identity and clinical facts but no
 * HSN/GST columns. A catalogue refresh therefore used to replace a useful drug
 * master with ~399k medicine rows that could not be billed. This classifier
 * supplies only facts that can be inferred safely from that dataset:
 *
 *   - vendor `drug` rows are finished medicaments for retail sale (HSN 3004);
 *   - ORS has its specific tariff item, so the HSN master can apply its rate;
 *   - the medicines named in Notification 10/2025-CT(R), Schedule S. No. 113,
 *     carry an explicit product-level exemption because their HSN alone cannot
 *     express it;
 *   - OTC/wellness products are not guessed. Their rates vary by actual HSN and
 *     they remain visibly unclassified until a pharmacist records that code.
 *
 * Ordinary medicines deliberately have no explicit treatment. Their rate is
 * resolved from the HSN master at billing time, so a later statutory HSN-rate
 * change takes effect without rewriting hundreds of thousands of products.
 */

import type { GstTreatment } from '../../shared/gst';

export const DRUG_GST_CLASSIFIER_VERSION = 2;
// Use the defensible 4-digit finished-medicament heading. The vendor does not
// provide enough tariff detail to invent an 8-digit subheading for every brand.
export const GENERIC_MEDICAMENT_HSN = '3004';
export const ORS_HSN = '30049010';
export const INSULIN_HSN = '30043110';

// Annexure I to Notification 10/2025-Central Tax (Rate), effective 22-09-2025.
// Normalised matching is against the vendor's Composition field. Both common
// spellings are included where the notification and catalogues vary (alfa/alpha,
// cysteamine/cystamine, C1/CI inhibitor).
export const NOTIFIED_EXEMPT_MEDICINES = [
  'gene therapy',
  'agalsidase beta',
  'imiglucerase',
  'eptacog alfa activated recombinant coagulation factor viia',
  'eptacogalfa activated recombinant coagulation factor viia',
  'onasemnogene abeparvovec',
  'asciminib',
  'mepolizumab',
  'pegylated liposomal irinotecan',
  'daratumumab',
  'daratumumab subcutaneous',
  'teclistamab',
  'amivantamab',
  'alectinib',
  'risdiplam',
  'obinutuzumab',
  'polatuzumab vedotin',
  'entrectinib',
  'atezolizumab',
  'spesolimab',
  'velaglucerase alfa',
  'velaglucerase alpha',
  'agalsidase alfa',
  'agalsidase alpha',
  'rurioctocog alfa pegol',
  'rurioctocog alpha pegol',
  'idursulfase',
  'idursulphatase',
  'alglucosidase alfa',
  'alglucosidase alpha',
  'laronidase',
  'olipudase alfa',
  'olipudase alpha',
  'tepotinib',
  'avelumab',
  'emicizumab',
  'belumosudil',
  'miglustat',
  'velmanase alfa',
  'velmanase alpha',
  'alirocumab',
  'evolocumab',
  'cysteamine bitartrate',
  'cystamine bitartrate',
  'c1 inhibitor injection',
  'ci inhibitor injection',
  'inclisiran',
] as const;

/** Lowercase letters/numbers only, with punctuation folded to one space. */
export function normalizeMedicineName(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsTerm(haystack: string, term: string): boolean {
  return (` ${haystack} `).includes(` ${term} `);
}

export function isNotifiedExemptMedicine(input: {
  name?: string | null;
  genericName?: string | null;
  saltComposition?: string | null;
}): boolean {
  const value = normalizeMedicineName(
    `${input.name ?? ''} ${input.genericName ?? ''} ${input.saltComposition ?? ''}`,
  );
  return NOTIFIED_EXEMPT_MEDICINES.some((name) => containsTerm(value, name));
}

export function isOrsMedicine(input: {
  name?: string | null;
  genericName?: string | null;
  saltComposition?: string | null;
}): boolean {
  const value = normalizeMedicineName(
    `${input.name ?? ''} ${input.genericName ?? ''} ${input.saltComposition ?? ''}`,
  );
  return (
    containsTerm(value, 'ors') ||
    value.includes('oral rehydration') ||
    value.includes('rehydration salt') ||
    containsTerm(value, 'electral')
  );
}

export function isInsulinMedicine(input: {
  name?: string | null;
  genericName?: string | null;
  saltComposition?: string | null;
}): boolean {
  const value = normalizeMedicineName(
    `${input.name ?? ''} ${input.genericName ?? ''} ${input.saltComposition ?? ''}`,
  );
  return containsTerm(value, 'insulin') || value.includes('insulin ');
}

export interface InferredDrugGst {
  hsnCode: string;
  gstRate: number;
  /** Null means the HSN master remains authoritative. */
  gstTreatment: GstTreatment | null;
  classifierVersion: number;
  reason: string;
}

export function inferCatalogDrugGst(input: {
  type?: string | null;
  name?: string | null;
  genericName?: string | null;
  saltComposition?: string | null;
}): InferredDrugGst | null {
  if (String(input.type ?? '').toLowerCase() === 'otc') return null;

  if (isOrsMedicine(input)) {
    return {
      hsnCode: ORS_HSN,
      gstRate: 5,
      gstTreatment: null,
      classifierVersion: DRUG_GST_CLASSIFIER_VERSION,
      reason: 'Oral rehydration salts — taxable at 5% under the current medicine schedule',
    };
  }

  const exempt = isNotifiedExemptMedicine(input);
  return {
    hsnCode: isInsulinMedicine(input) ? INSULIN_HSN : GENERIC_MEDICAMENT_HSN,
    gstRate: exempt ? 0 : 5,
    gstTreatment: exempt ? 'exempt' : null,
    classifierVersion: DRUG_GST_CLASSIFIER_VERSION,
    reason: exempt
      ? 'Exempt medicine named in Annexure I to Notification 10/2025-CT(R)'
      : 'Finished medicament; rate resolved from HSN master',
  };
}
