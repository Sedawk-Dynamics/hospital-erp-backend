import { Request, Response, NextFunction } from 'express';
import { AppError } from '../shared/appError';
import { logger } from '../config/logger';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  // Zod validation errors
  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      data: null,
      errors: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  // App errors (expected)
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      data: null,
      code: err.code,
    });
  }

  // Prisma known errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const rawTarget = err.meta?.target;
      const target = Array.isArray(rawTarget) ? rawTarget.join(', ') : String(rawTarget ?? 'field');
      // Friendlier copy for the GTIN unique indexes (the service layer usually
      // catches these first with a drug-named message, but this backstops the
      // race where two writes slip past the pre-check).
      const message = /gtin/i.test(target)
        ? 'This GTIN is already assigned to another medicine. Each medicine must have a unique GTIN.'
        : `Duplicate value for ${target}`;
      return res.status(409).json({
        success: false,
        message,
        data: null,
        code: 'DUPLICATE',
      });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({
        success: false,
        message: 'Record not found',
        data: null,
        code: 'NOT_FOUND',
      });
    }
  }

  // Unexpected errors
  logger.error({ err }, 'Unhandled error');
  return res.status(500).json({
    success: false,
    message: 'Internal server error',
    data: null,
  });
}
