import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../../shared/types';
import { sendPaginatedResponse, sendResponse } from '../../shared/apiResponse';
import * as service from './insurance.workflow.service';

const ids = (req: AuthenticatedRequest) => ({ tenantId: req.user!.tenantId, userId: req.user!.userId });

export async function createCorporatePayer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, statusCode: 201, message: 'Corporate payer created', data: await service.createCorporatePayer(req.user!.tenantId, req.body) }); } catch (error) { next(error); }
}
export async function listCorporatePayers(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const result = await service.listCorporatePayers(req.user!.tenantId, req.query); sendPaginatedResponse(res, result.items, result.total, result.page, result.limit, 'Corporate payers retrieved'); } catch (error) { next(error); }
}
export async function createGovernmentScheme(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, statusCode: 201, message: 'Government scheme created', data: await service.createGovernmentScheme(req.user!.tenantId, req.body) }); } catch (error) { next(error); }
}
export async function listGovernmentSchemes(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const result = await service.listGovernmentSchemes(req.user!.tenantId, req.query); sendPaginatedResponse(res, result.items, result.total, result.page, result.limit, 'Government schemes retrieved'); } catch (error) { next(error); }
}

export async function createInsuranceCase(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 201, message: 'Insurance / payer case created', data: await service.createInsuranceCase(tenantId, userId, req.body) }); } catch (error) { next(error); }
}
export async function listInsuranceCases(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const result = await service.listInsuranceCases(req.user!.tenantId, req.query); sendPaginatedResponse(res, result.items, result.total, result.page, result.limit, 'Insurance / payer cases retrieved'); } catch (error) { next(error); }
}
export async function getInsuranceCase(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, message: 'Insurance / payer case retrieved', data: await service.getInsuranceCase(req.user!.tenantId, req.params.id as string) }); } catch (error) { next(error); }
}
export async function updateInsuranceCaseStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, message: 'Case status updated', data: await service.updateInsuranceCaseStatus(tenantId, userId, req.params.id as string, req.body.status, req.body.notes) }); } catch (error) { next(error); }
}
export async function addCasePolicy(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 201, message: 'Policy added to case', data: await service.addCasePolicy(tenantId, userId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function recordEligibility(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 201, message: 'Eligibility snapshot recorded', data: await service.recordEligibility(tenantId, userId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function recordEmergencyIntimation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, message: 'Emergency intimation recorded', data: await service.recordEmergencyIntimation(tenantId, userId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function recordPhysicalRelease(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, message: 'Physical release recorded; payer workflow remains open', data: await service.recordPhysicalRelease(tenantId, userId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function getPatientCaseStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, message: 'Case status retrieved', data: await service.getPatientCaseStatus(req.user!.tenantId, req.params.id as string) }); } catch (error) { next(error); }
}

export async function createContract(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, statusCode: 201, message: 'Payer contract created', data: await service.createContract(req.user!.tenantId, req.body) }); } catch (error) { next(error); }
}
export async function updateContract(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, message: 'Payer contract updated', data: await service.updateContract(req.user!.tenantId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function listContracts(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, message: 'Payer contracts retrieved', data: await service.listContracts(req.user!.tenantId, req.query) }); } catch (error) { next(error); }
}
export async function getContract(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, message: 'Payer contract retrieved', data: await service.getContract(req.user!.tenantId, req.params.id as string) }); } catch (error) { next(error); }
}

export async function createEnhancement(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 201, message: 'Pre-authorization enhancement submitted', data: await service.createEnhancement(tenantId, userId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function requestFinalAuthorization(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 201, message: 'Final discharge authorization requested', data: await service.requestFinalAuthorization(tenantId, userId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function getSlaQueue(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, message: 'Insurance SLA queue retrieved', data: await service.getSlaQueue(req.user!.tenantId) }); } catch (error) { next(error); }
}

export async function syncClaimChecklist(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, message: 'Claim checklist synchronized', data: await service.syncClaimChecklist(req.user!.tenantId, req.params.id as string) }); } catch (error) { next(error); }
}
export async function getClaimChecklist(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, message: 'Claim checklist retrieved', data: await service.getClaimChecklist(req.user!.tenantId, req.params.id as string) }); } catch (error) { next(error); }
}
export async function addClaimDocument(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 201, message: 'Claim document added', data: await service.addClaimDocument(tenantId, userId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function verifyClaimDocument(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, message: 'Claim document reviewed', data: await service.verifyClaimDocument(tenantId, userId, req.params.documentId as string, req.body) }); } catch (error) { next(error); }
}
export async function raiseClaimQuery(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 201, message: 'Claim query recorded', data: await service.raiseClaimQuery(tenantId, userId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function respondClaimQuery(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, message: 'Query response submitted', data: await service.respondClaimQuery(tenantId, userId, req.params.queryId as string, req.body.responseText) }); } catch (error) { next(error); }
}
export async function resolveClaimQuery(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, message: 'Claim query resolved', data: await service.resolveClaimQuery(tenantId, userId, req.params.queryId as string) }); } catch (error) { next(error); }
}
export async function getClaimDossier(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, message: 'Claim dossier generated', data: await service.getClaimDossier(req.user!.tenantId, req.params.id as string) }); } catch (error) { next(error); }
}

export async function recordSettlement(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 201, message: 'Settlement recorded', data: await service.recordSettlement(tenantId, userId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function recordBulkSettlements(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 201, message: 'Bulk settlements allocated', data: await service.recordBulkSettlements(tenantId, userId, req.body.settlements) }); } catch (error) { next(error); }
}
export async function requestWriteOff(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 201, message: 'Write-off sent for approval', data: await service.requestWriteOff(tenantId, userId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function decideWriteOff(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, message: 'Write-off decision recorded', data: await service.decideWriteOff(tenantId, userId, req.params.writeOffId as string, req.body) }); } catch (error) { next(error); }
}
export async function createAdjustment(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 201, message: 'Post-settlement adjustment recorded', data: await service.createAdjustment(tenantId, userId, req.params.id as string, req.body) }); } catch (error) { next(error); }
}
export async function findBankMatches(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, message: 'Bank matches retrieved', data: await service.findBankMatches(req.user!.tenantId, String(req.query.bankReference)) }); } catch (error) { next(error); }
}

export async function queueExchange(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { const { tenantId, userId } = ids(req); sendResponse({ res, statusCode: 202, message: 'Insurance exchange queued', data: await service.queueExchange(tenantId, userId, req.body) }); } catch (error) { next(error); }
}
export async function getWorkflowAnalytics(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try { sendResponse({ res, message: 'Insurance workflow analytics retrieved', data: await service.getWorkflowAnalytics(req.user!.tenantId, req.query) }); } catch (error) { next(error); }
}
