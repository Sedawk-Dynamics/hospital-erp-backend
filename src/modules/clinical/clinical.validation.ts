import { z } from 'zod';
import { paginationSchema, booleanQueryParam } from '../../shared/pagination';

// ==================== Visits ====================

export const createVisitSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    // Optional — a patient can be admitted before a doctor is assigned.
    doctorId: z.string().uuid('Invalid doctor ID').optional(),
    appointmentId: z.string().uuid('Invalid appointment ID').optional(),
    visitType: z.enum(['op', 'ip']),
    visitDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid visit date',
    }),
    chiefComplaint: z.string().max(2000).optional(),
  }),
});

export const getVisitsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    doctorId: z.string().uuid().optional(),
    visitType: z.enum(['op', 'ip']).optional(),
    status: z.enum(['active', 'completed', 'transferred', 'discharged']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const visitIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid visit ID'),
  }),
});

export const updateVisitSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid visit ID'),
  }),
  body: z.object({
    doctorId: z.string().uuid('Invalid doctor ID').optional(),
    chiefComplaint: z.string().max(2000).optional(),
    // The nurse's intake version, recorded and attributed separately from the
    // doctor's. Empty string clears it.
    nurseChiefComplaint: z.string().max(2000).optional(),
    visitType: z.enum(['op', 'ip']).optional(),
  }),
});

export const closeVisitSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid visit ID'),
  }),
});

export const ensureVisitForAppointmentSchema = z.object({
  body: z.object({
    appointmentId: z.string().uuid('Invalid appointment ID'),
  }),
});

// ==================== Admissions ====================

export const createAdmissionSchema = z.object({
  body: z.object({
    visitId: z.string().uuid('Invalid visit ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    // Consultation doctor is optional now — can be assigned later.
    doctorId: z.string().uuid('Invalid doctor ID').optional(),
    // Bed & ward are NOT set at registration — front desk assigns/changes them
    // later from the IP ledger (beds move around during a stay).
    wardId: z.string().uuid('Invalid ward ID').optional(),
    bedId: z.string().uuid('Invalid bed ID').optional(),
    admissionDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid admission date',
    }),
    expectedDischargeDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid expected discharge date' })
      .optional(),
    admissionReason: z.string().max(2000).optional(),
    depositAmount: z.number().min(0).optional(),
    // How the deposit was tendered. MUST be named here: validate() replaces the
    // body with the parsed object, so a field the schema does not list is
    // silently dropped — the receipt would record every deposit as cash.
    depositPaymentMethod: z
      .enum(['cash', 'credit_card', 'debit_card', 'bank_transfer', 'upi', 'cheque', 'other'])
      .optional(),
    // G12: how this IP patient settles charges.
    billingCategory: z.enum(['cash', 'package', 'insurance', 'corporate']).optional(),
    // Care type — all three run the same IP flow; this is a tag/filter.
    admissionType: z.enum(['ip', 'emergency', 'daycare']).optional(),
  }),
});

export const getAdmissionsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    doctorId: z.string().uuid().optional(),
    // Doctor's own User ID — service resolves to DoctorProfile.id. Mirrors the
    // appointments query so the frontend can pass the logged-in user.id without
    // round-tripping for the doctor profile first.
    doctorUserId: z.string().uuid().optional(),
    nurseId: z.string().uuid().optional(),
    wardId: z.string().uuid().optional(),
    status: z
      .enum(['admitted', 'ready_to_discharge', 'discharged', 'transferred', 'absconded'])
      .optional(),
    admissionType: z.enum(['ip', 'emergency', 'daycare']).optional(),
    // With doctorUserId: also return admissions that have NO consultant yet.
    // An emergency admission opened by the front desk has none, so without this
    // it belongs to nobody and shows on nobody's list.
    includeUnassigned: booleanQueryParam.optional(),
    // Only stays with no bed yet. An admission can be opened before a bed is
    // free, so the desk needs to be able to ask which patients are still
    // waiting on one — nothing else could distinguish them from a stay whose
    // bed column simply had not been looked at.
    unassignedBed: booleanQueryParam.optional(),
    search: z.string().max(255).optional(),
    date: z.string().optional(),
    // Date-range window on admissionDate — used by the hospital reports screen.
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const admissionIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid admission ID'),
  }),
});

export const updateAdmissionSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid admission ID'),
  }),
  body: z.object({
    wardId: z.string().uuid('Invalid ward ID').optional(),
    bedId: z.string().uuid('Invalid bed ID').optional(),
    expectedDischargeDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid expected discharge date' })
      .optional(),
    admissionReason: z.string().max(2000).optional(),
    depositAmount: z.number().min(0).optional(),
    // How the deposit was tendered. MUST be named here: validate() replaces the
    // body with the parsed object, so a field the schema does not list is
    // silently dropped — the receipt would record every deposit as cash.
    depositPaymentMethod: z
      .enum(['cash', 'credit_card', 'debit_card', 'bank_transfer', 'upi', 'cheque', 'other'])
      .optional(),
    billingCategory: z.enum(['cash', 'package', 'insurance', 'corporate']).optional(),
  }),
});

// Set / clear the treating consultant. Null clears it (hand back to the pool).
export const assignAdmissionDoctorSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid admission ID'),
  }),
  body: z.object({
    doctorId: z.string().uuid('Invalid doctor ID').nullable(),
  }),
});

// Convert an admission's care type (ip ⇄ emergency ⇄ daycare).
export const changeAdmissionTypeSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid admission ID'),
  }),
  body: z.object({
    admissionType: z.enum(['ip', 'emergency', 'daycare']),
  }),
});

// Front-desk instant bed assign / change / clear from the IP ledger.
export const assignAdmissionBedSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid admission ID'),
  }),
  body: z.object({
    // A bed id to assign/move to, or null to unassign (leave the patient bedless).
    bedId: z.string().uuid('Invalid bed ID').nullable(),
  }),
});

export const dischargePatientSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid admission ID'),
  }),
  body: z.object({
    dischargeDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid discharge date' })
      .optional(),
    notes: z.string().max(2000).optional(),
    // Administrative override — discharge without a published discharge summary
    // AND without bill clearance (e.g. LAMA / transfer-out / death). Both gates
    // apply normally; `force` skips them and REQUIRES `reason`, which is written
    // to the audit log.
    force: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  })
    .refine((b) => !b.force || !!b.reason?.trim(), {
      message: 'A reason is required when overriding the discharge gates',
      path: ['reason'],
    })
    .optional(),
});

// ==================== Transfers ====================

export const createTransferSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid('Invalid visit ID'),
    transferType: z.enum(['doctor_to_doctor', 'ward_to_ward', 'bed_to_bed']),
    // from* may be null now that a patient can be admitted with no bed/ward, so
    // accept both null and undefined (nullish).
    fromDoctorId: z.string().uuid('Invalid from doctor ID').nullish(),
    toDoctorId: z.string().uuid('Invalid to doctor ID').nullish(),
    fromBedId: z.string().uuid('Invalid from bed ID').nullish(),
    toBedId: z.string().uuid('Invalid to bed ID').nullish(),
    fromWardId: z.string().uuid('Invalid from ward ID').nullish(),
    toWardId: z.string().uuid('Invalid to ward ID').nullish(),
    reason: z.string().max(2000).optional(),
    // Front desk applies bed/ward moves INSTANTLY (no separate approval step):
    // the transfer is created and immediately approved in one call.
    autoApprove: z.boolean().optional(),
  }),
});

export const getTransfersQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    status: z.enum(['requested', 'approved', 'completed', 'rejected']).optional(),
    transferType: z.enum(['doctor_to_doctor', 'ward_to_ward', 'bed_to_bed']).optional(),
    fromDoctorId: z.string().uuid().optional(),
    toDoctorId: z.string().uuid().optional(),
  }),
});

export const transferIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid transfer ID'),
  }),
});

export const approveTransferSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid transfer ID'),
  }),
  body: z
    .object({
      status: z.enum(['approved', 'rejected']).default('approved'),
      notes: z.string().max(2000).optional(),
    })
    .optional(),
});

// ==================== Vitals ====================

// Accepts visitId, admissionId, or appointmentId — at least one is required.
// The service resolves to a visitId, creating a Visit row from a confirmed
// appointment if none exists yet (mirrors nursing-forms.resolveVisitContext).
export const recordVitalsSchema = z.object({
  body: z
    .object({
      patientId: z.string().uuid('Invalid patient ID'),
      visitId: z.string().uuid('Invalid visit ID').optional(),
      admissionId: z.string().uuid('Invalid admission ID').optional(),
      appointmentId: z.string().uuid('Invalid appointment ID').optional(),
      bloodPressureSystolic: z.number().int().min(0).max(400).optional(),
      bloodPressureDiastolic: z.number().int().min(0).max(300).optional(),
      pulseRate: z.number().int().min(0).max(300).optional(),
      temperature: z.number().min(25).max(50).optional(),
      respiratoryRate: z.number().int().min(0).max(100).optional(),
      oxygenSaturation: z.number().min(0).max(100).optional(),
      weightKg: z.number().min(0).max(700).optional(),
      heightCm: z.number().min(0).max(300).optional(),
      bloodSugar: z.number().min(0).max(2000).optional(),
      notes: z.string().max(2000).optional(),
    })
    .refine(
      (b) => Boolean(b.visitId || b.admissionId || b.appointmentId),
      { message: 'Either visitId, admissionId, or appointmentId is required' },
    ),
});

export const patientIdParamSchema = z.object({
  params: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
  }),
});

// Correction to an existing Vital row. A new append-only row is created whenever
// the caller is outside the grace window OR is a doctor — both paths require
// `correctionReason` to be set. The legacy in-place update (grace window) is
// allowed only when recordedBy === userId and role is `nurse`.
export const correctVitalSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid vital ID'),
  }),
  body: z.object({
    bloodPressureSystolic: z.number().int().min(0).max(400).optional(),
    bloodPressureDiastolic: z.number().int().min(0).max(300).optional(),
    pulseRate: z.number().int().min(0).max(300).optional(),
    temperature: z.number().min(25).max(50).optional(),
    respiratoryRate: z.number().int().min(0).max(100).optional(),
    oxygenSaturation: z.number().min(0).max(100).optional(),
    weightKg: z.number().min(0).max(700).optional(),
    heightCm: z.number().min(0).max(300).optional(),
    bloodSugar: z.number().min(0).max(2000).optional(),
    notes: z.string().max(2000).optional(),
    correctionReason: z.string().min(1, 'Correction reason is required').max(500),
  }),
});

export const vitalIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid vital ID'),
  }),
});

export const getVitalsQuerySchema = z.object({
  params: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
  }),
  query: paginationSchema.extend({
    visitId: z.string().uuid().optional(),
  }),
});

export const getAllVitalsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    // Window on recordedAt (yyyy-MM-dd, IST day boundaries). Lets a queue ask
    // "who has had vitals taken today?" in one request instead of one per
    // patient on screen.
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

// ==================== Diagnoses ====================

export const addDiagnosisSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid('Invalid visit ID'),
    icdCode: z.string().max(20).optional(),
    diagnosisName: z.string().min(1, 'Diagnosis name is required').max(500),
    diagnosisType: z.enum(['primary', 'secondary', 'differential']).default('primary'),
    notes: z.string().max(2000).optional(),
  }),
});

export const getDiagnosesQuerySchema = z.object({
  params: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
  }),
  query: paginationSchema.extend({
    visitId: z.string().uuid().optional(),
    diagnosisType: z.enum(['primary', 'secondary', 'differential']).optional(),
  }),
});

export const getAllDiagnosesQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    visitId: z.string().uuid().optional(),
    diagnosisType: z.enum(['primary', 'secondary', 'differential']).optional(),
  }),
});

export const diagnosisIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid diagnosis ID'),
  }),
});

export const updateDiagnosisSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid diagnosis ID'),
  }),
  body: z.object({
    icdCode: z.string().max(20).optional(),
    diagnosisName: z.string().min(1).max(500).optional(),
    diagnosisType: z.enum(['primary', 'secondary', 'differential']).optional(),
    notes: z.string().max(2000).optional(),
  }),
});

// ==================== OT Requests ====================

export const createOtRequestSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid('Invalid visit ID'),
    doctorId: z.string().uuid('Invalid doctor ID'),
    procedureName: z.string().min(1, 'Procedure name is required').max(255),
    procedureDetails: z.string().max(5000).optional(),
    urgency: z.enum(['elective', 'urgent', 'emergency']).default('elective'),
    preferredDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid preferred date' })
      .optional(),
    preferredTime: z.string().optional(),
    durationMinutes: z.number().int().min(1).max(1440).optional(),
    requiredEquipment: z.any().optional(),
  }),
});

export const getOtRequestsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['requested', 'scheduled', 'in_progress', 'completed', 'cancelled']).optional(),
    doctorId: z.string().uuid().optional(),
    patientId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const otRequestIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid OT request ID'),
  }),
});

// ==================== Reservations ====================

export const createReservationSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    doctorId: z.string().uuid('Invalid doctor ID'),
    wardId: z.string().uuid('Invalid ward ID'),
    bedId: z.string().uuid('Invalid bed ID').optional(),
    reservedDate: z.string().refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid reserved date' }),
    expectedAdmission: z.string().refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid date' }).optional(),
    diagnosis: z.string().max(2000).optional(),
    speciality: z.string().max(100).optional(),
    advanceAmount: z.number().min(0).optional(),
    notes: z.string().max(2000).optional(),
  }),
});

export const getReservationsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    doctorId: z.string().uuid().optional(),
    wardId: z.string().uuid().optional(),
    status: z.enum(['reserved', 'confirmed', 'admitted', 'completed', 'cancelled']).optional(),
    search: z.string().max(255).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const reservationIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid reservation ID'),
  }),
});

export const updateReservationSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid reservation ID'),
  }),
  body: z.object({
    wardId: z.string().uuid().optional(),
    bedId: z.string().uuid().optional().nullable(),
    expectedAdmission: z.string().refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid date' }).optional(),
    diagnosis: z.string().max(2000).optional(),
    advanceAmount: z.number().min(0).optional(),
    notes: z.string().max(2000).optional(),
    status: z.enum(['reserved', 'confirmed', 'admitted', 'completed', 'cancelled']).optional(),
  }),
});

// ==================== Estimations ====================

export const createEstimationSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    doctorId: z.string().uuid('Invalid doctor ID'),
    complaints: z.string().max(2000).optional(),
    estimationPeriodDays: z.number().int().min(1).default(1),
    totalEstimateAmount: z.number().min(0),
    items: z.array(z.object({
      description: z.string().min(1),
      amount: z.number().min(0),
    })).optional(),
    notes: z.string().max(2000).optional(),
    admissionId: z.string().uuid().optional(),
  }),
});

export const getEstimationsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    doctorId: z.string().uuid().optional(),
    status: z.enum(['draft', 'finalized', 'approved', 'cancelled']).optional(),
    search: z.string().max(255).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const estimationIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid estimation ID'),
  }),
});

export const updateEstimationSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid estimation ID'),
  }),
  body: z.object({
    complaints: z.string().max(2000).optional(),
    estimationPeriodDays: z.number().int().min(1).optional(),
    totalEstimateAmount: z.number().min(0).optional(),
    items: z.array(z.object({
      description: z.string().min(1),
      amount: z.number().min(0),
    })).optional(),
    notes: z.string().max(2000).optional(),
    status: z.enum(['draft', 'finalized', 'approved', 'cancelled']).optional(),
  }),
});

// ==================== Exported Types ====================

export type CreateVisitInput = z.infer<typeof createVisitSchema>['body'];
export type GetVisitsQuery = z.infer<typeof getVisitsQuerySchema>['query'];
export type UpdateVisitInput = z.infer<typeof updateVisitSchema>['body'];

export type CreateAdmissionInput = z.infer<typeof createAdmissionSchema>['body'];
export type GetAdmissionsQuery = z.infer<typeof getAdmissionsQuerySchema>['query'];
export type UpdateAdmissionInput = z.infer<typeof updateAdmissionSchema>['body'];
export type AssignAdmissionDoctorInput = z.infer<typeof assignAdmissionDoctorSchema>['body'];

export type CreateTransferInput = z.infer<typeof createTransferSchema>['body'];
export type GetTransfersQuery = z.infer<typeof getTransfersQuerySchema>['query'];

export type RecordVitalsInput = z.infer<typeof recordVitalsSchema>['body'];
export type GetVitalsQuery = z.infer<typeof getVitalsQuerySchema>['query'];
export type GetAllVitalsQuery = z.infer<typeof getAllVitalsQuerySchema>['query'];

export type AddDiagnosisInput = z.infer<typeof addDiagnosisSchema>['body'];
export type GetDiagnosesQuery = z.infer<typeof getDiagnosesQuerySchema>['query'];
export type GetAllDiagnosesQuery = z.infer<typeof getAllDiagnosesQuerySchema>['query'];
export type UpdateDiagnosisInput = z.infer<typeof updateDiagnosisSchema>['body'];

export type CreateOtRequestInput = z.infer<typeof createOtRequestSchema>['body'];
export type GetOtRequestsQuery = z.infer<typeof getOtRequestsQuerySchema>['query'];

export type CreateReservationInput = z.infer<typeof createReservationSchema>['body'];
export type GetReservationsQuery = z.infer<typeof getReservationsQuerySchema>['query'];
export type UpdateReservationInput = z.infer<typeof updateReservationSchema>['body'];

export type CreateEstimationInput = z.infer<typeof createEstimationSchema>['body'];
export type GetEstimationsQuery = z.infer<typeof getEstimationsQuerySchema>['query'];
export type UpdateEstimationInput = z.infer<typeof updateEstimationSchema>['body'];

// ==================== Clinical Orders (unified nurse view) ====================

export const getClinicalOrdersQuerySchema = z.object({
  query: z.object({
    wardId: z.string().uuid().optional(),
    status: z.enum(['pending', 'completed', 'cancelled', 'all']).optional(),
    type: z.enum(['lab', 'imaging', 'all']).optional(),
    // scope=mine restricts to orders raised by doctors assigned to the
    // calling nurse (NurseDoctorAssignment). scope=all (default) preserves
    // the supervisory tenant-wide view.
    scope: z.enum(['mine', 'all']).optional(),
    patientId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
});

export const acknowledgeClinicalOrderSchema = z.object({
  body: z.object({
    orderType: z.enum(['lab', 'imaging']),
    orderId: z.string().uuid('Invalid order ID'),
    note: z.string().max(2000).optional(),
  }),
});

// Ack list: scope=mine filters to admissions with an active NurseAssignment to
// the caller; scope=ward filters to a ward (for nurse_admin oversight).
export const getOrderAcknowledgementsQuerySchema = z.object({
  query: z.object({
    scope: z.enum(['mine', 'ward', 'all']).default('mine'),
    wardId: z.string().uuid().optional(),
    status: z.enum(['pending', 'acknowledged', 'all']).default('all'),
    orderType: z.enum(['lab', 'imaging', 'all']).default('all'),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
});

export type GetClinicalOrdersQuery = z.infer<typeof getClinicalOrdersQuerySchema>['query'];
export type AcknowledgeClinicalOrderInput = z.infer<typeof acknowledgeClinicalOrderSchema>['body'];
export type CorrectVitalInput = z.infer<typeof correctVitalSchema>['body'];
export type GetOrderAcknowledgementsQuery = z.infer<typeof getOrderAcknowledgementsQuerySchema>['query'];

// ==================== Admission Requests ====================

export const createAdmissionRequestSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid('Invalid visit ID').optional(),
    doctorId: z.string().uuid('Invalid doctor ID'),
    reason: z.string().min(1, 'Reason is required').max(500),
    provisionalDiagnosis: z.string().max(1000).optional(),
    urgency: z.enum(['routine', 'urgent', 'emergency']).default('routine'),
    preferredWardType: z.string().max(100).optional(),
    expectedAdmissionDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid expected date' })
      .optional(),
    notes: z.string().max(2000).optional(),
  }),
});

export const getAdmissionRequestsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['pending', 'accepted', 'rejected', 'cancelled']).optional(),
    urgency: z.enum(['routine', 'urgent', 'emergency']).optional(),
    doctorId: z.string().uuid().optional(),
    patientId: z.string().uuid().optional(),
    search: z.string().max(255).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const admissionRequestIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid admission request ID'),
  }),
});

// Front desk accepts the request. Three branches:
//   • createReservation: blocks a bed/ward for later admission
//   • directAdmit: admits the patient on the spot (creates an IP visit if the
//     request didn't carry one) and links request.admissionId
//   • neither: just flips the request to "accepted"
// The two action flags are mutually exclusive — service refuses both at once.
export const acceptAdmissionRequestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid admission request ID'),
  }),
  body: z.object({
    createReservation: z.boolean().optional(),
    directAdmit: z.boolean().optional(),
    wardId: z.string().uuid().optional(),
    bedId: z.string().uuid().optional(),
    reservedDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid reserved date' })
      .optional(),
    expectedAdmission: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid date' })
      .optional(),
    // Direct admit only — when omitted defaults to "now"
    admissionDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid admission date' })
      .optional(),
    expectedDischargeDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid discharge date' })
      .optional(),
    admissionReason: z.string().max(1000).optional(),
    depositAmount: z.number().min(0).optional(),
    // How the deposit was tendered. MUST be named here: validate() replaces the
    // body with the parsed object, so a field the schema does not list is
    // silently dropped — the receipt would record every deposit as cash.
    depositPaymentMethod: z
      .enum(['cash', 'credit_card', 'debit_card', 'bank_transfer', 'upi', 'cheque', 'other'])
      .optional(),
    advanceAmount: z.number().min(0).optional(),
    notes: z.string().max(2000).optional(),
  }),
});

// Convert an existing reservation into an admission. Bed defaults to the
// reservation's blocked bed; pass bedId here to admit into a different bed.
export const admitFromReservationSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid reservation ID'),
  }),
  body: z.object({
    bedId: z.string().uuid().optional(),
    admissionDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid admission date' })
      .optional(),
    expectedDischargeDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid discharge date' })
      .optional(),
    admissionReason: z.string().max(1000).optional(),
    depositAmount: z.number().min(0).optional(),
    // How the deposit was tendered. MUST be named here: validate() replaces the
    // body with the parsed object, so a field the schema does not list is
    // silently dropped — the receipt would record every deposit as cash.
    depositPaymentMethod: z
      .enum(['cash', 'credit_card', 'debit_card', 'bank_transfer', 'upi', 'cheque', 'other'])
      .optional(),
  }),
});

export const rejectAdmissionRequestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid admission request ID'),
  }),
  body: z.object({
    rejectionReason: z.string().min(1, 'Rejection reason is required').max(2000),
  }),
});

export const cancelAdmissionRequestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid admission request ID'),
  }),
});

export type CreateAdmissionRequestInput = z.infer<typeof createAdmissionRequestSchema>['body'];
export type GetAdmissionRequestsQuery = z.infer<typeof getAdmissionRequestsQuerySchema>['query'];
export type AcceptAdmissionRequestInput = z.infer<typeof acceptAdmissionRequestSchema>['body'];
export type RejectAdmissionRequestInput = z.infer<typeof rejectAdmissionRequestSchema>['body'];
export type AdmitFromReservationInput = z.infer<typeof admitFromReservationSchema>['body'];
