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

export const createOtRequestSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid('Invalid visit ID'),
    doctorId: z.string().uuid('Invalid doctor ID'),
    procedureName: z.string().min(1, 'Procedure name is required').max(255),
    procedureDetails: z.string().optional(),
    urgency: z.enum(['elective', 'urgent', 'emergency']).default('elective'),
    preferredDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid preferred date' })
      .optional(),
    preferredTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format')
      .optional(),
    durationMinutes: z.number().int().positive().max(1440).optional(),
    requiredEquipment: z.array(z.string()).optional(),
    preOpChecklist: z.record(z.unknown()).optional(),
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
    scheduledDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid scheduled date',
    }),
    scheduledTime: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
    durationMinutes: z.number().int().positive().max(1440).optional(),
  }),
});

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
