import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './insurance.service';

// ============================================================
// Insurers
// ============================================================
export async function createInsurer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createInsurer(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Insurer created', data });
  } catch (err) { next(err); }
}
export async function getInsurers(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getInsurers(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.insurers, result.total, result.page, result.limit, 'Insurers retrieved');
  } catch (err) { next(err); }
}
export async function getInsurerById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getInsurerById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Insurer retrieved', data });
  } catch (err) { next(err); }
}
export async function updateInsurer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateInsurer(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Insurer updated', data });
  } catch (err) { next(err); }
}
export async function deleteInsurer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await service.deleteInsurer(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Insurer deleted' });
  } catch (err) { next(err); }
}

// ============================================================
// TPA Providers
// ============================================================
export async function createTPA(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createTPA(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'TPA provider created', data });
  } catch (err) { next(err); }
}
export async function getTPAs(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getTPAs(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.tpas, result.total, result.page, result.limit, 'TPA providers retrieved');
  } catch (err) { next(err); }
}
export async function getTPAById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getTPAById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'TPA provider retrieved', data });
  } catch (err) { next(err); }
}
export async function updateTPA(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateTPA(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'TPA provider updated', data });
  } catch (err) { next(err); }
}
export async function deleteTPA(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    await service.deleteTPA(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'TPA provider deleted' });
  } catch (err) { next(err); }
}

// ============================================================
// Policies
// ============================================================
export async function createPolicy(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createPolicy(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Policy created', data });
  } catch (err) { next(err); }
}
export async function getPolicies(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getPolicies(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.policies, result.total, result.page, result.limit, 'Policies retrieved');
  } catch (err) { next(err); }
}
export async function getPolicyById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getPolicyById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Policy retrieved', data });
  } catch (err) { next(err); }
}
export async function updatePolicy(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updatePolicy(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Policy updated', data });
  } catch (err) { next(err); }
}
export async function verifyPolicy(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.verifyPolicy(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Policy verified', data });
  } catch (err) { next(err); }
}
export async function getPoliciesByPatient(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getPoliciesByPatient(
      req.user!.tenantId,
      req.params.patientId as string,
    );
    sendResponse({ res, message: 'Patient policies retrieved', data });
  } catch (err) { next(err); }
}

// ============================================================
// Claims
// ============================================================
export async function createClaim(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createClaim(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Claim created', data });
  } catch (err) { next(err); }
}
export async function getClaims(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getClaims(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.claims, result.total, result.page, result.limit, 'Claims retrieved');
  } catch (err) { next(err); }
}
export async function getClaimById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getClaimById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Claim retrieved', data });
  } catch (err) { next(err); }
}
export async function updateClaim(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateClaim(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Claim updated', data });
  } catch (err) { next(err); }
}
export async function submitClaim(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.submitClaim(req.user!.tenantId, req.params.id as string, req.user!.userId);
    sendResponse({ res, message: 'Claim submitted', data });
  } catch (err) { next(err); }
}
export async function approveClaim(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.approveClaim(req.user!.tenantId, req.params.id as string, req.user!.userId, req.body);
    sendResponse({ res, message: 'Claim approved', data });
  } catch (err) { next(err); }
}
export async function rejectClaim(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.rejectClaim(req.user!.tenantId, req.params.id as string, req.user!.userId, req.body);
    sendResponse({ res, message: 'Claim rejected', data });
  } catch (err) { next(err); }
}
export async function partialApproveClaim(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.partialApproveClaim(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, message: 'Claim partially approved', data });
  } catch (err) { next(err); }
}
export async function settleClaim(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.settleClaim(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, message: 'Claim settlement recorded', data });
  } catch (err) { next(err); }
}
export async function resubmitClaim(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.resubmitClaim(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, statusCode: 201, message: 'Claim resubmitted', data });
  } catch (err) { next(err); }
}
export async function cancelClaim(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.cancelClaim(
      req.user!.tenantId,
      req.params.id as string,
      req.user!.userId,
      req.body,
    );
    sendResponse({ res, message: 'Claim cancelled', data });
  } catch (err) { next(err); }
}
export async function exportClaim(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.exportClaimForTpa(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Claim export prepared', data });
  } catch (err) { next(err); }
}
export async function getExpiringClaims(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const within = req.query.withinDays ? Number(req.query.withinDays) : 7;
    const data = await service.getExpiringClaims(req.user!.tenantId, within);
    sendResponse({ res, message: 'Expiring claims', data });
  } catch (err) { next(err); }
}

// ============================================================
// Pre-Authorization
// ============================================================
export async function createPreAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createPreAuth(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Pre-auth request created', data });
  } catch (err) { next(err); }
}
export async function getPreAuths(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getPreAuths(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.preAuths, result.total, result.page, result.limit, 'Pre-auth requests retrieved');
  } catch (err) { next(err); }
}
export async function getPreAuthById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getPreAuthById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Pre-auth request retrieved', data });
  } catch (err) { next(err); }
}
export async function updatePreAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updatePreAuth(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Pre-auth request updated', data });
  } catch (err) { next(err); }
}
export async function approvePreAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.approvePreAuth(req.user!.tenantId, req.params.id as string, req.body, req.user!.userId);
    sendResponse({ res, message: 'Pre-auth approved', data });
  } catch (err) { next(err); }
}
export async function rejectPreAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.rejectPreAuth(req.user!.tenantId, req.params.id as string, req.body, req.user!.userId);
    sendResponse({ res, message: 'Pre-auth rejected', data });
  } catch (err) { next(err); }
}
export async function holdPreAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.holdPreAuth(req.user!.tenantId, req.params.id as string, req.body, req.user!.userId);
    sendResponse({ res, message: 'Pre-auth put on hold', data });
  } catch (err) { next(err); }
}
export async function releasePreAuthHold(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.releasePreAuthHold(req.user!.tenantId, req.params.id as string, req.user!.userId);
    sendResponse({ res, message: 'Pre-auth hold released', data });
  } catch (err) { next(err); }
}
export async function cancelPreAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.cancelPreAuth(req.user!.tenantId, req.params.id as string, req.user!.userId);
    sendResponse({ res, message: 'Pre-auth cancelled', data });
  } catch (err) { next(err); }
}

// ============================================================
// Calc / Bill split
// ============================================================
export async function calcResponsibility(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const { policyId, billId } = req.query as { policyId: string; billId: string };
    const data = await service.calcResponsibility(req.user!.tenantId, policyId, billId);
    sendResponse({ res, message: 'Responsibility calculated', data });
  } catch (err) { next(err); }
}
export async function splitBill(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.splitBill(
      req.user!.tenantId,
      req.params.billId as string,
      req.body,
    );
    sendResponse({ res, message: 'Bill split applied', data });
  } catch (err) { next(err); }
}

// ============================================================
// Dashboard + Reports
// ============================================================
export async function getDashboard(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getDashboard(req.user!.tenantId);
    sendResponse({ res, message: 'Dashboard retrieved', data });
  } catch (err) { next(err); }
}

export async function getClaimsSummaryReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getClaimsSummaryReport(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Claims summary report', data });
  } catch (err) { next(err); }
}
export async function getApprovalRateReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getApprovalRateReport(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Approval rate report', data });
  } catch (err) { next(err); }
}
export async function getAgingReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getAgingReport(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Claims aging report', data });
  } catch (err) { next(err); }
}
export async function getOutstandingReport(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getOutstandingReport(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Outstanding claims report', data });
  } catch (err) { next(err); }
}

// ============================================================
// TPA Communication Logs
// ============================================================
export async function createTpaLog(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createTpaLog(req.user!.tenantId, req.user!.userId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Communication logged', data });
  } catch (err) { next(err); }
}
export async function getTpaLogs(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getTpaLogs(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.logs, result.total, result.page, result.limit, 'Communication logs retrieved');
  } catch (err) { next(err); }
}
