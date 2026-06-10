import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// ============================================================
// Common
// ============================================================

const idParam = z.object({
  params: z.object({
    id: z.string().uuid('Invalid ID'),
  }),
});

// ============================================================
// Tickets
// ============================================================

export const createTicketSchema = z.object({
  body: z.object({
    ticketType: z.enum([
      'appointment_request',
      'op_to_ip',
      'complaint',
      'service_request',
      'equipment_fault',
      'general',
    ]),
    subject: z.string().min(1, 'Subject is required').max(255),
    description: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
    patientId: z.string().uuid('Invalid patient ID').optional(),
    departmentId: z.string().uuid('Invalid department ID').optional(),
  }),
});

export const getTicketsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z
      .enum(['open', 'in_progress', 'pending', 'resolved', 'closed', 'escalated'])
      .optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    ticketType: z
      .enum([
        'appointment_request',
        'op_to_ip',
        'complaint',
        'service_request',
        'equipment_fault',
        'general',
      ])
      .optional(),
    assignedTo: z.string().uuid().optional(),
  }),
});

export const ticketIdParamSchema = idParam;

export const updateTicketSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid ticket ID'),
  }),
  body: z.object({
    subject: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    status: z
      .enum(['open', 'in_progress', 'pending', 'resolved', 'closed', 'escalated'])
      .optional(),
    departmentId: z.string().uuid('Invalid department ID').nullable().optional(),
  }),
});

export const assignTicketSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid ticket ID'),
  }),
  body: z.object({
    assignedTo: z.string().uuid('Invalid user ID'),
  }),
});

export const closeTicketSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid ticket ID'),
  }),
  body: z.object({
    resolutionNotes: z.string().min(1, 'Resolution notes are required').max(2000),
  }),
});

// ============================================================
// Feedback
// ============================================================

export const submitFeedbackSchema = z.object({
  body: z.object({
    feedbackType: z.enum(['general', 'doctor', 'service', 'facility', 'complaint']),
    subject: z.string().max(255).optional(),
    content: z.string().min(1, 'Content is required'),
    rating: z.number().int().min(1).max(5).optional(),
    patientId: z.string().uuid('Invalid patient ID').optional(),
    doctorId: z.string().uuid('Invalid doctor ID').optional(),
    departmentId: z.string().uuid('Invalid department ID').optional(),
  }),
});

export const getFeedbackQuerySchema = z.object({
  query: paginationSchema.extend({
    feedbackType: z
      .enum(['general', 'doctor', 'service', 'facility', 'complaint'])
      .optional(),
    status: z.enum(['submitted', 'reviewed', 'escalated', 'resolved']).optional(),
    doctorId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
  }),
});

export const feedbackIdParamSchema = idParam;

export const respondToFeedbackSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid feedback ID'),
  }),
  body: z.object({
    adminResponse: z.string().min(1, 'Response is required').max(2000),
    status: z.enum(['reviewed', 'escalated', 'resolved']).default('reviewed'),
  }),
});

// ============================================================
// Audit Logs
// ============================================================

export const getAuditLogsQuerySchema = z.object({
  query: paginationSchema.extend({
    userId: z.string().uuid().optional(),
    action: z.enum(['create', 'read', 'update', 'delete']).optional(),
    entityType: z.string().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const auditLogIdParamSchema = idParam;

export const auditLogsByEntitySchema = z.object({
  params: z.object({
    entityType: z.string().min(1, 'Entity type is required'),
    entityId: z.string().min(1, 'Entity ID is required'),
  }),
  query: paginationSchema,
});

// ============================================================
// Compliance Documents
// ============================================================

export const createComplianceDocSchema = z.object({
  body: z.object({
    documentType: z.enum(['license', 'certification', 'accreditation', 'policy', 'legal_hold']),
    title: z.string().min(1, 'Title is required').max(255),
    description: z.string().optional(),
    fileUrl: z.string().url('Invalid file URL').optional(),
    issuedDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid issued date' })
      .optional(),
    expiryDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid expiry date' })
      .optional(),
  }),
});

export const getComplianceDocsQuerySchema = z.object({
  query: paginationSchema.extend({
    documentType: z
      .enum(['license', 'certification', 'accreditation', 'policy', 'legal_hold'])
      .optional(),
    status: z.enum(['active', 'expired', 'renewal_pending']).optional(),
  }),
});

export const complianceDocIdParamSchema = idParam;

export const updateComplianceDocSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid document ID'),
  }),
  body: z.object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
    fileUrl: z.string().url('Invalid file URL').optional(),
    issuedDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid issued date' })
      .optional(),
    expiryDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid expiry date' })
      .optional(),
    status: z.enum(['active', 'expired', 'renewal_pending']).optional(),
  }),
});

export const approveComplianceDocSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid document ID'),
  }),
});

// ============================================================
// OT Requests
// ============================================================

// `procedureName` is the canonical column name, but the OT UI talks in terms
// of `surgeryName` / `priority` (matching the EmedHub clone reference). Accept
// both forms and normalize before persisting.
export const createOtRequestSchema = z.object({
  body: z
    .object({
      patientId: z.string().uuid('Invalid patient ID'),
      visitId: z.string().uuid('Invalid visit ID').optional(),
      doctorId: z.string().uuid('Invalid doctor ID').optional(),
      procedureName: z.string().min(1).max(255).optional(),
      surgeryName: z.string().min(1).max(255).optional(),
      procedureDetails: z.string().optional(),
      surgeryType: z.string().max(50).optional(),
      speciality: z.string().max(100).optional(),
      urgency: z.enum(['elective', 'urgent', 'emergency']).optional(),
      priority: z.enum(['routine', 'urgent', 'emergency']).optional(),
      surgeonId: z.string().uuid().optional(),
      anaesthetistId: z.string().uuid().optional(),
      otId: z.string().uuid().optional(),
      otName: z.string().max(100).optional(),
      preferredDate: z.string().optional(),
      preferredTime: z
        .string()
        .regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM')
        .optional(),
      scheduledDate: z.string().optional(),
      scheduledStartTime: z.string().optional(),
      scheduledEndTime: z.string().optional(),
      durationMinutes: z.number().int().positive().max(1440).optional(),
      estimatedDuration: z.number().int().positive().max(1440).optional(),
      requiredEquipment: z.array(z.string()).optional(),
      preOpChecklist: z.record(z.unknown()).optional(),
      preOpDiagnosis: z.string().max(2000).optional(),
      notes: z.string().max(5000).optional(),
    })
    .refine((d) => d.procedureName || d.surgeryName, {
      message: 'Either procedureName or surgeryName is required',
      path: ['surgeryName'],
    }),
});

export const getOtRequestsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z
      .enum(['requested', 'scheduled', 'in_progress', 'completed', 'cancelled'])
      .optional(),
    urgency: z.enum(['elective', 'urgent', 'emergency']).optional(),
    doctorId: z.string().uuid().optional(),
    patientId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const otRequestIdParamSchema = idParam;

export const approveOtRequestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid OT request ID'),
  }),
});

export const scheduleOtSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid OT request ID'),
  }),
  body: z.object({
    otId: z.string().uuid('Invalid operating theater ID').optional(),
    otName: z.string().max(100).optional(),
    scheduledDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid scheduled date',
    }),
    scheduledTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM')
      .optional(),
    scheduledStartTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM')
      .optional(),
    scheduledEndTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM')
      .optional(),
    surgeonId: z.string().uuid().optional(),
    anaesthetistId: z.string().uuid().optional(),
    durationMinutes: z.number().int().positive().max(1440).optional(),
  }),
});

// Update existing OT request — used by the UI for in-flight edits like start
// surgery, end surgery, mark cancelled, attach post-op notes.
export const updateOtRequestSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    status: z
      .enum(['requested', 'scheduled', 'in_progress', 'completed', 'cancelled'])
      .optional(),
    actualStartTime: z.string().optional(),
    actualEndTime: z.string().optional(),
    postOpDiagnosis: z.string().max(2000).optional(),
    cancellationReason: z.string().max(2000).optional(),
    notes: z.string().max(5000).optional(),
    billingAmount: z.number().min(0).optional(),
    billingStatus: z.enum(['pending', 'paid', 'partially_paid', 'cancelled']).optional(),
    surgeonId: z.string().uuid().optional(),
    anaesthetistId: z.string().uuid().optional(),
    surgeryType: z.string().max(50).optional(),
    speciality: z.string().max(100).optional(),
  }),
});

export const otAnalyticsQuerySchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    otId: z.string().uuid().optional(),
    surgeonId: z.string().uuid().optional(),
  }),
});

// --- Operating Theaters (rooms) ---
export const createOtSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    location: z.string().max(255).optional(),
    status: z.enum(['available', 'in_use', 'maintenance']).optional(),
    equipmentList: z.array(z.string()).optional(),
  }),
});

export const updateOtSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    location: z.string().max(255).optional().nullable(),
    status: z.enum(['available', 'in_use', 'maintenance']).optional(),
    equipmentList: z.array(z.string()).optional(),
  }),
});

export const otIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid operating theater ID') }),
});

export type UpdateOtRequestInput = z.infer<typeof updateOtRequestSchema>['body'];
export type CreateOtInput = z.infer<typeof createOtSchema>['body'];
export type UpdateOtInput = z.infer<typeof updateOtSchema>['body'];

export const updateOtSettingsSchema = z.object({
  body: z.object({
    defaultDurationMinutes: z.number().int().min(5).max(1440).optional(),
    bufferMinutes: z.number().int().min(0).max(240).optional(),
    maxSurgeriesPerDay: z.number().int().min(1).max(100).optional(),
    dayStartTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:mm').nullable().optional(),
    dayEndTime: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:mm').nullable().optional(),
  }),
});

export type UpdateOtSettingsInput = z.infer<typeof updateOtSettingsSchema>['body'];

// ============================================================
// Incidents
// ============================================================

export const reportIncidentSchema = z.object({
  body: z.object({
    incidentType: z.enum([
      'patient_fall',
      'medication_error',
      'equipment_fault',
      'adverse_event',
      'other',
    ]),
    description: z.string().min(1, 'Description is required'),
    severity: z.enum(['minor', 'moderate', 'major', 'critical']).optional(),
    patientId: z.string().uuid('Invalid patient ID').optional(),
    location: z.string().max(255).optional(),
    occurredAt: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid date' })
      .optional(),
  }),
});

export const getIncidentsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['reported', 'investigating', 'resolved', 'closed']).optional(),
    severity: z.enum(['minor', 'moderate', 'major', 'critical']).optional(),
    incidentType: z
      .enum([
        'patient_fall',
        'medication_error',
        'equipment_fault',
        'adverse_event',
        'other',
      ])
      .optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const incidentIdParamSchema = idParam;

export const updateIncidentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid incident ID'),
  }),
  body: z.object({
    description: z.string().min(1).optional(),
    severity: z.enum(['minor', 'moderate', 'major', 'critical']).optional(),
    location: z.string().max(255).optional(),
  }),
});

export const investigateIncidentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid incident ID'),
  }),
  body: z.object({
    resolutionNotes: z.string().min(1, 'Investigation notes are required').max(5000),
  }),
});

export const closeIncidentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid incident ID'),
  }),
  body: z.object({
    resolutionNotes: z.string().min(1, 'Resolution notes are required').max(5000),
  }),
});

// ============================================================
// Exported types
// ============================================================

export type CreateTicketInput = z.infer<typeof createTicketSchema>['body'];
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>['body'];
export type AssignTicketInput = z.infer<typeof assignTicketSchema>['body'];
export type CloseTicketInput = z.infer<typeof closeTicketSchema>['body'];
export type GetTicketsQuery = z.infer<typeof getTicketsQuerySchema>['query'];

export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>['body'];
export type RespondToFeedbackInput = z.infer<typeof respondToFeedbackSchema>['body'];
export type GetFeedbackQuery = z.infer<typeof getFeedbackQuerySchema>['query'];

export type GetAuditLogsQuery = z.infer<typeof getAuditLogsQuerySchema>['query'];

export type CreateComplianceDocInput = z.infer<typeof createComplianceDocSchema>['body'];
export type UpdateComplianceDocInput = z.infer<typeof updateComplianceDocSchema>['body'];
export type GetComplianceDocsQuery = z.infer<typeof getComplianceDocsQuerySchema>['query'];

export type CreateOtRequestInput = z.infer<typeof createOtRequestSchema>['body'];
export type ScheduleOtInput = z.infer<typeof scheduleOtSchema>['body'];
export type GetOtRequestsQuery = z.infer<typeof getOtRequestsQuerySchema>['query'];

export type ReportIncidentInput = z.infer<typeof reportIncidentSchema>['body'];
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>['body'];
export type InvestigateIncidentInput = z.infer<typeof investigateIncidentSchema>['body'];
export type CloseIncidentInput = z.infer<typeof closeIncidentSchema>['body'];
export type GetIncidentsQuery = z.infer<typeof getIncidentsQuerySchema>['query'];
