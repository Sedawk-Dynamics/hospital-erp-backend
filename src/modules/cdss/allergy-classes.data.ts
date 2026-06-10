/**
 * Allergy drug-class rules. A documented allergy to any member of a class
 * should flag every other member (same-class identity) and, where clinically
 * established, cross-reacting classes (e.g. penicillin → cephalosporins).
 *
 * Matching is substring-based on the lowercased allergen string vs the
 * prescribed drug/generic name, same convention as the interaction data.
 */

export interface AllergyClassRule {
  className: string;
  /** Keywords that identify the class in the patient's allergy list. */
  allergenMatchers: string[];
  /** Drug name/generic keywords that belong to (or cross-react with) the class. */
  drugMatchers: string[];
  /**
   * true = established cross-reactivity with a *different* class — always a
   * warning, never an auto-block, regardless of allergy severity.
   */
  crossReactivity?: boolean;
  note: string;
}

export const ALLERGY_CLASS_RULES: AllergyClassRule[] = [
  {
    className: 'Penicillins',
    allergenMatchers: ['penicillin', 'amoxicillin', 'amoxycillin', 'ampicillin', 'augmentin', 'amoxiclav', 'amoxyclav', 'piperacillin', 'cloxacillin'],
    drugMatchers: ['penicillin', 'amoxicillin', 'amoxycillin', 'ampicillin', 'augmentin', 'amoxiclav', 'amoxyclav', 'piperacillin', 'tazobactam', 'cloxacillin', 'flucloxacillin', 'benzathine'],
    note: 'Same beta-lactam class as the documented allergen.',
  },
  {
    className: 'Penicillin → cephalosporin cross-reactivity',
    allergenMatchers: ['penicillin', 'amoxicillin', 'amoxycillin', 'ampicillin', 'augmentin', 'amoxiclav', 'amoxyclav'],
    drugMatchers: ['cefixime', 'ceftriaxone', 'cefuroxime', 'cefpodoxime', 'cephalexin', 'cefalexin', 'cefotaxime', 'cefoperazone', 'cefepime', 'cefazolin', 'cefdinir'],
    crossReactivity: true,
    note: 'Cephalosporin cross-reactivity in penicillin-allergic patients (~1–2%; higher for 1st-gen and anaphylactic history).',
  },
  {
    className: 'Sulfonamides',
    allergenMatchers: ['sulfa', 'sulpha', 'sulfonamide', 'sulfamethoxazole', 'cotrimoxazole', 'co-trimoxazole', 'septran', 'bactrim'],
    drugMatchers: ['sulfamethoxazole', 'cotrimoxazole', 'co-trimoxazole', 'trimethoprim-sulfa', 'sulfasalazine', 'sulfadiazine', 'sulfadoxine'],
    note: 'Antibiotic sulfonamide class — risk of severe cutaneous reactions (SJS/TEN).',
  },
  {
    className: 'Sulfonamide → dapsone cross-reactivity',
    allergenMatchers: ['sulfa', 'sulpha', 'sulfonamide', 'sulfamethoxazole', 'cotrimoxazole'],
    drugMatchers: ['dapsone'],
    crossReactivity: true,
    note: 'Dapsone shares the arylamine group with antibiotic sulfonamides; use with caution.',
  },
  {
    className: 'NSAIDs',
    allergenMatchers: ['nsaid', 'aspirin', 'ibuprofen', 'diclofenac', 'naproxen', 'nimesulide', 'mefenamic'],
    drugMatchers: ['ibuprofen', 'diclofenac', 'aceclofenac', 'naproxen', 'ketorolac', 'indomethacin', 'piroxicam', 'mefenamic', 'nimesulide', 'etoricoxib', 'celecoxib', 'aspirin'],
    note: 'NSAID hypersensitivity is typically class-wide (COX-1 mediated pseudo-allergy).',
  },
  {
    className: 'Opioids',
    allergenMatchers: ['opioid', 'morphine', 'codeine', 'tramadol', 'pethidine'],
    drugMatchers: ['morphine', 'codeine', 'tramadol', 'fentanyl', 'oxycodone', 'hydromorphone', 'pethidine', 'buprenorphine', 'tapentadol'],
    note: 'Opioid class reaction — true IgE allergy is rare but histamine-release reactions recur across the class.',
  },
  {
    className: 'Fluoroquinolones',
    allergenMatchers: ['quinolone', 'fluoroquinolone', 'ciprofloxacin', 'levofloxacin', 'ofloxacin', 'norfloxacin'],
    drugMatchers: ['ciprofloxacin', 'levofloxacin', 'ofloxacin', 'moxifloxacin', 'norfloxacin', 'gemifloxacin'],
    note: 'Fluoroquinolone class — high cross-reactivity between members.',
  },
  {
    className: 'Macrolides',
    allergenMatchers: ['macrolide', 'erythromycin', 'azithromycin', 'clarithromycin'],
    drugMatchers: ['erythromycin', 'azithromycin', 'clarithromycin', 'roxithromycin'],
    note: 'Macrolide class allergy.',
  },
  {
    className: 'Tetracyclines',
    allergenMatchers: ['tetracycline', 'doxycycline', 'minocycline'],
    drugMatchers: ['tetracycline', 'doxycycline', 'minocycline', 'tigecycline'],
    note: 'Tetracycline class allergy.',
  },
  {
    className: 'Local anesthetics (amide)',
    allergenMatchers: ['lignocaine', 'lidocaine', 'bupivacaine', 'local anesthetic', 'local anaesthetic'],
    drugMatchers: ['lignocaine', 'lidocaine', 'bupivacaine', 'ropivacaine', 'prilocaine'],
    note: 'Amide local-anesthetic class reaction.',
  },
];

/** Find class rules triggered by a documented allergen string. */
export function findAllergyClassRules(allergen: string): AllergyClassRule[] {
  const a = allergen.toLowerCase();
  return ALLERGY_CLASS_RULES.filter((rule) =>
    rule.allergenMatchers.some((m) => a.includes(m)),
  );
}

/** Does a prescribed drug (brand or generic) fall inside a class rule? */
export function drugInAllergyClass(rule: AllergyClassRule, ...names: Array<string | null | undefined>) {
  return names.some((name) => {
    if (!name) return false;
    const n = name.toLowerCase();
    return rule.drugMatchers.some((m) => n.includes(m));
  });
}
