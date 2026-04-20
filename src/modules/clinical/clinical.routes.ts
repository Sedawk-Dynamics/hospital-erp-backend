import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/authorize';
import { validate } from '../../middleware/validate';
import {
  createVisitSchema,
  getVisitsQuerySchema,
  visitIdParamSchema,
  updateVisitSchema,
  closeVisitSchema,
  createAdmissionSchema,
  getAdmissionsQuerySchema,
  admissionIdParamSchema,
  updateAdmissionSchema,
  dischargePatientSchema,
  createTransferSchema,
  getTransfersQuerySchema,
  transferIdParamSchema,
  approveTransferSchema,
  recordVitalsSchema,
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
  createEstimationSchema,
  getEstimationsQuerySchema,
  estimationIdParamSchema,
  updateEstimationSchema,
} from './clinical.validation';
import * as controller from './clinical.controller';

export const clinicalRoutes = Router();

// --- Visits ---
clinicalRoutes.post('/visits', authenticate, requirePermission('visits', 'create'), validate(createVisitSchema), controller.createVisit);
clinicalRoutes.get('/visits', authenticate, requirePermission('visits', 'read'), validate(getVisitsQuerySchema), controller.getVisits);
clinicalRoutes.get('/visits/:id', authenticate, requirePermission('visits', 'read'), validate(visitIdParamSchema), controller.getVisitById);
clinicalRoutes.put('/visits/:id', authenticate, requirePermission('visits', 'update'), validate(updateVisitSchema), controller.updateVisit);
clinicalRoutes.patch('/visits/:id/close', authenticate, requirePermission('visits', 'update'), validate(closeVisitSchema), controller.closeVisit);

// --- Admissions ---
clinicalRoutes.post('/admissions', authenticate, requirePermission('admissions', 'create'), validate(createAdmissionSchema), controller.createAdmission);
clinicalRoutes.get('/admissions', authenticate, requirePermission('admissions', 'read'), validate(getAdmissionsQuerySchema), controller.getAdmissions);
clinicalRoutes.get('/admissions/:id', authenticate, requirePermission('admissions', 'read'), validate(admissionIdParamSchema), controller.getAdmissionById);
clinicalRoutes.put('/admissions/:id', authenticate, requirePermission('admissions', 'update'), validate(updateAdmissionSchema), controller.updateAdmission);
clinicalRoutes.patch('/admissions/:id/discharge', authenticate, requirePermission('admissions', 'update'), validate(dischargePatientSchema), controller.dischargePatient);

// --- Transfers ---
clinicalRoutes.post('/transfers', authenticate, requirePermission('admissions', 'create'), validate(createTransferSchema), controller.createTransfer);
clinicalRoutes.get('/transfers', authenticate, requirePermission('admissions', 'read'), validate(getTransfersQuerySchema), controller.getTransfers);
clinicalRoutes.get('/transfers/:id', authenticate, requirePermission('admissions', 'read'), validate(transferIdParamSchema), controller.getTransferById);
// Patient transfers are doctor-to-doctor / bed / ward handoffs against a Visit.
// The receiving doctor (or nurse, for bed/ward moves) is the one who accepts —
// gate on `visits:update` rather than `admissions:approve` so doctors can
// approve handoffs addressed to them without needing admin-level rights.
clinicalRoutes.patch('/transfers/:id/approve', authenticate, requirePermission('visits', 'update'), validate(approveTransferSchema), controller.approveTransfer);

// --- Vitals ---
clinicalRoutes.post('/vitals', authenticate, requirePermission('vitals', 'create'), validate(recordVitalsSchema), controller.recordVitals);
clinicalRoutes.get('/vitals', authenticate, requirePermission('vitals', 'read'), validate(getAllVitalsQuerySchema), controller.getAllVitals);
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

// --- Estimations ---
clinicalRoutes.post('/estimations', authenticate, requirePermission('admissions', 'create'), validate(createEstimationSchema), controller.createEstimation);
clinicalRoutes.get('/estimations', authenticate, requirePermission('admissions', 'read'), validate(getEstimationsQuerySchema), controller.getEstimations);
clinicalRoutes.get('/estimations/:id', authenticate, requirePermission('admissions', 'read'), validate(estimationIdParamSchema), controller.getEstimationById);
clinicalRoutes.put('/estimations/:id', authenticate, requirePermission('admissions', 'update'), validate(updateEstimationSchema), controller.updateEstimation);
