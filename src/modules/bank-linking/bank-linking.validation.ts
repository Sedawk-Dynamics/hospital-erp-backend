import { z } from 'zod';

export const linkBankAccountSchema = z.object({
  body: z.object({
    accountHolderName: z.string().min(2).max(120),
    accountNumber: z.string().min(9).max(18).regex(/^\d+$/, 'Account number must be numeric'),
    confirmAccountNumber: z.string(),
    ifscCode: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC code format'),
    bankName: z.string().min(2).max(100),
    panNumber: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN number format'),
    gstNumber: z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/, 'Invalid GST number format').optional().or(z.literal('')),
    businessType: z.enum(['individual', 'proprietorship', 'partnership', 'private_limited', 'public_limited', 'trust', 'society', 'ngo']).default('individual'),
    legalBusinessName: z.string().min(2).max(200),
  }).refine((data) => data.accountNumber === data.confirmAccountNumber, {
    message: 'Account numbers do not match',
    path: ['confirmAccountNumber'],
  }),
});

export type LinkBankAccountInput = z.infer<typeof linkBankAccountSchema>['body'];
