import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError, ZodIssue } from 'zod';
import { Prisma } from '@prisma/client';
import { errorHandler } from '../../../src/middleware/errorHandler';
import { AppError } from '../../../src/shared/appError';
import { mockRequest, mockResponse, mockNext } from '../../helpers';
import { logger } from '../../../src/config/logger';

describe('errorHandler middleware', () => {
  const res = mockResponse();
  const next = mockNext();

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-create res mocks since clearAllMocks resets them
    (res.status as any) = vi.fn().mockReturnValue(res);
    (res.json as any) = vi.fn().mockReturnValue(res);
  });

  // ─── ZodError ─────────────────────────────────────────────────

  it('should handle ZodError with field-level errors', () => {
    const issues: ZodIssue[] = [
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['body', 'email'],
        message: 'Required',
      },
      {
        code: 'too_small',
        minimum: 8,
        type: 'string',
        inclusive: true,
        exact: false,
        path: ['body', 'password'],
        message: 'String must contain at least 8 character(s)',
      },
    ];
    const zodError = new ZodError(issues);

    const req = mockRequest();
    errorHandler(zodError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Validation error',
      data: null,
      errors: [
        { field: 'body.email', message: 'Required' },
        { field: 'body.password', message: 'String must contain at least 8 character(s)' },
      ],
    });
  });

  it('should handle ZodError with single-field error', () => {
    const issues: ZodIssue[] = [
      {
        code: 'invalid_type',
        expected: 'number',
        received: 'string',
        path: ['query', 'page'],
        message: 'Expected number, received string',
      },
    ];
    const zodError = new ZodError(issues);

    const req = mockRequest();
    errorHandler(zodError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Validation error',
      data: null,
      errors: [
        { field: 'query.page', message: 'Expected number, received string' },
      ],
    });
  });

  // ─── AppError ─────────────────────────────────────────────────

  it('should handle AppError with correct status code and message', () => {
    const appError = AppError.forbidden('You do not have access');

    const req = mockRequest();
    errorHandler(appError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'You do not have access',
      data: null,
      code: 'FORBIDDEN',
    });
  });

  it('should handle AppError.notFound', () => {
    const error = AppError.notFound('Patient not found');

    const req = mockRequest();
    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Patient not found',
      data: null,
      code: 'NOT_FOUND',
    });
  });

  it('should handle AppError.badRequest', () => {
    const error = AppError.badRequest('Invalid input', 'VALIDATION_FAILED');

    const req = mockRequest();
    errorHandler(error, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Invalid input',
      data: null,
      code: 'VALIDATION_FAILED',
    });
  });

  // ─── Prisma P2002 ────────────────────────────────────────────

  it('should handle Prisma P2002 unique constraint error', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`email`)',
      {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['email'] },
      },
    );

    const req = mockRequest();
    errorHandler(prismaError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Duplicate value for email',
      data: null,
      code: 'DUPLICATE',
    });
  });

  it('should handle Prisma P2002 with multiple target fields', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['tenantId', 'email'] },
      },
    );

    const req = mockRequest();
    errorHandler(prismaError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Duplicate value for tenantId, email',
      data: null,
      code: 'DUPLICATE',
    });
  });

  it('should handle Prisma P2002 with missing meta target', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: {},
      },
    );

    const req = mockRequest();
    errorHandler(prismaError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Duplicate value for field',
      data: null,
      code: 'DUPLICATE',
    });
  });

  // ─── Prisma P2025 ────────────────────────────────────────────

  it('should handle Prisma P2025 record not found error', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'An operation failed because it depends on one or more records that were required but not found.',
      {
        code: 'P2025',
        clientVersion: '5.0.0',
      },
    );

    const req = mockRequest();
    errorHandler(prismaError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Record not found',
      data: null,
      code: 'NOT_FOUND',
    });
  });

  // ─── Unknown errors ──────────────────────────────────────────

  it('should handle unexpected errors as 500 and log them', () => {
    const unknownError = new Error('Something went terribly wrong');

    const req = mockRequest();
    errorHandler(unknownError, req, res, next);

    expect(logger.error).toHaveBeenCalledWith(
      { err: unknownError },
      'Unhandled error',
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Internal server error',
      data: null,
    });
  });

  it('should handle non-Error objects thrown as 500', () => {
    // Sometimes strings or other types are thrown
    const weirdError = { weird: true } as unknown as Error;

    const req = mockRequest();
    errorHandler(weirdError, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Internal server error',
      data: null,
    });
  });

  it('should handle unrecognized Prisma error codes as 500', () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Some other prisma error',
      {
        code: 'P2003',
        clientVersion: '5.0.0',
      },
    );

    const req = mockRequest();
    errorHandler(prismaError, req, res, next);

    // P2003 is not specifically handled, so falls through to 500
    expect(logger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Internal server error',
      data: null,
    });
  });
});
