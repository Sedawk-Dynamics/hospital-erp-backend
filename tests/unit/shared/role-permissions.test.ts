import { describe, it, expect } from 'vitest';
import { getRolePermissions } from '../../../src/shared/role-permissions';

const perms = getRolePermissions();

const has = (role: string, module: string, action: string) =>
  (perms[role] ?? []).some((p) => p.module === module && p.action === action);

describe('cross-role clinical reads', () => {
  // Test Report 3 / C2. The doctor's consultation page renders a Nursing Notes
  // panel, but GET /progress-notes/nursing is gated on nursing_notes:read. The
  // grant was missing, so the panel 403'd and showed nothing — which reads
  // exactly like the notes never being written.
  it('lets a doctor read what nursing wrote on the same encounter', () => {
    expect(has('doctor', 'nursing_notes', 'read')).toBe(true);
  });

  // The other half of that rule: the notes stay nursing's record. A doctor
  // documenting their own view of the patient uses progress_notes.
  it('does not let a doctor write or delete a nursing note', () => {
    expect(has('doctor', 'nursing_notes', 'create')).toBe(false);
    expect(has('doctor', 'nursing_notes', 'update')).toBe(false);
    expect(has('doctor', 'nursing_notes', 'delete')).toBe(false);
  });

  it('keeps nursing as the author of its own notes', () => {
    expect(has('nurse', 'nursing_notes', 'read')).toBe(true);
    expect(has('nurse', 'nursing_notes', 'create')).toBe(true);
    expect(has('nurse', 'nursing_notes', 'update')).toBe(true);
  });

  // Every screen added for Test Report 3 that reads across a role boundary.
  // Each one 403s silently if the grant goes missing, so they are pinned here
  // rather than found again by hand.
  it.each([
    ['doctor', 'nursing_notes', 'read', 'C2  nursing notes on the consultation page'],
    ['nurse', 'visits', 'update', 'A4  nurse records the chief complaint'],
    ['nurse', 'appointments', 'read', 'B1  nurse OPD queue'],
    ['nurse', 'visits', 'read', 'B1  nurse OPD queue'],
    ['doctor', 'vitals', 'update', 'A5  doctor amends a nurse-recorded vital'],
  ])('%s can %s:%s — %s', (role, module, action) => {
    expect(has(role, module, action)).toBe(true);
  });
});
