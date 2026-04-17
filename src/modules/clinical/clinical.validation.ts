import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// ==================== Visits ====================

export const createVisitSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    doctorId: z.string().uuid('Invalid doctor ID'),
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
    visitType: z.enum(['op', 'ip']).optional(),
  }),
});

export const closeVisitSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid visit ID'),
  }),
});

// ==================== Admissions ====================

export const createAdmissionSchema = z.object({
  body: z.object({
    visitId: z.string().uuid('Invalid visit ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    doctorId: z.string().uuid('Invalid doctor ID'),
    wardId: z.string().uuid('Invalid ward ID'),
    bedId: z.string().uuid('Invalid bed ID'),
    admissionDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid admission date',
    }),
    expectedDischargeDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid expected discharge date' })
      .optional(),
    admissionReason: z.string().max(2000).optional(),
    depositAmount: z.number().min(0).optional(),
  }),
});

export const getAdmissionsQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    doctorId: z.string().uuid().optional(),
    nurseId: z.string().uuid().optional(),
    wardId: z.string().uuid().optional(),
    status: z.enum(['admitted', 'discharged', 'transferred', 'absconded']).optional(),
    search: z.string().max(255).optional(),
    date: z.string().optional(),
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
  }).optional(),
});

// ==================== Transfers ====================

export const createTransferSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid('Invalid visit ID'),
    transferType: z.enum(['doctor_to_doctor', 'ward_to_ward', 'bed_to_bed']),
    fromDoctorId: z.string().uuid('Invalid from doctor ID').optional(),
    toDoctorId: z.string().uuid('Invalid to doctor ID').optional(),
    fromBedId: z.string().uuid('Invalid from bed ID').optional(),
    toBedId: z.string().uuid('Invalid to bed ID').optional(),
    fromWardId: z.string().uuid('Invalid from ward ID').optional(),
    toWardId: z.string().uuid('Invalid to ward ID').optional(),
    reason: z.string().max(2000).optional(),
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

export const recordVitalsSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid('Invalid visit ID'),
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
  }),
});

export const patientIdParamSchema = z.object({
  params: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
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
