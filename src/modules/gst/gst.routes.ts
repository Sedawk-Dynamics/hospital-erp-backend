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
import * as masters from './gst-master.service';

export const gstRoutes = Router();

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

// ── Group C — operational and control ─────────────────────────────────────

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

/** C-7 — Department-wise GST. */
gstRoutes.get(
  '/reports/department-gst',
  ...gstReportAccess,
  validate(salesQuerySchema),
  report('Department-wise GST', (t, q) => control.getDepartmentGst(t, q as never)),
);

/** C-9 — Cancelled and Amended Invoices. */
gstRoutes.get(
  '/reports/cancelled-invoices',
  ...gstReportAccess,
  validate(periodQuerySchema),
  report('Cancelled and amended invoices', (t, q) => control.getCancelledInvoices(t, q as never)),
);

// --- Platform SAC master (super admin only, like the HSN master) ---

gstRoutes.get(
  '/sac-codes',
  authenticate,
  requireRoles('super_admin'),
  async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      sendResponse({ res, message: 'SAC codes', data: await masters.listSacCodes() });
    } catch (err) {
      next(err);
    }
  },
);
