import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { authenticate } from '../../../src/middleware/authenticate';
import { mockRequest, mockResponse, mockNext, testUser } from '../../helpers';
import { AppError } from '../../../src/shared/appError';

vi.mock('jsonwebtoken');

describe('authenticate middleware', () => {
  const next = mockNext();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call next with error when no authorization header', () => {
    const req = mockRequest({ headers: {} });
    const res = mockResponse();

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('No token provided');
  });

  it('should call next with error when authorization header does not start with "Bearer "', () => {
    const req = mockRequest({
      headers: { authorization: 'Basic some-token' },
    });
    const res = mockResponse();

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('No token provided');
  });

  it('should call next with error when token is invalid or expired', () => {
    vi.mocked(jwt.verify).mockImplementation(() => {
      throw new Error('jwt expired');
    });

    const req = mockRequest({
      headers: { authorization: 'Bearer invalid-token' },
    });
    const res = mockResponse();

    authenticate(req, res, next);

    expect(jwt.verify).toHaveBeenCalledWith('invalid-token', expect.any(String));
    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('Invalid or expired token');
  });

  it('should set req.user and call next() on valid token', () => {
    const user = testUser();
    vi.mocked(jwt.verify).mockReturnValue(user as any);

    const req = mockRequest({
      headers: { authorization: 'Bearer valid-token' },
    });
    const res = mockResponse();

    authenticate(req, res, next);

    expect(jwt.verify).toHaveBeenCalledWith('valid-token', expect.any(String));
    expect(req.user).toBeDefined();
    expect(next).toHaveBeenCalledWith();
  });

  it('should correctly parse token payload into req.user', () => {
    const payload = {
      userId: 'usr-42',
      tenantId: 'ten-7',
      email: 'doctor@hospital.com',
      roles: ['doctor', 'admin'],
      iat: 1234567890,
      exp: 9999999999,
      extraField: 'should-be-excluded',
    };
    vi.mocked(jwt.verify).mockReturnValue(payload as any);

    const req = mockRequest({
      headers: { authorization: 'Bearer valid-token' },
    });
    const res = mockResponse();

    authenticate(req, res, next);

    expect(req.user).toEqual({
      userId: 'usr-42',
      tenantId: 'ten-7',
      email: 'doctor@hospital.com',
      roles: ['doctor', 'admin'],
    });
    // Ensure only the four expected fields are set
    expect(req.user).not.toHaveProperty('iat');
    expect(req.user).not.toHaveProperty('exp');
    expect(req.user).not.toHaveProperty('extraField');
  });

  it('should call next with error when authorization header is "Bearer " with empty token', () => {
    // "Bearer " followed by empty string still produces a token of ""
    // jwt.verify will throw on empty string
    vi.mocked(jwt.verify).mockImplementation(() => {
      throw new Error('jwt must be provided');
    });

    const req = mockRequest({
      headers: { authorization: 'Bearer ' },
    });
    const res = mockResponse();

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('Invalid or expired token');
  });
});
