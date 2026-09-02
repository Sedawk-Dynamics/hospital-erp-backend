import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission, requireRoles } from '../../middleware/authorize';
import { sendResponse } from '../../shared/apiResponse';
import type { AuthenticatedRequest } from '../../shared/types';
import * as service from './hospital-settings.service';

export const hospitalSettingsRoutes = Router();

// The registration fee is money the hospital charges, so only the hospital
// admin sets it — the same bar as the rest of Settings.
const adminOnly = [authenticate, requireRoles('super_admin', 'admin')];

hospitalSettingsRoutes.get(
  '/registration-fee',
  ...adminOnly,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.getRegistrationFeeSettings(req.user!.tenantId);
      sendResponse({ res, message: 'Registration fee settings', data });
    } catch (err) {
      next(err);
    }
  },
);

hospitalSettingsRoutes.put(
  '/registration-fee',
  ...adminOnly,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.updateRegistrationFeeSettings(req.user!.tenantId, req.body ?? {});
      sendResponse({ res, message: 'Registration fee saved', data });
    } catch (err) {
      next(err);
    }
  },
);

// Controlled-drug policy. Only an admin flips it, since it decides whether a
// narcotic can leave the pharmacy through an ordinary counter at all.
hospitalSettingsRoutes.put(
  '/controlled-drugs',
  ...adminOnly,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.updateControlledDrugSettings(req.user!.tenantId, req.body ?? {});
      sendResponse({ res, message: 'Controlled-drug settings saved', data });
    } catch (err) {
      next(err);
    }
  },
);

// Readable by anyone who dispenses — the counter and the ward need to know
// which mode is live to know whether to show the controlled-drug panel.
hospitalSettingsRoutes.get(
  '/controlled-drugs',
  authenticate,
  requirePermission('pharmacy', 'read'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.getControlledDrugSettings(req.user!.tenantId);
      sendResponse({ res, message: 'Controlled-drug settings', data });
    } catch (err) {
      next(err);
    }
  },
);

// Statutory drug licences. Written by an admin; readable by anyone who prints a
// register, since the licence block is part of the document's header.
hospitalSettingsRoutes.put(
  '/drug-licence',
  ...adminOnly,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.updateDrugLicenceSettings(req.user!.tenantId, req.body ?? {});
      sendResponse({ res, message: 'Drug licence details saved', data });
    } catch (err) {
      next(err);
    }
  },
);

hospitalSettingsRoutes.get(
  '/drug-licence',
  authenticate,
  requirePermission('pharmacy', 'read'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.getDrugLicenceSettings(req.user!.tenantId);
      sendResponse({ res, message: 'Drug licence details', data });
    } catch (err) {
      next(err);
    }
  },
);

// GST registration. Written by an admin only — it is the hospital's own tax
// identity and a wrong GSTIN invalidates every invoice printed against it.
hospitalSettingsRoutes.put(
  '/gst-profile',
  ...adminOnly,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.updateGstProfile(req.user!.tenantId, req.body ?? {});
      sendResponse({ res, message: 'GST registration saved', data });
    } catch (err) {
      next(err);
    }
  },
);

// Readable by anyone who raises a bill, because the counter has to know whether
// it is issuing a tax invoice or a bill of supply before it prints one.
hospitalSettingsRoutes.get(
  '/gst-profile',
  authenticate,
  requirePermission('billing', 'read'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.getGstProfile(req.user!.tenantId);
      sendResponse({ res, message: 'GST registration', data });
    } catch (err) {
      next(err);
    }
  },
);

// Read-only, and needed by whoever books an appointment — the front desk, not
// just the admin — so it is gated on reading patients rather than on being an
// admin. It returns the fee settings alongside, which is fine: the desk has to
// see the amount to tell the patient what they are paying.
hospitalSettingsRoutes.get(
  '/patient-visit-status/:patientId',
  authenticate,
  requirePermission('patients', 'read'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await service.getPatientVisitStatus(
        req.user!.tenantId,
        req.params.patientId as string,
        { excludeAppointmentId: (req.query.excludeAppointmentId as string) || undefined },
      );
      sendResponse({ res, message: 'Patient visit status', data });
    } catch (err) {
      next(err);
    }
  },
);
