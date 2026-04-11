import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import { paginationSchema } from '../../shared/pagination';
import { AppError } from '../../shared/appError';
import {
  systemFormsService,
  hospitalFormConfigService,
  formSubmissionsService,
} from './forms.service';

function tenantOf(req: AuthenticatedRequest): string {
  const t = req.user?.tenantId;
  if (!t) throw AppError.unauthorized('Missing tenant context');
  return t;
}

// ════════════════════════════════════════════════════════════════
//   System Forms Controller
// ════════════════════════════════════════════════════════════════

export const systemFormsController = {
  /** List all system forms (optionally with hospital config overlay) */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const query = paginationSchema.parse(req.query);
      const category = req.query.category as string | undefined;
      const trigger = req.query.trigger as string | undefined;
      const tenantId = (req.query.tenantId as string) || req.user?.tenantId;
      const result = await systemFormsService.list({ ...query, category, trigger, tenantId });
      sendPaginatedResponse(res, result.forms, result.total, result.page, result.limit, 'System forms retrieved');
    } catch (err) {
      next(err);
    }
  },

  /** Get a single system form by slug id */
  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const id = req.params.id as string;
      const form = await systemFormsService.getById(id, tenantId);
      sendResponse({ res, data: form, message: 'System form retrieved' });
    } catch (err) {
      next(err);
    }
  },

  /** Super admin: update schema, name, description, toggle, defaultRoleSettings */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const form = await systemFormsService.update(id, req.body);
      sendResponse({ res, data: form, message: 'System form updated' });
    } catch (err) {
      next(err);
    }
  },

  /** Resolve forms for a workflow trigger (respects hospital config + user role) */
  async getForTrigger(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const trigger = req.params.trigger as string;
      const tenantId = (req.query.tenantId as string) || req.user?.tenantId;
      const userRole = (req.user?.roles && req.user.roles[0]) || undefined;
      const forms = await systemFormsService.getForTrigger(trigger, tenantId, userRole);
      sendResponse({ res, data: forms, message: 'Trigger forms resolved' });
    } catch (err) {
      next(err);
    }
  },

  /** Get pending (unfilled required) forms for a context */
  async getPending(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const trigger = req.query.trigger as string;
      if (!trigger) throw AppError.badRequest('trigger query parameter is required');
      const tenantId = (req.query.tenantId as string) || req.user?.tenantId;
      const userRole = (req.user?.roles && req.user.roles[0]) || undefined;
      const pending = await systemFormsService.getPendingForContext({
        trigger,
        tenantId,
        userRole,
        appointmentId: req.query.appointmentId as string | undefined,
        admissionId: req.query.admissionId as string | undefined,
        visitId: req.query.visitId as string | undefined,
        patientId: req.query.patientId as string | undefined,
      });
      sendResponse({ res, data: pending, message: 'Pending forms retrieved' });
    } catch (err) {
      next(err);
    }
  },

  /** All forms current user can fill (Staff Forms Inbox) */
  async getAvailableForMe(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = (req.query.tenantId as string) || tenantOf(req);
      const userRole = (req.user?.roles && req.user.roles[0]) || 'admin';
      const forms = await systemFormsService.listAvailableForUser(tenantId, userRole);
      sendResponse({ res, data: forms, message: 'Available forms retrieved' });
    } catch (err) {
      next(err);
    }
  },
};

// ════════════════════════════════════════════════════════════════
//   Hospital Form Config Controller
// ════════════════════════════════════════════════════════════════

export const hospitalFormConfigController = {
  /** List all system forms with this hospital's config */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = tenantOf(req);
      const result = await hospitalFormConfigService.getAll(tenantId);
      sendResponse({ res, data: result, message: 'Hospital form configs retrieved' });
    } catch (err) {
      next(err);
    }
  },

  /** Upsert config for a form */
  async upsert(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = tenantOf(req);
      const config = await hospitalFormConfigService.upsert(tenantId, req.body);
      sendResponse({ res, data: config, message: 'Hospital form config saved' });
    } catch (err) {
      next(err);
    }
  },

  /** Update config by formId */
  async update(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = tenantOf(req);
      const formId = req.params.formId as string;
      const config = await hospitalFormConfigService.update(tenantId, formId, req.body);
      sendResponse({ res, data: config, message: 'Hospital form config updated' });
    } catch (err) {
      next(err);
    }
  },
};

// ════════════════════════════════════════════════════════════════
//   Form Submissions Controller
// ════════════════════════════════════════════════════════════════

export const formSubmissionsController = {
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = tenantOf(req);
      const query = paginationSchema.parse(req.query);
      const userRole = (req.user!.roles && req.user!.roles[0]) || undefined;
      const isAdmin = userRole === 'admin' || userRole === 'super_admin';
      const filters = {
        formId: req.query.formId as string | undefined,
        patientId: req.query.patientId as string | undefined,
        appointmentId: req.query.appointmentId as string | undefined,
        status: req.query.status as string | undefined,
        trigger: req.query.trigger as string | undefined,
        viewerRole: isAdmin ? undefined : userRole,
      };
      const result = await formSubmissionsService.list(tenantId, { ...query, ...filters });
      sendPaginatedResponse(res, result.submissions, result.total, result.page, result.limit, 'Submissions retrieved');
    } catch (err) {
      next(err);
    }
  },

  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = tenantOf(req);
      const submission = await formSubmissionsService.getById(tenantId, req.params.id as string);
      sendResponse({ res, data: submission, message: 'Submission retrieved' });
    } catch (err) {
      next(err);
    }
  },

  async create(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const fallbackTenantId = req.user?.tenantId;
      const submission = await formSubmissionsService.create(fallbackTenantId, req.body, req.user?.userId);
      sendResponse({ res, statusCode: 201, data: submission, message: 'Form submitted' });
    } catch (err) {
      next(err);
    }
  },

  async update(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = tenantOf(req);
      const submission = await formSubmissionsService.update(tenantId, req.params.id as string, req.body, req.user?.userId);
      sendResponse({ res, data: submission, message: 'Submission updated' });
    } catch (err) {
      next(err);
    }
  },

  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = tenantOf(req);
      await formSubmissionsService.delete(tenantId, req.params.id as string);
      sendResponse({ res, message: 'Submission deleted' });
    } catch (err) {
      next(err);
    }
  },
};
