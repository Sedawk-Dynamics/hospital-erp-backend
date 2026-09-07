// ---------------------------------------------------------------------------
// B-5 — GSTR-2B reconciliation.
//
// The hospital can only claim credit that its supplier has actually declared.
// The purchase register says what we believe we bought; GSTR-2B says what the
// supplier admitted to selling. The gap between the two is the whole report.
//
// Four buckets, and they are not four flavours of the same thing — each is a
// different person's job:
//
//   matched      both agree. Claim it.
//   mismatched   both have it, the figures differ. The accountant reconciles.
//   inPortalOnly the supplier declared it and our books have no purchase. Either
//                a goods receipt was never entered, or it is not ours at all.
//   inBooksOnly  we recorded it and the supplier has not declared it. This is
//                the expensive one: the credit CANNOT be claimed until they
//                file, and somebody has to chase them.
//
// The match is on supplier GSTIN plus the normalised invoice number, and our
// side is GROUPED to the invoice first. A purchase register is one row per
// batch; a supplier invoice covers many batches. Matching batch-to-invoice
// would report a five-line delivery as four missing invoices.
// ---------------------------------------------------------------------------

import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { logger } from '../../config/logger';
import { r2 } from '../../shared/gst';
import { matchKeyFor, parseGstr2b } from './gstr2b-parse';
import { getPurchaseRegister } from './gst-reports.purchase';
import { returnPeriod as returnPeriodFor } from './gst-reports.gstr1-json';

/**
 * How far apart two figures may be and still count as matched.
 *
 * A rupee, not a paisa. Suppliers round at the line and we round at the batch,
 * so an exact-to-the-paisa rule would put half a hospital's genuinely-matched
 * invoices in the mismatch bucket and make the report useless. A real
 * discrepancy is never one rupee.
 */
const MATCH_TOLERANCE = 1;

export interface ImportGstr2bInput {
  /** The downloaded JSON, parsed. */
  file: unknown;
  fileName?: string | null;
}

/**
 * Store a downloaded GSTR-2B.
 *
 * Re-importing a period REPLACES it. The portal reissues 2B as suppliers file
 * late, and the latest download is the only one that counts — keeping every
 * version would leave the reconciliation asking which copy to believe.
 */
export async function importGstr2b(
  tenantId: string,
  userId: string | null,
  input: ImportGstr2bInput,
) {
  const parsed = parseGstr2b(input.file);

  // The file names the GSTIN it was generated for. Importing another
  // hospital's 2B would reconcile our purchases against their suppliers and
  // report every invoice we hold as unfiled — a false alarm on the whole month.
  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const profile = await getGstProfile(tenantId);
  if (parsed.gstin && profile.gstin && parsed.gstin !== profile.gstin.toUpperCase()) {
    throw AppError.badRequest(
      `That GSTR-2B was generated for ${parsed.gstin}, and this hospital is ${profile.gstin}.`,
    );
  }

  const taxTotal = r2(parsed.documents.reduce((t, d) => t + d.taxAmount, 0));

  const saved = await prisma.$transaction(async (tx) => {
    // Replace rather than merge: the rows belong to the statement, and a
    // half-old half-new set would be nobody's 2B.
    await tx.gstr2bImport.deleteMany({
      where: { tenantId, returnPeriod: parsed.returnPeriod },
    });
    const imported = await tx.gstr2bImport.create({
      data: {
        tenantId,
        returnPeriod: parsed.returnPeriod,
        gstin: parsed.gstin,
        generatedAt: parsed.generatedAt,
        version: parsed.version,
        fileName: input.fileName ?? null,
        importedBy: userId,
        invoiceCount: parsed.documents.length,
        taxTotal,
      },
    });
    if (parsed.documents.length) {
      await tx.gstr2bDocument.createMany({
        data: parsed.documents.map((d) => ({
          importId: imported.id,
          tenantId,
          returnPeriod: parsed.returnPeriod,
          supplierGstin: d.supplierGstin,
          supplierName: d.supplierName,
          documentType: d.documentType,
          documentNumber: d.documentNumber,
          matchKey: d.matchKey,
          documentDate: d.documentDate,
          documentValue: d.documentValue,
          taxableValue: d.taxableValue,
          igstAmount: d.igstAmount,
          cgstAmount: d.cgstAmount,
          sgstAmount: d.sgstAmount,
          cessAmount: d.cessAmount,
          taxAmount: d.taxAmount,
          placeOfSupply: d.placeOfSupply,
          itcAvailable: d.itcAvailable,
          itcBlockedReason: d.itcBlockedReason,
          supplierFiledOn: d.supplierFiledOn,
        })),
      });
    }
    return imported;
  });

  logger.info(
    { tenantId, returnPeriod: parsed.returnPeriod, documents: parsed.documents.length, taxTotal },
    'GSTR-2B statement imported',
  );

  return {
    id: saved.id,
    returnPeriod: parsed.returnPeriod,
    documents: parsed.documents.length,
    taxTotal,
    warnings: [
      ...(parsed.gstin && !profile.gstin
        ? ['This hospital has no GSTIN on file, so the statement could not be checked against it.']
        : []),
      ...(parsed.skippedSections.length
        ? [
            `Sections not read: ${parsed.skippedSections.join(', ')}. This reconciliation covers supplier invoices and their credit/debit notes — imports, ISD and reverse-charge entries are not matched against a purchase.`,
          ]
        : []),
      ...(parsed.documents.length === 0
        ? ['The statement has no supplier invoices in it. Every purchase this month will show as unfiled by its supplier.']
        : []),
    ],
  };
}

/** Every statement imported, newest first. */
export async function listGstr2bImports(tenantId: string) {
  const rows = await prisma.gstr2bImport.findMany({
    where: { tenantId },
    orderBy: { returnPeriod: 'desc' },
    include: { importer: { select: { firstName: true, lastName: true } } },
  });
  const { fullName } = await import('../../shared/person-name');
  return {
    imports: rows.map((r) => ({
      id: r.id,
      returnPeriod: r.returnPeriod,
      gstin: r.gstin,
      generatedAt: r.generatedAt,
      fileName: r.fileName,
      importedAt: r.importedAt,
      importedBy: r.importer ? fullName(r.importer) : null,
      invoiceCount: r.invoiceCount,
      taxTotal: Number(r.taxTotal),
    })),
  };
}

interface BookInvoice {
  supplierGstin: string | null;
  supplierName: string | null;
  invoiceNumber: string;
  matchKey: string;
  invoiceDate: Date | null;
  taxableValue: number;
  taxAmount: number;
  lines: number;
}

/**
 * B-5 — the reconciliation itself.
 *
 * Reads the purchase register for the period and the imported statement for it,
 * then sorts every document into one of the four buckets.
 */
export async function reconcileGstr2b(
  tenantId: string,
  query: { from?: string; to?: string } = {},
) {
  const period = returnPeriodFor(query.from, query.to);

  const [{ rows: purchases }, statement] = await Promise.all([
    getPurchaseRegister(tenantId, query),
    prisma.gstr2bImport.findFirst({
      where: { tenantId, returnPeriod: period },
      include: { rows: true, importer: { select: { firstName: true, lastName: true } } },
    }),
  ]);

  // Group our side to the INVOICE. The register is one row per batch and a
  // supplier invoice covers many; matching batch-to-invoice would report a
  // five-line delivery as four missing invoices.
  const books = new Map<string, BookInvoice>();
  const unkeyed: typeof purchases = [];
  for (const p of purchases) {
    if (!p.supplierGstin || !p.invoiceNumber) {
      // Nothing to match on. Reported separately rather than counted as
      // missing from the portal — the fault is on our side of the desk.
      unkeyed.push(p);
      continue;
    }
    const gstin = p.supplierGstin.toUpperCase();
    const key = `${gstin}:${matchKeyFor(p.invoiceNumber)}`;
    const cur = books.get(key) ?? {
      supplierGstin: gstin,
      supplierName: p.supplierName,
      invoiceNumber: p.invoiceNumber,
      matchKey: matchKeyFor(p.invoiceNumber),
      invoiceDate: p.invoiceDate,
      taxableValue: 0,
      taxAmount: 0,
      lines: 0,
    };
    cur.taxableValue = r2(cur.taxableValue + p.taxableValue);
    cur.taxAmount = r2(cur.taxAmount + p.taxAmount);
    cur.lines += 1;
    books.set(key, cur);
  }

  const portalRows = statement?.rows ?? [];
  const portal = new Map<string, (typeof portalRows)[number]>();
  for (const d of portalRows) {
    // Only an invoice is matched against a purchase. A supplier's credit note
    // reduces the credit but has no goods receipt behind it, so it is reported
    // on its own rather than forced into a bucket it does not belong in.
    if (d.documentType !== 'invoice') continue;
    portal.set(`${d.supplierGstin}:${d.matchKey}`, d);
  }

  const matched: any[] = [];
  const mismatched: any[] = [];
  const inBooksOnly: any[] = [];

  for (const [key, b] of books) {
    const p = portal.get(key);
    if (!p) {
      inBooksOnly.push({
        supplierGstin: b.supplierGstin,
        supplierName: b.supplierName,
        invoiceNumber: b.invoiceNumber,
        invoiceDate: b.invoiceDate,
        lines: b.lines,
        taxableValue: b.taxableValue,
        taxAmount: b.taxAmount,
      });
      continue;
    }
    const portalTax = Number(p.taxAmount);
    const portalTaxable = Number(p.taxableValue);
    const taxDiff = r2(b.taxAmount - portalTax);
    const taxableDiff = r2(b.taxableValue - portalTaxable);
    const row = {
      supplierGstin: b.supplierGstin,
      supplierName: p.supplierName ?? b.supplierName,
      invoiceNumber: b.invoiceNumber,
      portalInvoiceNumber: p.documentNumber,
      invoiceDate: b.invoiceDate,
      portalInvoiceDate: p.documentDate,
      lines: b.lines,
      booksTaxableValue: b.taxableValue,
      booksTaxAmount: b.taxAmount,
      portalTaxableValue: portalTaxable,
      portalTaxAmount: portalTax,
      taxableDifference: taxableDiff,
      taxDifference: taxDiff,
      itcAvailable: p.itcAvailable,
      itcBlockedReason: p.itcBlockedReason,
      supplierFiledOn: p.supplierFiledOn,
    };
    if (Math.abs(taxDiff) <= MATCH_TOLERANCE && Math.abs(taxableDiff) <= MATCH_TOLERANCE) {
      matched.push(row);
    } else {
      mismatched.push(row);
    }
  }

  const bookKeys = new Set(books.keys());
  const inPortalOnly = [...portal.entries()]
    .filter(([key]) => !bookKeys.has(key))
    .map(([, p]) => ({
      supplierGstin: p.supplierGstin,
      supplierName: p.supplierName,
      invoiceNumber: p.documentNumber,
      invoiceDate: p.documentDate,
      taxableValue: Number(p.taxableValue),
      taxAmount: Number(p.taxAmount),
      itcAvailable: p.itcAvailable,
      itcBlockedReason: p.itcBlockedReason,
      supplierFiledOn: p.supplierFiledOn,
    }));

  const supplierNotes = portalRows
    .filter((d) => d.documentType !== 'invoice')
    .map((d) => ({
      supplierGstin: d.supplierGstin,
      supplierName: d.supplierName,
      documentType: d.documentType,
      documentNumber: d.documentNumber,
      documentDate: d.documentDate,
      taxableValue: Number(d.taxableValue),
      // A credit note takes credit AWAY, so it is carried negative and the
      // claimable figure below nets it off rather than adding it on.
      taxAmount: d.documentType === 'credit_note' ? -Number(d.taxAmount) : Number(d.taxAmount),
    }));

  const sum = (list: Array<Record<string, unknown>>, k: string) =>
    r2(list.reduce((t, x) => t + Number(x[k] ?? 0), 0));

  // What may actually be claimed: matched credit, at the PORTAL's figure and
  // only where the portal says the credit is available, net of the supplier's
  // own notes. Claiming our own figure where the two disagree is how a notice
  // starts.
  const claimableMatched = r2(
    matched.filter((m) => m.itcAvailable).reduce((t, m) => t + m.portalTaxAmount, 0),
  );
  const noteAdjustment = r2(supplierNotes.reduce((t, n) => t + n.taxAmount, 0));

  const { fullName } = await import('../../shared/person-name');

  return {
    period: { from: query.from ?? null, to: query.to ?? null },
    returnPeriod: period,
    statement: statement
      ? {
          id: statement.id,
          gstin: statement.gstin,
          generatedAt: statement.generatedAt,
          fileName: statement.fileName,
          importedAt: statement.importedAt,
          importedBy: statement.importer ? fullName(statement.importer) : null,
          invoiceCount: statement.invoiceCount,
        }
      : null,
    matched,
    mismatched,
    inPortalOnly,
    inBooksOnly,
    supplierNotes,
    /** Purchases with no supplier GSTIN or no invoice number to match on. */
    unmatchable: unkeyed.map((p) => ({
      batchId: p.batchId,
      supplierName: p.supplierName,
      supplierGstin: p.supplierGstin,
      invoiceNumber: p.invoiceNumber,
      drugName: p.drugName,
      taxAmount: p.taxAmount,
      problem: !p.supplierGstin ? 'No supplier GSTIN on file' : 'No supplier invoice number recorded',
    })),
    totals: {
      matched: { count: matched.length, taxAmount: sum(matched, 'booksTaxAmount') },
      mismatched: { count: mismatched.length, taxAmount: sum(mismatched, 'booksTaxAmount') },
      inPortalOnly: { count: inPortalOnly.length, taxAmount: sum(inPortalOnly, 'taxAmount') },
      inBooksOnly: { count: inBooksOnly.length, taxAmount: sum(inBooksOnly, 'taxAmount') },
      unmatchable: { count: unkeyed.length, taxAmount: sum(unkeyed as never, 'taxAmount') },
      supplierNotes: { count: supplierNotes.length, taxAmount: noteAdjustment },
      /** Credit at risk: recorded by us, not declared by the supplier. */
      creditAtRisk: sum(inBooksOnly, 'taxAmount'),
      /** What the portal supports, net of the supplier's notes. */
      claimable: r2(claimableMatched + noteAdjustment),
    },
    notes: [
      ...(statement
        ? []
        : [
            `No GSTR-2B has been imported for ${period}. Until one is, every purchase in the period shows as not declared by its supplier.`,
          ]),
      `Matched within ₹${MATCH_TOLERANCE}: suppliers round at the line and we round at the batch, and a real discrepancy is never one rupee.`,
      'Invoices are matched on supplier GSTIN plus the invoice number with punctuation stripped — "SUP/001" and "SUP-001" are the same invoice.',
      'The claimable figure uses the PORTAL’s tax, not ours, and only where the portal says the credit is available. Claiming our own figure where the two disagree is how a notice starts.',
      'This reconciles pharmacy and inventory purchases. Anything that does not arrive as a stock batch is not in the register and will appear as portal-only.',
    ],
  };
}
