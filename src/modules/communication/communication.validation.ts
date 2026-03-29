import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// ============================================================
// Notifications
// ============================================================

export const createNotificationSchema = z.object({
  body: z.object({
    userId: z.string().uuid('Invalid user ID'),
    title: z.string().min(1, 'Title is required').max(255),
    message: z.string().min(1, 'Message is required'),
    notificationType: z.enum([
      'appointment',
      'lab_result',
      'prescription',
      'billing',
      'system',
      'ticket',
      'alert',
      'general',
    ]),
    channel: z.enum(['in_app', 'sms', 'email', 'push']).default('in_app'),
    referenceType: z.string().max(50).optional(),
    referenceId: z.string().optional(),
  }),
});

export const getNotificationsQuerySchema = z.object({
  query: paginationSchema.extend({
    isRead: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    notificationType: z
      .enum([
        'appointment',
        'lab_result',
        'prescription',
        'billing',
        'system',
        'ticket',
        'alert',
        'general',
      ])
      .optional(),
  }),
});

export const notificationIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid notification ID'),
  }),
});

// ============================================================
// Messages
// ============================================================

export const sendMessageSchema = z.object({
  body: z.object({
    receiverId: z.string().uuid('Invalid receiver ID'),
    subject: z.string().max(255).optional(),
    content: z.string().min(1, 'Message content is required'),
    parentMessageId: z.string().uuid('Invalid parent message ID').optional(),
  }),
});

export const getMessagesQuerySchema = z.object({
  query: paginationSchema.extend({
    isRead: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const messageIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid message ID'),
  }),
});

export const conversationUserParamSchema = z.object({
  params: z.object({
    userId: z.string().uuid('Invalid user ID'),
  }),
  query: paginationSchema,
});

// ============================================================
// Shift Handover Notes
// ============================================================

export const createHandoverSchema = z.object({
  body: z.object({
    toNurseId: z.string().uuid('Invalid target nurse ID').optional(),
    wardId: z.string().uuid('Invalid ward ID'),
    shiftDate: z.string().refine((val) => !isNaN(Date.parse(val)), {
      message: 'Invalid shift date',
    }),
    shiftType: z.enum(['morning', 'afternoon', 'night']),
    content: z.string().min(1, 'Content is required'),
    patientStatuses: z.any().optional(),
    outstandingTasks: z.any().optional(),
  }),
});

export const getHandoversQuerySchema = z.object({
  query: paginationSchema.extend({
    wardId: z.string().uuid().optional(),
    shiftType: z.enum(['morning', 'afternoon', 'night']).optional(),
    shiftDate: z.string().optional(),
    isAcknowledged: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const handoverIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid handover ID'),
  }),
});

export const addHandoverNoteSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid handover ID'),
  }),
  body: z.object({
    content: z.string().min(1, 'Note content is required'),
    patientStatuses: z.any().optional(),
    outstandingTasks: z.any().optional(),
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
    description: z.string().max(5000).optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
    patientId: z.string().uuid('Invalid patient ID').optional(),
    departmentId: z.string().uuid('Invalid department ID').optional(),
    assignedTo: z.string().uuid('Invalid assignee ID').optional(),
  }),
});

export const getTicketsQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['open', 'in_progress', 'pending', 'resolved', 'closed', 'escalated']).optional(),
    ticketType: z.enum([
      'appointment_request',
      'op_to_ip',
      'complaint',
      'service_request',
      'equipment_fault',
      'general',
    ]).optional(),
    raisedBy: z.string().uuid().optional(),
    assignedTo: z.string().uuid().optional(),
  }),
});

export const ticketIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid ticket ID'),
  }),
});

// ============================================================
// Inferred types
// ============================================================

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>['body'];
export type GetNotificationsQuery = z.infer<typeof getNotificationsQuerySchema>['query'];
export type SendMessageInput = z.infer<typeof sendMessageSchema>['body'];
export type GetMessagesQuery = z.infer<typeof getMessagesQuerySchema>['query'];
export type ConversationQuery = z.infer<typeof conversationUserParamSchema>['query'];
export type CreateHandoverInput = z.infer<typeof createHandoverSchema>['body'];
export type GetHandoversQuery = z.infer<typeof getHandoversQuerySchema>['query'];
export type AddHandoverNoteInput = z.infer<typeof addHandoverNoteSchema>['body'];

export type CreateTicketInput = z.infer<typeof createTicketSchema>['body'];
export type GetTicketsQuery = z.infer<typeof getTicketsQuerySchema>['query'];
