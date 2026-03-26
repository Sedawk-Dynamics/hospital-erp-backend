import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse, sendPaginatedResponse } from '../../shared/apiResponse';
import { paginationSchema } from '../../shared/pagination';
import { demoRequestsService } from './demo-requests.service';

export const demoRequestsController = {
  /** POST /demo-requests — public */
  async submit(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await demoRequestsService.submit(req.body);
      sendResponse({
        res,
        statusCode: 201,
        message: 'Demo request submitted successfully. Our team will contact you shortly.',
        data: { id: result.id },
      });
    } catch (err) {
      next(err);
    }
  },

  /** GET /demo-requests — super_admin */
  async list(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const query = paginationSchema.parse(req.query);
      const status = req.query.status as string | undefined;
      const { requests, total, page, limit } = await demoRequestsService.list({
        ...query,
        status,
      });
      sendPaginatedResponse(res, requests, total, page, limit, 'Demo requests retrieved');
    } catch (err) {
      next(err);
    }
  },

  /** PATCH /demo-requests/:id/approve — super_admin */
  async approve(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await demoRequestsService.approve(
        req.params.id as string,
        req.user!.userId,
        req.body,
      );
      sendResponse({
        res,
        message: 'Demo request approved — hospital and trial account created',
        data: {
          demoRequest: result.demoRequest,
          hospital: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug },
          user: { id: result.user.id, email: result.user.email },
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /** PATCH /demo-requests/:id/reject — super_admin */
  async reject(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await demoRequestsService.reject(
        req.params.id as string,
        req.user!.userId,
        req.body.rejectionNote,
      );
      sendResponse({ res, message: 'Demo request rejected', data: result });
    } catch (err) {
      next(err);
    }
  },

  /** PATCH /demo-requests/:id/end-trial — super_admin */
  async endTrial(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await demoRequestsService.endTrial(req.params.id as string);
      sendResponse({ res, message: 'Trial ended successfully', data: result });
    } catch (err) {
      next(err);
    }
  },

  /** DELETE /demo-requests/:id — super_admin */
  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const result = await demoRequestsService.delete(req.params.id as string);
      sendResponse({ res, message: 'Demo request deleted', data: result });
    } catch (err) {
      next(err);
    }
  },
};
