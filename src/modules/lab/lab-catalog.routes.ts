// Gap 369: catalogue governance, mounted at /lab/catalog.
import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/authorize';
import { authenticate } from '../../middleware/authenticate';
import { validate } from '../../middleware/validate';
import { sendResponse } from '../../shared/apiResponse';
import type { AuthenticatedRequest } from '../../shared/types';
import * as ranges from './lab-range-proposals.service';
import { getPriceReview } from './lab-price-guard';
import { getDuplicateGroups, previewRetire, retireDuplicate } from './lab-catalog-retire.service';
import { commitImport, previewImport } from './lab-catalog-import.service';

const uuid = z.string().uuid();
const key = z.string().min(1).max(60);
const hash = z.string().length(64);
const limit = z.number().finite().nullable().optional();

const rangeShape = {
  unit: z.string().max(50).nullable().optional(),
  refLow: limit,
  refHigh: limit,
  refText: z.string().max(100).nullable().optional(),
  qualifiers: z
    .array(
      z.object({
        sex: z.enum(['male', 'female', 'any']).nullable().optional(),
        ageMinYears: limit,
        ageMaxYears: limit,
        low: limit,
        high: limit,
      }),
    )
    .max(8)
    .nullable()
    .optional(),
};

const testParams = z.object({ params: z.object({ testId: uuid }) });

export const proposeRangeSchema = testParams.extend({
  body: z.object({ parameterKey: key, ...rangeShape, rationale: z.string().max(1000).nullable().optional() }),
});
export const suggestRangeSchema = testParams.extend({ body: z.object({ parameterKey: key }) });
export const confirmRangesSchema = testParams.extend({
  body: z.object({
    items: z.array(z.object({ parameterKey: key, expectedLiveHash: hash })).min(1).max(101),
    note: z.string().max(1000).nullable().optional(),
  }),
});
export const approveRangesSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          id: uuid,
          expectedLiveHash: hash,
          edits: z.object(rangeShape).nullable().optional(),
          note: z.string().max(1000).nullable().optional(),
        }),
      )
      .min(1)
      .max(100),
  }),
});
export const rejectRangeSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({ reason: z.string().trim().min(3, 'Give a reason').max(1000) }),
});
const retirePreviewSchema = testParams.extend({ query: z.object({ keepTestId: uuid }) });
const retireSchema = testParams.extend({
  body: z.object({
    keepTestId: uuid,
    reason: z.string().trim().max(1000).nullable().optional(),
    confirmDifferences: z.boolean().optional(),
  }),
});
const cell = z.union([z.string().max(5000), z.number()]).nullable().optional();
const importRow = z.object({
  rowNumber: z.number().int().positive(),
  testCode: cell, testName: cell, sampleType: cell, specimen: cell, instructions: cell, description: cell,
  turnaroundHours: cell, price: cell, aliases: cell, parameterName: cell, parameterUnit: cell,
  refLow: cell, refHigh: cell, refText: cell, group: cell,
});
const rows = z.array(importRow).min(1, 'The file has no rows').max(2000, 'Import at most 2,000 rows at a time');
const previewSchema = z.object({ body: z.object({ rows }) });
const commitSchema = z.object({
  body: z.object({
    rows,
    confirmed: z
      .array(
        z.object({
          key: z.string().min(1).max(400),
          action: z.enum(['create', 'update']),
          testId: uuid.nullable().optional(),
          stamp: z.string().max(60).nullable().optional(),
          priceReason: z.string().trim().min(5).max(500).nullable().optional(),
        }),
      )
      .min(1, 'Tick at least one test')
      .max(500, 'Import at most 500 tests at a time'),
  }),
});
const pendingSchema = z.object({ query: z.object({ testId: uuid.optional() }) });

const run =
  (message: string, fn: (req: AuthenticatedRequest) => Promise<unknown>) =>
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      sendResponse({ res, message, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };

const t = (req: AuthenticatedRequest) => req.user!.tenantId;
const u = (req: AuthenticatedRequest) => req.user!.userId;
const roles = (req: AuthenticatedRequest) => req.user!.roles ?? [];
const testId = (req: AuthenticatedRequest) => req.params.testId as string;

export const labCatalogRoutes = Router();
labCatalogRoutes.use(authenticate);

// Reading: catalogue staff only. Suggestions must not reach an ordering screen,
// so these sit on lab_orders:update rather than the lab_orders:read doctors hold.
const manage = requirePermission('lab_orders', 'update');
// Signing: the same permission that approves results and signs reports, plus the
// pathologist-role check inside the service (a hospital admin holds the former).
const sign = requirePermission('lab_reports', 'approve');
const supervise = requirePermission('lab_orders', 'approve');

labCatalogRoutes.get('/range-status', manage, run('Range status', (r) => ranges.getRangeStatus(t(r))));
labCatalogRoutes.get(
  '/range-proposals',
  manage,
  validate(pendingSchema),
  run('Range proposals', (r) => ranges.listPendingProposals(t(r), r.query.testId as string | undefined)),
);
labCatalogRoutes.get(
  '/tests/:testId/ranges',
  manage,
  validate(testParams),
  run('Reference ranges', (r) => ranges.getTestRanges(t(r), testId(r))),
);
labCatalogRoutes.post(
  '/tests/:testId/ranges/propose',
  manage,
  validate(proposeRangeSchema),
  run('Range sent for approval', (r) => {
    const { parameterKey, ...input } = r.body;
    return ranges.proposeRange(t(r), u(r), testId(r), parameterKey, input);
  }),
);
labCatalogRoutes.post(
  '/tests/:testId/ranges/suggest',
  manage,
  validate(suggestRangeSchema),
  run('AI suggestion saved for review', (r) => ranges.suggestRangeWithAi(t(r), u(r), testId(r), r.body.parameterKey)),
);
labCatalogRoutes.post(
  '/tests/:testId/ranges/confirm',
  sign,
  validate(confirmRangesSchema),
  run('Ranges confirmed', (r) => ranges.confirmCurrentRanges(t(r), u(r), testId(r), r.body.items, r.body.note)),
);
labCatalogRoutes.post(
  '/range-proposals/approve',
  sign,
  validate(approveRangesSchema),
  run('Range approved', (r) => ranges.approveRangeProposals(t(r), u(r), r.body.items)),
);
labCatalogRoutes.post(
  '/range-proposals/:id/reject',
  sign,
  validate(rejectRangeSchema),
  run('Range rejected', (r) => ranges.rejectRangeProposal(t(r), u(r), r.params.id as string, r.body.reason)),
);

labCatalogRoutes.get('/price-review', manage, run('Price review', (r) => getPriceReview(t(r))));

labCatalogRoutes.get('/duplicates', supervise, run('Possible duplicates', (r) => getDuplicateGroups(t(r))));
labCatalogRoutes.get(
  '/tests/:testId/retire-preview',
  supervise,
  validate(retirePreviewSchema),
  run('Retire preview', (r) => previewRetire(t(r), roles(r), testId(r), r.query.keepTestId as string)),
);
labCatalogRoutes.post(
  '/tests/:testId/retire',
  supervise,
  validate(retireSchema),
  run('Test retired', (r) => retireDuplicate(t(r), u(r), roles(r), testId(r), r.body)),
);

labCatalogRoutes.post(
  '/import/preview',
  manage,
  validate(previewSchema),
  run('Import preview', (r) => previewImport(t(r), roles(r), r.body.rows)),
);
labCatalogRoutes.post(
  '/import/commit',
  manage,
  validate(commitSchema),
  run('Import finished', (r) => commitImport(t(r), u(r), roles(r), r.body.rows, r.body.confirmed)),
);
