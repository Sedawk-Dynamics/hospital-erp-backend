import { z } from 'zod';

export const createUserSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password must not exceed 128 characters'),
    firstName: z.string().min(1, 'First name is required').max(100),
    lastName: z.string().min(1, 'Last name is required').max(100),
    phone: z.string().optional(),
    roleIds: z.array(z.string().uuid()).min(1, 'At least one role is required'),
  }),
});

export const updateUserSchema = z.object({
  body: z.object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    phone: z.string().optional(),
    email: z.string().email().optional(),
    isActive: z.boolean().optional(),
    roleIds: z.array(z.string().uuid()).min(1).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid user ID'),
  }),
});

export const assignRoleSchema = z.object({
  body: z.object({
    roleId: z.string().uuid('Invalid role ID'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid user ID'),
  }),
});

export const removeRoleParamsSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid user ID'),
    roleId: z.string().uuid('Invalid role ID'),
  }),
});

export const createRoleSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Role name is required').max(100),
    slug: z
      .string()
      .min(1, 'Slug is required')
      .max(100)
      .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with underscores'),
    description: z.string().max(500).optional(),
    isSystem: z.boolean().default(false),
  }),
});

export const updateRoleSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid role ID'),
  }),
});

export const assignPermissionsSchema = z.object({
  body: z.object({
    permissionIds: z.array(z.string().uuid('Invalid permission ID')).min(1, 'At least one permission is required'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid role ID'),
  }),
});

export const userIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid user ID'),
  }),
});

export type CreateUserInput = z.infer<typeof createUserSchema>['body'];
export type UpdateUserInput = z.infer<typeof updateUserSchema>['body'];
export type AssignRoleInput = z.infer<typeof assignRoleSchema>['body'];
export type CreateRoleInput = z.infer<typeof createRoleSchema>['body'];
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>['body'];
export type AssignPermissionsInput = z.infer<typeof assignPermissionsSchema>['body'];
