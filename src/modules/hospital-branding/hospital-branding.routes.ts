import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles } from '../../middleware/authorize';
import { uploadSingle } from '../../services/upload.service';
import * as controller from './hospital-branding.controller';

export const hospitalBrandingRoutes = Router();

// Hospital admin only (super_admin also allowed): the per-hospital PDF/print
// branding that every document inherits.
const adminOnly = [authenticate, requireRoles('super_admin', 'admin')];

hospitalBrandingRoutes.get('/', ...adminOnly, controller.getBranding);
hospitalBrandingRoutes.put('/', ...adminOnly, controller.updateBranding);
hospitalBrandingRoutes.post('/preview.pdf', ...adminOnly, controller.previewPdf);
hospitalBrandingRoutes.post(
  '/logo',
  ...adminOnly,
  (req: Request, res: Response, next: NextFunction) => uploadSingle('file')(req, res, next),
  controller.uploadLogo,
);
hospitalBrandingRoutes.delete('/logo', ...adminOnly, controller.removeLogo);
