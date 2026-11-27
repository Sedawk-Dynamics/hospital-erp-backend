import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission, requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import { sendResponse } from '../../shared/apiResponse';
import type { AuthenticatedRequest } from '../../shared/types';
import * as reports from './gst-reports.service';
import * as sales from './gst-reports.sales';
import * as returns from './gst-reports.returns';
import * as purchase from './gst-reports.purchase';
import * as control from './gst-reports.control';
import * as archive from './gst-reports.archive';
import * as annual from './gst-reports.annual';
import * as reconcile from './gst-reports.reconcile';
import * as einvoice from './gst-reports.einvoice';
import { gstEinvoiceRoutes } from './gst-einvoice.routes';
import * as amendments from './gst-reports.amendments';
import * as masters from './gst-master.service';
import { returnPeriodLabel } from './gst-reports.gstr1-json';
import { gstinVerificationCaption } from '../../shared/gst-profile';

export const gstRoutes = Router();

// G-5 (gap #266): portal credentials, Test connection, IRN generate / retry /
// cancel and e-way bill generation. Its own role gate (GST managers only).
gstRoutes.use(gstEinvoiceRoutes);

/**
 * GST reports show the hospital's complete revenue position, so they are not
 * open to everyone who can read a bill.
 *
 * `billing:read` is too wide — doctor and patient both hold it, and neither
 * should see the hospital's turnover or its tax liability. `billing:approve` is
 * the narrowest existing permission that still covers the people who need
 * these: the front desk, billing admin, insurance staff and hospital admin.
 * That matches the instruction that the accounts/GST team owns the reports and
 * management gets access.
 */
const gstReportAccess = [authenticate, requirePermission('billing', 'approve')];

const advancesQuerySchema = z.object({
  query: z.object({
    // Plain YYYY-MM-DD. A filter missing from this schema is silently dropped
    // by validate(), so every supported filter has to be named here.
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    patientId: z.string().uuid().optional(),
    treatment: z.enum(['taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated']).optional(),
  }),
});

/**
 * A-10 — Advances & Advance Adjustments.
 *
 * What came in before a supply, what tax fell due on it, what has since been
 * adjusted against an invoice, and what is still held. Feeds GSTR-1 table 11.
 */
gstRoutes.get(
  '/reports/advances',
  ...gstReportAccess,
  validate(advancesQuerySchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await reports.getAdvancesReport(req.user!.tenantId, req.query as never);
      sendResponse({ res, message: 'Advances and advance adjustments', data });
    } catch (err) {
      next(err);
    }
  },
);

// ── Group A — filing reports (sales side) ─────────────────────────────────
//
// A-1 is the register every other sales report folds. They share one query
// deliberately: a summary assembled independently WILL eventually disagree with
// the register it claims to summarise, and then nobody can tell which is wrong.

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const salesQuerySchema = z.object({
  query: z.object({
    // A filter missing from this schema is silently dropped by validate(), so
    // every supported filter has to be named here.
    from: z.string().regex(DATE).optional(),
    to: z.string().regex(DATE).optional(),
    department: z
      .enum([
        'consultation', 'registration', 'surgery', 'room', 'lab',
        'radiology', 'pharmacy', 'procedure', 'consumable', 'other',
      ])
      .optional(),
    documentType: z
      .enum(['tax_invoice', 'bill_of_supply', 'invoice_cum_bill_of_supply'])
      .optional(),
    treatment: z.enum(['taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated']).optional(),
    customerType: z.enum(['b2b', 'b2c']).optional(),
  }),
});

/** Table 12 reports 6 digits above ₹5 crore aggregate turnover, 4 below. */
const hsnQuerySchema = z.object({
  query: salesQuerySchema.shape.query.extend({
    sixDigit: z.enum(['true', 'false']).optional(),
  }),
});

const periodQuerySchema = z.object({
  query: z.object({
    from: z.string().regex(DATE).optional(),
    to: z.string().regex(DATE).optional(),
  }),
});

/** D-1's status filter. Named here or validate() would silently drop it. */
const eInvoiceQuerySchema = z.object({
  query: z.object({
    from: z.string().regex(DATE).optional(),
    to: z.string().regex(DATE).optional(),
    status: z.enum(['registered', 'pending', 'failed', 'not_sent', 'cancelled']).optional(),
  }),
});

/** Wrap a report so every route is one line and they all fail the same way. */
function report<T>(
  message: string,
  run: (tenantId: string, query: Record<string, unknown>) => Promise<T>,
) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await run(req.user!.tenantId, req.query as Record<string, unknown>);
      sendResponse({ res, message, data });
    } catch (err) {
      next(err);
    }
  };
}

/** A-1 — GST Sales Register. One row per bill line. */
gstRoutes.get(
  '/reports/sales-register',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('GST sales register', (t, q) => sales.getSalesRegister(t, q as never)),
);

/** A-2 — Rate-wise GST Summary, and the same figures by department. */
gstRoutes.get(
  '/reports/rate-summary',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('Rate-wise GST summary', (t, q) => sales.getRateWiseSummary(t, q as never)),
);

/** A-3 — HSN / SAC Summary, the shape GSTR-1 Table 12 wants. */
gstRoutes.get(
  '/reports/hsn-summary',
  ...gstReportAccess,
  validate(hsnQuerySchema),
  report('HSN / SAC summary', (t, q) =>
    sales.getHsnSummary(t, { ...(q as sales.SalesReportQuery), sixDigit: q.sixDigit === 'true' }),
  ),
);

/** A-4 — B2B Invoice Register: recipients with a GSTIN, invoice-wise. */
gstRoutes.get(
  '/reports/b2b-register',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('B2B invoice register', (t, q) => sales.getB2bRegister(t, q as never)),
);

/** A-5 — B2C Summary: by place of supply and rate, large inter-State listed. */
gstRoutes.get(
  '/reports/b2c-summary',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('B2C summary', (t, q) => sales.getB2cSummary(t, q as never)),
);

/** A-6 — Credit and Debit Note Register. */
gstRoutes.get(
  '/reports/credit-notes',
  ...gstReportAccess,
  validate(periodQuerySchema),
  report('Credit and debit note register', (t, q) => returns.getCreditNoteRegister(t, q as never)),
);

/** A-7 — Exempt, Nil-rated and Non-GST turnover. Feeds the B-3 reversal. */
gstRoutes.get(
  '/reports/exempt-turnover',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('Exempt, nil-rated and non-GST turnover', (t, q) => sales.getExemptTurnover(t, q as never)),
);

/**
 * GSTR-9 — the annual return summary.
 *
 * Not a new set of figures: the monthly reports run once over a whole financial
 * year, so the annual return cannot disagree with the twelve returns it
 * summarises.
 */
gstRoutes.get(
  '/reports/gstr9',
  ...gstReportAccess,
  validate(z.object({ query: z.object({ financialYear: z.string().regex(/^\d{4}-\d{2}$/).optional() }) })),
  report('GSTR-9 annual return', (t, q) => annual.getGstr9Summary(t, q as never)),
);

/**
 * GSTR-9C — the reconciliation working the accountant needs.
 *
 * The audited turnover comes from the financial statements, which are not held
 * here; pass it in to complete the reconciliation.
 */
gstRoutes.get(
  '/reports/gstr9c',
  ...gstReportAccess,
  validate(
    z.object({
      query: z.object({
        financialYear: z.string().regex(/^\d{4}-\d{2}$/).optional(),
        auditedTurnover: z.coerce.number().nonnegative().optional(),
      }),
    }),
  ),
  report('GSTR-9C reconciliation', (t, q) => annual.getGstr9cReconciliation(t, q as never)),
);

/** A-8 — GSTR-1, every table filled in and reconciled back to A-1. */
gstRoutes.get(
  '/reports/gstr1',
  ...gstReportAccess,
  validate(hsnQuerySchema),
  report('GSTR-1 summary', (t, q) =>
    returns.getGstr1Summary(t, { ...(q as sales.SalesReportQuery), sixDigit: q.sixDigit === 'true' }),
  ),
);

/** A-9 — GSTR-3B: outward liability, input credit, net payable. */
gstRoutes.get(
  '/reports/gstr3b',
  ...gstReportAccess,
  validate(periodQuerySchema),
  report('GSTR-3B summary', (t, q) => returns.getGstr3bSummary(t, q as never)),
);

/**
 * A-8 — the file the accountant uploads, rather than the screen they check.
 *
 * Served as a download with the return period in its name, and with the
 * warnings alongside: a file is silently incomplete when a line has no
 * classification, and the accountant has to see that BEFORE uploading it.
 */
gstRoutes.get(
  '/reports/gstr1/json',
  ...gstReportAccess,
  validate(hsnQuerySchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = req.query as Record<string, unknown>;
      const { buildGstr1Json, returnPeriod } = await import('./gst-reports.gstr1-json');
      const out = await buildGstr1Json(req.user!.tenantId, {
        ...(q as sales.SalesReportQuery),
        sixDigit: q.sixDigit === 'true',
      });
      sendResponse({
        res,
        message: `GSTR-1 JSON for ${returnPeriod(q.from as string, q.to as string)}`,
        data: out,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Any report on screen, as a real PDF document (gap items 282 / 372).
 *
 * The client posts the rows it is showing, so the PDF matches the screen; the
 * hospital name and GSTIN are added here rather than trusted from the body.
 */
gstRoutes.post(
  '/reports/pdf',
  ...gstReportAccess,
  validate(
    z.object({
      body: z.object({
        title: z.string().min(1).max(200),
        subtitle: z.string().max(500).nullish(),
        period: z.object({ from: z.string().max(10).nullish(), to: z.string().max(10).nullish() }).nullish(),
        stats: z.array(z.object({ label: z.string().max(100), value: z.string().max(100) })).max(20).optional(),
        columns: z.array(z.object({
          label: z.string().max(100),
          align: z.enum(['left', 'right', 'center']).optional(),
        })).min(1).max(30),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).max(20000),
        notes: z.array(z.string().max(2000)).max(40).optional(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { renderReportPdf } = await import('./gst-reports.pdf');
      const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
      const { prisma } = await import('../../config/database');
      const tenantId = req.user!.tenantId;
      const [profile, tenant, user] = await Promise.all([
        getGstProfile(tenantId),
        prisma.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
        prisma.user.findFirst({ where: { id: req.user!.userId }, select: { firstName: true, lastName: true } }),
      ]);
      const body = req.body as import('./gst-reports.pdf').ReportPdfInput;
      const pdf = await renderReportPdf(
        { ...body, runBy: user ? [user.firstName, user.lastName].filter(Boolean).join(' ') : null },
        {
          hospitalName: profile.legalName ?? tenant?.name ?? null,
          gstin: profile.registered ? profile.gstin : null,
          gstinVerified: profile.gstinVerified,
          // Gap #311: "not verified" until the provider confirms this GSTIN,
          // and a SANDBOX label even when the sandbox did.
          gstinCaption: gstinVerificationCaption(profile),
        },
      );
      const safe = body.title.replace(/[^A-Za-z0-9-]+/g, '_').slice(0, 60);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.pdf"`);
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  },
);

// ── Group B — purchases and input tax credit ──────────────────────────────

const purchaseQuerySchema = z.object({
  query: z.object({
    from: z.string().regex(DATE).optional(),
    to: z.string().regex(DATE).optional(),
    supplierId: z.string().uuid().optional(),
  }),
});

/** B-1 — GST Purchase Register. One row per batch received. */
gstRoutes.get(
  '/reports/purchase-register',
  ...gstReportAccess,
  validate(purchaseQuerySchema),
  report('GST purchase register', (t, q) => purchase.getPurchaseRegister(t, q as never)),
);

/** B-2 — Input Tax Credit Summary, BEFORE any reversal. */
gstRoutes.get(
  '/reports/itc-summary',
  ...gstReportAccess,
  validate(purchaseQuerySchema),
  report('Input tax credit summary', (t, q) => purchase.getItcSummary(t, q as never)),
);

/** B-3 — Rule 42 / 43 ITC Reversal Working, step by step. */
gstRoutes.get(
  '/reports/itc-reversal',
  ...gstReportAccess,
  validate(periodQuerySchema),
  report('Rule 42 / 43 ITC reversal working', (t, q) =>
    purchase.getItcReversalWorking(t, q as never),
  ),
);

/** B-4 — Supplier GSTIN Exception Report: credit at risk. */
gstRoutes.get(
  '/reports/supplier-gstin-exceptions',
  ...gstReportAccess,
  validate(periodQuerySchema),
  report('Supplier GSTIN exceptions', (t, q) =>
    purchase.getSupplierGstinExceptions(t, q as never),
  ),
);

/** B-6 — Purchase returns and expiry write-offs: credit that has to go back. */
gstRoutes.get(
  '/reports/purchase-returns',
  ...gstReportAccess,
  validate(purchaseQuerySchema),
  report('Purchase returns and debit notes', (t, q) => purchase.getPurchaseReturns(t, q as never)),
);

/** B-5 — our purchase register against what the portal says suppliers filed. */
gstRoutes.get(
  '/reports/gstr2b-reconciliation',
  ...gstReportAccess,
  validate(periodQuerySchema),
  report('GSTR-2B reconciliation', (t, q) => reconcile.reconcileGstr2b(t, q as never)),
);

/** Every GSTR-2B statement imported so far. */
gstRoutes.get(
  '/reports/gstr2b-imports',
  ...gstReportAccess,
  report('GSTR-2B statements imported', (t) => reconcile.listGstr2bImports(t)),
);

/**
 * Import a downloaded GSTR-2B.
 *
 * The JSON is posted as-is rather than uploaded as a file: it is the accountant
 * pasting in what the portal gave them, the parser wants the object anyway, and
 * a multipart round trip would put a copy of the hospital's supplier list on
 * disk for no gain. Express is configured for 10mb, which is far more than a
 * month of 2B.
 */
gstRoutes.post(
  '/reports/gstr2b-imports',
  ...gstReportAccess,
  validate(
    z.object({
      body: z.object({
        // Not described further on purpose — the shape is the government's, it
        // changes with their releases, and the parser is what validates it.
        file: z.unknown(),
        fileName: z.string().max(255).nullish(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await reconcile.importGstr2b(req.user!.tenantId, req.user!.userId, req.body);
      sendResponse({
        res,
        statusCode: 201,
        message: `GSTR-2B for ${returnPeriodLabel(data.returnPeriod)} imported — ${data.documents} document(s)`,
        data,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── Group C — operational and control ─────────────────────────────────────

/**
 * C-1 — Daily GST Billing / Tax Liability. What the hospital CHARGED.
 *
 * The review document is explicit that this and the collection report below are
 * different accounting concepts and must not be one report: an invoice raised
 * today and paid next month is liability today.
 */
gstRoutes.get(
  '/reports/daily-liability',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('Daily GST billing / tax liability', (t, q) => control.getDailyGstLiability(t, q as never)),
);

/** C-1 — Daily GST Collection, by counter, cashier and mode. */
gstRoutes.get(
  '/reports/daily-collection',
  ...gstReportAccess,
  validate(periodQuerySchema),
  report('Daily GST collection', (t, q) => control.getDailyCollection(t, q as never)),
);

/** C-2 — Exempt vs Taxable Revenue Mix, trended by month. */
gstRoutes.get(
  '/reports/revenue-mix',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('Exempt vs taxable revenue mix', (t, q) => control.getRevenueMix(t, q as never)),
);

/** C-3 — Unmapped Items Exception Report. */
gstRoutes.get(
  '/reports/unmapped-items',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('Unmapped items', (t, q) => control.getUnmappedItems(t, q as never)),
);

/** C-4 — Document Series Continuity. Auditors ask for this on day one. */
gstRoutes.get(
  '/reports/series-continuity',
  ...gstReportAccess,
  validate(
    z.object({
      query: z.object({ financialYear: z.string().regex(/^\d{4}-\d{2}$/).optional() }),
    }),
  ),
  report('Document series continuity', (t, q) => control.getSeriesContinuity(t, q as never)),
);

/** C-5 — Rate Override Log: every line where somebody typed the tax. */
gstRoutes.get(
  '/reports/rate-overrides',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('Rate override log', (t, q) => control.getRateOverrides(t, q as never)),
);

/** C-7 — Department-wise GST. */
gstRoutes.get(
  '/reports/department-gst',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('Department-wise GST', (t, q) => control.getDepartmentGst(t, q as never)),
);

/** C-8 — Rate Change Impact: what moved on a master, and what it touched. */
gstRoutes.get(
  '/reports/rate-changes',
  ...gstReportAccess,
  validate(periodQuerySchema),
  report('Rate change impact', (t, q) => control.getRateChangeImpact(t, q as never)),
);

/** C-9 — Cancelled and Amended Invoices. */
gstRoutes.get(
  '/reports/cancelled-invoices',
  ...gstReportAccess,
  validate(periodQuerySchema),
  report('Cancelled and amended invoices', (t, q) => control.getCancelledInvoices(t, q as never)),
);

/**
 * A-13 — GSTR-1 amendments: tables 9A, 9C and 10.
 *
 * Not keyed on the period picker like every other Group A report. An amendment
 * belongs to the return being prepared NOW and corrects an earlier one, so the
 * question is "what has moved since I filed", not "what happened in March" —
 * and the optional filter names the period being CORRECTED, not the one being
 * filed.
 */
gstRoutes.get(
  '/reports/gstr1-amendments',
  ...gstReportAccess,
  validate(
    z.object({
      query: z.object({
        /** MMYYYY, the way the portal writes a return period. */
        returnPeriod: z.string().regex(/^\d{6}$/).optional(),
      }),
    }),
  ),
  report('GSTR-1 amendments', (t, q) => amendments.getGstr1Amendments(t, q as never)),
);

// ── Group D — e-invoice and e-way bill ────────────────────────────────────
//
// Behind the same gate as every other report. Whether they apply at all is the
// hospital's own configuration, per correction 14 — never a turnover threshold
// written into the code — and each report says so in its own answer rather
// than being hidden from the menu, because "not applicable" is itself the
// thing an auditor asks the hospital to demonstrate.

/** D-1 — E-invoice (IRN) Register. */
gstRoutes.get(
  '/reports/einvoice-register',
  ...gstReportAccess,
  validate(eInvoiceQuerySchema),
  report('E-invoice (IRN) register', (t, q) => einvoice.getEInvoiceRegister(t, q as never)),
);

/** D-2 — Failed IRN Report. */
gstRoutes.get(
  '/reports/failed-irn',
  ...gstReportAccess,
  validate(periodQuerySchema),
  report('Failed IRN report', (t, q) => einvoice.getFailedIrnReport(t, q as never)),
);

/** D-3 — E-way Bill Register. */
gstRoutes.get(
  '/reports/eway-bills',
  ...gstReportAccess,
  validate(periodQuerySchema),
  report('E-way bill register', (t, q) => einvoice.getEwayBillRegister(t, q as never)),
);

// ── C-6 — the filed period archive ────────────────────────────────────────
//
// Filing is a WRITE, and it is the accountant's act rather than a report, so it
// sits behind the same gate but on POST.

/**
 * The one-off list section 6.11 asks for: IP bills that charged tax on ward
 * medicines before the composite-supply rule went in.
 *
 * A list, not a fix — the owner's answer to question 3 was to apply the treatment
 * to NEW bills and not alter old ones automatically.
 */
gstRoutes.get(
  '/reports/historic-ip-medicine-tax',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('Historic IP medicine tax', (t, q) => control.getHistoricIpMedicineTax(t, q as never)),
);

/** Every period this hospital has filed, newest first. */
gstRoutes.get(
  '/reports/filed-periods',
  ...gstReportAccess,
  report('Filed periods', (t) => archive.listFiledPeriods(t)),
);

/** One filing read back, with today's figures beside it. */
gstRoutes.get(
  '/reports/filed-periods/:id',
  ...gstReportAccess,
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await archive.getFiledPeriod(req.user!.tenantId, String(req.params.id));
      sendResponse({ res, message: `Filed period ${returnPeriodLabel(data.returnPeriod)}`, data });
    } catch (err) {
      next(err);
    }
  },
);

/** Gap 281: the reopen / correction trail of one filed period. */
gstRoutes.get(
  '/reports/filed-periods/:id/history',
  ...gstReportAccess,
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await archive.getFiledPeriod(req.user!.tenantId, String(req.params.id));
      sendResponse({
        res,
        message: `History of ${returnPeriodLabel(data.returnPeriod)}`,
        data: { id: data.id, returnPeriod: data.returnPeriod, status: data.status, versions: data.versions, history: data.history },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Lock a filed period, or open it again.
 *
 * Locking is what makes section 6.10 real: every bill dated inside a locked
 * period becomes read-only, and a correction has to go through a credit note in
 * the current period. Filing on its own only archives the figures.
 *
 * Gap 281: REOPENING needs an amendment role (admin / billing admin — 403
 * otherwise) and a non-empty correction reason (400 otherwise). Both are
 * enforced in the service so no other caller can skip them.
 */
gstRoutes.patch(
  '/reports/filed-periods/:id/lock',
  ...gstReportAccess,
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ locked: z.boolean(), reason: z.string().max(1000).nullish() }),
    }),
  ),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { locked: boolean; reason?: string | null };
      const data = await archive.setFiledPeriodLock(
        req.user!.tenantId,
        { userId: req.user!.userId, roles: req.user!.roles ?? [] },
        String(req.params.id),
        Boolean(body.locked),
        body.reason ?? null,
      );
      sendResponse({
        res,
        message: data.lockedAt ? `${returnPeriodLabel(data.returnPeriod)} locked` : `${returnPeriodLabel(data.returnPeriod)} reopened for correction`,
        data,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Freeze a period as filed.
 *
 * Gap 281: re-filing a month is a CORRECTION. It needs the period reopened, an
 * amendment role and a reason; the original snapshot is kept and the corrected
 * figures are stored as the next version in the period's history.
 */
gstRoutes.post(
  '/reports/filed-periods',
  ...gstReportAccess,
  validate(
    z.object({
      body: z.object({
        from: z.string().regex(DATE),
        to: z.string().regex(DATE),
        note: z.string().max(1000).nullish(),
        sixDigit: z.boolean().optional(),
        /** Gap 281: required when correcting a period already filed. */
        reason: z.string().max(1000).nullish(),
      }),
    }),
  ),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await archive.filePeriod(req.user!.tenantId, req.user!.userId, req.body, req.user!.roles ?? []);
      sendResponse({
        res,
        statusCode: 201,
        message: data.correction
          ? `${returnPeriodLabel(data.returnPeriod)} correction filed as version ${data.version} and locked — the original filing is kept`
          : `${returnPeriodLabel(data.returnPeriod)} filed and locked`,
        data,
      });
    } catch (err) {
      next(err);
    }
  },
);

// --- Platform GST slab master (super admin only) ---

/**
 * The rates the law recognises, with the window each was legal in.
 *
 * Read is open to any signed-in user: a hospital admin classifying an item has
 * to be able to see what the legal rates are, and every refusal message names
 * them anyway. Only super admin writes — a slab is not a hospital's opinion.
 */
gstRoutes.get(
  '/slabs',
  authenticate,
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await masters.listGstSlabs();
      sendResponse({ res, message: 'GST slabs', data });
    } catch (err) {
      next(err);
    }
  },
);

const slabBody = z.object({
  ratePercent: z.number().min(0).max(100),
  label: z.string().min(1).max(40),
  effectiveFrom: z.string().regex(DATE),
  effectiveTo: z.string().regex(DATE).nullish(),
  note: z.string().max(255).nullish(),
  isActive: z.boolean().optional(),
});

gstRoutes.post(
  '/slabs',
  authenticate,
  validate(z.object({ body: slabBody })),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await masters.createGstSlab(req.user!.roles ?? [], req.body as never);
      sendResponse({ res, statusCode: 201, message: 'GST slab added', data });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * A slab is CLOSED with an end date rather than deleted, which is why there is
 * no delete route: a bill raised while a rate was legal has to stay
 * explainable.
 */
gstRoutes.patch(
  '/slabs/:id',
  authenticate,
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: slabBody.partial().omit({ ratePercent: true, effectiveFrom: true }),
    }),
  ),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await masters.updateGstSlab(
        req.user!.roles ?? [],
        String(req.params.id),
        req.body as never,
      );
      sendResponse({ res, message: 'GST slab updated', data });
    } catch (err) {
      next(err);
    }
  },
);

// --- Platform SAC master (super admin only, like the HSN master) ---

/**
 * The SAC master is PLATFORM data, like the HSN master beside it: a service
 * accounting code means the same thing in every hospital, and letting each one
 * keep its own copy is how two hospitals end up filing the same service under
 * two different codes.
 *
 * Read is open to any signed-in user — a hospital admin classifying a service
 * has to be able to look a code up — but only super admin writes.
 */
gstRoutes.get(
  '/sac-codes',
  authenticate,
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      sendResponse({ res, message: 'SAC codes', data: await masters.listSacCodes() });
    } catch (err) {
      next(err);
    }
  },
);

const sacBodySchema = z.object({
  body: z.object({
    sacCode: z.string().min(2).max(20),
    description: z.string().max(500).nullish(),
    // A rate above zero only means anything on a taxable row; the service
    // reconciles the two so a row cannot say two different things.
    gstRate: z.number().min(0).max(100),
    treatment: z.enum(['taxable', 'exempt', 'nil_rated', 'non_gst', 'zero_rated']).optional(),
    category: z.string().max(100).nullish(),
    isActive: z.boolean().optional(),
  }),
});

gstRoutes.post(
  '/sac-codes',
  authenticate,
  requireRoles('super_admin'),
  validate(sacBodySchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await masters.createSacCode(req.user!.roles, req.body, req.user!.userId);
      sendResponse({ res, statusCode: 201, message: 'SAC code added', data });
    } catch (err) {
      next(err);
    }
  },
);

gstRoutes.patch(
  '/sac-codes/:id',
  authenticate,
  requireRoles('super_admin'),
  validate(
    z.object({
      params: z.object({ id: z.string().uuid() }),
      body: sacBodySchema.shape.body.partial(),
    }),
  ),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await masters.updateSacCode(
        req.user!.roles,
        String(req.params.id),
        req.body,
        req.user!.userId,
      );
      sendResponse({ res, message: 'SAC code updated', data });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Deactivated, never deleted. A bill line already carries the code it was
 * classified under; removing the master row would leave that line pointing at
 * nothing, and a filed return would lose the description behind its figure.
 */
gstRoutes.delete(
  '/sac-codes/:id',
  authenticate,
  requireRoles('super_admin'),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await masters.deactivateSacCode(
        req.user!.roles,
        String(req.params.id),
        req.user!.userId,
      );
      sendResponse({ res, message: 'SAC code deactivated', data });
    } catch (err) {
      next(err);
    }
  },
);
