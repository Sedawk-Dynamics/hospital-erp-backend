import { Router } from 'express';
import { authController } from './auth.controller';
import { patientPinController } from './patient-pin.controller';
import { authenticate } from '../../middleware/authenticate';
import {
  authLimiter,
  sensitiveAuthLimiter,
  refreshLimiter,
  loginAttemptGuard,
} from '../../middleware/rateLimiter';
import { validate } from '../../middleware/validate';
import {
  registerSchema,
  loginSchema,
  requestOtpSchema,
  verifyOtpSchema,
  refreshTokenSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verify2FASchema,
  changePasswordSchema,
  disable2FASchema,
  requestPhoneChangeSchema,
  verifyPhoneChangeSchema,
  pinLoginSchema,
  setPinSchema,
  changePinSchema,
  pinDeviceIdSchema,
} from './auth.validation';

const router = Router();

// Registration — per-IP limiter (30 / 15 min). Credential-stuffing guard.
router.post('/register', authLimiter, validate(registerSchema), authController.register);

// Login — two independent limiters:
//   1. authLimiter      per-IP (bursts from one location)
//   2. loginAttemptGuard per-email (slow attacks rotating IPs)
router.post(
  '/login',
  authLimiter,
  loginAttemptGuard,
  validate(loginSchema),
  authController.login,
);

// Patient phone-OTP auth — per-IP limiter, same as login. Per-phone limits
// (resend cooldown, sends per hour/day, wrong-code lockout) are in the service.
router.post('/otp/request', authLimiter, validate(requestOtpSchema), authController.requestOtp);
router.post('/otp/verify', authLimiter, validate(verifyOtpSchema), authController.verifyOtp);

// Patient device PIN — per-IP limiter here, 5 attempts per device in the service.
router.post('/pin/login', authLimiter, validate(pinLoginSchema), patientPinController.login);
router.get('/me/pin/devices', authenticate, patientPinController.listDevices);
router.post('/me/pin/code', authLimiter, authenticate, patientPinController.requestSetupCode);
router.post('/me/pin', authLimiter, authenticate, validate(setPinSchema), patientPinController.setPin);
router.put('/me/pin', authLimiter, authenticate, validate(changePinSchema), patientPinController.changePin);
router.delete('/me/pin/devices', authenticate, patientPinController.revokeAllDevices);
router.delete('/me/pin/devices/:id', authenticate, validate(pinDeviceIdSchema), patientPinController.revokeDevice);

// Refresh — looser limit; browsers can legitimately burst refreshes on tab wake.
router.post('/refresh', refreshLimiter, validate(refreshTokenSchema), authController.refresh);

router.post('/logout', authenticate, authController.logout);

// Password reset flows — very tight (10 / hour per IP) to prevent weaponization.
router.post('/forgot-password', sensitiveAuthLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', sensitiveAuthLimiter, validate(resetPasswordSchema), authController.resetPassword);

// 2FA — same tight budget; setup requires auth anyway but limit is still useful.
router.post('/2fa/setup', sensitiveAuthLimiter, authenticate, authController.setup2FA);
router.post('/2fa/verify', sensitiveAuthLimiter, authenticate, validate(verify2FASchema), authController.verify2FA);
// Turning 2FA off needs the password + a current code (gap 297).
router.post('/2fa/disable', sensitiveAuthLimiter, authenticate, validate(disable2FASchema), authController.disable2FA);

// Change own phone with a one-time code (My Account, gap 297).
router.post(
  '/me/phone/request',
  sensitiveAuthLimiter,
  authenticate,
  validate(requestPhoneChangeSchema),
  authController.requestPhoneChange,
);
router.post(
  '/me/phone/verify',
  sensitiveAuthLimiter,
  authenticate,
  validate(verifyPhoneChangeSchema),
  authController.verifyPhoneChange,
);

// Change own password (My Account, gap 297) — tight budget, it checks a password.
router.post(
  '/change-password',
  sensitiveAuthLimiter,
  authenticate,
  validate(changePasswordSchema),
  authController.changePassword,
);

router.get('/onboarding-status', authenticate, authController.getOnboardingStatus);
router.get('/me', authenticate, authController.getMe);
router.get('/me/doctor-profile', authenticate, authController.getMyDoctorProfile);

export { router as authRoutes };
