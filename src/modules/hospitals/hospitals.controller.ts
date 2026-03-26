import { Response, NextFunction } from 'express';
import { hospitalsService } from './hospitals.service';
import { sendResponse } from '../../shared/apiResponse';
import { AuthenticatedRequest } from '../../shared/types';

export const hospitalsController = {
  createHospital: async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const hospital = await hospitalsService.createHospital(req.user!.userId, req.body);
      sendResponse({
        res,
        statusCode: 201,
        message: 'Hospital created successfully',
        data: hospital,
      });
    } catch (error) {
      next(error);
    }
  },

  listMyHospitals: async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const hospitals = await hospitalsService.listMyHospitals(req.user!.userId);
      sendResponse({
        res,
        message: 'Hospitals retrieved successfully',
        data: hospitals,
      });
    } catch (error) {
      next(error);
    }
  },

  getMyHospital: async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const hospital = await hospitalsService.getMyHospital(
        req.user!.userId,
        req.params.id as string,
      );
      sendResponse({
        res,
        message: 'Hospital retrieved successfully',
        data: hospital,
      });
    } catch (error) {
      next(error);
    }
  },

  switchHospital: async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await hospitalsService.switchHospital(
        req.user!.userId,
        req.params.tenantId as string,
      );
      sendResponse({
        res,
        message: 'Switched to hospital successfully',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  },

  getHospitalLimit: async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const limit = await hospitalsService.getHospitalLimit(req.user!.userId);
      sendResponse({
        res,
        message: 'Hospital limit retrieved successfully',
        data: limit,
      });
    } catch (error) {
      next(error);
    }
  },

  updateMyHospital: async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const hospital = await hospitalsService.updateMyHospital(
        req.user!.userId,
        req.params.id as string,
        req.body,
      );
      sendResponse({
        res,
        message: 'Hospital updated successfully',
        data: hospital,
      });
    } catch (error) {
      next(error);
    }
  },
};
