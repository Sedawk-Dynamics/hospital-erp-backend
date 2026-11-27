import { Response, NextFunction } from 'express';
import { authService } from './auth.service';
import { sendResponse } from '../../shared/apiResponse';
import { AuthenticatedRequest } from '../../shared/types';
import { AppError } from '../../shared/appError';
import { logger } from '../../config/logger';

/**
 * Gap 371: a fault inside sign-in (database down, a bug in token issuing) used
 * to surface as a bare 500 "Internal server error" and blocked every login with
 * nothing in the UI to say it was not the user's password. Expected refusals
 * (AppError: bad password, locked, 2FA needed) and validation errors pass
 * through untouched; anything else is logged loudly and answered with a
 * controlled 503 the login page can explain.
 */
export function signInFailure(err: unknown, flow: string, identifier?: string): unknown {
  if (err instanceof AppError || (err as { name?: string })?.name === 'ZodError') return err;
  // Domain only — enough to spot a single tenant's outage without logging PII.
  const domain = identifier?.includes('@') ? identifier.split('@').pop() : undefined;
  logger.error({ err, flow, emailDomain: domain }, 'Sign-in failed unexpectedly');
  return new AppError(
    'Sign-in is temporarily unavailable. Try again in a few minutes.',
    503,
    'SIGNIN_UNAVAILABLE',
  );
}

export const authController = {
  async register(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const user = await authService.register(req.body);
      sendResponse({
        res,
        statusCode: 201,
        message: 'User registered successfully',
        data: user,
      });
    } catch (err) {
      next(err);
    }
  },

  async login(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await authService.login(req.body);
      sendResponse({
        res,
        message: 'Login successful',
        data: result,
      });
    } catch (err) {
      next(signInFailure(err, 'password', req.body?.email));
    }
  },

  // ── Patient phone-OTP auth ───────────────────────────────
  async requestOtp(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await authService.requestPhoneOtp(req.body);
      sendResponse({
        res,
        message: 'Verification code sent',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },

  async verifyOtp(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await authService.loginWithPhoneOtp(req.body);
      sendResponse({
        res,
        message: 'Login successful',
        data: result,
      });
    } catch (err) {
      next(signInFailure(err, 'phone-otp'));
    }
  },

  async refresh(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = req.body;
      const tokens = await authService.refreshToken(refreshToken);
      sendResponse({
        res,
        message: 'Token refreshed successfully',
        data: tokens,
      });
    } catch (err) {
      next(err);
    }
  },

  async logout(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized();
      }
      await authService.logout(req.user.userId);
      sendResponse({
        res,
        message: 'Logged out successfully',
      });
    } catch (err) {
      next(err);
    }
  },

  async forgotPassword(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await authService.forgotPassword(req.body);
      sendResponse({
        res,
        message: result.message,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },

  async resetPassword(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await authService.resetPassword(req.body);
      sendResponse({
        res,
        message: result.message,
      });
    } catch (err) {
      next(err);
    }
  },

  async setup2FA(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized();
      }
      const result = await authService.setup2FA(req.user.userId);
      sendResponse({
        res,
        message: '2FA setup initiated. Scan the QR code with your authenticator app.',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },

  async verify2FA(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized();
      }
      const result = await authService.verify2FA(req.user.userId, req.body, { tenantId: req.user.tenantId });
      sendResponse({
        res,
        message: result.message,
      });
    } catch (err) {
      next(err);
    }
  },

  async disable2FA(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized();
      }
      const result = await authService.disable2FA(req.user.userId, req.body, { tenantId: req.user.tenantId });
      sendResponse({ res, message: result.message, data: null });
    } catch (err) {
      next(err);
    }
  },

  async requestPhoneChange(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized();
      }
      // Says where the code went (masked); never contains the code.
      const result = await authService.requestPhoneChange(req.user.userId, req.body);
      sendResponse({ res, message: `Verification code sent to ${result.sentTo}`, data: result });
    } catch (err) {
      next(err);
    }
  },

  async verifyPhoneChange(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized();
      }
      const result = await authService.verifyPhoneChange(req.user.userId, req.body, {
        tenantId: req.user.tenantId,
      });
      sendResponse({ res, message: result.message, data: { phone: result.phone } });
    } catch (err) {
      next(err);
    }
  },

  async registerAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await authService.registerAdmin(req.body);
      sendResponse({
        res,
        statusCode: 201,
        message: 'Account created successfully',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },

  async getOnboardingStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized();
      }
      const result = await authService.getOnboardingStatus(req.user.userId, req.user.tenantId);
      sendResponse({
        res,
        message: 'Onboarding status retrieved',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },

  async changePassword(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized();
      }
      const result = await authService.changePassword(req.user.userId, req.body, { tenantId: req.user.tenantId });
      sendResponse({ res, message: result.message, data: null });
    } catch (err) {
      next(err);
    }
  },

  async getMe(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized();
      }
      const user = await authService.getMe(req.user.userId);
      sendResponse({
        res,
        message: 'User profile retrieved',
        data: user,
      });
    } catch (err) {
      next(err);
    }
  },

  async getMyDoctorProfile(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw AppError.unauthorized();
      }
      const { prisma } = await import('../../config/database');
      const profile = await prisma.doctorProfile.findFirst({
        where: { userId: req.user.userId, tenantId: req.user.tenantId },
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatarUrl: true },
          },
          department: { select: { id: true, name: true } },
          schedules: true,
        },
      });
      if (!profile) {
        throw AppError.notFound('Doctor profile not found for this user');
      }
      sendResponse({
        res,
        message: 'Doctor profile retrieved',
        data: profile,
      });
    } catch (err) {
      next(err);
    }
  },
};
