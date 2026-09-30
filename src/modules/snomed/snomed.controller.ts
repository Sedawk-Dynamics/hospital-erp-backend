import { NextFunction, Request, Response } from 'express';
import { sendResponse } from '../../shared/apiResponse';
import { searchSnomedConcepts, selectedSnomed } from './snomed.service';

export async function searchSnomed(req: Request, res: Response, next: NextFunction) {
  try {
    const { q, limit } = req.query as unknown as { q: string; limit?: number };
    const results = await searchSnomedConcepts(q, limit);
    sendResponse({ res, message: 'SNOMED concepts retrieved', data: results });
  } catch (err) {
    next(err);
  }
}

export async function snomedSelect(req: Request, res: Response, next: NextFunction) {
  try {
    const snomedCode = req.params.conceptId as string;
    const results = await selectedSnomed(snomedCode);
    sendResponse({ res, message: 'SNOMED mapping retrieved', data: results });
  } catch (error) {
    next(error);
  }
}
