import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as configService from './ai.config.service';
import * as chatService from './ai.chat.service';
import * as platformService from './ai.platform.service';

// --- Super-admin: LLM provider configuration ("Configure LLM Options") ---
// tenantId (query for GET, body for PUT) selects the scope: omitted = platform
// default, a uuid = that hospital's override.

export async function getConfig(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = (req.query.tenantId as string) || null;
    const config = await configService.getAiConfigForAdmin(tenantId);
    sendResponse({ res, message: 'AI configuration', data: config });
  } catch (err) {
    next(err);
  }
}

export async function listConfigs(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await configService.listAiConfigs();
    sendResponse({ res, message: 'AI configurations', data });
  } catch (err) {
    next(err);
  }
}

export async function updateConfig(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, ...data } = req.body as { tenantId?: string | null };
    const result = await configService.updateAiConfig(req.user!.userId, tenantId ?? null, data);
    sendResponse({ res, message: 'AI configuration updated', data: result });
  } catch (err) {
    next(err);
  }
}

export async function resetConfig(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await configService.resetAiConfig(req.query.tenantId as string);
    sendResponse({ res, message: 'AI configuration reset to platform default', data: result });
  } catch (err) {
    next(err);
  }
}

export async function getModels(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    sendResponse({ res, message: 'AI model catalog', data: configService.getModelCatalog() });
  } catch (err) {
    next(err);
  }
}

// --- Any authenticated user: feature status for THEIR hospital ---

export async function getStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const status = await configService.getAiStatus(req.user!.tenantId);
    sendResponse({ res, message: 'AI status', data: status });
  } catch (err) {
    next(err);
  }
}

// --- Use Case 2 (Lvl 1): Patient AI chatbot for the doctor ---

export async function patientChat(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await chatService.patientChat(
      req.user!.tenantId,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, message: 'AI patient analysis', data: result });
  } catch (err) {
    next(err);
  }
}

export async function bloodReportAnalysis(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await chatService.bloodReportAnalysis(
      req.user!.tenantId,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, message: 'Blood report analysis', data: result });
  } catch (err) {
    next(err);
  }
}

// --- Use Case 3 (Lvl 1): Platform-wide support chatbot (read-only) ---

export async function platformChat(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await platformService.platformChat(
      req.user!.tenantId,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, message: 'Support assistant', data: result });
  } catch (err) {
    next(err);
  }
}
