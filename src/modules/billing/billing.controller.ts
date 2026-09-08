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
    const { getHospitalBranding, resolvePdfTemplate } = await import('../hospital-branding/hospital-branding.service');
    const [receipt, branding, template] = await Promise.all([
      billingService.getReceiptById(tenantId, req.params.id as string),
      getHospitalBranding(tenantId),
      resolvePdfTemplate(tenantId, 'payment_receipt'),
    ]);
    const { streamReceiptPdf } = await import('./billing.receipt-pdf');
    streamReceiptPdf(res, receipt as any, branding, template);
  } catch (err) {
    next(err);
  }
}

/**
 * The printable OP / counter bill. Read-only, and unlike the receipt it does
 * not need a payment to exist first.
 */
export async function getBillDocument(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const bill = await billingService.getBillDocument(tenantId, req.params.id as string);
    sendResponse({ res, message: 'Bill document retrieved successfully', data: bill });
  } catch (err) {
    next(err);
  }
}

export async function getBillDocumentPdf(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { getHospitalBranding, resolvePdfTemplate } = await import('../hospital-branding/hospital-branding.service');
    const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
    const [bill, branding, template, gstProfile] = await Promise.all([
      billingService.getBillDocument(tenantId, req.params.id as string),
      getHospitalBranding(tenantId),
      resolvePdfTemplate(tenantId, 'op_bill'),
      // Decides whether this bill prints as a GST document at all.
      getGstProfile(tenantId),
    ]);
    const { streamOpBillPdf } = await import('./billing.op-bill-pdf');
    streamOpBillPdf(res, bill as any, branding, template, gstProfile);
  } catch (err) {
    next(err);
  }
}

/**
 * The printable bill for an IP / Emergency / Day Care stay, as JSON for the
 * on-screen print view. Read-only and available at any time — before discharge
 * it renders as an interim bill, afterwards as the final one.
 */
export async function getAdmissionBillDocument(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { buildAdmissionBillDocument } = await import('./billing.bill-document');
    const data = await buildAdmissionBillDocument(
      req.user!.tenantId,
      req.params.admissionId as string,
      { userId: req.user!.userId, roles: req.user!.roles ?? [] },
    );
    sendResponse({ res, message: 'Admission bill document', data });
  } catch (err) {
    next(err);
  }
}

/** Same document as a branded PDF (hospital letterhead from the PDF Builder). */
export async function getAdmissionBillPdf(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const { buildAdmissionBillDocument } = await import('./billing.bill-document');
    // Branding and template ride on the document, so the PDF and the print view
    // cannot be rendered from different settings — and we resolve them once.
    const doc = await buildAdmissionBillDocument(tenantId, req.params.admissionId as string, {
      userId: req.user!.userId,
      roles: req.user!.roles ?? [],
    });
    const { streamAdmissionBillPdf } = await import('./billing.ip-bill-pdf');
    streamAdmissionBillPdf(res, doc, doc.hospital, doc.template);
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

// --- Discount approval ---

export async function getDiscountPolicy(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const policy = await billingService.getDiscountApprovalSettings(req.user!.tenantId);
    sendResponse({ res, message: 'Discount policy retrieved', data: policy });
  } catch (err) { next(err); }
}

export async function updateDiscountPolicy(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = req.user!;
    const policy = await billingService.updateDiscountApprovalSettings(tenantId, userId, req.body);
    sendResponse({ res, message: 'Discount policy updated', data: policy });
  } catch (err) { next(err); }
}

export async function getPendingDiscounts(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const rows = await billingService.getPendingDiscounts(req.user!.tenantId);
    sendResponse({ res, message: 'Pending concessions retrieved', data: rows });
  } catch (err) { next(err); }
}

export async function approveDiscount(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = req.user!;
    const d = await billingService.decideDiscount(tenantId, userId, req.params.id as string, { approve: true });
    sendResponse({ res, message: 'Concession approved', data: d });
  } catch (err) { next(err); }
}

export async function rejectDiscount(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = req.user!;
    const d = await billingService.decideDiscount(tenantId, userId, req.params.id as string, {
      approve: false,
      reason: req.body?.reason,
    });
    sendResponse({ res, message: 'Concession rejected', data: d });
  } catch (err) { next(err); }
}

// --- Cash drawer close ---

export async function getDrawerStatus(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const { tenantId, userId } = req.user!;
    const q = req.query as { date?: string; cashierId?: string; openingFloat?: number };
    const status = await billingService.getDrawerStatus(tenantId, q.cashierId ?? userId, q);
    sendResponse({ res, message: 'Drawer status retrieved successfully', data: status });
  } catch (err) {
    next(err);
  }
}

export async function closeDrawer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = req.user!;
    const closure = await billingService.closeDrawer(tenantId, userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Drawer closed successfully', data: closure });
  } catch (err) {
    next(err);
  }
}

export async function listDrawerClosures(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await billingService.listDrawerClosures(tenantId, req.query as any);
    sendResponse({ res, message: 'Drawer closures retrieved successfully', data: result });
  } catch (err) {
    next(err);
  }
}

export async function reopenDrawer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { tenantId, userId } = req.user!;
    const result = await billingService.reopenDrawer(tenantId, userId, req.params.id as string);
    sendResponse({ res, message: 'Drawer reopened for recount', data: result });
  } catch (err) {
    next(err);
  }
}

export async function getPendingOrders(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const result = await billingService.getPendingOrders(tenantId, req.query as any);
    sendResponse({ res, message: 'Pending orders retrieved successfully', data: result });
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
    const result = await billingService.billOtRequest(tenantId, req.params.otRequestId as string, req.user!.userId, {
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
        // Who is acting comes from the token, never from the request body.
        // This value is stored as `requestedBy`, and decideDiscount refuses an
        // approval by the person who requested it — so a body that could name
        // someone else let one person do both halves of the gate.
        approvedBy: req.user!.userId,
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

/**
 * Approve (or withdraw approval of) a tariff's GST classification.
 *
 * Separate from updating the tariff because it is a different act by a
 * different person: the report puts the item-to-code mapping in the hospital
 * auditor's hands, not the billing clerk's, and this is the only thing that
 * ever writes `gstApproved`.
 */
export async function setServiceTariffGstApproval(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const tenantId = req.user!.tenantId;
    const tariff = await billingService.setServiceTariffGstApproval(
      tenantId,
      req.user!.userId,
      req.params.id as string,
      Boolean((req.body as { approved: boolean }).approved),
    );
    sendResponse({
      res,
      message: tariff.gstApproved
        ? 'GST classification approved'
        : 'GST approval withdrawn',
      data: tariff,
    });
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
    const settlement = await billingService.settleCredit(tenantId, req.user!.userId, req.params.id as string, req.body);
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
    const bill = await billingService.createBill(tenantId, req.user!.userId, req.body);
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

export async function updateBillItem(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const item = await billingService.updateBillItem(
      tenantId,
      req.params.id as string,
      req.params.itemId as string,
      req.body,
    );
    sendResponse({ res, message: 'Bill item updated successfully', data: item });
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
    const bill = await billingService.finalizeBill(
      tenantId,
      req.user!.userId,
      req.params.id as string,
    );
    sendResponse({
      res,
      message: 'Bill finalized successfully',
      data: bill,
    });
  } catch (err) {
    next(err);
  }
}

export async function reopenBill(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId;
    const bill = await billingService.reopenBill(tenantId, req.params.id as string);
    sendResponse({
      res,
      message: 'Bill reopened for editing',
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
    const roles = req.user!.roles ?? [];
    const data = await billingService.addIpCharge(tenantId, userId, req.params.admissionId as string, req.body, roles);
    sendResponse({ res, statusCode: 201, message: 'Charge added to the IP ledger', data });
  } catch (err) {
    next(err);
  }
}

export async function removeIpCharge(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.removeIpCharge(
      req.user!.tenantId,
      req.user!.userId,
      req.params.admissionId as string,
      req.params.itemId as string,
      req.user!.roles ?? [],
    );
    sendResponse({ res, message: 'Charge removed from the IP ledger', data });
  } catch (err) {
    next(err);
  }
}

export async function consolidateAdmissionBill(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.consolidateAdmissionBill(
      req.user!.tenantId,
      req.user!.userId,
      req.params.admissionId as string,
      { finalize: true },
    );
    sendResponse({ res, message: 'IP bill consolidated', data });
  } catch (err) {
    next(err);
  }
}

export async function transferAdmissionToTpa(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.transferAdmissionToTpa(
      req.user!.tenantId,
      req.user!.userId,
      req.params.admissionId as string,
      req.body ?? {},
    );
    sendResponse({ res, statusCode: 201, message: 'Bill transferred to TPA — insurance claim raised', data });
  } catch (err) {
    next(err);
  }
}

export async function recordTpaSettlement(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.recordTpaSettlement(
      req.user!.tenantId,
      req.user!.userId,
      req.params.admissionId as string,
      req.body,
    );
    sendResponse({ res, message: 'TPA settlement recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function setBillItemReimbursable(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.setBillItemReimbursable(
      req.user!.tenantId,
      req.params.itemId as string,
      req.body.isReimbursable ?? null,
    );
    sendResponse({ res, message: 'Bill line split updated', data });
  } catch (err) {
    next(err);
  }
}

export async function getAdmissionLedger(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.getAdmissionLedger(req.user!.tenantId, req.params.admissionId as string, {
      userId: req.user!.userId,
      roles: req.user!.roles ?? [],
    });
    sendResponse({ res, message: 'IP admission ledger', data });
  } catch (err) {
    next(err);
  }
}

// The IP billing worklist — one row per admission, from day one.
export async function getIpAdmissionsForBilling(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.getIpAdmissionsForBilling(req.user!.tenantId, req.user!.userId, {
      search: (req.query.search as string) || undefined,
      includeDischarged: req.query.includeDischarged === 'true' || req.query.includeDischarged === '1',
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    sendResponse({ res, message: 'IP admissions for billing', data });
  } catch (err) {
    next(err);
  }
}

// Cut (part of) the admission deposit from the running IP bill.
export async function applyDepositToBill(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.applyDepositToBill(
      req.user!.tenantId,
      req.user!.userId,
      req.params.admissionId as string,
      { userId: req.user!.userId, roles: req.user!.roles ?? [] },
      { amount: req.body?.amount != null ? Number(req.body.amount) : undefined },
    );
    sendResponse({ res, message: 'Deposit applied to the IP bill', data });
  } catch (err) {
    next(err);
  }
}

// Return the unused deposit to the patient (e.g. insurance covered the charges).
export async function refundDeposit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.refundDeposit(
      req.user!.tenantId,
      req.user!.userId,
      req.params.admissionId as string,
      { userId: req.user!.userId, roles: req.user!.roles ?? [] },
      { amount: req.body?.amount != null ? Number(req.body.amount) : undefined, reason: req.body?.reason },
    );
    sendResponse({ res, message: 'Deposit returned to the patient', data });
  } catch (err) {
    next(err);
  }
}

export async function recordDoctorVisit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.recordDoctorVisit(
      req.user!.tenantId,
      req.user!.userId,
      req.params.admissionId as string,
      req.body,
      req.user!.roles ?? [],
    );
    sendResponse({ res, statusCode: 201, message: 'Doctor visit recorded', data });
  } catch (err) {
    next(err);
  }
}

export async function getAdmissionActivity(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await billingService.getAdmissionActivity(req.user!.tenantId, req.params.admissionId as string, {
      userId: req.user!.userId,
      roles: req.user!.roles ?? [],
    });
    sendResponse({ res, message: 'IP admission activity log', data });
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
    const discount = await billingService.applyDiscount(
      tenantId,
      req.params.id as string,
      req.body,
      req.user!.userId,
    );
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
    const result = await billingService.createPayment(tenantId, req.user!.userId, req.body);
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
    const refund = await billingService.createRefund(tenantId, req.user!.userId, req.body);
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
