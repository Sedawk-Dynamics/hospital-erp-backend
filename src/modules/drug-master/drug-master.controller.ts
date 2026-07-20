import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import { AppError } from '../../shared/appError';
import * as service from './drug-master.service';
import * as refresh from './drug-master.refresh';
import { listProviders } from './drug-master.providers';

export async function searchDrugMaster(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const drugs = await service.searchDrugMaster(req.query as any);
    sendResponse({ res, message: 'Drug catalog search', data: drugs });
  } catch (err) {
    next(err);
  }
}

export async function listDrugMaster(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { items, total, page, limit } = await service.listDrugMaster(req.query as any);
    sendPaginatedResponse(res, items, total, page, limit, 'Drug catalog retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getDrugMasterById(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const drug = await service.getDrugMasterById(req.params.id as string);
    sendResponse({ res, message: 'Drug retrieved', data: drug });
  } catch (err) {
    next(err);
  }
}

export async function createDrugMaster(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const drug = await service.createDrugMaster(
      req.user!.roles ?? [],
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Drug added to catalog', data: drug });
  } catch (err) {
    next(err);
  }
}

// G11: a pharmacist suggests an unlisted brand — lands unpublished for review.
export async function suggestDrugMaster(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const drug = await service.suggestDrugMaster(req.user!.userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Suggestion submitted to the national master for review',
      data: drug,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateDrugMaster(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const drug = await service.updateDrugMaster(
      req.user!.roles ?? [],
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Drug updated', data: drug });
  } catch (err) {
    next(err);
  }
}

export async function deleteDrugMaster(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const out = await service.deleteDrugMaster(req.user!.roles ?? [], req.params.id as string);
    sendResponse({ res, message: 'Drug removed from catalog', data: out });
  } catch (err) {
    next(err);
  }
}

// List the available drug-data providers (for the Refresh dialog dropdown).
export async function getDrugProviders(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    sendResponse({ res, message: 'Drug providers', data: listProviders() });
  } catch (err) {
    next(err);
  }
}

// Kick off a background catalog refresh. Source precedence: uploaded CSV
// (multipart "file") → JSON { url } → named { provider } → default provider.
export async function refreshCatalog(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
    const csvText = file?.buffer ? file.buffer.toString('utf-8') : undefined;
    const url =
      typeof req.body?.url === 'string' && /^https?:\/\//i.test(req.body.url)
        ? req.body.url
        : undefined;
    const provider = typeof req.body?.provider === 'string' ? req.body.provider : undefined;
    const sourceLabel = csvText
      ? `upload:${file?.originalname}`
      : url ?? provider ?? 'open-dataset';
    const st = refresh.startRefresh({ csvText, url, provider, sourceLabel });
    sendResponse({ res, statusCode: 202, message: 'Catalog refresh started', data: st });
  } catch (err) {
    next(err);
  }
}

export async function refreshStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    sendResponse({ res, message: 'Refresh status', data: refresh.getRefreshStatus() });
  } catch (err) {
    next(err);
  }
}

// ── HSN → GST tax reference (any authenticated pharmacy/inventory user) ──

// The full reference, so the stock-inward UI can cache it and auto-fill GST
// locally without a round trip per keystroke.
export async function listHsnGstRates(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    sendResponse({ res, message: 'HSN → GST reference', data: await service.listHsnGstRates() });
  } catch (err) {
    next(err);
  }
}

// Resolve one HSN code → GST rate (longest-prefix match). Returns null match
// (not a 404) so the caller can fall back to manual entry gracefully.
export async function lookupHsnGst(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const code = String(req.query.code ?? '');
    const match = await service.resolveHsnGst(code);
    sendResponse({ res, message: 'HSN → GST lookup', data: match });
  } catch (err) {
    next(err);
  }
}
