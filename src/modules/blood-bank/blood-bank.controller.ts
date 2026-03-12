import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './blood-bank.service';

// Donors
export async function registerDonor(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.registerDonor(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Donor registered', data });
  } catch (err) { next(err); }
}
export async function getDonors(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getDonors(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.donors, result.total, result.page, result.limit, 'Donors retrieved');
  } catch (err) { next(err); }
}
export async function getDonorById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getDonorById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Donor retrieved', data });
  } catch (err) { next(err); }
}
export async function updateDonor(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateDonor(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Donor updated', data });
  } catch (err) { next(err); }
}
export async function getDonorHistory(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getDonorHistory(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Donor history retrieved', data });
  } catch (err) { next(err); }
}

// Donations
export async function recordDonation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.recordDonation(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Donation recorded', data });
  } catch (err) { next(err); }
}
export async function getDonations(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getDonations(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.donations, result.total, result.page, result.limit, 'Donations retrieved');
  } catch (err) { next(err); }
}
export async function getDonationById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getDonationById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Donation retrieved', data });
  } catch (err) { next(err); }
}
export async function updateDonation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateDonation(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Donation updated', data });
  } catch (err) { next(err); }
}
export async function screenDonation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.screenDonation(req.user!.tenantId, req.params.id as string, req.user!.userId, req.body);
    sendResponse({ res, message: 'Donation screened', data });
  } catch (err) { next(err); }
}

// Inventory
export async function getBloodInventory(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getBloodInventory(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.items, result.total, result.page, result.limit, 'Blood inventory retrieved');
  } catch (err) { next(err); }
}
export async function getBloodInventoryByGroup(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getBloodInventoryByGroup(req.user!.tenantId);
    sendResponse({ res, message: 'Blood inventory by group', data });
  } catch (err) { next(err); }
}
export async function addBloodUnit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.addBloodUnit(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Blood unit added', data });
  } catch (err) { next(err); }
}
export async function updateBloodUnit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateBloodUnit(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Blood unit updated', data });
  } catch (err) { next(err); }
}
export async function discardBloodUnit(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.discardBloodUnit(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Blood unit discarded', data });
  } catch (err) { next(err); }
}
export async function getExpiringUnits(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const data = await service.getExpiringUnits(req.user!.tenantId, days);
    sendResponse({ res, message: 'Expiring units retrieved', data });
  } catch (err) { next(err); }
}

// Cross-Match
export async function requestCrossMatch(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.requestCrossMatch(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Cross-match requested', data });
  } catch (err) { next(err); }
}
export async function getCrossMatches(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getCrossMatches(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.crossMatches, result.total, result.page, result.limit, 'Cross-matches retrieved');
  } catch (err) { next(err); }
}
export async function getCrossMatchById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getCrossMatchById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Cross-match retrieved', data });
  } catch (err) { next(err); }
}
export async function completeCrossMatch(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.completeCrossMatch(req.user!.tenantId, req.params.id as string, req.user!.userId, req.body);
    sendResponse({ res, message: 'Cross-match completed', data });
  } catch (err) { next(err); }
}

// Transfusions
export async function requestTransfusion(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.requestTransfusion(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Transfusion requested', data });
  } catch (err) { next(err); }
}
export async function getTransfusions(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getTransfusions(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.transfusions, result.total, result.page, result.limit, 'Transfusions retrieved');
  } catch (err) { next(err); }
}
export async function getTransfusionById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getTransfusionById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Transfusion retrieved', data });
  } catch (err) { next(err); }
}
export async function startTransfusion(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.startTransfusion(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Transfusion started', data });
  } catch (err) { next(err); }
}
export async function completeTransfusion(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.completeTransfusion(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Transfusion completed', data });
  } catch (err) { next(err); }
}
export async function reportReaction(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.reportReaction(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Reaction reported', data });
  } catch (err) { next(err); }
}
