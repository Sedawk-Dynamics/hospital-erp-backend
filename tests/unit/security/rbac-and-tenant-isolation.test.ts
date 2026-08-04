import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response, NextFunction } from 'express';
import { requireRoles, denyRoles, requirePermission } from '../../../src/middleware/authorize';
import { getRolePermissions } from '../../../src/shared/role-permissions';
import { prisma } from '../../../src/config/database';
import type { AuthenticatedRequest } from '../../../src/shared/types';

// ============================================================
// Security regressions — RBAC, tenant isolation, role ownership
// ============================================================
//
// These lock in the access rules the app depends on. They are cheap to run and
// they fail loudly if a guard is loosened by accident, which is exactly the
// class of change that is easy to make and expensive to miss.
//
// Findings from the 2026-08-04 audit that are ACCEPTED RISK (the product owner
// chose to leave them for now) are recorded at the bottom as `it.todo`, so they
// stay visible in every test run instead of living only in a report.

const res = () => {
  const r: Partial<Response> = {};
  r.status = vi.fn().mockReturnValue(r);
  r.json = vi.fn().mockReturnValue(r);
  return r as Response;
};

const req = (over: Partial<AuthenticatedRequest['user']> = {}): AuthenticatedRequest =>
  ({
    user: { userId: 'u1', tenantId: 't1', email: 'a@b.c', roles: ['doctor'], ...over },
  }) as AuthenticatedRequest;

/** Run a middleware and report whether it called next() cleanly. */
async function run(mw: any, r: AuthenticatedRequest) {
  let err: unknown;
  const next: NextFunction = ((e?: unknown) => {
    err = e;
  }) as NextFunction;
  await mw(r, res(), next);
  return { allowed: err === undefined, err: err as { statusCode?: number; message?: string } };
}

describe('security: role guards', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('requireRoles', () => {
    it('allows a caller holding one of the listed roles', async () => {
      const { allowed } = await run(requireRoles('admin', 'super_admin'), req({ roles: ['admin'] }));
      expect(allowed).toBe(true);
    });

    it('rejects a caller holding none of them', async () => {
      const { allowed, err } = await run(requireRoles('admin'), req({ roles: ['doctor'] }));
      expect(allowed).toBe(false);
      expect(err?.statusCode).toBe(403);
    });

    it('rejects an unauthenticated caller', async () => {
      const { allowed, err } = await run(requireRoles('admin'), {} as AuthenticatedRequest);
      expect(allowed).toBe(false);
      expect(err?.statusCode).toBe(401);
    });
  });

  describe('denyRoles — documentation ownership', () => {
    // These deny-lists encode who OWNS a record type. A nurse may read a
    // prescription and administer the dose, but must never author or alter the
    // doctor's script; patient forms are the mirror image.
    it('blocks a nurse from writing prescriptions', async () => {
      const { allowed, err } = await run(denyRoles('nurse', 'nurse_admin'), req({ roles: ['nurse'] }));
      expect(allowed).toBe(false);
      expect(err?.statusCode).toBe(403);
    });

    it('still lets a doctor write prescriptions', async () => {
      const { allowed } = await run(denyRoles('nurse', 'nurse_admin'), req({ roles: ['doctor'] }));
      expect(allowed).toBe(true);
    });

    it('blocks a doctor from submitting patient forms (nursing documentation)', async () => {
      const { allowed, err } = await run(denyRoles('doctor'), req({ roles: ['doctor'] }));
      expect(allowed).toBe(false);
      expect(err?.statusCode).toBe(403);
    });

    it('still lets a nurse submit patient forms', async () => {
      const { allowed } = await run(denyRoles('doctor'), req({ roles: ['nurse'] }));
      expect(allowed).toBe(true);
    });
  });

  describe('requirePermission', () => {
    it('allows when the role grants the permission', async () => {
      vi.mocked(prisma.rolePermission.findFirst).mockResolvedValue({ id: 'rp1' } as never);
      const { allowed } = await run(requirePermission('patients', 'read'), req());
      expect(allowed).toBe(true);
    });

    it('rejects when no role grants it', async () => {
      vi.mocked(prisma.rolePermission.findFirst).mockResolvedValue(null as never);
      const { allowed, err } = await run(requirePermission('billing', 'delete'), req());
      expect(allowed).toBe(false);
      expect(err?.statusCode).toBe(403);
    });

    it('rejects an unauthenticated caller before touching the database', async () => {
      const { allowed, err } = await run(requirePermission('patients', 'read'), {} as AuthenticatedRequest);
      expect(allowed).toBe(false);
      expect(err?.statusCode).toBe(401);
      expect(prisma.rolePermission.findFirst).not.toHaveBeenCalled();
    });
  });
});

describe('security: the permission matrix', () => {
  const matrix = getRolePermissions();
  const has = (role: string, module: string, action: string) =>
    (matrix[role] ?? []).some((p) => p.module === module && p.action === action);

  it('gives super_admin everything and admin everything except tenants', () => {
    expect(has('super_admin', 'tenants', 'create')).toBe(true);
    expect(has('admin', 'tenants', 'create')).toBe(false);
    expect(has('admin', 'billing', 'update')).toBe(true);
  });

  it('keeps clinical write permissions away from non-clinical roles', () => {
    expect(has('front_desk', 'prescriptions', 'create')).toBe(false);
    expect(has('lab_technician', 'prescriptions', 'create')).toBe(false);
    expect(has('pharmacist', 'diagnoses', 'create')).toBe(false);
  });

  it('keeps billing writes away from clinical roles', () => {
    expect(has('doctor', 'billing', 'create')).toBe(false);
    expect(has('nurse', 'billing', 'create')).toBe(false);
    expect(has('doctor', 'billing', 'read')).toBe(true); // read-through is intended
  });

  it('never grants the patient role write access to clinical records', () => {
    for (const mod of ['patients', 'visits', 'admissions', 'diagnoses', 'prescriptions', 'vitals']) {
      for (const act of ['create', 'update', 'delete']) {
        expect(
          has('patient', mod, act),
          `patient must not hold ${mod}:${act}`,
        ).toBe(false);
      }
    }
  });

  it('grants nurses vitals + nursing notes but not prescription authoring', () => {
    expect(has('nurse', 'vitals', 'create')).toBe(true);
    expect(has('nurse', 'nursing_notes', 'create')).toBe(true);
    // The nurse HOLDS prescriptions:create for the ward key-sheet flow; the
    // route-level denyRoles above is what stops them authoring a doctor's
    // script. Both halves matter — assert the permission really is granted so
    // nobody "tidies" it away and breaks ward ordering.
    expect(has('nurse', 'prescriptions', 'create')).toBe(true);
  });

  it('grants doctors forms:create for the catalogue but not submission', () => {
    // Submission is blocked at the route with denyRoles('doctor') — see above.
    expect(has('doctor', 'forms', 'create')).toBe(true);
  });
});

// ── Accepted-risk findings from the 2026-08-04 security audit ──────────────
//
// Left unfixed by an explicit product decision. Kept as `it.todo` so they show
// up as pending on every run rather than being forgotten in a document.
describe('security: known gaps (accepted risk, 2026-08-04 audit)', () => {
  it.todo(
    'authenticate: an X-Tenant-Id override by a hospital admin should require a ' +
      'TenantOwner link — today it only checks the tenant exists and is active, ' +
      'so an admin of one hospital can read and write another hospital\'s data',
  );

  it.todo(
    'patients/billing/medical-history: a patient-role token can read ANY other ' +
      'patient in the tenant — those routes check patients:read but never ' +
      'ownership, and the patient role holds that permission for its own portal',
  );

  it.todo(
    'GET /billing/patient/:patientId, GET /patients/:id/visits and ' +
      'POST /patients/:id/documents have no route-level permission gate at all',
  );
});
