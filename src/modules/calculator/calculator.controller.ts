import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as calculatorService from './calculator.service';

export const addCalculator = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const tenantId = req.user!.tenantId as string;
    const userId = req.user!.userId as string;
    const result = await calculatorService.createCalculator(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Calculator added successfully', data: result });
  } catch (error) {
    next(error);
  }
};

export const fetchCalculators = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const tenantId = req.user!.tenantId as string;
    const userId = req.user!.userId as string;
    const result = await calculatorService.fetchCalculators(tenantId, userId, req.query);
    sendResponse({ res, message: 'Calculators fetched successfully', data: result });
  } catch (error) {
    next(error);
  }
};

export const updateCalculator = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const tenantId = req.user!.tenantId as string;
    const userId = req.user!.userId as string;
    const result = await calculatorService.updateCalculator(
      tenantId,
      userId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Calculator updated successfully', data: result });
  } catch (error) {
    next(error);
  }
};
