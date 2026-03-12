import { Request } from 'express';

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  email: string;
  roles: string[];
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

export interface ServiceResult<T> {
  data: T;
  message?: string;
}
