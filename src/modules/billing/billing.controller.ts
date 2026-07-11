import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as billingService from './billing.service';

// --- Week 12: Split payment / advance / reversal / cancel / receipts ---

export async function createSplitPayment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await billingService.createSplitPayment(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Split payment recorded successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function createAdvancePayment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await billingService.createAdvancePayment(tenantId, userId, req.body);
    sendResponse({
      res,
      statusCode: 201,
      message: 'Advance payment recorded',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function adjustAdvance(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await billingService.adjustAdvanceToBill(tenantId, userId, req.body);
    sendResponse({ res, message: 'Advance adjusted', data: result });
  } catch (err) {
    next(err);
  }
}

export async function getPatientAdvanceBalance(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const balance = await billingService.getPatientAdvanceBalance(
      tenantId,
      req.params.patientId as string,
    );
    sendResponse({ res, message: 'Advance balance retrieved', data: balance });
  } catch (err) {
    next(err);
  }
}

export async function reversePayment(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await billingService.reversePayment(tenantId, userId, req.body);
    sendResponse({ res, message: 'Payment reversed', data: result });
  } catch (err) {
    next(err);
  }
}

export async function cancelBill(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const result = await billingService.cancelBill(
      tenantId,
      userId,
      req.params.id as string,
      req.body,
    );
    sendResponse({ res, message: 'Bill cancelled', data: result });
  } catch (err) {
    next(err);
  }
}

export async function rejectRefund(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const rejectedBy = req.user!.userId;
    const result = await billingService.rejectRefund(
      tenantId,
      req.params.id as string,
      rejectedBy,
      req.body.reason,
    );
    sendResponse({ res, message: 'Refund rejected', data: result });
  } catch (err) {
    next(err);
  }
}

export async function getRefunds(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { refunds, total, page, limit } = await billingService.getRefunds(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, refunds, total, page, limit, 'Refunds retrieved');
  } catch (err) {
    next(err);
  }
}

export async function listReceipts(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { receipts, total, page, limit } = await billingService.listReceipts(
      tenantId,
      req.query as any,
    );
    sendPaginatedResponse(res, receipts, total, page, limit, 'Receipts retrieved');
  } catch (err) {
    next(err);
  }
}

export async function getReceiptPdf(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const receipt = await billingService.getReceiptById(tenantId, req.params.id as string);
    const { streamReceiptPdf } = await import('./billing.receipt-pdf');
    streamReceiptPdf(res, receipt as any);
  } catch (err) {
    next(err);
  }
}

export async function getDayEndReport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await billingService.getDayEndReport(tenantId, req.query as any);
    sendResponse({ res, message: 'Day-end report retrieved', data: result });
  } catch (err) {
    next(err);
  }
}

export async function getCreditSettlementBills(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const bills = await billingService.getCreditSettlementBills(
      tenantId,
      req.params.id as string,
    );
    sendResponse({ res, message: 'Settlement bills retrieved', data: bills });
  } catch (err) {
    next(err);
  }
}

// --- Charges (auto-pull) ---

export async function getCharges(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await billingService.getPatientCharges(tenantId, req.query as any);
    sendResponse({ res, message: 'Charges retrieved successfully', data: result });
  } catch (err) {
    next(err);
  }
}

export async function pullCharges(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await billingService.pullChargesToBill(
      tenantId,
      req.params.id as string,
      req.body.charges,
    );
    sendResponse({
      res,
      statusCode: 201,
      message: 'Charges auto-pulled to bill',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

// --- OT surgery → bill ---

export async function billOtRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await billingService.billOtRequest(tenantId, req.params.otRequestId as string, {
      collectPayment: req.body?.collectPayment === true,
      paymentMethod: req.body?.paymentMethod,
    });
    sendResponse({
      res,
      statusCode: 201,
      message: result.paid ? 'Surgery billed and payment recorded' : 'Surgery added to bill',
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

// --- Bill-level discount ---

export async function setBillDiscount(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const bill = await billingService.setBillDiscount(
      tenantId,
      req.params.id as string,
      {
        ...req.body,
        approvedBy: req.body.approvedBy ?? req.user!.userId,
      },
    );
    sendResponse({ res, message: 'Discount updated', data: bill });
  } catch (err) {
    next(err);
  }
}

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

export async function deleteServiceTariff(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    await billingService.deleteServiceTariff(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Service tariff deleted successfully',
    });
  } catch (err) {
    next(err);
  }
}

// --- Collection Summary ---

export async function getCollectionSummary(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const summary = await billingService.getCollectionSummary(tenantId, req.query as any);
    sendResponse({
      res,
      message: 'Collection summary retrieved successfully',
      data: summary,
    });
  } catch (err) {
    next(err);
  }
}

// --- Credit Settlements ---

export async function getCreditSettlements(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { settlements, total, page, limit, stats } = await billingService.getCreditSettlements(
      tenantId,
      req.query as any,
    );
    sendResponse({
      res,
      message: 'Credit settlements retrieved',
      data: { settlements, stats, page, limit, total } as any,
    });
  } catch (err) {
    next(err);
  }
}

export async function settleCredit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const settlement = await billingService.settleCredit(tenantId, req.params.id as string, req.body);
    sendResponse({
      res,
      message: 'Credit settled successfully',
      data: settlement,
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

// G5 (2.1): assemble an admission's discharge bill — pull outstanding charges onto
// a finalized final-charges bill, optionally applying the patient's advance.
export async function assembleDischargeBill(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await billingService.assembleDischargeBill(tenantId, userId, req.params.admissionId as string, {
      applyAdvance: !!req.body?.applyAdvance,
    });
    sendResponse({ res, message: 'Discharge bill assembled', data });
  } catch (err) {
    next(err);
  }
}

// IP running ledger — a clinician posts a charge; anyone on the care team reads it.
export async function addIpCharge(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const userId = req.user!.userId;
    const data = await billingService.addIpCharge(tenantId, userId, req.params.admissionId as string, req.body);
    sendResponse({ res, statusCode: 201, message: 'Charge added to the IP ledger', data });
  } catch (err) {
    next(err);
  }
}

export async function getAdmissionLedger(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.getAdmissionLedger(req.user!.tenantId, req.params.admissionId as string);
    sendResponse({ res, message: 'IP admission ledger', data });
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
