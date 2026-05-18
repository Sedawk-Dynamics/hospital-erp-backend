import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// ============================================================
// Lab Departments
// ============================================================

export const createLabDepartmentSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Department name is required').max(100),
    isActive: z.boolean().default(true),
  }),
});

export const getLabDepartmentsSchema = z.object({
  query: paginationSchema.extend({
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const updateLabDepartmentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid department ID'),
  }),
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
  }),
});

export const labDepartmentIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid department ID'),
  }),
});

// ============================================================
// Test Catalog
// ============================================================

export const createTestSchema = z.object({
  body: z.object({
    labDepartmentId: z.string().uuid('Invalid department ID'),
    testName: z.string().min(1, 'Test name is required').max(255),
    testCode: z.string().max(50).optional(),
    description: z.string().optional(),
    normalRange: z.string().optional(),
    unit: z.string().max(50).optional(),
    price: z.number().positive('Price must be positive').optional(),
    turnaroundHours: z.number().int().positive().optional(),
    sampleType: z.string().max(50).optional(),
    isActive: z.boolean().default(true),
  }),
});

export const getTestsSchema = z.object({
  query: paginationSchema.extend({
    labDepartmentId: z.string().uuid().optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    sampleType: z.string().optional(),
  }),
});

export const testIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid test ID'),
  }),
});

export const updateTestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid test ID'),
  }),
  body: z.object({
    labDepartmentId: z.string().uuid().optional(),
    testName: z.string().min(1).max(255).optional(),
    testCode: z.string().max(50).optional(),
    description: z.string().optional(),
    normalRange: z.string().optional(),
    unit: z.string().max(50).optional(),
    price: z.number().positive().optional(),
    turnaroundHours: z.number().int().positive().optional(),
    sampleType: z.string().max(50).optional(),
    isActive: z.boolean().optional(),
  }),
});

// ============================================================
// Lab Orders
// ============================================================

export const createLabOrderSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID'),
    visitId: z.string().uuid('Invalid visit ID'),
    urgency: z.enum(['routine', 'urgent', 'stat']).default('routine'),
    isThirdParty: z.boolean().default(false),
    thirdPartyLabName: z.string().max(255).optional(),
    notes: z.string().optional(),
    items: z
      .array(
        z.object({
          testId: z.string().uuid('Invalid test ID'),
        }),
      )
      .min(1, 'At least one test item is required'),
  }),
});

export const getLabOrdersSchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    status: z
      .enum([
        'ordered',
        'sample_collected',
        'in_transit',
        'received',
        'in_progress',
        'completed',
        'cancelled',
      ])
      .optional(),
    urgency: z.enum(['routine', 'urgent', 'stat']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    assignedTo: z.string().optional(),
    assignedDeptId: z.string().uuid().optional(),
    outsourced: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    isThirdParty: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    accepted: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    date: z.string().optional(),
  }),
});

export const labOrderIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid order ID'),
  }),
});

export const updateLabOrderSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid order ID'),
  }),
  body: z.object({
    urgency: z.enum(['routine', 'urgent', 'stat']).optional(),
    notes: z.string().optional(),
    status: z
      .enum([
        'ordered',
        'sample_collected',
        'in_transit',
        'received',
        'in_progress',
        'completed',
        'cancelled',
      ])
      .optional(),
  }),
});

export const cancelLabOrderSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid order ID'),
  }),
  body: z.object({
    reason: z.string().max(500).optional(),
  }).optional(),
});

export const acceptLabOrderSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid order ID'),
  }),
  body: z.object({
    assignedToId: z.string().uuid('Invalid technician user ID').optional(),
    assignedDeptId: z.string().uuid('Invalid department ID').optional(),
    notes: z.string().max(500).optional(),
  }),
});

// ============================================================
// Samples
// ============================================================

export const collectSampleSchema = z.object({
  body: z.object({
    labOrderId: z.string().uuid('Invalid order ID'),
    sampleType: z.string().min(1, 'Sample type is required').max(50),
    barcode: z.string().max(100).optional(),
    notes: z.string().optional(),
  }),
});

export const getSamplesSchema = z.object({
  query: paginationSchema.extend({
    labOrderId: z.string().uuid().optional(),
    status: z
      .enum(['collected', 'in_transit', 'received', 'processing', 'completed', 'rejected'])
      .optional(),
  }),
});

export const updateSampleStatusSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid sample ID'),
  }),
  body: z.object({
    status: z.enum(['collected', 'in_transit', 'received', 'processing', 'completed', 'rejected']),
  }),
});

export const rejectSampleSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid sample ID'),
  }),
  body: z.object({
    rejectionReason: z.string().min(1, 'Rejection reason is required').max(500),
  }),
});

// ============================================================
// Results
// ============================================================

export const enterResultsSchema = z.object({
  body: z.object({
    labOrderItemId: z.string().uuid('Invalid order item ID'),
    labOrderId: z.string().uuid('Invalid order ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    results: z
      .array(
        z.object({
          parameterName: z.string().min(1, 'Parameter name is required').max(255),
          value: z.string().max(255).optional(),
          unit: z.string().max(50).optional(),
          normalRange: z.string().max(100).optional(),
          isAbnormal: z.boolean().default(false),
        }),
      )
      .min(1, 'At least one result entry is required'),
  }),
});

export const getResultsSchema = z.object({
  query: paginationSchema.extend({
    labOrderId: z.string().uuid().optional(),
    labOrderItemId: z.string().uuid().optional(),
    patientId: z.string().uuid().optional(),
  }),
});

export const completeLabOrderItemSchema = z.object({
  params: z.object({
    orderId: z.string().uuid('Invalid order ID'),
    itemId: z.string().uuid('Invalid order item ID'),
  }),
});

export const verifyResultSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid result ID'),
  }),
  body: z
    .object({
      action: z.enum(['approve', 'request_correction']).default('approve'),
      correctionNotes: z.string().max(1000).optional(),
    })
    .optional(),
});

// ============================================================
// Reports
// ============================================================

export const generateLabReportSchema = z.object({
  params: z.object({
    orderId: z.string().uuid('Invalid order ID'),
  }),
  body: z
    .object({
      reportContent: z.string().optional(),
      hospitalBranding: z
        .object({
          name: z.string().optional(),
          logoUrl: z.string().optional(),
          address: z.string().optional(),
          phone: z.string().optional(),
          accreditation: z.string().optional(),
        })
        .partial()
        .optional(),
    })
    .optional(),
});

export const signLabReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
});

export const publishLabReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
  body: z
    .object({
      notify: z.boolean().default(true),
    })
    .optional(),
});

export const correctLabReportSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
  body: z.object({
    correctionNotes: z.string().min(1, 'Correction reason is required').max(2000),
    reportContent: z.string().optional(),
    notify: z.boolean().default(true),
  }),
});

export const getLabReportsSchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    status: z.enum(['draft', 'review', 'approved', 'published', 'corrected']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const labReportIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid report ID'),
  }),
});

// ============================================================
// Inferred types
// ============================================================

export type CreateLabDepartmentInput = z.infer<typeof createLabDepartmentSchema>['body'];
export type UpdateLabDepartmentInput = z.infer<typeof updateLabDepartmentSchema>['body'];
export type GetLabDepartmentsQuery = z.infer<typeof getLabDepartmentsSchema>['query'];

export type CreateTestInput = z.infer<typeof createTestSchema>['body'];
export type UpdateTestInput = z.infer<typeof updateTestSchema>['body'];
export type GetTestsQuery = z.infer<typeof getTestsSchema>['query'];

export type CreateLabOrderInput = z.infer<typeof createLabOrderSchema>['body'];
export type UpdateLabOrderInput = z.infer<typeof updateLabOrderSchema>['body'];
export type GetLabOrdersQuery = z.infer<typeof getLabOrdersSchema>['query'];
export type AcceptLabOrderInput = z.infer<typeof acceptLabOrderSchema>['body'];
export type VerifyResultInput = NonNullable<z.infer<typeof verifyResultSchema>['body']>;

export type CollectSampleInput = z.infer<typeof collectSampleSchema>['body'];
export type GetSamplesQuery = z.infer<typeof getSamplesSchema>['query'];
export type UpdateSampleStatusInput = z.infer<typeof updateSampleStatusSchema>['body'];
export type RejectSampleInput = z.infer<typeof rejectSampleSchema>['body'];

export type EnterResultsInput = z.infer<typeof enterResultsSchema>['body'];
export type GetResultsQuery = z.infer<typeof getResultsSchema>['query'];

export type GetLabReportsQuery = z.infer<typeof getLabReportsSchema>['query'];
export type CorrectLabReportInput = z.infer<typeof correctLabReportSchema>['body'];
