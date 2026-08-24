// ---------------------------------------------------------------------------
// Finding the bill a ward-side charge belongs on.
//
// Several paths post a charge as it happens — a ward stock dispense, a ward
// indent issue, a ward prescription dispense, an NDPS bedside dose — and each
// one has to answer the same question: which of this patient's bills is still
// open?
//
// Two things make the naive answer wrong.
//
// 1. THE ADVANCE BUCKET IS NOT A BILL. A patient's advance money lives on a
//    sentinel `ADV-…` bill so it can reuse the Payment/Receipt machinery. It is
//    created once per patient, sits at `status: 'pending'` for good, and its
//    `amountPaid` IS the running advance balance. So it matches a plain
//    "open bill" filter, and because the desk usually collects the advance
//    partway through a stay it is often the NEWEST match — meaning
//    `orderBy: createdAt desc` picked it in preference to the real IP bill.
//    The charge then vanished: every bill list excludes `ADV-` deliberately
//    (see NOT_ADVANCE_BUCKET in billing.service), and the bucket carries no
//    admissionId, so it was off the IP ledger too. The medicine was given and
//    nobody was ever billed for it.
//
// 2. AN OPEN BILL FROM SOMEWHERE ELSE IS NOT THIS STAY'S BILL. With an active
//    admission, a ward charge belongs on that admission's running bill — not on
//    an unpaid OP counter bill from a different visit.
//
// This mirrors what the OT kit path already does; it is centralised here so a
// fifth charge path cannot drift away from it again.
// ---------------------------------------------------------------------------

/** Bill statuses that can still take a new charge. */
const OPEN_BILL_STATUSES = ['draft', 'pending', 'partially_paid'] as const;

/**
 * The advance holding account, excluded from anything that treats a row as a
 * bill. Kept here (rather than imported from billing.service) so the ward
 * services do not have to pull in the billing module to post a charge.
 */
export const NOT_ADVANCE_BUCKET = {
  billNumber: { not: { startsWith: 'ADV-' } },
} as const;

/** True for the `ADV-…` sentinel bill that holds a patient's advance money. */
export function isAdvanceBucket(billNumber: string | null | undefined): boolean {
  return !!billNumber && billNumber.startsWith('ADV-');
}

/**
 * The bill an as-it-happens charge should be appended to, or `null` if the
 * caller should open a fresh one.
 *
 * With a stay in progress the admission's own running draft is PREFERRED, so a
 * ward charge lands on that stay's bill rather than on whatever happened to be
 * created most recently. The fallback is then the patient's newest open bill —
 * deliberately unrestricted, because a lab or imaging charge for an admitted
 * patient can sit on an orphan bill raised against the admission's VISIT with
 * no admissionId, and the callers adopt that bill onto the stay. Narrowing the
 * fallback to `admissionId` would have stopped adopting it and opened a second
 * bill per dispense instead.
 *
 * The advance bucket is never returned from either branch.
 *
 * @param tx  a Prisma client or transaction client — callers run inside
 *            `$transaction`, so this must accept either.
 */
export async function findOpenChargeBill(
  tx: any,
  params: { tenantId: string; patientId: string; admissionId?: string | null },
): Promise<any | null> {
  const { tenantId, patientId, admissionId } = params;

  // A stay in progress: its own draft is the running IP bill.
  if (admissionId) {
    const own = await tx.bill.findFirst({
      where: { tenantId, admissionId, status: 'draft', ...NOT_ADVANCE_BUCKET },
      orderBy: { createdAt: 'desc' },
    });
    if (own) return own;
  }

  return tx.bill.findFirst({
    where: {
      tenantId,
      patientId,
      status: { in: [...OPEN_BILL_STATUSES] },
      ...NOT_ADVANCE_BUCKET,
    },
    orderBy: { createdAt: 'desc' },
  });
}
