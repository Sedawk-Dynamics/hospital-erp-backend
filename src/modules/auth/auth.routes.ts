import { Router } from 'express';
import { authController } from './auth.controller';
import { authenticate } from '../../middleware/authenticate';
import { authLimiter } from '../../middleware/rateLimiter';
import { validate } from '../../middleware/validate';
import {
  registerSchema,
  registerAdminSchema,
  loginSchema,
  refreshTokenSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verify2FASchema,
} from './auth.validation';

const router = Router();

router.post('/register', validate(registerSchema), authController.register);
// register-admin removed — hospital admins are now created via demo request approval
router.post('/login', authLimiter, validate(loginSchema), authController.login);
router.post('/refresh', validate(refreshTokenSchema), authController.refresh);
router.post('/logout', authenticate, authController.logout);
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);
router.post('/2fa/setup', authenticate, authController.setup2FA);
router.post('/2fa/verify', authenticate, validate(verify2FASchema), authController.verify2FA);
router.get('/onboarding-status', authenticate, authController.getOnboardingStatus);
router.get('/me', authenticate, authController.getMe);
router.get('/me/doctor-profile', authenticate, authController.getMyDoctorProfile);

export { router as authRoutes };
