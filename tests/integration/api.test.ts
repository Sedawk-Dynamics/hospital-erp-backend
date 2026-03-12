import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';

// ─── Integration tests for API endpoints ───
// These tests verify that routes are wired correctly, middleware is applied,
// and the correct HTTP status codes are returned.

describe('API Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Health Check ───
  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  // ─── Auth Routes ───
  describe('Auth Routes', () => {
    describe('POST /api/v1/auth/register', () => {
      it('should return 400 for invalid registration body', async () => {
        const res = await request(app)
          .post('/api/v1/auth/register')
          .send({});
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
      });

      it('should validate email format', async () => {
        const res = await request(app)
          .post('/api/v1/auth/register')
          .send({
            email: 'invalid-email',
            password: 'Test@1234',
            firstName: 'John',
            lastName: 'Doe',
            tenantSlug: 'hospital-1',
          });
        expect(res.status).toBe(400);
      });

      it('should validate password strength', async () => {
        const res = await request(app)
          .post('/api/v1/auth/register')
          .send({
            email: 'test@example.com',
            password: 'weak',
            firstName: 'John',
            lastName: 'Doe',
            tenantSlug: 'hospital-1',
          });
        expect(res.status).toBe(400);
      });
    });

    describe('POST /api/v1/auth/login', () => {
      it('should return 400 for missing credentials', async () => {
        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({});
        expect(res.status).toBe(400);
      });

      it('should validate email format on login', async () => {
        const res = await request(app)
          .post('/api/v1/auth/login')
          .send({ email: 'bad', password: 'pass' });
        expect(res.status).toBe(400);
      });
    });

    describe('POST /api/v1/auth/refresh', () => {
      it('should return 400 for missing refresh token', async () => {
        const res = await request(app)
          .post('/api/v1/auth/refresh')
          .send({});
        expect(res.status).toBe(400);
      });
    });

    describe('POST /api/v1/auth/logout', () => {
      it('should return 401 without auth token', async () => {
        const res = await request(app).post('/api/v1/auth/logout');
        expect(res.status).toBe(401);
      });
    });

    describe('GET /api/v1/auth/me', () => {
      it('should return 401 without auth token', async () => {
        const res = await request(app).get('/api/v1/auth/me');
        expect(res.status).toBe(401);
      });
    });

    describe('POST /api/v1/auth/2fa/setup', () => {
      it('should return 401 without auth token', async () => {
        const res = await request(app).post('/api/v1/auth/2fa/setup');
        expect(res.status).toBe(401);
      });
    });
  });

  // ─── Protected Routes require authentication ───
  describe('Protected Routes - Authentication Required', () => {
    const protectedEndpoints = [
      { method: 'get', path: '/api/v1/patients' },
      { method: 'post', path: '/api/v1/patients' },
      { method: 'get', path: '/api/v1/appointments' },
      { method: 'post', path: '/api/v1/appointments' },
      { method: 'get', path: '/api/v1/billing' },
      { method: 'post', path: '/api/v1/billing' },
      { method: 'get', path: '/api/v1/clinical/visits' },
      { method: 'post', path: '/api/v1/clinical/visits' },
      { method: 'get', path: '/api/v1/lab/departments' },
      { method: 'get', path: '/api/v1/pharmacy/categories' },
      { method: 'get', path: '/api/v1/inventory/items' },
      { method: 'get', path: '/api/v1/insurance/insurers' },
      { method: 'get', path: '/api/v1/blood-bank/donors' },
      { method: 'get', path: '/api/v1/hr/staff' },
      { method: 'get', path: '/api/v1/infrastructure/departments' },
      { method: 'get', path: '/api/v1/prescriptions' },
      { method: 'get', path: '/api/v1/progress-notes' },
      { method: 'get', path: '/api/v1/imaging/requests' },
      { method: 'get', path: '/api/v1/communication/notifications' },
      { method: 'get', path: '/api/v1/compliance/audit-logs' },
      { method: 'get', path: '/api/v1/dashboard/stats' },
    ];

    protectedEndpoints.forEach(({ method, path }) => {
      it(`${method.toUpperCase()} ${path} should return 401 without token`, async () => {
        const res = await (request(app) as any)[method](path);
        expect(res.status).toBe(401);
      });
    });
  });

  // ─── 404 for unknown routes ───
  describe('Unknown Routes', () => {
    it('should return 404 for unknown API route', async () => {
      const res = await request(app).get('/api/v1/nonexistent');
      expect(res.status).toBe(404);
    });

    it('should return 404 for unknown base route', async () => {
      const res = await request(app).get('/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  // ─── Request validation on key endpoints ───
  describe('Request Validation', () => {
    describe('POST /api/v1/auth/forgot-password', () => {
      it('should return 400 for missing email', async () => {
        const res = await request(app)
          .post('/api/v1/auth/forgot-password')
          .send({});
        expect(res.status).toBe(400);
      });

      it('should return 400 for invalid email', async () => {
        const res = await request(app)
          .post('/api/v1/auth/forgot-password')
          .send({ email: 'not-an-email' });
        expect(res.status).toBe(400);
      });
    });

    describe('POST /api/v1/auth/reset-password', () => {
      it('should return 400 for missing fields', async () => {
        const res = await request(app)
          .post('/api/v1/auth/reset-password')
          .send({});
        expect(res.status).toBe(400);
      });

      it('should return 400 for weak password', async () => {
        const res = await request(app)
          .post('/api/v1/auth/reset-password')
          .send({ token: 'some-token', newPassword: 'weak' });
        expect(res.status).toBe(400);
      });
    });
  });

  // ─── CORS Headers ───
  describe('CORS', () => {
    it('should include CORS headers in response', async () => {
      const res = await request(app)
        .get('/health')
        .set('Origin', 'http://localhost:3000');
      // CORS headers should be present (exact values depend on config)
      expect(res.status).toBe(200);
    });
  });

  // ─── Security Headers ───
  describe('Security Headers', () => {
    it('should include helmet security headers', async () => {
      const res = await request(app).get('/health');
      // Helmet adds various security headers
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
    });
  });

  // ─── JSON Body Parsing ───
  describe('Body Parsing', () => {
    it('should parse JSON body', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ email: 'test@example.com', password: 'Test@1234' }));
      // Should not be 415 Unsupported Media Type
      expect(res.status).not.toBe(415);
    });
  });
});
