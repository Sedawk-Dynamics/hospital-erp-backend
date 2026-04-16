import { Response, NextFunction } from 'express';
import { usersService } from './users.service';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import { AuthenticatedRequest } from '../../shared/types';
import { AppError } from '../../shared/appError';
import { paginationSchema } from '../../shared/pagination';

export const usersController = {
  // ─── USER CRUD ───────────────────────────────────────────────────────

  async create(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const user = await usersService.create(req.user.tenantId, req.body);
      sendResponse({
        res,
        statusCode: 201,
        message: 'User created successfully',
        data: user,
      });
    } catch (err) {
      next(err);
    }
  },

  async findAll(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const query = paginationSchema.parse(req.query);
      const { users, total, page, limit } = await usersService.findAll(req.user.tenantId, {
        ...query,
        roleId: req.query.roleId as string | undefined,
        isActive: req.query.isActive as string | undefined,
      });
      sendPaginatedResponse(res, users, total, page, limit, 'Users retrieved successfully');
    } catch (err) {
      next(err);
    }
  },

  /**
   * Look up users by phone or email — used by the front-desk to find an existing
   * account-holder before registering a new family-member patient profile under them.
   * Searches across ALL tenants because patients typically sign up on the platform
   * tenant while front-desk operates in a hospital tenant.
   */
  async findByContact(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const phone = (req.query.phone as string | undefined)?.trim();
      const email = (req.query.email as string | undefined)?.trim();
      if (!phone && !email) {
        sendResponse({ res, statusCode: 400, message: 'phone or email query param is required' });
        return;
      }
      const users = await usersService.findByContact({ phone, email });
      sendResponse({ res, message: 'Users matching contact', data: users });
    } catch (err) {
      next(err);
    }
  },

  /** List all users across all hospital tenants (super_admin only) */
  async findAllGlobal(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const query = paginationSchema.parse(req.query);
      const { users, total, page, limit } = await usersService.findAllGlobal({
        ...query,
        roleId: req.query.roleId as string | undefined,
        isActive: req.query.isActive as string | undefined,
      });
      sendPaginatedResponse(res, users, total, page, limit, 'All users retrieved successfully');
    } catch (err) {
      next(err);
    }
  },

  /** Hard-delete a user (super_admin, any tenant) */
  async hardDeleteGlobal(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const result = await usersService.hardDeleteGlobal(req.params.id as string, req.user.userId);
      sendResponse({
        res,
        message: result.message,
      });
    } catch (err) {
      next(err);
    }
  },

  /** Toggle active status for a user (super_admin, any tenant) */
  async toggleActiveGlobal(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const { isActive } = req.body;
      const user = await usersService.toggleActiveGlobal(req.params.id as string, isActive);
      sendResponse({
        res,
        message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
        data: user,
      });
    } catch (err) {
      next(err);
    }
  },

  async findById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const user = await usersService.findById(req.user.tenantId, req.params.id as string);
      sendResponse({
        res,
        message: 'User retrieved successfully',
        data: user,
      });
    } catch (err) {
      next(err);
    }
  },

  async update(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const user = await usersService.update(req.user.tenantId, req.params.id as string, req.body);
      sendResponse({
        res,
        message: 'User updated successfully',
        data: user,
      });
    } catch (err) {
      next(err);
    }
  },

  async deactivate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const user = await usersService.deactivate(req.user.tenantId, req.params.id as string);
      sendResponse({
        res,
        message: 'User deactivated successfully',
        data: user,
      });
    } catch (err) {
      next(err);
    }
  },

  async getStats(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const stats = await usersService.getStats(req.user.tenantId);
      sendResponse({
        res,
        message: 'User stats retrieved successfully',
        data: stats,
      });
    } catch (err) {
      next(err);
    }
  },

  // ─── TENANT-SCOPED (SUPER ADMIN) ─────────────────────────────────

  async findAllForTenant(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const tenantId = req.params.tenantId as string;
      const query = paginationSchema.parse(req.query);
      const { users, total, page, limit } = await usersService.findAll(tenantId, {
        ...query,
        roleId: req.query.roleId as string | undefined,
        isActive: req.query.isActive as string | undefined,
      });
      sendPaginatedResponse(res, users, total, page, limit, 'Users retrieved successfully');
    } catch (err) {
      next(err);
    }
  },

  async createForTenant(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const tenantId = req.params.tenantId as string;
      const user = await usersService.create(tenantId, req.body);
      sendResponse({
        res,
        statusCode: 201,
        message: 'User created successfully',
        data: user,
      });
    } catch (err) {
      next(err);
    }
  },

  async getRolesForTenant(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const tenantId = req.params.tenantId as string;
      const roles = await usersService.getRoles(tenantId);
      sendResponse({
        res,
        message: 'Roles retrieved successfully',
        data: roles,
      });
    } catch (err) {
      next(err);
    }
  },

  async getStatsForTenant(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const tenantId = req.params.tenantId as string;
      const stats = await usersService.getStats(tenantId);
      sendResponse({
        res,
        message: 'User stats retrieved successfully',
        data: stats,
      });
    } catch (err) {
      next(err);
    }
  },

  // ─── ROLE ASSIGNMENT ────────────────────────────────────────────────

  async assignRole(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const userRole = await usersService.assignRole(req.params.id as string, req.body);
      sendResponse({
        res,
        statusCode: 201,
        message: 'Role assigned successfully',
        data: userRole,
      });
    } catch (err) {
      next(err);
    }
  },

  async removeRole(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const result = await usersService.removeRole(req.params.id as string, req.params.roleId as string);
      sendResponse({
        res,
        message: result.message,
      });
    } catch (err) {
      next(err);
    }
  },

  // ─── ROLES CRUD ─────────────────────────────────────────────────────

  async getRoles(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const roles = await usersService.getRoles(req.user.tenantId);
      sendResponse({
        res,
        message: 'Roles retrieved successfully',
        data: roles,
      });
    } catch (err) {
      next(err);
    }
  },

  async createRole(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const role = await usersService.createRole(req.user.tenantId, req.body);
      sendResponse({
        res,
        statusCode: 201,
        message: 'Role created successfully',
        data: role,
      });
    } catch (err) {
      next(err);
    }
  },

  async updateRole(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const role = await usersService.updateRole(req.user.tenantId, req.params.id as string, req.body);
      sendResponse({
        res,
        message: 'Role updated successfully',
        data: role,
      });
    } catch (err) {
      next(err);
    }
  },

  // ─── PERMISSIONS ────────────────────────────────────────────────────

  async getPermissions(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const permissions = await usersService.getPermissions();
      sendResponse({
        res,
        message: 'Permissions retrieved successfully',
        data: permissions,
      });
    } catch (err) {
      next(err);
    }
  },

  async assignPermissions(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw AppError.unauthorized();
      const role = await usersService.assignPermissionsToRole(req.params.id as string, req.body);
      sendResponse({
        res,
        message: 'Permissions assigned successfully',
        data: role,
      });
    } catch (err) {
      next(err);
    }
  },
};
