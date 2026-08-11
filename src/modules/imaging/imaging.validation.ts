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
    // Set when the doctor picked a study from the imaging catalog — used to
    // price the auto-linked bill item exactly off that tariff.
    serviceTariffId: z.string().uuid('Invalid service tariff ID').optional(),
  }),
});

export const imagingCatalogQuerySchema = z.object({
  query: z.object({
    search: z.string().optional(),
    modality: z.enum(['xray', 'mri', 'ct_scan', 'ultrasound', 'ecg', 'echo', 'other']).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  }),
});

export const getImagingRequestsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z
      .enum(['requested', 'scheduled', 'in_progress', 'completed', 'no_show', 'cancelled'])
      .optional(),
    imagingType: z.enum(['xray', 'mri', 'ct_scan', 'ultrasound', 'ecg', 'echo', 'other']).optional(),
    urgency: z.enum(['routine', 'urgent', 'stat']).optional(),
    patientId: z.string().uuid().optional(),
    assignedTechnicianId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    date: z.string().optional(),
    // 'true'/'false' query string — the radiology_admin queue filters
    // to paymentVerified=false (need to verify), the radiologist queue
    // filters to paymentVerified=true (cleared to start).
    paymentVerified: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    // Radiology module surfaces pass this to hide cancelled requests from
    // their lists/dashboard. Other callers (e.g. doctor order panels) omit it
    // and still see the full set.
    excludeCancelled: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    // The Pending worklist passes this (with excludeCancelled) to show only
    // the active to-do set — i.e. everything except completed/cancelled/no_show.
    excludeCompleted: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    // The radiology "Closed / No-show" tab passes this to fetch the terminal
    // admin-closed set (status in cancelled + no_show) in one call instead of
    // filtering by a single status.
    closed: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    // Several statuses at once, comma separated — a worklist wants "everything
    // still open", which a single enum cannot express. Same param the lab takes.
    statuses: z.string().optional(),
    /** Admin intake queue: has the department accepted this study yet? */
    accepted: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    /** Accepted but nobody owns it. */
    unassigned: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    /** Open >24h with nothing published. */
    overdue: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
  }),
});

export const imagingRequestIdParamSchema = idParam;

/**
 * Money collected at radiology's own counter — same shape as the lab's, so one
 * dialog drives both accept flows.
 */
export const diagnosticPaymentSchema = z.object({
  paymentMethod: z.enum([
    'cash',
    'credit_card',
    'debit_card',
    'upi',
    'net_banking',
    'cheque',
    'insurance',
    'other',
  ]),
  amount: z.coerce.number().positive('Enter an amount to collect').optional(),
  referenceNumber: z.string().max(200).optional(),
  notes: z.string().max(500).optional(),
});

export const acceptImagingRequestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging request ID'),
  }),
  body: z.object({
    assignedTechnicianId: z.string().uuid('Invalid radiologist ID').optional(),
    notes: z.string().max(500).optional(),
    /** Price off an exact catalog study rather than the modality lookup. */
    serviceTariffId: z.string().uuid().optional(),
    payment: diagnosticPaymentSchema.optional(),
    /** Admit without collecting — TPA / insurance / credit / pay later. */
    deferReason: z.string().min(2).max(300).optional(),
  }),
});

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

// Radiology admin closes a request that won't produce a report file. The
// reason drives the resulting status (patient_no_show → no_show, everything
// else → cancelled) and is preserved for departmental reporting.
export const IMAGING_CLOSURE_REASONS = [
  'patient_no_show',
  'patient_refused',
  'patient_cancelled',
  'done_externally',
  'not_required',
  'equipment_unavailable',
  'duplicate_order',
  'other',
] as const;

export const closeImagingRequestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging request ID'),
  }),
  body: z.object({
    reason: z.enum(IMAGING_CLOSURE_REASONS),
    note: z.string().max(1000).optional(),
  }),
});

export const reopenImagingRequestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging request ID'),
  }),
});

export const verifyImagingPaymentSchema = z.object({
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
    // Admin "Awaiting Approval" queue: exactly what a radiologist has marked
    // done (status='finalized').
    pendingApproval: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
    // The radiologist's own bench: uploaded but not yet marked done, so still
    // editable by them.
    draft: z
      .string()
      .transform((v) => v === 'true')
      .optional(),
  }),
});

export const imagingResultIdParamSchema = idParam;

export const addImagingReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging result ID'),
  }),
  body: z.object({
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

/** Radiologist's Mark as Done — hands the draft to the admin for approval. */
export const submitImagingResultSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging result ID'),
  }),
  body: z
    .object({
      impression: z.string().max(5000).optional(),
    })
    .optional(),
});

/** Admin sends a submitted report back to the radiologist for changes. */
export const reopenImagingResultSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid imaging result ID'),
  }),
  body: z
    .object({
      reason: z.string().max(500).optional(),
    })
    .optional(),
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
export type AcceptImagingRequestInput = z.infer<typeof acceptImagingRequestSchema>['body'];

export type CloseImagingRequestInput = z.infer<typeof closeImagingRequestSchema>['body'];
export type UploadImagingResultInput = z.infer<typeof uploadImagingResultSchema>['body'];
export type GetImagingResultsQuery = z.infer<typeof getImagingResultsQuerySchema>['query'];
export type AddImagingReportInput = z.infer<typeof addImagingReportSchema>['body'];
