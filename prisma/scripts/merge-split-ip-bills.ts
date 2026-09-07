/**
 * One-off repair: fold an IP stay's split bills back into a single bill.
 *
 * `getOrCreateRunningIpBill` used to reuse only a DRAFT bill, so every
 * "Generate / refresh bill" (which finalizes to `pending`) orphaned the running
 * bill and the next worklist load opened a fresh empty one. Charges landed on
 * whichever bill was current, scattering a single stay across several. The
 * worklist row then summed them all while naming only the first, so the collect
 * dialog showed a total the payment endpoint had to reject.
 *
 * The code no longer splits. This moves the already-split rows back together.
 *
 *   npm run db:merge-split-ip-bills          # dry run, writes nothing
 *   npm run db:merge-split-ip-bills -- --apply
 *
 * Rules:
 *  - Target = the EARLIEST open `IPW-` bill, so the number the desk already
 *    sees is the one that survives.
 *  - Only open (`draft` / `pending` / `partially_paid`) `IPW-` bills merge. A
 *    `paid` bill is a settled document and is left alone, as is any other
 *    series (`PH-`, `RUN-CM-`, `ADV-`).
 *  - A source under an insurance claim is SKIPPED — the claim was raised
 *    against those lines.
 *  - A source that was issued a GST invoice number is SKIPPED — cancelling an
 *    issued document needs a credit note, not a script.
 *  - Bill items, payments, refunds and discounts follow the money to the
 *    target; the emptied source is cancelled with a reason, never deleted.
 */
import { PrismaClient } from '@prisma/client';
import { recalculateBillTotalsPublic } from '../../src/modules/billing/billing.service';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const money = (v: unknown) => Number(v ?? 0).toFixed(2);

type Row = { id: string; billNumber: string; status: string; admissionId: string | null;
  totalAmount: unknown; amountPaid: unknown; balanceDue: unknown; invoiceNumber: string | null };

async function main() {
  const bills = (await prisma.bill.findMany({
    where: { admissionId: { not: null }, status: { in: ['draft', 'pending', 'partially_paid'] },
             billNumber: { startsWith: 'IPW-' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, billNumber: true, status: true, admissionId: true,
              totalAmount: true, amountPaid: true, balanceDue: true, invoiceNumber: true },
  })) as Row[];

  const byAdmission = new Map<string, Row[]>();
  for (const b of bills) {
    const k = b.admissionId!;
    if (!byAdmission.has(k)) byAdmission.set(k, []);
    byAdmission.get(k)!.push(b);
  }

  const split = [...byAdmission.entries()].filter(([, list]) => list.length > 1);
  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN — nothing will be written ===');
  console.log(`admissions with more than one open IP bill: ${split.length}\n`);

  let merged = 0, skipped = 0, moved = 0;

  for (const [admissionId, list] of split) {
    const [target, ...sources] = list;
    const mergeable: Row[] = [];
    const skippedHere: Row[] = [];
    console.log(`admission ${admissionId}`);
    console.log(`  KEEP  ${target.billNumber}  ${target.status}  total=${money(target.totalAmount)} paid=${money(target.amountPaid)} balance=${money(target.balanceDue)}`);

    for (const src of sources) {
      const [claims, items, payments] = await Promise.all([
        prisma.insuranceClaim.count({ where: { billId: src.id } }),
        prisma.billItem.count({ where: { billId: src.id } }),
        prisma.payment.count({ where: { billId: src.id } }),
      ]);

      if (claims > 0) {
        console.log(`  SKIP  ${src.billNumber}  — under ${claims} insurance claim(s)`);
        skippedHere.push(src); skipped++; continue;
      }
      if (src.invoiceNumber) {
        console.log(`  SKIP  ${src.billNumber}  — GST invoice ${src.invoiceNumber} already issued`);
        skippedHere.push(src); skipped++; continue;
      }

      console.log(`  MERGE ${src.billNumber}  ${src.status}  total=${money(src.totalAmount)} balance=${money(src.balanceDue)}  (${items} item(s), ${payments} payment(s)) -> ${target.billNumber}`);

      if (APPLY) {
        await prisma.$transaction(async (tx) => {
          await tx.billItem.updateMany({ where: { billId: src.id }, data: { billId: target.id } });
          await tx.payment.updateMany({ where: { billId: src.id }, data: { billId: target.id } });
          await tx.refund.updateMany({ where: { billId: src.id }, data: { billId: target.id } });
          await tx.discount.updateMany({ where: { billId: src.id }, data: { billId: target.id } });
          await tx.bill.update({
            where: { id: src.id },
            data: { status: 'cancelled',
                    cancellationReason: `Merged into ${target.billNumber} — an IP stay is one bill` },
          });
        });
      }
      mergeable.push(src);
      merged++; moved += items;
    }

    if (APPLY) {
      await recalculateBillTotalsPublic(target.id);
      const after = await prisma.bill.findUnique({
        where: { id: target.id },
        select: { status: true, totalAmount: true, amountPaid: true, balanceDue: true },
      });
      console.log(`  AFTER ${target.billNumber}  ${after!.status}  total=${money(after!.totalAmount)} paid=${money(after!.amountPaid)} balance=${money(after!.balanceDue)}`);
    } else {
      // Project from what will ACTUALLY move. Summing the whole list counted
      // the skipped bills too and overstated the result.
      const wouldTotal = Number(target.totalAmount) + mergeable.reduce((s, b) => s + Number(b.totalAmount), 0);
      const wouldBalance = Number(target.balanceDue) + mergeable.reduce((s, b) => s + Number(b.balanceDue), 0);
      console.log(`  AFTER ${target.billNumber}  (projected) total=${wouldTotal.toFixed(2)} balance=${wouldBalance.toFixed(2)}`);
      const stranded = skippedHere.reduce((s, b) => s + Number(b.balanceDue), 0);
      if (stranded > 0) {
        console.log(`  !!    ${stranded.toFixed(2)} stays on ${skippedHere.length} skipped bill(s) — NOT collectable through the IP dialog`);
      }
    }
    console.log('');
  }

  console.log(`${merged} bill(s) ${APPLY ? 'merged' : 'would merge'}, ${moved} item(s) moved, ${skipped} skipped.`);
  if (!APPLY) console.log('\nRe-run with --apply to write these changes.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
