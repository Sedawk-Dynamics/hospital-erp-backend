import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import { AppError } from '../../shared/appError';
import * as service from './platform-branding.service';
import type { LogoVariant } from './platform-branding.service';

function parseVariant(raw: unknown): LogoVariant {
  return raw === 'dark' ? 'dark' : 'light';
}

// Public: any surface (incl. the pre-auth login screen & website) can read the
// two platform logo URLs to render the brand mark.
export async function getBranding(_req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    sendResponse({ res, message: 'Platform branding', data: service.getBranding() });
  } catch (err) {
    next(err);
  }
}

// Super-admin only: upload/replace one placement variant's logo.
export async function uploadLogo(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) throw AppError.badRequest('No image uploaded. Attach a PNG, JPG or WebP file.');
    const variant = parseVariant(req.body?.variant);
    const data = service.setLogo(variant, file.filename);
    sendResponse({ res, statusCode: 201, message: `${variant === 'dark' ? 'Dark' : 'Light'}-background logo updated`, data });
  } catch (err) {
    next(err);
  }
}

// Super-admin only: clear one variant back to the built-in icon fallback.
export async function deleteLogo(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const variant = parseVariant(req.query?.variant);
    const data = service.clearLogo(variant);
    sendResponse({ res, message: `${variant === 'dark' ? 'Dark' : 'Light'}-background logo removed`, data });
  } catch (err) {
    next(err);
  }
}
