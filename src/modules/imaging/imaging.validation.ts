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
// Imaging Requests
// ============================================================

export const createImagingRequestSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid('Invalid visit ID'),
    imagingType: z.enum(['xray', 'mri', 'ct_scan', 'ultrasound', 'ecg', 'echo', 'other']),
    bodyPart: z.string().max(100).optional(),
    urgency: z.enum(['routine', 'urgent', 'stat']).default('routine'),
    clinicalIndication: z.string().optional(),
    notes: z.string().optional(),
    scheduledAt: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid scheduled date' })
      .optional(),
  }),
});

export const getImagingRequestsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['requested', 'scheduled', 'in_progress', 'completed', 'cancelled']).optional(),
    imagingType: z.enum(['xray', 'mri', 'ct_scan', 'ultrasound', 'ecg', 'echo', 'other']).optional(),
    urgency: z.enum(['routine', 'urgent', 'stat']).optional(),
    patientId: z.string().uuid().optional(),
    assignedTechnicianId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    date: z.string().optional(),
  }),
});

export const imagingRequestIdParamSchema = idParam;

export const updateImagingRequestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging request ID'),
  }),
  body: z.object({
    imagingType: z.enum(['xray', 'mri', 'ct_scan', 'ultrasound', 'ecg', 'echo', 'other']).optional(),
    bodyPart: z.string().max(100).optional(),
    urgency: z.enum(['routine', 'urgent', 'stat']).optional(),
    clinicalIndication: z.string().optional(),
    notes: z.string().optional(),
    scheduledAt: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid scheduled date' })
      .optional(),
    assignedTechnicianId: z.string().uuid('Invalid technician ID').optional(),
    room: z.string().max(100).optional(),
  }),
});

export const cancelImagingRequestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging request ID'),
  }),
});

export const scheduleImagingSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging request ID'),
  }),
  body: z.object({
    scheduledAt: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid scheduled date',
    }),
    assignedTechnicianId: z.string().uuid('Invalid technician ID').optional(),
    room: z.string().max(100).optional(),
  }),
});

// ============================================================
// Imaging Results
// ============================================================

export const uploadImagingResultSchema = z.object({
  body: z.object({
    imagingRequestId: z.string().uuid('Invalid imaging request ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    findings: z.string().optional(),
    impression: z.string().optional(),
    imageUrls: z.array(z.string().url('Invalid image URL')).optional(),
    pacsReferenceId: z.string().max(255).optional(),
  }),
});

export const getImagingResultsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['draft', 'finalized', 'published']).optional(),
    imagingRequestId: z.string().uuid().optional(),
    patientId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const imagingResultIdParamSchema = idParam;

export const addImagingReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging result ID'),
  }),
  body: z.object({
    findings: z.string().min(1, 'Findings are required'),
    impression: z.string().optional(),
    recommendation: z.string().optional(),
    pdfReportUrl: z.string().url('Invalid report URL').optional(),
  }),
});

// Used by the radiologist "Edit" button on a draft / finalized result. Any
// subset of these fields can be sent. URL is allowed to be an `/uploads/...`
// relative path (set by the attachment mirror) so the strict url() check is
// relaxed to a string.
export const editImagingResultSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging result ID'),
  }),
  body: z.object({
    findings: z.string().optional(),
    impression: z.string().optional(),
    pacsReferenceId: z.string().max(255).optional(),
    pdfReportUrl: z.string().max(2048).optional(),
  }),
});

export const verifyImagingResultSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging result ID'),
  }),
});

export const publishImagingResultSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging result ID'),
  }),
  body: z
    .object({
      notify: z.boolean().default(true),
    })
    .optional(),
});

// ============================================================
// Exported types
// ============================================================

export type CreateImagingRequestInput = z.infer<typeof createImagingRequestSchema>['body'];
export type UpdateImagingRequestInput = z.infer<typeof updateImagingRequestSchema>['body'];
export type GetImagingRequestsQuery = z.infer<typeof getImagingRequestsQuerySchema>['query'];
export type ScheduleImagingInput = z.infer<typeof scheduleImagingSchema>['body'];

export type UploadImagingResultInput = z.infer<typeof uploadImagingResultSchema>['body'];
export type GetImagingResultsQuery = z.infer<typeof getImagingResultsQuerySchema>['query'];
export type AddImagingReportInput = z.infer<typeof addImagingReportSchema>['body'];
