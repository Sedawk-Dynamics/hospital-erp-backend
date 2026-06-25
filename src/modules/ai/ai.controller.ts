import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as configService from './ai.config.service';

// --- Super-admin: LLM provider configuration ("Configure LLM Options") ---

export async function getConfig(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const config = await configService.getAiConfigForAdmin();
    sendResponse({ res, message: 'AI configuration', data: config });
  } catch (err) {
    next(err);
  }
}

export async function updateConfig(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await configService.updateAiConfig(req.user!.userId, req.body);
    sendResponse({ res, message: 'AI configuration updated', data: result });
  } catch (err) {
    next(err);
  }
}

// --- Any authenticated user: feature status (drives UI affordances) ---

export async function getStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const status = await configService.getAiStatus();
    sendResponse({ res, message: 'AI status', data: status });
  } catch (err) {
    next(err);
  }
}
