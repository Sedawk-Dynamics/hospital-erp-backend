import { z } from 'zod';

export const submitDemoRequestSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Name is required').max(120),
    email: z.string().email('Invalid email address'),
    phone: z.string().min(7, 'Phone is required').max(20),
    hospitalName: z.string().min(2, 'Hospital/clinic name is required').max(255),
    designation: z.string().min(2, 'Designation is required').max(100),
    city: z.string().min(2, 'City is required').max(100),
    message: z.string().min(2, 'Message is required').max(2000),
  }),
});

export const approveDemoRequestSchema = z.object({
  body: z.object({
    trialDays: z.number().int().min(1).max(365).default(14),
    planId: z.string().uuid('Invalid plan ID'),
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  }),
  params: z.object({
    id: z.string().uuid('Invalid demo request ID'),
  }),
});

export const rejectDemoRequestSchema = z.object({
  body: z.object({
    rejectionNote: z.string().max(1000).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid demo request ID'),
  }),
});

export const endTrialSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid demo request ID'),
  }),
});

export const deleteDemoRequestSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid demo request ID'),
  }),
});

export type SubmitDemoRequestInput = z.infer<typeof submitDemoRequestSchema>['body'];
export type ApproveDemoRequestInput = z.infer<typeof approveDemoRequestSchema>['body'];
