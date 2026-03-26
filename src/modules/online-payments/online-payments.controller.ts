import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import { prisma } from '../../config/database';
import { onlinePaymentsService } from './online-payments.service';

export const createOnlineOrder = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = await onlinePaymentsService.createOnlineOrder(
      req.user!.tenantId,
      req.user!.userId,
      req.body
    );

    sendResponse({ res, statusCode: 201, message: 'Online order created successfully', data: result });
  } catch (error) {
    next(error);
  }
};

export const verifyOnlinePayment = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = await onlinePaymentsService.verifyOnlinePayment(req.body);

    sendResponse({ res, message: 'Payment verified successfully', data: result });
  } catch (error) {
    next(error);
  }
};

export const handleWebhook = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const rawBody = (req.body as Buffer).toString('utf-8');
    const signature = req.headers['x-razorpay-signature'] as string;

    await onlinePaymentsService.handleWebhook(rawBody, signature);

    res.json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
};

export const getBankStatus = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user!.tenantId },
      select: { linkedAccountId: true, bankVerified: true },
    });

    sendResponse({ res, message: 'Bank status retrieved', data: {
      linkedAccountId: tenant?.linkedAccountId || null,
      bankVerified: tenant?.bankVerified || false,
    } });
  } catch (error) {
    next(error);
  }
};
