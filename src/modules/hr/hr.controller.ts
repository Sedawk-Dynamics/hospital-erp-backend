import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import * as service from './hr.service';

// Staff
export async function createStaffProfile(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createStaffProfile(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Staff profile created', data });
  } catch (err) { next(err); }
}
export async function getStaffProfiles(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getStaffProfiles(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.profiles, result.total, result.page, result.limit, 'Staff profiles retrieved');
  } catch (err) { next(err); }
}
export async function getStaffProfileById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getStaffProfileById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Staff profile retrieved', data });
  } catch (err) { next(err); }
}
export async function updateStaffProfile(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateStaffProfile(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Staff profile updated', data });
  } catch (err) { next(err); }
}
export async function deactivateStaffProfile(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.deactivateStaffProfile(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Staff profile deactivated', data });
  } catch (err) { next(err); }
}

// Licenses
export async function addLicense(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.addLicense(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'License added', data });
  } catch (err) { next(err); }
}
export async function getLicenses(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getLicenses(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.licenses, result.total, result.page, result.limit, 'Licenses retrieved');
  } catch (err) { next(err); }
}
export async function updateLicense(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateLicense(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'License updated', data });
  } catch (err) { next(err); }
}
export async function getExpiringLicenses(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getExpiringLicenses(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Expiring licenses retrieved', data });
  } catch (err) { next(err); }
}

// Rosters
export async function createDutyRoster(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createDutyRoster(req.user!.tenantId, req.body, req.user!.userId);
    sendResponse({ res, statusCode: 201, message: 'Duty roster created', data });
  } catch (err) { next(err); }
}
export async function createDutyRosterBulk(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.createDutyRosterBulk(req.user!.tenantId, req.body, req.user!.userId);
    sendResponse({ res, statusCode: 201, message: 'Duty rosters created', data });
  } catch (err) { next(err); }
}
export async function getDutyRosters(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getDutyRosters(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.rosters, result.total, result.page, result.limit, 'Rosters retrieved');
  } catch (err) { next(err); }
}
export async function getDutyRosterById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getDutyRosterById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Roster retrieved', data });
  } catch (err) { next(err); }
}
export async function updateDutyRoster(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.updateDutyRoster(req.user!.tenantId, req.params.id as string, req.body);
    sendResponse({ res, message: 'Roster updated', data });
  } catch (err) { next(err); }
}
export async function publishDutyRoster(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.publishDutyRoster(req.user!.tenantId, req.params.id as string, req.user!.userId);
    sendResponse({ res, message: 'Roster published', data });
  } catch (err) { next(err); }
}

// Attendance
export async function recordAttendance(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.recordAttendance(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Attendance recorded', data });
  } catch (err) { next(err); }
}
export async function getAttendance(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getAttendance(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.records, result.total, result.page, result.limit, 'Attendance retrieved');
  } catch (err) { next(err); }
}
export async function getAttendanceSummary(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getAttendanceSummary(req.user!.tenantId, req.query as any);
    sendResponse({ res, message: 'Attendance summary retrieved', data });
  } catch (err) { next(err); }
}

// Leaves
export async function applyLeave(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.applyLeave(req.user!.tenantId, req.body);
    sendResponse({ res, statusCode: 201, message: 'Leave applied', data });
  } catch (err) { next(err); }
}
export async function getLeaves(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getLeaves(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.leaves, result.total, result.page, result.limit, 'Leaves retrieved');
  } catch (err) { next(err); }
}
export async function approveLeave(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.approveLeave(req.user!.tenantId, req.params.id as string, req.user!.userId);
    sendResponse({ res, message: 'Leave approved', data });
  } catch (err) { next(err); }
}
export async function rejectLeave(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.rejectLeave(req.user!.tenantId, req.params.id as string, req.user!.userId);
    sendResponse({ res, message: 'Leave rejected', data });
  } catch (err) { next(err); }
}
export async function getLeaveBalance(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getLeaveBalance(req.user!.tenantId, req.params.userId as string);
    sendResponse({ res, message: 'Leave balance retrieved', data });
  } catch (err) { next(err); }
}

// Payroll
export async function generatePayroll(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.generatePayroll(req.user!.tenantId, req.body, req.user!.userId);
    sendResponse({ res, statusCode: 201, message: 'Payroll generated', data });
  } catch (err) { next(err); }
}
export async function getPayrollList(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getPayrollList(req.user!.tenantId, req.query as any);
    sendPaginatedResponse(res, result.payrolls, result.total, result.page, result.limit, 'Payroll retrieved');
  } catch (err) { next(err); }
}
export async function getPayrollById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getPayrollById(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Payroll retrieved', data });
  } catch (err) { next(err); }
}
export async function approvePayroll(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.approvePayroll(req.user!.tenantId, req.params.id as string, req.user!.userId);
    sendResponse({ res, message: 'Payroll approved', data });
  } catch (err) { next(err); }
}
export async function getPayslip(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const data = await service.getPayslip(req.user!.tenantId, req.params.id as string);
    sendResponse({ res, message: 'Payslip retrieved', data });
  } catch (err) { next(err); }
}
