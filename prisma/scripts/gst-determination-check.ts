/**
 * Walk the tax determination rules against the LIVE masters and the LIVE
 * hospital profile, and print what the engine decides for each.
 *
 * Not an HTTP e2e — it calls the resolver directly, because what is being
 * checked is the rule set, not a route. The value is that it shows the whole
 * decision table on one screen, so a wrong answer is obvious: the same strip
 * must be taxable at the counter and exempt in the ward, ORS must follow its
 * specific tariff item, a general bed must be exempt while a deluxe one is
 * not, and an
 * unmapped taxable item must be flagged rather than quietly billed.
 *
 * Run with `npm run db:check-gst-determination`. Read-only — it writes nothing.
 */
import 'dotenv/config';
import { prisma } from '../../src/config/database';
import { taxResolverFor } from '../../src/modules/gst/gst-resolver.service';

const TENANT = '0ae28771-4678-4473-8807-74789e08346c'; // Green city Hospital

async function main() {
  const r = await taxResolverFor(TENANT);
  console.log('profile:', r.profile.registered, r.profile.gstin, r.profile.stateName, '| from', r.profile.effectiveFrom);
  console.log('');

  const cases: Array<[string, Parameters<typeof r.determine>[0], { unitPrice: number; quantity: number }]> = [
    ['Paracetamol at the counter',        { kind: 'medicine', hsnCode: '30049099', taxInclusive: true }, { unitPrice: 20, quantity: 2 }],
    ['Same strip to an admitted patient', { kind: 'medicine', hsnCode: '30049099', taxInclusive: true, patientAdmitted: true, issuedForTreatment: true }, { unitPrice: 20, quantity: 2 }],
    ['Discharge medicine (take home)',    { kind: 'medicine', hsnCode: '30049099', taxInclusive: true, patientAdmitted: true, issuedForTreatment: true, isTakeHome: true }, { unitPrice: 20, quantity: 2 }],
    ['ORS sachets',                       { kind: 'medicine', hsnCode: '30049010', taxInclusive: true }, { unitPrice: 22, quantity: 5 }],
    ['Protein supplement',                { kind: 'medicine', hsnCode: '21069099', taxInclusive: true }, { unitPrice: 850, quantity: 1 }],
    ['Consultation',                      { kind: 'consultation', sacCode: '999312' }, { unitPrice: 500, quantity: 1 }],
    ['Lab test',                          { kind: 'lab', sacCode: '999316' }, { unitPrice: 450, quantity: 2 }],
    ['General ward bed, 1500/day',        { kind: 'room', sacCode: '996311', dailyRate: 1500, wardType: 'general' }, { unitPrice: 1500, quantity: 3 }],
    ['Deluxe room, 6000/day',             { kind: 'room', sacCode: '996311', dailyRate: 6000, wardType: 'private' }, { unitPrice: 6000, quantity: 3 }],
    ['ICU bed, 12000/day',                { kind: 'room', sacCode: '996311', dailyRate: 12000, wardType: 'icu', bedType: 'icu' }, { unitPrice: 12000, quantity: 2 }],
    ['Cosmetic procedure',                { kind: 'procedure', sacCode: '999319', isCosmetic: true }, { unitPrice: 20000, quantity: 1 }],
    ['Therapeutic surgery',               { kind: 'procedure', sacCode: '9993' }, { unitPrice: 35000, quantity: 1 }],
    ['Canteen sale',                      { kind: 'other', sacCode: '996332' }, { unitPrice: 200, quantity: 1 }],
    ['Unmapped item, no code',            { kind: 'other' }, { unitPrice: 300, quantity: 1 }],
  ];

  const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
  console.log(pad('SUPPLY', 34), pad('TREATMENT', 11), pad('RATE', 6), pad('TAXABLE', 10), pad('TAX', 9), pad('TOTAL', 10), 'SOURCE / why');
  console.log('-'.repeat(140));
  for (const [label, ctx, money] of cases) {
    const { determination: d, money: m } = r.price(ctx, money);
    console.log(
      pad(label, 34),
      pad(d.treatment, 11),
      pad(d.ratePercent + '%', 6),
      pad(m.taxableValue.toFixed(2), 10),
      pad(m.taxAmount.toFixed(2), 9),
      pad(m.totalAmount.toFixed(2), 10),
      d.source + (d.requiresResolution ? '  [NEEDS RESOLUTION]' : ''),
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
