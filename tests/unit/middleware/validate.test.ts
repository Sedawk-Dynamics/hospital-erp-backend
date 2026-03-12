import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z, ZodError } from 'zod';
import { validate } from '../../../src/middleware/validate';
import { mockRequest, mockResponse, mockNext } from '../../helpers';

describe('validate middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Success cases ────────────────────────────────────────────

  it('should call next() when validation passes', () => {
    const schema = z.object({
      body: z.object({
        name: z.string(),
        age: z.number(),
      }),
      query: z.object({}).optional(),
      params: z.object({}).optional(),
    });

    const req = mockRequest({
      body: { name: 'John', age: 30 },
      query: {},
      params: {},
    });
    const res = mockResponse();
    const next = mockNext();

    const middleware = validate(schema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('should replace req.body with parsed (transformed) data', () => {
    const schema = z.object({
      body: z.object({
        email: z.string().email().toLowerCase(),
        age: z.coerce.number(),
      }),
      query: z.object({}).optional(),
      params: z.object({}).optional(),
    });

    const req = mockRequest({
      body: { email: 'ADMIN@HOSPITAL.COM', age: '25' },
      query: {},
      params: {},
    });
    const res = mockResponse();
    const next = mockNext();

    const middleware = validate(schema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    // email should be lowercased, age should be coerced to number
    expect(req.body).toEqual({
      email: 'admin@hospital.com',
      age: 25,
    });
  });

  it('should replace req.query with parsed data', () => {
    const schema = z.object({
      body: z.object({}).optional(),
      query: z.object({
        page: z.coerce.number().default(1),
        limit: z.coerce.number().default(10),
      }),
      params: z.object({}).optional(),
    });

    const req = mockRequest({
      body: {},
      query: { page: '3', limit: '20' },
      params: {},
    });
    const res = mockResponse();
    const next = mockNext();

    const middleware = validate(schema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.query).toEqual({ page: 3, limit: 20 });
  });

  it('should replace req.params with parsed data', () => {
    const schema = z.object({
      body: z.object({}).optional(),
      query: z.object({}).optional(),
      params: z.object({
        id: z.string().uuid(),
      }),
    });

    const req = mockRequest({
      body: {},
      query: {},
      params: { id: '550e8400-e29b-41d4-a716-446655440000' },
    });
    const res = mockResponse();
    const next = mockNext();

    const middleware = validate(schema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.params).toEqual({ id: '550e8400-e29b-41d4-a716-446655440000' });
  });

  it('should validate body, query, and params together', () => {
    const schema = z.object({
      body: z.object({
        name: z.string(),
      }),
      query: z.object({
        include: z.string().optional(),
      }),
      params: z.object({
        id: z.string(),
      }),
    });

    const req = mockRequest({
      body: { name: 'Ward A' },
      query: { include: 'beds' },
      params: { id: 'ward-1' },
    });
    const res = mockResponse();
    const next = mockNext();

    const middleware = validate(schema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ name: 'Ward A' });
    expect(req.query).toEqual({ include: 'beds' });
    expect(req.params).toEqual({ id: 'ward-1' });
  });

  // ─── Failure cases ────────────────────────────────────────────

  it('should call next(err) with ZodError when body validation fails', () => {
    const schema = z.object({
      body: z.object({
        email: z.string().email(),
        password: z.string().min(8),
      }),
      query: z.object({}).optional(),
      params: z.object({}).optional(),
    });

    const req = mockRequest({
      body: { email: 'not-an-email', password: '123' },
      query: {},
      params: {},
    });
    const res = mockResponse();
    const next = mockNext();

    const middleware = validate(schema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(ZodError);
    // There should be errors for email format and password min length
    expect(error.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('should call next(err) when required body fields are missing', () => {
    const schema = z.object({
      body: z.object({
        name: z.string(),
        age: z.number(),
      }),
      query: z.object({}).optional(),
      params: z.object({}).optional(),
    });

    const req = mockRequest({
      body: {},
      query: {},
      params: {},
    });
    const res = mockResponse();
    const next = mockNext();

    const middleware = validate(schema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(ZodError);
  });

  it('should call next(err) when params validation fails', () => {
    const schema = z.object({
      body: z.object({}).optional(),
      query: z.object({}).optional(),
      params: z.object({
        id: z.string().uuid(),
      }),
    });

    const req = mockRequest({
      body: {},
      query: {},
      params: { id: 'not-a-uuid' },
    });
    const res = mockResponse();
    const next = mockNext();

    const middleware = validate(schema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error).toBeInstanceOf(ZodError);
  });

  it('should strip unknown body fields when schema uses strict', () => {
    const schema = z.object({
      body: z.object({
        name: z.string(),
      }),
      query: z.object({}).optional(),
      params: z.object({}).optional(),
    });

    const req = mockRequest({
      body: { name: 'Test', extraField: 'should-be-stripped' },
      query: {},
      params: {},
    });
    const res = mockResponse();
    const next = mockNext();

    const middleware = validate(schema);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    // Zod default strips unknown keys
    expect(req.body).toEqual({ name: 'Test' });
  });
});
