import { Router, Response, NextFunction } from 'express';
import { requireRoles } from '../../middleware/authorize';
import { sendResponse } from '../../shared/apiResponse';
import { AppError } from '../../shared/appError';
import type { AuthenticatedRequest } from '../../shared/types';
import { GST_REGISTRATION_ROLES } from '../hospital-settings/hospital-settings.routes';
import * as portal from './gst-portal.credentials';
import * as einvoice from './gst-einvoice.service';

// ---------------------------------------------------------------------------
// G-5 (gap #266): portal credentials, Test connection, and IRN / e-way bill
// generation. Mounted under /gst, which already authenticates.
//
// Every route here is for the people who manage the hospital's GST
// registration — admin and finance (billing_admin). Registering, cancelling or
// retrying an IRN files something with the government in the hospital's name,
// and the credentials are the hospital's portal login, so the counter roles
// that can merely read reports are left out.
// ---------------------------------------------------------------------------

export const gstEinvoiceRoutes = Router();
const gstManagers = requireRoles(...GST_REGISTRATION_ROLES);

const portalParam = (req: AuthenticatedRequest) => {
  const p = req.params.portal;
  if (!portal.isGstPortal(p)) throw AppError.badRequest('Portal must be "einvoice" or "eway"');
  return p;
};

type Handler = (req: AuthenticatedRequest) => Promise<{ message: string; data: unknown }>;
const handle = (fn: Handler) => async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { message, data } = await fn(req);
    sendResponse({ res, message, data });
  } catch (err) {
    next(err);
  }
};

/** Readiness of both portals: provider, saved credentials (masked), last test. */
gstEinvoiceRoutes.get(
  '/portal/status',
  gstManagers,
  handle(async (req) => ({ message: 'E-invoice / e-way bill integration status', data: await portal.getPortalStatus(req.user!.tenantId) })),
);

gstEinvoiceRoutes.put(
  '/portal/:portal/credentials',
  gstManagers,
  handle(async (req) => ({
    message: 'Portal credentials saved',
    data: await portal.savePortalCredentials(req.user!.tenantId, req.user!.userId, portalParam(req), (req.body ?? {}) as Record<string, unknown>),
  })),
);

gstEinvoiceRoutes.delete(
  '/portal/:portal/credentials',
  gstManagers,
  handle(async (req) => ({
    message: 'Portal credentials removed',
    data: await portal.deletePortalCredentials(req.user!.tenantId, req.user!.userId, portalParam(req)),
  })),
);

gstEinvoiceRoutes.post(
  '/portal/:portal/test',
  gstManagers,
  handle(async (req) => {
    const data = await portal.testPortalConnection(req.user!.tenantId, req.user!.userId, portalParam(req));
    return { message: data.ok ? data.message : `Connection failed: ${data.message}`, data };
  }),
);

const irnMessage = (o: einvoice.IrnOutcome) =>
  o.alreadyRegistered
    ? `Already registered — IRN ${o.irn}`
    : o.status === 'registered'
      ? `IRN generated${o.sandbox ? ' (SANDBOX — not registered with the government portal)' : ''}`
      : `IRN not generated: ${o.error ?? o.status}`;

gstEinvoiceRoutes.post(
  '/einvoice/bills/:billId/generate',
  gstManagers,
  handle(async (req) => {
    const data = await einvoice.generateIrnForBill(req.user!.tenantId, req.user!.userId, req.params.billId as string, 'generate');
    return { message: irnMessage(data), data };
  }),
);

gstEinvoiceRoutes.post(
  '/einvoice/bills/:billId/retry',
  gstManagers,
  handle(async (req) => {
    const data = await einvoice.generateIrnForBill(req.user!.tenantId, req.user!.userId, req.params.billId as string, 'retry');
    return { message: irnMessage(data), data };
  }),
);

gstEinvoiceRoutes.post(
  '/einvoice/bills/:billId/cancel',
  gstManagers,
  handle(async (req) => {
    const body = (req.body ?? {}) as { reasonCode?: unknown; remark?: unknown };
    const data = await einvoice.cancelIrnForBill(req.user!.tenantId, req.user!.userId, req.params.billId as string, body);
    return { message: 'IRN cancelled', data };
  }),
);

// Credit / debit notes against a B2B invoice: the same three actions.
const noteIrnMessage = (o: einvoice.NoteIrnOutcome) =>
  o.alreadyRegistered
    ? `Already registered — IRN ${o.irn}`
    : o.status === 'registered'
      ? `IRN generated for ${o.noteType} note ${o.noteNumber}${o.sandbox ? ' (SANDBOX — not registered with the government portal)' : ''}`
      : `IRN not generated: ${o.error ?? o.status}`;

gstEinvoiceRoutes.post(
  '/einvoice/notes/:noteId/generate',
  gstManagers,
  handle(async (req) => {
    const data = await einvoice.generateIrnForNote(req.user!.tenantId, req.user!.userId, req.params.noteId as string, 'generate');
    return { message: noteIrnMessage(data), data };
  }),
);

gstEinvoiceRoutes.post(
  '/einvoice/notes/:noteId/retry',
  gstManagers,
  handle(async (req) => {
    const data = await einvoice.generateIrnForNote(req.user!.tenantId, req.user!.userId, req.params.noteId as string, 'retry');
    return { message: noteIrnMessage(data), data };
  }),
);

gstEinvoiceRoutes.post(
  '/einvoice/notes/:noteId/cancel',
  gstManagers,
  handle(async (req) => {
    const body = (req.body ?? {}) as { reasonCode?: unknown; remark?: unknown };
    const data = await einvoice.cancelIrnForNote(req.user!.tenantId, req.user!.userId, req.params.noteId as string, body);
    return { message: 'IRN cancelled', data };
  }),
);

const ewayMessage = (o: einvoice.EwayOutcome) =>
  o.alreadyGenerated
    ? `Already has e-way bill ${o.ewayBillNumber}`
    : o.status === 'generated'
      ? `E-way bill ${o.ewayBillNumber} generated${o.sandbox ? ' (SANDBOX — not registered with the government portal)' : ''}`
      : `E-way bill not generated: ${o.error ?? o.status}`;

gstEinvoiceRoutes.post(
  '/eway/returns/:returnId/generate',
  gstManagers,
  handle(async (req) => {
    const data = await einvoice.generateEwayBillForReturn(
      req.user!.tenantId,
      req.user!.userId,
      req.params.returnId as string,
      (req.body ?? {}) as einvoice.EwayInput,
    );
    return { message: ewayMessage(data), data };
  }),
);

gstEinvoiceRoutes.post(
  '/eway/returns/:returnId/retry',
  gstManagers,
  handle(async (req) => {
    const data = await einvoice.generateEwayBillForReturn(
      req.user!.tenantId,
      req.user!.userId,
      req.params.returnId as string,
      (req.body ?? {}) as einvoice.EwayInput,
      'retry',
    );
    return { message: ewayMessage(data), data };
  }),
);

gstEinvoiceRoutes.post(
  '/eway/returns/:returnId/cancel',
  gstManagers,
  handle(async (req) => {
    const body = (req.body ?? {}) as { reasonCode?: unknown; remark?: unknown };
    const data = await einvoice.cancelEwayBillForReturn(req.user!.tenantId, req.user!.userId, req.params.returnId as string, body);
    return { message: `E-way bill ${data.ewayBillNumber} cancelled`, data };
  }),
);
