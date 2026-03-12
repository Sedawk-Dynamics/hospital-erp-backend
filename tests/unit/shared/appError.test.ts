import { describe, it, expect } from 'vitest';
import { AppError } from '../../../src/shared/appError';

describe('AppError', () => {
  it('should create an error with custom message and status code', () => {
    const error = new AppError('Something went wrong', 422, 'CUSTOM_CODE');
    expect(error.message).toBe('Something went wrong');
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe('CUSTOM_CODE');
    expect(error.isOperational).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
  });

  it('should create a 400 Bad Request error', () => {
    const error = AppError.badRequest('Invalid input');
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Invalid input');
  });

  it('should create a 400 Bad Request with custom code', () => {
    const error = AppError.badRequest('Validation failed', 'VALIDATION_FAILED');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('should create a 401 Unauthorized error with default message', () => {
    const error = AppError.unauthorized();
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('Unauthorized');
    expect(error.code).toBe('UNAUTHORIZED');
  });

  it('should create a 401 Unauthorized error with custom message', () => {
    const error = AppError.unauthorized('Invalid credentials');
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('Invalid credentials');
  });

  it('should create a 403 Forbidden error with default message', () => {
    const error = AppError.forbidden();
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe('Forbidden');
    expect(error.code).toBe('FORBIDDEN');
  });

  it('should create a 403 Forbidden error with custom message', () => {
    const error = AppError.forbidden('Insufficient permissions');
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe('Insufficient permissions');
  });

  it('should create a 404 Not Found error with default message', () => {
    const error = AppError.notFound();
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Resource not found');
    expect(error.code).toBe('NOT_FOUND');
  });

  it('should create a 404 Not Found error with custom message', () => {
    const error = AppError.notFound('Patient not found');
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Patient not found');
  });

  it('should create a 409 Conflict error', () => {
    const error = AppError.conflict('User already exists');
    expect(error.statusCode).toBe(409);
    expect(error.message).toBe('User already exists');
    expect(error.code).toBe('CONFLICT');
  });

  it('should create a 500 Internal Server Error with default message', () => {
    const error = AppError.internal();
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe('Internal server error');
    expect(error.code).toBe('INTERNAL_ERROR');
  });

  it('should create a 500 Internal Server Error with custom message', () => {
    const error = AppError.internal('Database connection failed');
    expect(error.statusCode).toBe(500);
    expect(error.message).toBe('Database connection failed');
  });

  it('should always set isOperational to true', () => {
    const errors = [
      AppError.badRequest('test'),
      AppError.unauthorized(),
      AppError.forbidden(),
      AppError.notFound(),
      AppError.conflict('test'),
      AppError.internal(),
    ];
    errors.forEach((error) => {
      expect(error.isOperational).toBe(true);
    });
  });

  it('should have correct prototype chain', () => {
    const error = AppError.badRequest('test');
    expect(error instanceof AppError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });

  it('should work without a code parameter', () => {
    const error = new AppError('No code', 400);
    expect(error.code).toBeUndefined();
  });
});
