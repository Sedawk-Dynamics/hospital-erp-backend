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
