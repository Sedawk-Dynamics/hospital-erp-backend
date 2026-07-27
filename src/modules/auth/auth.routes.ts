import { Router } from 'express';
import { authController } from './auth.controller';
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

// Patient phone-OTP auth — per-IP limiter, same as login.
router.post('/otp/request', authLimiter, validate(requestOtpSchema), authController.requestOtp);
router.post('/otp/verify', authLimiter, validate(verifyOtpSchema), authController.verifyOtp);

// Refresh — looser limit; browsers can legitimately burst refreshes on tab wake.
router.post('/refresh', refreshLimiter, validate(refreshTokenSchema), authController.refresh);

router.post('/logout', authenticate, authController.logout);

// Password reset flows — very tight (10 / hour per IP) to prevent weaponization.
router.post('/forgot-password', sensitiveAuthLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', sensitiveAuthLimiter, validate(resetPasswordSchema), authController.resetPassword);

// 2FA — same tight budget; setup requires auth anyway but limit is still useful.
router.post('/2fa/setup', sensitiveAuthLimiter, authenticate, authController.setup2FA);
router.post('/2fa/verify', sensitiveAuthLimiter, authenticate, validate(verify2FASchema), authController.verify2FA);

router.get('/onboarding-status', authenticate, authController.getOnboardingStatus);
router.get('/me', authenticate, authController.getMe);
router.get('/me/doctor-profile', authenticate, authController.getMyDoctorProfile);

export { router as authRoutes };
