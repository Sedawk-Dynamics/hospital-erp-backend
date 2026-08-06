import { describe, it, expect } from 'vitest';
import {
  ACTIVE_ADMISSION_STATUSES,
  ACTIVE_ADMISSION_STATUS,
  isActiveAdmission,
  isReadyToDischarge,
} from '../../../src/shared/admission-status';

// `ready_to_discharge` means the doctor has signed off but the patient is STILL
// IN THE BED waiting on the counter. Roughly thirty queries key off "is this
// patient here?" — eMAR ward resolution, pharmacy credit + IP dispensing, ward
// indents, OT-kit billing, NDPS, nurse assignments, dashboards. If this set ever
// narrows back to just `admitted`, a signed-off patient silently drops out of
// all of them — their drug chart included — while still physically present.
describe('ACTIVE_ADMISSION_STATUSES', () => {
  it('treats a patient waiting on the counter as still in the hospital', () => {
    expect(isActiveAdmission('ready_to_discharge')).toBe(true);
    expect(isActiveAdmission('admitted')).toBe(true);
  });

  it('does not treat a closed stay as active', () => {
    expect(isActiveAdmission('discharged')).toBe(false);
    expect(isActiveAdmission('transferred')).toBe(false);
    expect(isActiveAdmission('absconded')).toBe(false);
    expect(isActiveAdmission(null)).toBe(false);
    expect(isActiveAdmission(undefined)).toBe(false);
  });

  it('contains exactly the two bed-occupying statuses', () => {
    expect([...ACTIVE_ADMISSION_STATUSES].sort()).toEqual(['admitted', 'ready_to_discharge']);
  });

  it('exposes a Prisma-shaped filter over the same set', () => {
    expect(ACTIVE_ADMISSION_STATUS.in).toEqual([...ACTIVE_ADMISSION_STATUSES]);
  });

  it('separates "waiting on the counter" from "still being treated"', () => {
    expect(isReadyToDischarge('ready_to_discharge')).toBe(true);
    expect(isReadyToDischarge('admitted')).toBe(false);
    expect(isReadyToDischarge('discharged')).toBe(false);
  });
});
