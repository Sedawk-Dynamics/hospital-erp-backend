import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// ─── Shared ────────────────────────────────────────────────────────────────────

const idParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid ID'),
  }),
});

// ─── Departments ───────────────────────────────────────────────────────────────

export const createDepartmentSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Department name is required').max(100),
    code: z.string().max(20).optional(),
    description: z.string().max(1000).optional(),
    headUserId: z.string().uuid('Invalid head user ID').optional(),
    isActive: z.boolean().default(true),
  }),
});

export const updateDepartmentSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    code: z.string().max(20).optional().nullable(),
    description: z.string().max(1000).optional().nullable(),
    headUserId: z.string().uuid('Invalid head user ID').optional().nullable(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid department ID'),
  }),
});

export const listDepartmentsSchema = z.object({
  query: paginationSchema.extend({
    search: z.string().optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const departmentIdParamSchema = idParamSchema;

// ─── Floors ────────────────────────────────────────────────────────────────────

export const createFloorSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Floor name is required').max(60),
    level: z.number().int().min(-10).max(200).default(0),
    description: z.string().max(1000).optional(),
    isActive: z.boolean().default(true),
  }),
});

export const updateFloorSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(60).optional(),
    level: z.number().int().min(-10).max(200).optional(),
    description: z.string().max(1000).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid floor ID'),
  }),
});

export const listFloorsSchema = z.object({
  query: paginationSchema.extend({
    search: z.string().optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const floorIdParamSchema = idParamSchema;

// ─── Wards ─────────────────────────────────────────────────────────────────────

const wardTypeEnum = z.enum([
  'general',
  'semi_private',
  'private_ward',
  'icu',
  'nicu',
  'picu',
  'emergency',
]);

export const createWardSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Ward name is required').max(100),
    departmentId: z.string().uuid('Invalid department ID').optional(),
    floorId: z.string().uuid('Invalid floor ID').optional(),
    wardType: wardTypeEnum.optional(),
    totalBeds: z.number().int().min(0).default(0),
    // Per-day bed charge for the ward (hospital-admin set).
    dailyCharge: z.number().min(0).optional().nullable(),
    isActive: z.boolean().default(true),
  }),
});

export const updateWardSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    departmentId: z.string().uuid('Invalid department ID').optional().nullable(),
    floorId: z.string().uuid('Invalid floor ID').optional().nullable(),
    wardType: wardTypeEnum.optional().nullable(),
    totalBeds: z.number().int().min(0).optional(),
    dailyCharge: z.number().min(0).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid ward ID'),
  }),
});

export const listWardsSchema = z.object({
  query: paginationSchema.extend({
    search: z.string().optional(),
    departmentId: z.string().uuid().optional(),
    floorId: z.string().uuid().optional(),
    wardType: wardTypeEnum.optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const wardIdParamSchema = idParamSchema;

// ─── Beds ──────────────────────────────────────────────────────────────────────

const bedTypeEnum = z.enum(['standard', 'electric', 'icu', 'pediatric', 'bariatric']);
const bedStatusEnum = z.enum(['available', 'occupied', 'maintenance', 'reserved']);

export const createBedSchema = z.object({
  body: z.object({
    wardId: z.string().uuid('Invalid ward ID'),
    bedNumber: z.string().min(1, 'Bed number is required').max(20),
    bedType: bedTypeEnum.optional(),
    status: bedStatusEnum.default('available'),
  }),
});

export const bulkCreateBedsSchema = z.object({
  body: z.object({
    wardId: z.string().uuid('Invalid ward ID'),
    bedType: bedTypeEnum.optional(),
    beds: z
      .array(
        z.object({
          bedNumber: z.string().min(1, 'Bed number is required').max(20),
          bedType: bedTypeEnum.optional(),
        }),
      )
      .min(1, 'At least one bed is required')
      .max(200, 'Cannot create more than 200 beds at once'),
  }),
});

export const updateBedSchema = z.object({
  body: z.object({
    wardId: z.string().uuid('Invalid ward ID').optional(),
    bedNumber: z.string().min(1).max(20).optional(),
    bedType: bedTypeEnum.optional().nullable(),
    status: bedStatusEnum.optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid bed ID'),
  }),
});

export const listBedsSchema = z.object({
  query: paginationSchema.extend({
    search: z.string().optional(),
    wardId: z.string().uuid().optional(),
    floorId: z.string().uuid().optional(),
    bedType: bedTypeEnum.optional(),
    status: bedStatusEnum.optional(),
    // When set together with `status=available`, also include beds that are
    // currently held (reserved/occupied) for THIS patient — used by the
    // admission/transfer pickers so a patient's pre-reserved bed remains
    // selectable.
    forPatientId: z.string().uuid().optional(),
  }),
});

export const bedAvailabilitySchema = z.object({
  query: z.object({
    wardId: z.string().uuid().optional(),
    floorId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
  }),
});

export const bedIdParamSchema = idParamSchema;

// ─── Exported Types ────────────────────────────────────────────────────────────

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>['body'];
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>['body'];
export type ListDepartmentsQuery = z.infer<typeof listDepartmentsSchema>['query'];

export type CreateFloorInput = z.infer<typeof createFloorSchema>['body'];
export type UpdateFloorInput = z.infer<typeof updateFloorSchema>['body'];
export type ListFloorsQuery = z.infer<typeof listFloorsSchema>['query'];

export type CreateWardInput = z.infer<typeof createWardSchema>['body'];
export type UpdateWardInput = z.infer<typeof updateWardSchema>['body'];
export type ListWardsQuery = z.infer<typeof listWardsSchema>['query'];

export type CreateBedInput = z.infer<typeof createBedSchema>['body'];
export type BulkCreateBedsInput = z.infer<typeof bulkCreateBedsSchema>['body'];
export type UpdateBedInput = z.infer<typeof updateBedSchema>['body'];
export type ListBedsQuery = z.infer<typeof listBedsSchema>['query'];
export type BedAvailabilityQuery = z.infer<typeof bedAvailabilitySchema>['query'];
