import { Router, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as patientPortalService from './patient-portal.service';
import { uploadSingle } from '../../services/upload.service';

const router = Router();

// All patient portal routes require authentication only (no permission checks)
router.use(authenticate);

// ────────────────────────────────────────────────────────────
// Hospital Discovery & Connections
// ────────────────────────────────────────────────────────────

// GET /patient-portal/hospitals — Lookup by code or name
router.get('/hospitals', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await patientPortalService.lookupHospital(req.user!.userId, {
      code: req.query.code as string | undefined,
      search: req.query.search as string | undefined,
    });
    sendResponse({ res, statusCode: 200, message: 'Hospitals', data: result.data });
  } catch (err) {
    next(err);
  }
});

// GET /patient-portal/connections
router.get('/connections', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const connections = await patientPortalService.getMyConnections(req.user!.userId);
    sendResponse({ res, statusCode: 200, message: 'My connections', data: connections });
  } catch (err) {
    next(err);
  }
});

// POST /patient-portal/connections
router.post('/connections', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { tenantId, message } = req.body;
    if (!tenantId) {
      sendResponse({ res, statusCode: 400, message: 'tenantId is required' });
      return;
    }
    const connection = await patientPortalService.requestConnection(
      req.user!.userId,
      req.user!.email,
      tenantId,
      message,
    );
    sendResponse({ res, statusCode: 201, message: 'Connection request sent', data: connection });
  } catch (err) {
    next(err);
  }
});

// DELETE /patient-portal/connections/:id
router.delete('/connections/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await patientPortalService.cancelConnection(req.user!.userId, req.params.id as string);
    sendResponse({ res, statusCode: 200, message: 'Connection request cancelled' });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────
// Patient Portal Data
// ────────────────────────────────────────────────────────────

// GET /patient-portal/profile
router.get('/profile', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const profile = await patientPortalService.getPatientProfile(req.user!.userId, req.user!.email);
    sendResponse({ res, statusCode: 200, message: 'Patient profile', data: profile });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────
// Appointment Booking
// ────────────────────────────────────────────────────────────

// GET /patient-portal/all-hospitals — List all active hospitals for booking (paginated)
router.get('/all-hospitals', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await patientPortalService.getAllHospitalsForBooking({
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    });
    sendResponse({ res, statusCode: 200, message: 'All hospitals', data: result.data, meta: result.meta });
  } catch (err) { next(err); }
});

// GET /patient-portal/departments?tenantId=xxx
router.get('/departments', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) { sendResponse({ res, statusCode: 400, message: 'tenantId is required' }); return; }
    const result = await patientPortalService.getDepartmentsForBooking(req.user!.userId, tenantId);
    sendResponse({ res, statusCode: 200, message: 'Departments', data: result.data });
  } catch (err) { next(err); }
});

// GET /patient-portal/doctors?tenantId=xxx&departmentId=xxx&search=xxx
router.get('/doctors', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) { sendResponse({ res, statusCode: 400, message: 'tenantId is required' }); return; }
    const result = await patientPortalService.getDoctorsForBooking(req.user!.userId, tenantId, {
      departmentId: req.query.departmentId as string | undefined,
      search: req.query.search as string | undefined,
    });
    sendResponse({ res, statusCode: 200, message: 'Doctors', data: result.data });
  } catch (err) { next(err); }
});

// GET /patient-portal/doctors/:id/slots?tenantId=xxx&date=YYYY-MM-DD
router.get('/doctors/:id/slots', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.query.tenantId as string;
    const date = req.query.date as string;
    if (!tenantId || !date) { sendResponse({ res, statusCode: 400, message: 'tenantId and date are required' }); return; }
    const result = await patientPortalService.getDoctorSlotsForPatient(
      req.user!.userId, tenantId, req.params.id as string, date,
    );
    sendResponse({ res, statusCode: 200, message: 'Available slots', data: result });
  } catch (err) { next(err); }
});

// POST /patient-portal/book-appointment
router.post('/book-appointment', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { tenantId, doctorId, appointmentDate, startTime, endTime, reason } = req.body;
    if (!tenantId || !doctorId || !appointmentDate || !startTime || !endTime) {
      sendResponse({ res, statusCode: 400, message: 'tenantId, doctorId, appointmentDate, startTime, endTime are required' });
      return;
    }
    const appointment = await patientPortalService.bookAppointmentAsPatient(
      req.user!.userId, req.user!.email, tenantId,
      { doctorId, appointmentDate, startTime, endTime, reason },
    );
    sendResponse({ res, statusCode: 201, message: 'Appointment booked successfully', data: appointment });
  } catch (err) { next(err); }
});

// POST /patient-portal/appointments/:id/cancel
router.post('/appointments/:id/cancel', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const appointment = await patientPortalService.cancelAppointmentAsPatient(
      req.user!.userId, req.user!.email, req.params.id as string,
    );
    sendResponse({ res, statusCode: 200, message: 'Appointment cancelled', data: appointment });
  } catch (err) { next(err); }
});

// GET /patient-portal/appointments
router.get('/appointments', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await patientPortalService.getPatientAppointments(req.user!.userId, req.user!.email, {
      status: req.query.status as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      sortOrder: (req.query.sortOrder as 'asc' | 'desc') || undefined,
      tenantId: req.query.tenantId as string | undefined,
    });
    sendResponse({ res, statusCode: 200, message: 'Patient appointments', data: result.data });
  } catch (err) {
    next(err);
  }
});

// GET /patient-portal/available-forms — all forms the patient can fill across all hospitals
router.get(
  '/available-forms',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await patientPortalService.getPatientAvailableForms(
        req.user!.userId,
        req.user!.email,
      );
      sendResponse({ res, statusCode: 200, message: 'Patient available forms', data: result.data });
    } catch (err) {
      next(err);
    }
  },
);

// GET /patient-portal/lab-reports
router.get('/lab-reports', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await patientPortalService.getPatientLabReports(req.user!.userId, req.user!.email, {
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      tenantId: req.query.tenantId as string | undefined,
    });
    sendResponse({ res, statusCode: 200, message: 'Patient lab reports', data: result.data });
  } catch (err) {
    next(err);
  }
});

// GET /patient-portal/prescriptions
router.get('/prescriptions', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await patientPortalService.getPatientPrescriptions(req.user!.userId, req.user!.email, {
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      tenantId: req.query.tenantId as string | undefined,
    });
    sendResponse({ res, statusCode: 200, message: 'Patient prescriptions', data: result.data });
  } catch (err) {
    next(err);
  }
});

// ── Miscellaneous Records (patient-uploaded documents) ──────
router.get('/documents', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.listMyDocuments(req.user!.userId, req.user!.email, req.query.tenantId as string | undefined);
    sendResponse({ res, message: 'Documents', data });
  } catch (err) { next(err); }
});

router.post(
  '/documents',
  (req: any, res: any, next: any) => uploadSingle('file')(req, res, next),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const file = (req as any).file;
      if (!file) return next(new Error('No file uploaded'));
      const { title, documentType, notes } = req.body || {};
      const data = await patientPortalService.createMyDocument(
        req.user!.userId,
        req.user!.email,
        file,
        { title, documentType, notes },
        req.query.tenantId as string | undefined,
      );
      sendResponse({ res, statusCode: 201, message: 'Document uploaded', data });
    } catch (err) { next(err); }
  },
);

router.delete('/documents/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await patientPortalService.deleteMyDocument(req.user!.userId, req.user!.email, req.params.id as string);
    sendResponse({ res, message: 'Document deleted' });
  } catch (err) { next(err); }
});

// ── Current Medications (patient read-only, combined) ───────
router.get('/current-medications', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.listMyCurrentMedications(req.user!.userId, req.user!.email, req.query.tenantId as string | undefined);
    sendResponse({ res, message: 'Current medications', data });
  } catch (err) { next(err); }
});

// ── Medical History (patient self-service) ──────────────────
router.get('/medical-history/personal', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.getMyPersonalHistory(req.user!.userId, req.user!.email, req.query.tenantId as string | undefined);
    sendResponse({ res, message: 'Personal history', data });
  } catch (err) { next(err); }
});

router.put('/medical-history/personal', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.upsertMyPersonalHistory(req.user!.userId, req.user!.email, req.body, req.query.tenantId as string | undefined);
    sendResponse({ res, message: 'Personal history saved', data });
  } catch (err) { next(err); }
});

router.get('/medical-history/family', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.listMyFamilyHistory(req.user!.userId, req.user!.email, req.query.tenantId as string | undefined);
    sendResponse({ res, message: 'Family history', data });
  } catch (err) { next(err); }
});

router.post('/medical-history/family', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.createMyFamilyHistory(req.user!.userId, req.user!.email, req.body, req.query.tenantId as string | undefined);
    sendResponse({ res, statusCode: 201, message: 'Family history added', data });
  } catch (err) { next(err); }
});

router.put('/medical-history/family/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.updateMyFamilyHistory(req.user!.userId, req.user!.email, req.params.id as string, req.body);
    sendResponse({ res, message: 'Family history updated', data });
  } catch (err) { next(err); }
});

router.delete('/medical-history/family/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await patientPortalService.deleteMyFamilyHistory(req.user!.userId, req.user!.email, req.params.id as string);
    sendResponse({ res, message: 'Family history deleted' });
  } catch (err) { next(err); }
});

router.get('/medical-history/allergies', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.listMyAllergies(req.user!.userId, req.user!.email, req.query.tenantId as string | undefined);
    sendResponse({ res, message: 'Allergies', data });
  } catch (err) { next(err); }
});

router.post('/medical-history/allergies', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.createMyAllergy(req.user!.userId, req.user!.email, req.body, req.query.tenantId as string | undefined);
    sendResponse({ res, statusCode: 201, message: 'Allergy added', data });
  } catch (err) { next(err); }
});

router.put('/medical-history/allergies/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.updateMyAllergy(req.user!.userId, req.user!.email, req.params.id as string, req.body);
    sendResponse({ res, message: 'Allergy updated', data });
  } catch (err) { next(err); }
});

router.delete('/medical-history/allergies/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await patientPortalService.deleteMyAllergy(req.user!.userId, req.user!.email, req.params.id as string);
    sendResponse({ res, message: 'Allergy deleted' });
  } catch (err) { next(err); }
});

// GET /patient-portal/discharge-summaries
router.get('/discharge-summaries', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.getPatientDischargeSummaries(req.user!.userId, req.user!.email);
    sendResponse({ res, statusCode: 200, message: 'Discharge summaries', data });
  } catch (err) {
    next(err);
  }
});

// GET /patient-portal/discharge-summaries/:id
router.get('/discharge-summaries/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.getPatientDischargeSummaryById(
      req.user!.userId,
      req.user!.email,
      req.params.id as string,
    );
    sendResponse({ res, statusCode: 200, message: 'Discharge summary', data });
  } catch (err) {
    next(err);
  }
});

// GET /patient-portal/discharge-summaries/:id/pdf
router.get('/discharge-summaries/:id/pdf', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const summary = await patientPortalService.getPatientDischargeSummaryById(
      req.user!.userId,
      req.user!.email,
      req.params.id as string,
    );
    const { streamDischargeSummaryPdf } = await import('../mrd/discharge-summary-pdf');
    streamDischargeSummaryPdf(res, summary as any);
  } catch (err) {
    next(err);
  }
});

// GET /patient-portal/drug-history
router.get('/drug-history', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = await patientPortalService.getPatientDrugHistory(req.user!.userId, req.user!.email, {
      tenantId: req.query.tenantId as string | undefined,
    });
    sendResponse({ res, statusCode: 200, message: 'Drug history', data });
  } catch (err) {
    next(err);
  }
});

// GET /patient-portal/follow-ups
router.get('/follow-ups', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await patientPortalService.getPatientFollowUps(req.user!.userId, req.user!.email, {
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      tenantId: req.query.tenantId as string | undefined,
    });
    sendResponse({ res, statusCode: 200, message: 'Patient follow-ups', data: result.data });
  } catch (err) {
    next(err);
  }
});

// GET /patient-portal/billing
router.get('/billing', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await patientPortalService.getPatientBills(req.user!.userId, req.user!.email, {
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      tenantId: req.query.tenantId as string | undefined,
    });
    sendResponse({ res, statusCode: 200, message: 'Patient bills', data: result.data });
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────
// Payment
// ────────────────────────────────────────────────────────────

// GET /patient-portal/payment-info?tenantId=xxx
router.get('/payment-info', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) { sendResponse({ res, statusCode: 400, message: 'tenantId is required' }); return; }
    const result = await patientPortalService.getPaymentInfo(tenantId);
    sendResponse({ res, statusCode: 200, message: 'Payment info', data: result });
  } catch (err) { next(err); }
});

// POST /patient-portal/create-payment-order
router.post('/create-payment-order', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { appointmentId } = req.body;
    if (!appointmentId) {
      sendResponse({ res, statusCode: 400, message: 'appointmentId is required' });
      return;
    }
    const result = await patientPortalService.createPatientPaymentOrder(
      req.user!.userId, req.user!.email, { appointmentId },
    );
    sendResponse({ res, statusCode: 201, message: 'Payment order created', data: result });
  } catch (err) { next(err); }
});

// POST /patient-portal/verify-payment
router.post('/verify-payment', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      sendResponse({ res, statusCode: 400, message: 'razorpay_order_id, razorpay_payment_id, razorpay_signature are required' });
      return;
    }
    const result = await patientPortalService.verifyPatientPayment({
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
    });
    sendResponse({ res, statusCode: 200, message: 'Payment verified', data: result });
  } catch (err) { next(err); }
});

// POST /patient-portal/confirm-frontdesk-payment
router.post('/confirm-frontdesk-payment', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { appointmentId } = req.body;
    if (!appointmentId) {
      sendResponse({ res, statusCode: 400, message: 'appointmentId is required' });
      return;
    }
    const result = await patientPortalService.confirmFrontdeskPayment(
      req.user!.userId, req.user!.email, { appointmentId },
    );
    sendResponse({ res, statusCode: 201, message: 'Front desk payment confirmed', data: result });
  } catch (err) { next(err); }
});

export { router as patientPortalRoutes };
