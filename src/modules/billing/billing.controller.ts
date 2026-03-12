import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as billingService from './billing.service';

// --- Service Tariffs ---

export async function createServiceTariff(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const tariff = await billingService.createServiceTariff(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Service tariff created successfully',
      data: tariff,
    });
  } catch (err) {
    next(err);
  }
}

export async function getServiceTariffs(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { tariffs, total, page, limit } = await billingService.getServiceTariffs(
      tenantId,
      req.query,
    );
    sendPaginatedResponse(res, tariffs, total, page, limit, 'Service tariffs retrieved');
  } catch (err) {
    next(err);
  }
}

export async function updateServiceTariff(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const tariff = await billingService.updateServiceTariff(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Service tariff updated successfully',
      data: tariff,
    });
  } catch (err) {
    next(err);
  }
}

// --- Bills ---

export async function createBill(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const bill = await billingService.createBill(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Bill created successfully',
      data: bill,
    });
  } catch (err) {
    next(err);
  }
}

export async function getBills(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { bills, total, page, limit } = await billingService.getBills(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, bills, total, page, limit, 'Bills retrieved successfully');
  } catch (err) {
    next(err);
  }
}

export async function getBillById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const bill = await billingService.getBillById(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Bill retrieved successfully',
      data: bill,
    });
  } catch (err) {
    next(err);
  }
}

export async function addBillItem(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const item = await billingService.addBillItem(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Bill item added successfully',
      data: item,
    });
  } catch (err) {
    next(err);
  }
}

export async function removeBillItem(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    await billingService.removeBillItem(tenantId, req.params.id as string, req.params.itemId as string);
    sendResponse({
      res,
      message: 'Bill item removed successfully',
    });
  } catch (err) {
    next(err);
  }
}

export async function finalizeBill(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const bill = await billingService.finalizeBill(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Bill finalized successfully',
      data: bill,
    });
  } catch (err) {
    next(err);
  }
}

export async function applyDiscount(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const discount = await billingService.applyDiscount(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Discount applied successfully',
      data: discount,
    });
  } catch (err) {
    next(err);
  }
}

export async function getPatientBills(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const bills = await billingService.getPatientBills(tenantId, req.params.patientId as string);
    sendResponse({
      res,
      message: 'Patient bills retrieved successfully',
      data: bills,
    });
  } catch (err) {
    next(err);
  }
}

// --- Payments ---

export async function createPayment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await billingService.createPayment(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Payment recorded successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function getPayments(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const { payments, total, page, limit } = await billingService.getPayments(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, payments, total, page, limit, 'Payments retrieved successfully');
  } catch (err) {
    next(err);
  }
}

// --- Refunds ---

export async function createRefund(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const refund = await billingService.createRefund(tenantId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Refund request created successfully',
      data: refund,
    });
  } catch (err) {
    next(err);
  }
}

export async function approveRefund(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const approvedBy = req.user!.userId;
    const refund = await billingService.approveRefund(tenantId, req.params.id as string, approvedBy);
    sendResponse({
      res,
      message: 'Refund approved successfully',
      data: refund,
    });
  } catch (err) {
    next(err);
  }
}
