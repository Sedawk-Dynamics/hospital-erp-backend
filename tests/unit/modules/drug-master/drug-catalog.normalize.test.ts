import { describe, it, expect } from 'vitest';
import {
  TEMPLATE_PLACEHOLDER,
  templateText,
  renderTemplate,
  listText,
  titleCaseWords,
  parseMrp,
  cleanCountry,
  categoryTrail,
  parseFactBox,
  parseSafetyAdvice,
  parseInteractions,
  interactionSummary,
  mapVendorForm,
  resolveCatalogPackSize,
  normalizeVendorRow,
  monographTexts,
  detectKind,
  parseVendorCsv,
  structureSection,
  plainText,
} from '../../../../src/modules/drug-master/drug-catalog.normalize';

// Rows as they appear in the June 2026 vendor drop.
const ACENAC = {
  'Product ID': 'DRS003256',
  'Product Name': 'Acenac Tablet',
  Marketer: 'Medley Pharmaceuticals',
  Composition: 'Aceclofenac (100mg)',
  medicine_type: 'drugs',
  'Packaging Detail': 'strip of 10 tablets',
  Package: 'Strip',
  Qty: '10',
  'Product Form': 'Tablet',
  MRP: '55.78',
  prescription_required: 'Prescription Required',
  Fact_Box:
    "Chemical Class :: Dichlorobenzenes|Habit Forming :: No|Therapeutic Class :: PAIN ANALGESICS|Action Class :: NSAID's- Non-Selective COX 1&2 Inhibitors (acetic acid)",
  primary_use: 'Pain relief',
  storage: 'Store below 25°C',
  side_effect: 'Vomiting | Stomach pain/epigastric pain | Nausea',
  alcoholInteraction: 'CONSULT YOUR DOCTOR',
  pregnancyInteraction: 'CONSULT YOUR DOCTOR',
  lactationInteraction: 'CAUTION',
  drivingInteraction: 'UNSAFE',
  kidneyInteraction: 'CAUTION',
  liverInteraction: 'CAUTION',
  country_of_origin: 'India',
  Introduction: 'Acenac Tablet is a pain-relieving medicine.',
};

const CAMEL_MILK = {
  'Product ID': 'DR001835',
  name: 'Aadvik Camel Milk Powder Freeze Dried',
  Category:
    'Home > Diabetes > Diabetic Diet > Diabetic Nutrition Supplements > Aadvik Camel Milk Powder Freeze Dried',
  'Marketing Company': 'Aadvik Foods & Products Pvt Ltd',
  type: 'Diabetic Nutrition Supplements',
  Packaging: 'Packet of 500 gm Powder',
  Package: 'Packet',
  Qty: '500 gm',
  'Product Form': 'Powder',
  MRP: '3135.0',
  'Key Ingredients': 'Camel Milk Powder (Freeze-dried)',
  country_of_origin: 'India',
};

describe('shared texts', () => {
  it('takes the product name out and puts it back byte for byte', () => {
    const text = 'Acenac Tablet is a pain-relieving medicine. Take Acenac Tablet with food.';
    const t = templateText(text, 'Acenac Tablet');
    expect(t).toBe(`${TEMPLATE_PLACEHOLDER} is a pain-relieving medicine. Take ${TEMPLATE_PLACEHOLDER} with food.`);
    expect(renderTemplate(t, 'Acenac Tablet')).toBe(text);
  });

  it('lets two brands of one molecule share a single text', () => {
    expect(templateText('Acenac Tablet relieves pain.', 'Acenac Tablet')).toBe(
      templateText('Zynac Tablet relieves pain.', 'Zynac Tablet'),
    );
  });

  it('round-trips even when the name is inside other words', () => {
    const text = 'Acen relieves pain. Acenaclofen is different.';
    expect(renderTemplate(templateText(text, 'Acen'), 'Acen')).toBe(text);
  });

  it('leaves a name too short or too long to store untouched', () => {
    expect(templateText('Ac is short', 'Ac')).toBe('Ac is short');
    const long = 'x'.repeat(256);
    expect(templateText(`${long} text`, long)).toBe(`${long} text`);
  });
});

describe('field readers', () => {
  it('joins the vendor lists with a separator that does not occur inside items', () => {
    expect(listText('Vomiting | Stomach pain/epigastric pain|Nausea ')).toBe(
      'Vomiting; Stomach pain/epigastric pain; Nausea',
    );
    expect(listText('')).toBeNull();
  });

  it('spells a package one way', () => {
    expect(titleCaseWords('Prefilled syringe')).toBe('Prefilled Syringe');
    expect(titleCaseWords('pump bottle')).toBe('Pump Bottle');
    expect(titleCaseWords(null)).toBeNull();
  });

  it('reads an MRP, treating zero and nonsense as no price', () => {
    expect(parseMrp('55.78')).toBe(55.78);
    expect(parseMrp('3135.0')).toBe(3135);
    expect(parseMrp('0')).toBeNull();
    expect(parseMrp('abc')).toBeNull();
    expect(parseMrp('123456789')).toBeNull();
  });

  it('refuses an address fragment where a country belongs', () => {
    expect(cleanCountry('India')).toBe('India');
    expect(cleanCountry('</strong> 5th Floor Tower - B, Gurugram, Haryana-122001, India')).toBeNull();
  });

  it('turns the breadcrumb into a category path without "Home" or the product', () => {
    expect(categoryTrail(CAMEL_MILK.Category, CAMEL_MILK.name)).toBe(
      'Diabetes > Diabetic Diet > Diabetic Nutrition Supplements',
    );
    expect(categoryTrail(null, 'x')).toBeNull();
  });

  it('reads the fact box', () => {
    expect(parseFactBox(ACENAC.Fact_Box)).toEqual({
      therapeuticClass: 'PAIN ANALGESICS',
      chemicalClass: 'Dichlorobenzenes',
      actionClass: "NSAID's- Non-Selective COX 1&2 Inhibitors (acetic acid)",
      habitForming: false,
    });
    expect(parseFactBox('Habit Forming :: Yes|Therapeutic Class :: NEURO CNS').habitForming).toBe(true);
    expect(parseFactBox(null).therapeuticClass).toBeNull();
  });

  it('keeps the six safety verdicts and drops a word it does not know', () => {
    expect(parseSafetyAdvice(ACENAC)).toEqual({
      alcohol: 'consult_doctor',
      pregnancy: 'consult_doctor',
      lactation: 'caution',
      driving: 'unsafe',
      kidney: 'caution',
      liver: 'caution',
    });
    expect(parseSafetyAdvice({ alcoholInteraction: 'MAYBE', liverInteraction: 'NOT RELEVANT' })).toEqual({
      liver: 'not_relevant',
    });
    expect(parseSafetyAdvice({})).toBeNull();
  });
});

describe('interactions', () => {
  it('reads the molecule layout, keeping a bracket that is not a route in the name', () => {
    const list = parseInteractions(
      '-Tacrolimus (Oral Route): Severe <p> Monitor kidney function. <p> | ' +
        '-Cholera Vaccine (Inactivated) (Oral Route): Severe <p> Talk to your doctor. <p> | ' +
        '-Heparin (None): Moderate <p> Watch for bleeding. <p>',
    );
    expect(list).toEqual([
      { drug: 'Tacrolimus', route: 'Oral Route', severity: 'Severe', advice: 'Monitor kidney function.' },
      { drug: 'Cholera Vaccine (Inactivated)', route: 'Oral Route', severity: 'Severe', advice: 'Talk to your doctor.' },
      { drug: 'Heparin', route: null, severity: 'Moderate', advice: 'Watch for bleeding.' },
    ]);
  });

  it('does not cut an entry in two at a "|" inside its advice', () => {
    const list = parseInteractions(
      '-Warfarin (Oral Route): Severe <p> Monitor INR | adjust the dose <p> | -Aspirin (Oral Route): Moderate <p> Avoid. <p>',
    );
    expect(list.map((i) => i.drug)).toEqual(['Warfarin', 'Aspirin']);
    expect(list[0].advice).toBe('Monitor INR | adjust the dose');
  });

  it('reads the brand layout, naming the other product', () => {
    const templated = parseInteractions(
      `${TEMPLATE_PLACEHOLDER} & Regubeat 100mg Tablet : <p> Avoid together. | ${TEMPLATE_PLACEHOLDER} & Atazor 200mg Capsule : <p> Avoid.`,
    );
    expect(templated.map((i) => i.drug)).toEqual(['Regubeat 100mg Tablet', 'Atazor 200mg Capsule']);
    const plain = parseInteractions('Regubeat 100mg Tablet & 2-Pnol Tablet 20 : <p> Avoid.', '2-Pnol Tablet 20');
    expect(plain[0].drug).toBe('Regubeat 100mg Tablet');
  });

  it('summarises into the { drug[], effect[] } shape the column has always had', () => {
    const list = parseInteractions(
      '-Isosorbide Dinitrate (Oral Route): Life-threatening <p> a <p> | -Isosorbide Dinitrate (Sublingual route): Life-threatening <p> b <p> | -Ranolazine (Oral Route): Severe <p> c <p>',
    );
    expect(interactionSummary(list)).toEqual({
      drug: ['Isosorbide Dinitrate', 'Ranolazine'],
      effect: ['Life-threatening', 'Severe'],
    });
    expect(interactionSummary([])).toBeNull();
  });
});

describe('dosage form', () => {
  it('reads a drug form in full', () => {
    expect(mapVendorForm('drug', 'Tablet SR', 'x', null)).toBe('tablet');
    expect(mapVendorForm('drug', 'Soft Gelatin Capsule', 'x', null)).toBe('capsule');
    expect(mapVendorForm('drug', 'Rotacap', 'x', null)).toBe('inhaler');
    expect(mapVendorForm('drug', 'Powder for Injection', 'x', null)).toBe('injection');
    expect(mapVendorForm('drug', 'Oral Suspension', 'x', null)).toBe('syrup');
    expect(mapVendorForm('drug', 'Eye Drop', 'x', null)).toBe('drops');
    expect(mapVendorForm('drug', 'Nasal Spray', 'x', null)).toBe('drops');
    expect(mapVendorForm('drug', 'Gel', 'x', null)).toBe('cream');
    expect(mapVendorForm('drug', 'Eye Ointment', 'x', null)).toBe('cream');
    expect(mapVendorForm('drug', 'Mouth Wash', 'x', null)).toBe('other');
  });

  it('falls back to the name when the vendor gives no form', () => {
    expect(mapVendorForm('drug', null, 'Dolo 650 Tablet', 'strip of 15 tablets')).toBe('tablet');
  });

  it('reads an OTC form narrowly — a cream or a liquid is not assumed to be a medicine', () => {
    expect(mapVendorForm('otc', 'Tablet', 'x', null)).toBe('tablet');
    expect(mapVendorForm('otc', 'Syrup', 'x', null)).toBe('syrup');
    expect(mapVendorForm('otc', 'Oral Drop', 'x', null)).toBe('drops');
    expect(mapVendorForm('otc', 'Cream', 'x', null)).toBe('other');
    expect(mapVendorForm('otc', 'Liquid', 'x', null)).toBe('other');
    expect(mapVendorForm('otc', 'Powder', 'x', null)).toBe('other');
    expect(mapVendorForm('otc', null, 'x', null)).toBe('other');
  });
});

describe('pack size', () => {
  it('reads the label first, exactly as before', () => {
    expect(resolveCatalogPackSize('tablet', 'strip of 10 tablets', '10')).toBe(10);
    expect(resolveCatalogPackSize('tablet', 'bottle of 30 tablets', '30')).toBe(30);
  });

  it('uses the vendor count for a strip the label parser cannot read', () => {
    expect(resolveCatalogPackSize('capsule', 'strip of 15 soft gelatin capsules', '15')).toBe(15);
    expect(resolveCatalogPackSize('tablet', 'strip of 14 tablet dt', '14.0')).toBe(14);
  });

  it('falls back to a typical strip, and never splits a container', () => {
    expect(resolveCatalogPackSize('tablet', 'strip of tablets', null)).toBe(10);
    expect(resolveCatalogPackSize('syrup', 'bottle of 100 ml Syrup', '100 ml')).toBeNull();
    expect(resolveCatalogPackSize('injection', 'vial of 2 ml Injection', '2 ml')).toBeNull();
  });
});

describe('normalizeVendorRow', () => {
  it('reads a drug row', () => {
    expect(normalizeVendorRow('drug', ACENAC)).toMatchObject({
      kind: 'drug',
      type: 'drug',
      sourceId: 'DRS003256',
      name: 'Acenac Tablet',
      genericName: 'Aceclofenac (100mg)',
      saltComposition: 'Aceclofenac (100mg)',
      manufacturer: 'Medley Pharmaceuticals',
      dosageForm: 'tablet',
      packSizeLabel: 'strip of 10 tablets',
      packSize: 10,
      mrp: 55.78,
      packageType: 'Strip',
      packQuantity: '10',
      productForm: 'Tablet',
      rxRequired: true,
      habitForming: false,
      therapeuticClass: 'PAIN ANALGESICS',
      storage: 'Store below 25°C',
      countryOfOrigin: 'India',
      description: 'Pain relief',
      sideEffects: 'Vomiting; Stomach pain/epigastric pain; Nausea',
      productCategory: null,
    });
  });

  it('builds search tokens the way every other catalogue write does', () => {
    expect(normalizeVendorRow('drug', ACENAC)!.searchTokens).toBe(
      'acenac tablet | aceclofenac (100mg) | medley pharmaceuticals',
    );
  });

  it('reads a drug with no prescription line as not prescription-only', () => {
    expect(normalizeVendorRow('drug', { ...ACENAC, prescription_required: undefined })!.rxRequired).toBe(false);
  });

  it('reads an OTC row, keeping its ingredients out of the composition', () => {
    const p = normalizeVendorRow('otc', CAMEL_MILK)!;
    expect(p).toMatchObject({
      kind: 'otc',
      type: 'otc',
      sourceId: 'DR001835',
      genericName: null,
      saltComposition: null,
      manufacturer: 'Aadvik Foods & Products Pvt Ltd',
      dosageForm: 'other',
      packSize: null,
      mrp: 3135,
      rxRequired: false,
      productCategory: 'Diabetic Nutrition Supplements',
      categoryPath: 'Diabetes > Diabetic Diet > Diabetic Nutrition Supplements',
      safetyAdvice: null,
      description: null,
    });
    expect(monographTexts('otc', CAMEL_MILK)).toEqual({ ingredients: 'Camel Milk Powder (Freeze-dried)' });
  });

  it('skips a blank line and clamps a name to the column', () => {
    expect(normalizeVendorRow('drug', { 'Product ID': 'DRS1' })).toBeNull();
    expect(normalizeVendorRow('otc', { ...CAMEL_MILK, name: 'y'.repeat(300) })!.name).toHaveLength(255);
  });
});

describe('vendor CSV upload', () => {
  it('tells the two layouts apart and refuses anything else', () => {
    expect(detectKind(['Product ID', 'Product Name', 'Composition'])).toBe('drug');
    expect(detectKind(['Product ID', 'name', 'Marketing Company'])).toBe('otc');
    expect(detectKind(['name', 'price', 'manufacturer_name'])).toBeNull();
  });

  it('reads a CSV whatever the case of its headers', () => {
    const csv =
      'product id,Product Name,marketer,Composition,Packaging Detail,Package,Qty,Product Form,MRP,prescription_required,Introduction\n' +
      'DRS003256,Acenac Tablet,Medley Pharmaceuticals,Aceclofenac (100mg),strip of 10 tablets,Strip,10,Tablet,55.78,Prescription Required,"Acenac Tablet is a pain-relieving medicine, taken with food."\n';
    const rows = parseVendorCsv(csv)!;
    expect(rows).toHaveLength(1);
    expect(rows[0].product).toMatchObject({ sourceId: 'DRS003256', manufacturer: 'Medley Pharmaceuticals', packSize: 10 });
    expect(rows[0].texts).toEqual({ intro: 'Acenac Tablet is a pain-relieving medicine, taken with food.' });
  });

  it('returns null for a file in some other layout', () => {
    expect(parseVendorCsv('name,price\nDolo,30\n')).toBeNull();
  });
});

describe('structureSection', () => {
  it('splits questions from answers', () => {
    expect(structureSection('faq', 'Is it safe?::: Yes.| Can I stop?::: Ask your doctor.')).toEqual({
      type: 'faq',
      items: [
        { question: 'Is it safe?', answer: 'Yes.' },
        { question: 'Can I stop?', answer: 'Ask your doctor.' },
      ],
    });
  });

  it('splits the safety advice into verdicts', () => {
    const block = structureSection(
      'safetyAdvice',
      '- Alcohol : SAFE <p> Alcohol causes no harm. | - Breast feeding : CONSULT YOUR DOCTOR <p> Not known.',
    );
    expect(block).toEqual({
      type: 'verdicts',
      items: [
        { topic: 'Alcohol', verdict: 'SAFE', text: 'Alcohol causes no harm.' },
        { topic: 'Breast feeding', verdict: 'CONSULT YOUR DOCTOR', text: 'Not known.' },
      ],
    });
  });

  it('never passes markup through', () => {
    expect(structureSection('intro', 'First <strong>part</strong>.<p>Second &amp; last.')).toEqual({
      type: 'paragraphs',
      paragraphs: ['First part .', 'Second & last.'],
    });
    expect(plainText('a<br/>b')).toBe('a b');
  });

  it('lists highlights and the marketer', () => {
    expect(structureSection('highlights', 'Pure | Natural')).toEqual({ type: 'list', items: ['Pure', 'Natural'] });
    expect(structureSection('marketer', 'Medley | Mumbai-400 093')).toEqual({
      type: 'list',
      items: ['Medley', 'Mumbai-400 093'],
    });
  });
});
