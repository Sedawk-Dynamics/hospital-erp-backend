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
    wardType: wardTypeEnum.optional(),
    floor: z.string().max(20).optional(),
    totalBeds: z.number().int().min(0).default(0),
    isActive: z.boolean().default(true),
  }),
});

export const updateWardSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    departmentId: z.string().uuid('Invalid department ID').optional().nullable(),
    wardType: wardTypeEnum.optional().nullable(),
    floor: z.string().max(20).optional().nullable(),
    totalBeds: z.number().int().min(0).optional(),
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
    wardType: wardTypeEnum.optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const wardIdParamSchema = idParamSchema;

// ─── Rooms ─────────────────────────────────────────────────────────────────────

const roomTypeEnum = z.enum(['single', 'double', 'shared', 'suite']);

export const createRoomSchema = z.object({
  body: z.object({
    wardId: z.string().uuid('Invalid ward ID'),
    roomNumber: z.string().min(1, 'Room number is required').max(20),
    roomType: roomTypeEnum.optional(),
    floor: z.string().max(20).optional(),
    isActive: z.boolean().default(true),
  }),
});

export const updateRoomSchema = z.object({
  body: z.object({
    wardId: z.string().uuid('Invalid ward ID').optional(),
    roomNumber: z.string().min(1).max(20).optional(),
    roomType: roomTypeEnum.optional().nullable(),
    floor: z.string().max(20).optional().nullable(),
    isActive: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid room ID'),
  }),
});

export const listRoomsSchema = z.object({
  query: paginationSchema.extend({
    search: z.string().optional(),
    wardId: z.string().uuid().optional(),
    roomType: roomTypeEnum.optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const roomIdParamSchema = idParamSchema;

// ─── Beds ──────────────────────────────────────────────────────────────────────

const bedTypeEnum = z.enum(['standard', 'electric', 'icu', 'pediatric', 'bariatric']);
const bedStatusEnum = z.enum(['available', 'occupied', 'maintenance', 'reserved']);

export const createBedSchema = z.object({
  body: z.object({
    roomId: z.string().uuid('Invalid room ID'),
    bedNumber: z.string().min(1, 'Bed number is required').max(20),
    bedType: bedTypeEnum.optional(),
    status: bedStatusEnum.default('available'),
  }),
});

export const updateBedSchema = z.object({
  body: z.object({
    roomId: z.string().uuid('Invalid room ID').optional(),
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
    roomId: z.string().uuid().optional(),
    wardId: z.string().uuid().optional(),
    bedType: bedTypeEnum.optional(),
    status: bedStatusEnum.optional(),
  }),
});

export const bedAvailabilitySchema = z.object({
  query: z.object({
    wardId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
  }),
});

export const bedIdParamSchema = idParamSchema;

// ─── Exported Types ────────────────────────────────────────────────────────────

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>['body'];
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>['body'];
export type ListDepartmentsQuery = z.infer<typeof listDepartmentsSchema>['query'];

export type CreateWardInput = z.infer<typeof createWardSchema>['body'];
export type UpdateWardInput = z.infer<typeof updateWardSchema>['body'];
export type ListWardsQuery = z.infer<typeof listWardsSchema>['query'];

export type CreateRoomInput = z.infer<typeof createRoomSchema>['body'];
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>['body'];
export type ListRoomsQuery = z.infer<typeof listRoomsSchema>['query'];

export type CreateBedInput = z.infer<typeof createBedSchema>['body'];
export type UpdateBedInput = z.infer<typeof updateBedSchema>['body'];
export type ListBedsQuery = z.infer<typeof listBedsSchema>['query'];
export type BedAvailabilityQuery = z.infer<typeof bedAvailabilitySchema>['query'];
