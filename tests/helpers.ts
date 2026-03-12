import { Response } from 'express';
import { vi } from 'vitest';
import { AuthenticatedRequest, AuthenticatedUser } from '../src/shared/types';

/**
 * Creates a mock Express Response object.
 */
export function mockResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    cookie: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

/**
 * Creates a mock AuthenticatedRequest with optional user.
 */
export function mockRequest(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    headers: {},
    body: {},
    query: {},
    params: {},
    ...overrides,
  } as AuthenticatedRequest;
}

/**
 * Returns a test user payload matching the AuthenticatedUser interface.
 */
export function testUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    email: 'test@hospital.com',
    roles: ['admin'],
    ...overrides,
  };
}

/**
 * Returns a mock next function.
 */
export function mockNext() {
  return vi.fn();
}
