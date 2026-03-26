import { Response, NextFunction } from 'express';
import { tenantsService } from './tenants.service';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import { AuthenticatedRequest } from '../../shared/types';
import { paginationSchema } from '../../shared/pagination';

export const tenantsController = {
  async create(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenant = await tenantsService.create(req.body);
      sendResponse({
        res,
        statusCode: 201,
        message: 'Tenant created successfully',
        data: tenant,
      });
    } catch (err) {
      next(err);
    }
  },

  async findAll(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const query = paginationSchema.parse(req.query);
      const { tenants, total, page, limit } = await tenantsService.findAll(query);
      sendPaginatedResponse(res, tenants, total, page, limit, 'Tenants retrieved successfully');
    } catch (err) {
      next(err);
    }
  },

  async findById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenant = await tenantsService.findById(req.params.id as string);
      sendResponse({
        res,
        message: 'Tenant retrieved successfully',
        data: tenant,
      });
    } catch (err) {
      next(err);
    }
  },

  async update(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenant = await tenantsService.update(req.params.id as string, req.body);
      sendResponse({
        res,
        message: 'Tenant updated successfully',
        data: tenant,
      });
    } catch (err) {
      next(err);
    }
  },

  async deactivate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenant = await tenantsService.deactivate(req.params.id as string);
      sendResponse({
        res,
        message: 'Tenant deactivated successfully',
        data: tenant,
      });
    } catch (err) {
      next(err);
    }
  },

  async activate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenant = await tenantsService.activate(req.params.id as string);
      sendResponse({
        res,
        message: 'Tenant activated successfully',
        data: tenant,
      });
    } catch (err) {
      next(err);
    }
  },

  async hardDelete(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await tenantsService.hardDelete(req.params.id as string);
      sendResponse({
        res,
        message: result.message,
      });
    } catch (err) {
      next(err);
    }
  },

  async createSubscription(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const subscription = await tenantsService.createSubscription(req.params.id as string, req.body);
      sendResponse({
        res,
        statusCode: 201,
        message: 'Subscription created successfully',
        data: subscription,
      });
    } catch (err) {
      next(err);
    }
  },

  async bootstrapRoles(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      await tenantsService.bootstrapRolesAndPermissions(req.params.id as string);
      sendResponse({
        res,
        message: 'System roles and permissions bootstrapped successfully',
        data: null,
      });
    } catch (err) {
      next(err);
    }
  },

  async getComprehensiveStats(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const stats = await tenantsService.getComprehensiveStats(req.params.id as string);
      sendResponse({
        res,
        message: 'Hospital statistics retrieved successfully',
        data: stats,
      });
    } catch (err) {
      next(err);
    }
  },

  async updateFeatureToggle(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { featureKey, enabled, config } = req.body;
      const toggle = await tenantsService.updateFeatureToggle(
        req.params.id as string,
        featureKey,
        enabled,
        config,
      );
      sendResponse({
        res,
        message: 'Feature toggle updated successfully',
        data: toggle,
      });
    } catch (err) {
      next(err);
    }
  },
};
