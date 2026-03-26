import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as bankLinkingService from './bank-linking.service';

/**
 * POST /api/v1/bank-linking/link
 * Link a bank account to the tenant via Razorpay Route API.
 */
export async function linkBankAccount(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await bankLinkingService.linkBankAccount(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Bank account linked successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/bank-linking/status
 * Get the bank link status for the authenticated tenant.
 */
export async function getBankLinkStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await bankLinkingService.getBankLinkStatus(tenantId);
    sendResponse({
      res,
      message: 'Bank link status retrieved successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/bank-linking/unlink
 * Unlink the bank account from the tenant.
 */
export async function unlinkBankAccount(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await bankLinkingService.unlinkBankAccount(tenantId);
    sendResponse({
      res,
      message: 'Bank account unlinked successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
