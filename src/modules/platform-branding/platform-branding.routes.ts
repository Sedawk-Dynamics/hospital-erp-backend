import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRoles } from '../../middleware/authorize';
import { uploadSingle } from '../../services/upload.service';
import * as controller from './platform-branding.controller';

export const platformBrandingRoutes = Router();

// Public read — used by the login screen, website and in-app chrome to render
// the platform logo (no auth: the brand shows before a user signs in).
platformBrandingRoutes.get('/', controller.getBranding);

// Super-admin only: upload a logo variant. multipart/form-data:
//   file    = the image (PNG / JPG / WebP)
//   variant = 'light' | 'dark'  (which placement it's for)
platformBrandingRoutes.post(
  '/logo',
  authenticate,
  requireRoles('super_admin'),
  (req: Request, res: Response, next: NextFunction) => uploadSingle('file')(req, res, next),
  controller.uploadLogo,
);

// Super-admin only: remove a logo variant (?variant=light|dark).
platformBrandingRoutes.delete(
  '/logo',
  authenticate,
  requireRoles('super_admin'),
  controller.deleteLogo,
);
