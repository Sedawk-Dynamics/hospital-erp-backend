import { Response, NextFunction } from 'express';
import { authService } from './auth.service';
import { sendResponse } from '../../shared/apiResponse';
import { AuthenticatedRequest } from '../../shared/types';
import { AppError } from '../../shared/appError';

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
      next(err);
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
      next(err);
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
      const result = await authService.verify2FA(req.user.userId, req.body);
      sendResponse({
        res,
        message: result.message,
      });
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
