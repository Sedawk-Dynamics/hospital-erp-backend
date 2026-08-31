import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './disorders.service';

export async function searchDisorders(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { q, limit } = req.query as { q: string; limit?: string };
    const results = await service.searchDisorders(
      req.user!.tenantId,
      q,
      limit ? Number(limit) : undefined,
    );
    sendResponse({ res, message: 'Disorder search', data: results });
  } catch (err) {
    next(err);
  }
}

export async function listDisorders(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { items, total, page, limit } = await service.listDisorders(req.query as any);
    sendPaginatedResponse(res, items, total, page, limit, 'Disorders retrieved');
  } catch (err) {
    next(err);
  }
}

export async function createDisorder(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const created = await service.createDisorder(req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Disorder added', data: created });
  } catch (err) {
    next(err);
  }
}

export async function deleteDisorder(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.deleteDisorder(String(req.params.id));
    sendResponse({
      res,
      // Said plainly, because the two are genuinely different: a seeded
      // disorder is switched off and can be restored, a hand-added one is gone.
      message: result.removed
        ? 'Disorder deleted'
        : 'Disorder removed from the list — it can be restored',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function restoreDisorder(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const restored = await service.restoreDisorder(String(req.params.id));
    sendResponse({ res, message: 'Disorder restored', data: restored });
  } catch (err) {
    next(err);
  }
}
