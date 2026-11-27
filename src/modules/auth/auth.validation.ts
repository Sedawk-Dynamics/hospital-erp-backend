import { z } from 'zod';

export const registerSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password must not exceed 128 characters')
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/,
        'Password must contain uppercase, lowercase, number, and special character',
      ),
    firstName: z.string().min(1, 'First name is required').max(100),
    lastName: z.string().min(1, 'Last name is required').max(100),
    tenantSlug: z.string().optional(),
    phone: z.string().optional(),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
    twoFactorCode: z.string().length(6).optional(),
  }),
});

// ── Patient phone-OTP auth ───────────────────────────────────
// Patients sign in / sign up with just their phone number + a one-time code.
// The code is random, single use, and sent by SMS / WhatsApp or email.
export const requestOtpSchema = z.object({
  body: z.object({
    phone: z.string().min(7, 'Enter a valid phone number').max(20),
    // What the code is for; the same value must come back with it on verify.
    intent: z.enum(['login', 'signup']).optional(),
  }),
});

export const verifyOtpSchema = z.object({
  body: z.object({
    phone: z.string().min(7, 'Enter a valid phone number').max(20),
    otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
    // Only for an account with two-factor sign-in on (the server asks for it).
    twoFactorCode: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app').optional(),
    // Separate patient flows: 'login' must find an existing account (never
    // creates one), 'signup' must NOT find one (creates it). Omitted → allow both.
    intent: z.enum(['login', 'signup']).optional(),
    // Collected only when the number has no account yet (new patient signup).
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().max(100).optional(),
    gender: z.enum(['male', 'female', 'other']).optional(),
    dateOfBirth: z.string().optional(),
    tenantSlug:z.string().optional()
  }),
});

// Patient device PIN (see patient-pin.service.ts). The PIN is a 6-digit string.
const pin = z.string().regex(/^\d{6}$/, 'Enter a 6-digit PIN');
const deviceToken = z.string().min(20, 'Invalid device').max(128, 'Invalid device');

export const pinLoginSchema = z.object({
  body: z.object({
    deviceToken,
    pin,
    twoFactorCode: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app').optional(),
  }),
});

export const setPinSchema = z.object({
  body: z.object({
    pin,
    // One of these proves a one-time code was just used.
    setupToken: z.string().min(20).max(128).optional(),
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code').optional(),
    // This device's previous token, when it already had a PIN.
    deviceToken: deviceToken.optional(),
  }),
});

export const changePinSchema = z.object({
  body: z.object({ deviceToken, currentPin: pin, newPin: pin }),
});

export const pinDeviceIdSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid device') }),
});

export const refreshTokenSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, 'Refresh token is required'),
  }),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Reset token is required'),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(128, 'Password must not exceed 128 characters')
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/,
        'Password must contain uppercase, lowercase, number, and special character',
      ),
  }),
});

/**
 * Gap 297: change your own password from My Account. Same strength rule as a
 * reset; the current password is required so an unattended session cannot be
 * used to take the account over.
 */
export const changePasswordSchema = z.object({
  body: z
    .object({
      currentPassword: z.string().min(1, 'Current password is required'),
      newPassword: z
        .string()
        .min(8, 'Password must be at least 8 characters')
        .max(128, 'Password must not exceed 128 characters')
        .regex(
          /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#])/,
          'Password must contain uppercase, lowercase, number, and special character',
        ),
    })
    .refine((b) => b.newPassword !== b.currentPassword, {
      message: 'New password must be different from the current one',
      path: ['newPassword'],
    }),
});

export const setup2FASchema = z.object({});

export const verify2FASchema = z.object({
  body: z.object({
    code: z.string().length(6, 'TOTP code must be 6 digits'),
  }),
});

/** Gap 297: turning 2FA off needs the password AND a current code. */
export const disable2FASchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
  }),
});

/** Gap 297: change your phone with a one-time code (service checks the format). */
export const requestPhoneChangeSchema = z.object({
  body: z.object({
    phone: z.string().min(10, 'Enter a valid 10-digit mobile number').max(20),
  }),
});

export const verifyPhoneChangeSchema = z.object({
  body: z.object({
    phone: z.string().min(10, 'Enter a valid 10-digit mobile number').max(20),
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  }),
});

export const registerAdminSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters').max(128),
    firstName: z.string().min(1, 'First name is required').max(100),
    lastName: z.string().min(1, 'Last name is required').max(100),
    phone: z.string().optional(),
  }),
});

export type RequestOtpInput = z.infer<typeof requestOtpSchema>['body'];
export type PinLoginInput = z.infer<typeof pinLoginSchema>['body'];
export type SetPinInput = z.infer<typeof setPinSchema>['body'];
export type ChangePinInput = z.infer<typeof changePinSchema>['body'];
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>['body'];
export type RegisterInput = z.infer<typeof registerSchema>['body'];
export type RegisterAdminInput = z.infer<typeof registerAdminSchema>['body'];
export type LoginInput = z.infer<typeof loginSchema>['body'];
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>['body'];
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>['body'];
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>['body'];
export type Verify2FAInput = z.infer<typeof verify2FASchema>['body'];

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>['body'];
export type Disable2FAInput = z.infer<typeof disable2FASchema>['body'];
export type RequestPhoneChangeInput = z.infer<typeof requestPhoneChangeSchema>['body'];
export type VerifyPhoneChangeInput = z.infer<typeof verifyPhoneChangeSchema>['body'];
