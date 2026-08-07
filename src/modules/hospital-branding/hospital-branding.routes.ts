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

// Per-document-type templates (page setup, typography, watermark, footer,
// signature block, custom text). `__all__` carries the hospital-wide defaults
// every type inherits. Literal subpath first — see the route-shadowing rule.
hospitalBrandingRoutes.get('/templates', ...adminOnly, controller.listTemplates);
hospitalBrandingRoutes.get('/templates/:documentType', ...adminOnly, controller.getTemplate);
hospitalBrandingRoutes.put('/templates/:documentType', ...adminOnly, controller.saveTemplate);
hospitalBrandingRoutes.delete('/templates/:documentType', ...adminOnly, controller.resetTemplate);
hospitalBrandingRoutes.post(
  '/logo',
  ...adminOnly,
  (req: Request, res: Response, next: NextFunction) => uploadSingle('file')(req, res, next),
  controller.uploadLogo,
);
hospitalBrandingRoutes.delete('/logo', ...adminOnly, controller.removeLogo);
