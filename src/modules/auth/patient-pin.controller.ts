import { NextFunction, Response } from 'express';
import { sendResponse } from '../../shared/apiResponse';
import { AppError } from '../../shared/appError';
import { AuthenticatedRequest } from '../../shared/types';
import { signInFailure } from './auth.controller';
import { patientPinService } from './patient-pin.service';

type Handler = (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>;

/** A signed-in handler: the caller's own user id, errors to the error handler. */
function forMe(run: (userId: string, req: AuthenticatedRequest) => Promise<{ message: string; data: unknown }>): Handler {
  return async (req, res, next) => {
    try {
      if (!req.user) throw AppError.unauthorized();
      const { message, data } = await run(req.user.userId, req);
      sendResponse({ res, message, data });
    } catch (err) {
      next(err);
    }
  };
}

export const patientPinController = {
  login: (async (req, res, next) => {
    try {
      sendResponse({ res, message: 'Login successful', data: await patientPinService.login(req.body) });
    } catch (err) {
      next(signInFailure(err, 'patient-pin'));
    }
  }) as Handler,

  listDevices: forMe(async (userId) => ({
    message: 'Devices retrieved',
    data: await patientPinService.listDevices(userId),
  })),

  requestSetupCode: forMe(async (userId) => ({
    message: 'Verification code sent',
    data: await patientPinService.requestSetupCode(userId),
  })),

  setPin: forMe(async (userId, req) => ({
    message: 'PIN set for this device',
    data: await patientPinService.setPin(userId, req.body),
  })),

  changePin: forMe(async (userId, req) => {
    const result = await patientPinService.changePin(userId, req.body);
    return { message: result.message, data: null };
  }),

  revokeDevice: forMe(async (userId, req) => {
    const result = await patientPinService.revokeDevice(userId, req.params.id as string);
    return { message: result.message, data: null };
  }),

  revokeAllDevices: forMe(async (userId) => {
    const result = await patientPinService.revokeAllDevices(userId);
    return { message: result.message, data: { count: result.count } };
  }),
};
