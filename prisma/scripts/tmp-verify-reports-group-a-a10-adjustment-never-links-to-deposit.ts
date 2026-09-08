import 'dotenv/config';
import { prisma } from '../../src/config/database';

const T = '0ae28771-4678-4473-8807-74789e08346c';

async function main() {
  const pays: any[] = await prisma.$queryRawUnsafe(`
    select payment_type, status, transaction_id, amount, payment_date, gst_treatment, voucher_number,
           source_advance_payment_id
    from payments where tenant_id = '${T}' and payment_type = 'advance'
    order by payment_date`);
  console.log('advance-typed payments:', pays.length);
  for (const p of pays) console.log(' ', p.payment_type, p.status, p.transaction_id, String(p.amount), p.payment_date?.toISOString?.().slice(0,10), p.gst_treatment, p.voucher_number, p.source_advance_payment_id);

  const counts: any[] = await prisma.$queryRawUnsafe(`
    select coalesce(split_part(transaction_id,':',1),'(none)') as kind, payment_type, status, count(*), sum(amount)
    from payments where tenant_id='${T}' group by 1,2,3 order by 1,2`);
  console.log('\nall payments by kind:'); console.table(counts.map(c=>({...c, count:Number(c.count), sum:String(c.sum)})));

  const adms: any[] = await prisma.$queryRawUnsafe(`
    select count(*)::int n, sum(deposit_amount) s from admissions where tenant_id='${T}' and deposit_amount > 0`);
  console.log('\nadmissions holding deposits:', adms[0]);

  const rcpt: any[] = await prisma.$queryRawUnsafe(`
    select count(*)::int n from payments where tenant_id='${T}' and transaction_id like 'IPDEPRCPT:%'`);
  console.log('IPDEPRCPT rows:', rcpt[0].n);

  const { getAdvancesReport } = await import('../../src/modules/gst/gst-reports.service');
  const r: any = await getAdvancesReport(T, { from: '2026-04-01', to: '2027-03-31' });
  console.log('\nA-10 rows:', r.rows.length, 'summary:', JSON.stringify(r.summary));
  for (const row of r.rows) console.log('  row', row.source, row.date?.toISOString?.().slice(0,10), row.amount, row.gstTreatment, 'adjusted', row.adjusted, 'refunded', row.refunded, 'balance', row.balance, JSON.stringify(row.adjustments));

  const rAll: any = await getAdvancesReport(T, {});
  console.log('\nA-10 unfiltered rows:', rAll.rows.length, JSON.stringify(rAll.summary));
}
main().finally(() => prisma.$disconnect());
