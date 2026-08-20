import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission, requireRoles } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createVisitSchema,
  getVisitsQuerySchema,
  visitIdParamSchema,
  updateVisitSchema,
  closeVisitSchema,
  ensureVisitForAppointmentSchema,
  createAdmissionSchema,
  getAdmissionsQuerySchema,
  admissionIdParamSchema,
  updateAdmissionSchema,
  assignAdmissionBedSchema,
  changeAdmissionTypeSchema,
  assignAdmissionDoctorSchema,
  dischargePatientSchema,
  createTransferSchema,
  getTransfersQuerySchema,
  transferIdParamSchema,
  approveTransferSchema,
  recordVitalsSchema,
  correctVitalSchema,
  vitalIdParamSchema,
  patientIdParamSchema,
  getVitalsQuerySchema,
  getAllVitalsQuerySchema,
  addDiagnosisSchema,
  getDiagnosesQuerySchema,
  getAllDiagnosesQuerySchema,
  diagnosisIdParamSchema,
  updateDiagnosisSchema,
  createOtRequestSchema,
  getOtRequestsQuerySchema,
  otRequestIdParamSchema,
  createReservationSchema,
  getReservationsQuerySchema,
  reservationIdParamSchema,
  updateReservationSchema,
  admitFromReservationSchema,
  createEstimationSchema,
  getEstimationsQuerySchema,
  estimationIdParamSchema,
  updateEstimationSchema,
  getClinicalOrdersQuerySchema,
  acknowledgeClinicalOrderSchema,
  getOrderAcknowledgementsQuerySchema,
  createAdmissionRequestSchema,
  getAdmissionRequestsQuerySchema,
  admissionRequestIdParamSchema,
  acceptAdmissionRequestSchema,
  rejectAdmissionRequestSchema,
  cancelAdmissionRequestSchema,
} from './clinical.validation';
import {
  createNurseAssignmentSchema,
  getNurseAssignmentsQuerySchema,
  nurseAssignmentIdParamSchema,
  updateNurseAssignmentSchema,
  endNurseAssignmentSchema,
  handoverNurseAssignmentSchema,
  bulkHandoverSchema,
  handoverFeedQuerySchema,
} from './nurse-assignments.validation';
import {
  createNurseDoctorAssignmentSchema,
  getNurseDoctorAssignmentsQuerySchema,
  nurseDoctorAssignmentIdParamSchema,
  endNurseDoctorAssignmentSchema,
  myPatientsQuerySchema,
} from './nurse-doctor-assignments.validation';
import * as controller from './clinical.controller';
import * as nurseAssignmentsController from './nurse-assignments.controller';
import * as nurseDoctorController from './nurse-doctor-assignments.controller';

export const clinicalRoutes = Router();

// --- Visits ---
clinicalRoutes.post('/visits', authenticate, requirePermission('visits', 'create'), validate(createVisitSchema), controller.createVisit);
clinicalRoutes.post('/visits/ensure-for-appointment', authenticate, requirePermission('visits', 'create'), validate(ensureVisitForAppointmentSchema), controller.ensureVisitForAppointment);
clinicalRoutes.get('/visits', authenticate, requirePermission('visits', 'read'), validate(getVisitsQuerySchema), controller.getVisits);
clinicalRoutes.get('/visits/:id', authenticate, requirePermission('visits', 'read'), validate(visitIdParamSchema), controller.getVisitById);
clinicalRoutes.put('/visits/:id', authenticate, requirePermission('visits', 'update'), validate(updateVisitSchema), controller.updateVisit);
clinicalRoutes.patch('/visits/:id/close', authenticate, requirePermission('visits', 'update'), validate(closeVisitSchema), controller.closeVisit);

// --- Admissions ---
clinicalRoutes.post('/admissions', authenticate, requirePermission('admissions', 'create'), validate(createAdmissionSchema), controller.createAdmission);
clinicalRoutes.get('/admissions', authenticate, requirePermission('admissions', 'read'), validate(getAdmissionsQuerySchema), controller.getAdmissions);
clinicalRoutes.get('/admissions/:id', authenticate, requirePermission('admissions', 'read'), validate(admissionIdParamSchema), controller.getAdmissionById);
clinicalRoutes.put('/admissions/:id', authenticate, requirePermission('admissions', 'update'), validate(updateAdmissionSchema), controller.updateAdmission);
clinicalRoutes.patch('/admissions/:id/assign-bed', authenticate, requirePermission('admissions', 'update'), validate(assignAdmissionBedSchema), controller.assignAdmissionBed);
// Convert care type (ip/emergency/daycare) — front desk, doctors AND nurses may
// flip it (nurses lack admissions:update, so gate by role, not permission).
// Assign / claim the treating consultant. Admission.doctorId is nullable so an
// emergency admission can be opened before a consultant is named, but nothing
// could fill it in afterwards — PUT /admissions/:id does not accept doctorId, so
// an unassigned admission stayed on nobody's list forever.
// Gated by ROLE for the same reason as /type below: nurses hold no
// admissions:update, and granting it would also open PUT /admissions/:id.
clinicalRoutes.patch('/admissions/:id/doctor', authenticate, requireRoles('doctor', 'front_desk', 'admin', 'super_admin', 'nurse_admin'), validate(assignAdmissionDoctorSchema), controller.assignAdmissionDoctor);

clinicalRoutes.patch('/admissions/:id/type', authenticate, requireRoles('front_desk', 'admin', 'super_admin', 'doctor', 'nurse', 'nurse_admin'), validate(changeAdmissionTypeSchema), controller.changeAdmissionType);
// Discharge is the CASH COUNTER's action, not the doctor's. The doctor's
// sign-off is publishing the discharge summary, which now only marks the
// admission ready; Front Desk / Billing then clears the bill and discharges
// here (the service re-checks both gates). Cashier is included because the
// same person often collects the final payment and closes the file.
// Gated by ROLE, not by `admissions:update`: billing_admin / cashier have no
// admissions permissions at all, and granting them the module-wide update right
// would also open PUT /admissions/:id. Same precedent as /admissions/:id/type.
clinicalRoutes.patch('/admissions/:id/discharge', authenticate, requireRoles('front_desk', 'billing_admin', 'cashier', 'admin', 'super_admin'), validate(dischargePatientSchema), controller.dischargePatient);

// --- Transfers ---
// Moving an admitted patient. Gated on its own permission rather than
// `admissions:create`, which also grants admitting a patient, opening a
// reservation and raising or cancelling an IP request — far more than nursing
// needs to walk someone to another ward. The doctor_to_doctor carve-out is
// enforced in the service, where the transfer type is known.
clinicalRoutes.post('/transfers', authenticate, requirePermission('patient_transfers', 'create'), validate(createTransferSchema), controller.createTransfer);
clinicalRoutes.get('/transfers', authenticate, requirePermission('admissions', 'read'), validate(getTransfersQuerySchema), controller.getTransfers);
clinicalRoutes.get('/transfers/:id', authenticate, requirePermission('admissions', 'read'), validate(transferIdParamSchema), controller.getTransferById);
// Patient transfers are doctor-to-doctor / bed / ward handoffs against a Visit.
// The receiving doctor (or nurse, for bed/ward moves) is the one who accepts,
// so this stays off admin-level rights. Everyone who could approve before
// holds patient_transfers:approve, and nursing is added to it.
clinicalRoutes.patch('/transfers/:id/approve', authenticate, requirePermission('patient_transfers', 'approve'), validate(approveTransferSchema), controller.approveTransfer);

// --- Vitals ---
clinicalRoutes.post('/vitals', authenticate, requirePermission('vitals', 'create'), validate(recordVitalsSchema), controller.recordVitals);
clinicalRoutes.get('/vitals', authenticate, requirePermission('vitals', 'read'), validate(getAllVitalsQuerySchema), controller.getAllVitals);
// Append-only correction: any attempt to modify a vital (by doctor or by nurse
// outside the grace window) creates a NEW row linked to the original via
// supersedesVitalId. Within-grace self-edits by the original nurse are the only
// in-place updates and happen via this same endpoint.
clinicalRoutes.post('/vitals/:id/correct', authenticate, requirePermission('vitals', 'update'), validate(correctVitalSchema), controller.correctVital);
clinicalRoutes.get('/vitals/:id/history', authenticate, requirePermission('vitals', 'read'), validate(vitalIdParamSchema), controller.getVitalHistory);
clinicalRoutes.get('/vitals/:patientId', authenticate, requirePermission('vitals', 'read'), validate(getVitalsQuerySchema), controller.getVitals);
clinicalRoutes.get('/vitals/:patientId/latest', authenticate, requirePermission('vitals', 'read'), validate(patientIdParamSchema), controller.getLatestVitals);

// --- Diagnoses ---
clinicalRoutes.post('/diagnoses', authenticate, requirePermission('diagnoses', 'create'), validate(addDiagnosisSchema), controller.addDiagnosis);
clinicalRoutes.get('/diagnoses', authenticate, requirePermission('diagnoses', 'read'), validate(getAllDiagnosesQuerySchema), controller.getAllDiagnoses);
clinicalRoutes.get('/diagnoses/:patientId', authenticate, requirePermission('diagnoses', 'read'), validate(getDiagnosesQuerySchema), controller.getDiagnoses);
clinicalRoutes.put('/diagnoses/:id', authenticate, requirePermission('diagnoses', 'update'), validate(updateDiagnosisSchema), controller.updateDiagnosis);
clinicalRoutes.delete('/diagnoses/:id', authenticate, requirePermission('diagnoses', 'delete'), validate(diagnosisIdParamSchema), controller.deleteDiagnosis);

// --- OT Requests ---
clinicalRoutes.post('/ot-requests', authenticate, requirePermission('ot_requests', 'create'), validate(createOtRequestSchema), controller.createOtRequest);
clinicalRoutes.get('/ot-requests', authenticate, requirePermission('ot_requests', 'read'), validate(getOtRequestsQuerySchema), controller.getOtRequests);
clinicalRoutes.get('/ot-requests/:id', authenticate, requirePermission('ot_requests', 'read'), validate(otRequestIdParamSchema), controller.getOtRequestById);

// --- Reservations ---
clinicalRoutes.post('/reservations', authenticate, requirePermission('admissions', 'create'), validate(createReservationSchema), controller.createReservation);
clinicalRoutes.get('/reservations', authenticate, requirePermission('admissions', 'read'), validate(getReservationsQuerySchema), controller.getReservations);
clinicalRoutes.get('/reservations/:id', authenticate, requirePermission('admissions', 'read'), validate(reservationIdParamSchema), controller.getReservationById);
clinicalRoutes.put('/reservations/:id', authenticate, requirePermission('admissions', 'update'), validate(updateReservationSchema), controller.updateReservation);
// Convert a reservation into an admission. Front desk presses Admit on the
// reservation row; the service pulls patient/doctor/ward (+ default bed) from
// the reservation and spins up the Admission, freeing any orphaned beds.
clinicalRoutes.post('/reservations/:id/admit', authenticate, requirePermission('admissions', 'create'), validate(admitFromReservationSchema), controller.admitReservation);

// --- Clinical Orders (Nurse unified view) ---
clinicalRoutes.get('/orders', authenticate, requirePermission('prescriptions', 'read'), validate(getClinicalOrdersQuerySchema), controller.getClinicalOrders);
clinicalRoutes.get('/orders/acknowledgements', authenticate, requirePermission('nursing_notes', 'read'), validate(getOrderAcknowledgementsQuerySchema), controller.getOrderAcknowledgements);
clinicalRoutes.post('/orders/acknowledge', authenticate, requirePermission('nursing_notes', 'create'), validate(acknowledgeClinicalOrderSchema), controller.acknowledgeClinicalOrder);

// --- Nurse → Doctor Assignments (persistent mapping; SOW core flow) ---
// `my-doctors` and `my-patients` are scoped to the calling user, so any
// authenticated user can call them — `nurse_assignments:read` covers both
// admin lookups and bedside-nurse self-service.
clinicalRoutes.get('/nurse-doctor-assignments/my-doctors', authenticate, nurseDoctorController.getMyDoctors);
clinicalRoutes.get('/nurse-doctor-assignments/my-patients', authenticate, validate(myPatientsQuerySchema), nurseDoctorController.getMyPatients);
clinicalRoutes.get('/nurse-doctor-assignments', authenticate, requirePermission('nurse_assignments', 'read'), validate(getNurseDoctorAssignmentsQuerySchema), nurseDoctorController.listNurseDoctorAssignments);
clinicalRoutes.post('/nurse-doctor-assignments', authenticate, requirePermission('nurse_assignments', 'create'), validate(createNurseDoctorAssignmentSchema), nurseDoctorController.createNurseDoctorAssignments);
clinicalRoutes.get('/nurse-doctor-assignments/:id', authenticate, requirePermission('nurse_assignments', 'read'), validate(nurseDoctorAssignmentIdParamSchema), nurseDoctorController.getNurseDoctorAssignmentById);
clinicalRoutes.post('/nurse-doctor-assignments/:id/end', authenticate, requirePermission('nurse_assignments', 'update'), validate(endNurseDoctorAssignmentSchema), nurseDoctorController.endNurseDoctorAssignment);

// --- Nurse Assignments (per-shift patient→nurse, IPD only) ---
clinicalRoutes.get('/nurse-assignments', authenticate, requirePermission('nurse_assignments', 'read'), validate(getNurseAssignmentsQuerySchema), nurseAssignmentsController.listNurseAssignments);
clinicalRoutes.post('/nurse-assignments', authenticate, requirePermission('nurse_assignments', 'create'), validate(createNurseAssignmentSchema), nurseAssignmentsController.createNurseAssignment);
clinicalRoutes.post('/nurse-assignments/bulk-handover', authenticate, requirePermission('nurse_assignments', 'update'), validate(bulkHandoverSchema), nurseAssignmentsController.bulkHandoverAssignments);
// Per-nurse "what nurse_admin set up for me" feed (incoming + outgoing handovers).
// Defaults to the logged-in user; nurse_admin can pass userId to inspect any nurse.
clinicalRoutes.get('/nurse-assignments/handover-feed', authenticate, requirePermission('nurse_assignments', 'read'), validate(handoverFeedQuerySchema), nurseAssignmentsController.getHandoverFeed);
clinicalRoutes.get('/nurse-assignments/:id', authenticate, requirePermission('nurse_assignments', 'read'), validate(nurseAssignmentIdParamSchema), nurseAssignmentsController.getNurseAssignmentById);
clinicalRoutes.patch('/nurse-assignments/:id', authenticate, requirePermission('nurse_assignments', 'update'), validate(updateNurseAssignmentSchema), nurseAssignmentsController.updateNurseAssignment);
clinicalRoutes.post('/nurse-assignments/:id/end', authenticate, requirePermission('nurse_assignments', 'update'), validate(endNurseAssignmentSchema), nurseAssignmentsController.endNurseAssignment);
clinicalRoutes.post('/nurse-assignments/:id/handover', authenticate, requirePermission('nurse_assignments', 'update'), validate(handoverNurseAssignmentSchema), nurseAssignmentsController.handoverNurseAssignment);

// --- Admission Requests (doctor → front desk handoff for OP→IP) ---
// Doctor raises the request from the consultation workspace
// (`admissions:create`); front desk works the queue from IP Home
// (`admissions:read` / `update`). Cancel is doctor self-service so it shares
// the same `admissions:create` permission as the create call.
clinicalRoutes.post('/admission-requests', authenticate, requirePermission('admissions', 'create'), validate(createAdmissionRequestSchema), controller.createAdmissionRequest);
clinicalRoutes.get('/admission-requests', authenticate, requirePermission('admissions', 'read'), validate(getAdmissionRequestsQuerySchema), controller.getAdmissionRequests);
clinicalRoutes.get('/admission-requests/:id', authenticate, requirePermission('admissions', 'read'), validate(admissionRequestIdParamSchema), controller.getAdmissionRequestById);
clinicalRoutes.post('/admission-requests/:id/cancel', authenticate, requirePermission('admissions', 'create'), validate(cancelAdmissionRequestSchema), controller.cancelAdmissionRequest);
clinicalRoutes.post('/admission-requests/:id/accept', authenticate, requirePermission('admissions', 'update'), validate(acceptAdmissionRequestSchema), controller.acceptAdmissionRequest);
clinicalRoutes.post('/admission-requests/:id/reject', authenticate, requirePermission('admissions', 'update'), validate(rejectAdmissionRequestSchema), controller.rejectAdmissionRequest);

// --- Estimations ---
clinicalRoutes.post('/estimations', authenticate, requirePermission('admissions', 'create'), validate(createEstimationSchema), controller.createEstimation);
clinicalRoutes.get('/estimations', authenticate, requirePermission('admissions', 'read'), validate(getEstimationsQuerySchema), controller.getEstimations);
clinicalRoutes.get('/estimations/:id', authenticate, requirePermission('admissions', 'read'), validate(estimationIdParamSchema), controller.getEstimationById);
clinicalRoutes.put('/estimations/:id', authenticate, requirePermission('admissions', 'update'), validate(updateEstimationSchema), controller.updateEstimation);
