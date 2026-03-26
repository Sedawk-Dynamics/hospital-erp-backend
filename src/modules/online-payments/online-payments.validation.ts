import { z } from 'zod';

export const createOnlineOrderSchema = z.object({
  body: z.object({
    billId: z.string().uuid('Invalid bill ID'),
  }),
});

export const verifyOnlinePaymentSchema = z.object({
  body: z.object({
    razorpay_order_id: z.string().min(1),
    razorpay_payment_id: z.string().min(1),
    razorpay_signature: z.string().min(1),
  }),
});

export type CreateOnlineOrderInput = z.infer<typeof createOnlineOrderSchema>['body'];
export type VerifyOnlinePaymentInput = z.infer<typeof verifyOnlinePaymentSchema>['body'];
