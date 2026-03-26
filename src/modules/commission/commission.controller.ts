import { Response, NextFunction } from 'express';
import { CommissionService } from './commission.service';
import { sendResponse } from '../../shared/apiResponse';
import { AuthenticatedRequest } from '../../shared/types';

export class CommissionController {
  private service = new CommissionService();

  getDefaultCommission = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const setting = await this.service.getDefaultCommission();
      sendResponse({
        res,
        message: 'Default commission retrieved',
        data: setting,
      });
    } catch (error) {
      next(error);
    }
  };

  updateDefaultCommission = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const setting = await this.service.updateDefaultCommission(req.body, req.user!.userId);
      sendResponse({
        res,
        message: 'Default commission updated',
        data: setting,
      });
    } catch (error) {
      next(error);
    }
  };

  listAllCommissions = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await this.service.listAllCommissions();
      sendResponse({
        res,
        message: 'All commissions retrieved',
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  getHospitalCommission = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.params.tenantId as string;
      const commissionPercent = await this.service.getCommissionForTenant(tenantId);
      sendResponse({
        res,
        message: 'Hospital commission retrieved',
        data: { tenantId, commissionPercent },
      });
    } catch (error) {
      next(error);
    }
  };

  setHospitalCommission = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.params.tenantId as string;
      const commission = await this.service.setHospitalCommission(
        tenantId,
        req.body,
        req.user!.userId,
      );
      sendResponse({
        res,
        message: 'Hospital commission updated',
        data: commission,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteHospitalCommission = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.params.tenantId as string;
      await this.service.deleteHospitalCommission(tenantId);
      sendResponse({
        res,
        message: 'Hospital commission override removed',
      });
    } catch (error) {
      next(error);
    }
  };
}
