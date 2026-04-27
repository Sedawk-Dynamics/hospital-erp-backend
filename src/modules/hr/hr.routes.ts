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
} from './hr.validation';

export const hrRoutes = Router();

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

// --- Duty Rosters --- gated by duty_rosters:* so nurse_admin / head_nurse can
// operate here without full HR access.
hrRoutes.post('/rosters', authenticate, requirePermission('duty_rosters', 'create'), validate(createDutyRosterSchema), controller.createDutyRoster);
hrRoutes.post('/rosters/bulk', authenticate, requirePermission('duty_rosters', 'create'), validate(createDutyRosterBulkSchema), controller.createDutyRosterBulk);
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
