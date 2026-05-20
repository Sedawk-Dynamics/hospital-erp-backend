import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import * as controller from './hr.controller';
import {
  createStaffProfileSchema,
  getStaffProfilesSchema,
  staffIdParamSchema,
  updateStaffProfileSchema,
  addLicenseSchema,
  getLicensesSchema,
  updateLicenseSchema,
  getExpiringLicensesSchema,
  createDutyRosterSchema,
  createDutyRosterBulkSchema,
  getDutyRostersSchema,
  dutyRosterIdParamSchema,
  updateDutyRosterSchema,
  getActiveRosterSchema,
  getRosterCoverageSchema,
  recordAttendanceSchema,
  getAttendanceSchema,
  getAttendanceSummarySchema,
  applyLeaveSchema,
  getLeavesSchema,
  leaveIdParamSchema,
  leaveBalanceParamSchema,
  generatePayrollSchema,
  getPayrollListSchema,
  payrollIdParamSchema,
  hrReportsQuerySchema,
} from './hr.validation';

export const hrRoutes = Router();

// --- HR Dashboard (Week 14) ---
hrRoutes.get('/dashboard', authenticate, requirePermission('hr', 'read'), controller.getHrDashboard);

// --- Staff Profiles ---
hrRoutes.post('/staff', authenticate, requirePermission('hr', 'create'), validate(createStaffProfileSchema), controller.createStaffProfile);
hrRoutes.get('/staff', authenticate, requirePermission('hr', 'read'), validate(getStaffProfilesSchema), controller.getStaffProfiles);
hrRoutes.get('/staff/:id', authenticate, requirePermission('hr', 'read'), validate(staffIdParamSchema), controller.getStaffProfileById);
hrRoutes.put('/staff/:id', authenticate, requirePermission('hr', 'update'), validate(updateStaffProfileSchema), controller.updateStaffProfile);
hrRoutes.patch('/staff/:id/deactivate', authenticate, requirePermission('hr', 'update'), validate(staffIdParamSchema), controller.deactivateStaffProfile);

// --- Licenses ---
hrRoutes.post('/licenses', authenticate, requirePermission('hr', 'create'), validate(addLicenseSchema), controller.addLicense);
hrRoutes.get('/licenses', authenticate, requirePermission('hr', 'read'), validate(getLicensesSchema), controller.getLicenses);
hrRoutes.put('/licenses/:id', authenticate, requirePermission('hr', 'update'), validate(updateLicenseSchema), controller.updateLicense);
hrRoutes.get('/licenses/expiring', authenticate, requirePermission('hr', 'read'), validate(getExpiringLicensesSchema), controller.getExpiringLicenses);

// --- Duty Rosters --- gated by duty_rosters:* so nurse_admin can operate
// here without full HR access.
hrRoutes.post('/rosters', authenticate, requirePermission('duty_rosters', 'create'), validate(createDutyRosterSchema), controller.createDutyRoster);
hrRoutes.post('/rosters/bulk', authenticate, requirePermission('duty_rosters', 'create'), validate(createDutyRosterBulkSchema), controller.createDutyRosterBulk);
// Order matters: register specific paths before the `:id` catch-all so that
// /rosters/active and /rosters/coverage don't get parsed as roster IDs.
hrRoutes.get('/rosters/active', authenticate, requirePermission('duty_rosters', 'read'), validate(getActiveRosterSchema), controller.getActiveRoster);
hrRoutes.get('/rosters/coverage', authenticate, requirePermission('duty_rosters', 'read'), validate(getRosterCoverageSchema), controller.getRosterCoverage);
hrRoutes.get('/rosters', authenticate, requirePermission('duty_rosters', 'read'), validate(getDutyRostersSchema), controller.getDutyRosters);
hrRoutes.get('/rosters/:id', authenticate, requirePermission('duty_rosters', 'read'), validate(dutyRosterIdParamSchema), controller.getDutyRosterById);
hrRoutes.put('/rosters/:id', authenticate, requirePermission('duty_rosters', 'update'), validate(updateDutyRosterSchema), controller.updateDutyRoster);
hrRoutes.patch('/rosters/:id/publish', authenticate, requirePermission('duty_rosters', 'approve'), validate(dutyRosterIdParamSchema), controller.publishDutyRoster);

// --- Attendance ---
hrRoutes.post('/attendance', authenticate, requirePermission('hr', 'create'), validate(recordAttendanceSchema), controller.recordAttendance);
hrRoutes.get('/attendance', authenticate, requirePermission('hr', 'read'), validate(getAttendanceSchema), controller.getAttendance);
hrRoutes.get('/attendance/summary', authenticate, requirePermission('hr', 'read'), validate(getAttendanceSummarySchema), controller.getAttendanceSummary);

// --- Leaves ---
hrRoutes.post('/leaves', authenticate, requirePermission('hr', 'create'), validate(applyLeaveSchema), controller.applyLeave);
hrRoutes.get('/leaves', authenticate, requirePermission('hr', 'read'), validate(getLeavesSchema), controller.getLeaves);
hrRoutes.patch('/leaves/:id/approve', authenticate, requirePermission('hr', 'approve'), validate(leaveIdParamSchema), controller.approveLeave);
hrRoutes.patch('/leaves/:id/reject', authenticate, requirePermission('hr', 'approve'), validate(leaveIdParamSchema), controller.rejectLeave);
hrRoutes.get('/leaves/balance/:userId', authenticate, requirePermission('hr', 'read'), validate(leaveBalanceParamSchema), controller.getLeaveBalance);

// --- Payroll ---
hrRoutes.post('/payroll/generate', authenticate, requirePermission('hr', 'create'), validate(generatePayrollSchema), controller.generatePayroll);
hrRoutes.get('/payroll', authenticate, requirePermission('hr', 'read'), validate(getPayrollListSchema), controller.getPayrollList);
hrRoutes.get('/payroll/:id', authenticate, requirePermission('hr', 'read'), validate(payrollIdParamSchema), controller.getPayrollById);
hrRoutes.patch('/payroll/:id/approve', authenticate, requirePermission('hr', 'approve'), validate(payrollIdParamSchema), controller.approvePayroll);
hrRoutes.get('/payroll/:id/payslip', authenticate, requirePermission('hr', 'read'), validate(payrollIdParamSchema), controller.getPayslip);

// --- Salary Slip PDF (Week 14) — payrollId is the SalarySlip handle on the
// service layer; auto-creates the slip on first access just like /payslip
hrRoutes.get('/salary-slips/:id/pdf', authenticate, requirePermission('hr', 'read'), validate(payrollIdParamSchema), controller.getSalarySlipPdf);

// --- HR Reports (Week 14) ---
hrRoutes.get('/reports/absenteeism', authenticate, requirePermission('hr', 'read'), validate(hrReportsQuerySchema), controller.getAbsenteeismReport);
hrRoutes.get('/reports/attrition', authenticate, requirePermission('hr', 'read'), validate(hrReportsQuerySchema), controller.getAttritionReport);
hrRoutes.get('/reports/overtime', authenticate, requirePermission('hr', 'read'), validate(hrReportsQuerySchema), controller.getOvertimeReport);
hrRoutes.get('/reports/leave-utilization', authenticate, requirePermission('hr', 'read'), validate(hrReportsQuerySchema), controller.getLeaveUtilizationReport);
