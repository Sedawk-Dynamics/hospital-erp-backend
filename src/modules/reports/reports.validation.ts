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
// Saved Reports
// ============================================================

export const createSavedReportSchema = z.object({
  body: z.object({
    reportName: z.string().min(1, 'Report name is required').max(255),
    reportType: z.enum([
      'financial',
      'operational',
      'clinical',
      'insurance',
      'inventory',
      'pharmacy',
      'hr',
      'custom',
    ]),
    parameters: z.record(z.unknown()).optional(),
    fileFormat: z.enum(['pdf', 'csv', 'excel']).optional(),
  }),
});

export const getSavedReportsQuerySchema = z.object({
  query: paginationSchema.extend({
    reportType: z
      .enum([
        'financial',
        'operational',
        'clinical',
        'insurance',
        'inventory',
        'pharmacy',
        'hr',
        'custom',
      ])
      .optional(),
  }),
});

export const savedReportIdParamSchema = idParam;

export const updateSavedReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
  body: z.object({
    reportName: z.string().min(1).max(255).optional(),
    reportType: z
      .enum([
        'financial',
        'operational',
        'clinical',
        'insurance',
        'inventory',
        'pharmacy',
        'hr',
        'custom',
      ])
      .optional(),
    parameters: z.record(z.unknown()).optional(),
    fileFormat: z.enum(['pdf', 'csv', 'excel']).optional(),
  }),
});

export const generateReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
  body: z
    .object({
      fromDate: z
        .string()
        .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid from date' })
        .optional(),
      toDate: z
        .string()
        .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid to date' })
        .optional(),
      filters: z.record(z.unknown()).optional(),
    })
    .optional(),
});

export const exportReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
  query: z.object({
    format: z.enum(['pdf', 'csv', 'excel']).default('pdf'),
  }),
});

// ============================================================
// Scheduled Reports
// ============================================================

export const createScheduledReportSchema = z.object({
  body: z.object({
    reportName: z.string().min(1, 'Report name is required').max(255),
    reportType: z.string().min(1, 'Report type is required').max(50),
    parameters: z.record(z.unknown()).optional(),
    schedule: z.enum(['daily', 'weekly', 'monthly']),
    deliveryEmail: z.string().email('Invalid email').max(255).optional(),
  }),
});

export const getScheduledReportsQuerySchema = z.object({
  query: paginationSchema.extend({
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    schedule: z.enum(['daily', 'weekly', 'monthly']).optional(),
  }),
});

export const scheduledReportIdParamSchema = idParam;

export const updateScheduledReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid scheduled report ID'),
  }),
  body: z.object({
    reportName: z.string().min(1).max(255).optional(),
    reportType: z.string().min(1).max(50).optional(),
    parameters: z.record(z.unknown()).optional(),
    schedule: z.enum(['daily', 'weekly', 'monthly']).optional(),
    deliveryEmail: z.string().email('Invalid email').max(255).nullable().optional(),
  }),
});

export const toggleScheduledReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid scheduled report ID'),
  }),
});

// ============================================================
// Support Tickets
// ============================================================

export const createSupportTicketSchema = z.object({
  body: z.object({
    subject: z.string().min(1, 'Subject is required').max(255),
    description: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  }),
});

export const getSupportTicketsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['open', 'in_progress', 'resolved', 'escalated', 'closed']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  }),
});

export const supportTicketIdParamSchema = idParam;

export const updateSupportTicketSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid support ticket ID'),
  }),
  body: z.object({
    subject: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    status: z.enum(['open', 'in_progress', 'resolved', 'escalated', 'closed']).optional(),
  }),
});

export const addSupportTicketCommentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid support ticket ID'),
  }),
  body: z.object({
    content: z.string().min(1, 'Comment content is required').max(5000),
  }),
});

export const closeSupportTicketSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid support ticket ID'),
  }),
  body: z.object({
    resolutionNotes: z.string().min(1, 'Resolution notes are required').max(5000),
  }),
});

// ============================================================
// Exported types
// ============================================================

export type CreateSavedReportInput = z.infer<typeof createSavedReportSchema>['body'];
export type UpdateSavedReportInput = z.infer<typeof updateSavedReportSchema>['body'];
export type GetSavedReportsQuery = z.infer<typeof getSavedReportsQuerySchema>['query'];
export type GenerateReportInput = z.infer<typeof generateReportSchema>['body'];
export type ExportReportQuery = z.infer<typeof exportReportSchema>['query'];

export type CreateScheduledReportInput = z.infer<typeof createScheduledReportSchema>['body'];
export type UpdateScheduledReportInput = z.infer<typeof updateScheduledReportSchema>['body'];
export type GetScheduledReportsQuery = z.infer<typeof getScheduledReportsQuerySchema>['query'];

export type CreateSupportTicketInput = z.infer<typeof createSupportTicketSchema>['body'];
export type UpdateSupportTicketInput = z.infer<typeof updateSupportTicketSchema>['body'];
export type GetSupportTicketsQuery = z.infer<typeof getSupportTicketsQuerySchema>['query'];
export type AddSupportTicketCommentInput = z.infer<typeof addSupportTicketCommentSchema>['body'];
export type CloseSupportTicketInput = z.infer<typeof closeSupportTicketSchema>['body'];
