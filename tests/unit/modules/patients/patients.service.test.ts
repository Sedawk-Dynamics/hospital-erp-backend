import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as patientsService from '../../../../src/modules/patients/patients.service';
import { prisma } from '../../../../src/config/database';
import { AppError } from '../../../../src/shared/appError';

// NOTE: do NOT add `vi.mock('.../config/database')` here. A bare vi.mock is
// an AUTOMOCK and overrides the working factory mock in tests/setup.ts,
// which is what made every prisma call in this file undefined.


// Creating a patient with a phone number now also provisions an "account
// holder" User on the __platform__ tenant (the global-patient-identity work),
// so every create test has to stand that path up: platform tenant, patient
// role, and no e-mail clash. Without it the service throws
// "Platform tenant not found" long before it reaches patient.create.
function mockAccountHolderPath() {
  // vi.clearAllMocks() clears CALLS but not implementations, so a $queryRaw stub
  // staged by the phone-duplicate test would otherwise leak into later ones.
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as any);
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.tenant.findFirst).mockResolvedValue({
    id: 'platform-tenant', slug: '__platform__', name: 'Platform', isActive: true,
  } as any);
  vi.mocked(prisma.role.findFirst).mockResolvedValue({ id: 'role-patient', name: 'patient' } as any);
  vi.mocked(prisma.user.findFirst).mockResolvedValue(null as any);
  vi.mocked(prisma.user.create).mockResolvedValue({ id: 'account-user-1' } as any);
  vi.mocked(prisma.userRole.create).mockResolvedValue({ id: 'ur-1' } as any);
  // The new patient is linked to that account holder, and create() verifies
  // the linked user exists before writing the row.
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: 'account-user-1' } as any);
}

/**
 * The guard asks the database two separate questions now, so the mock has to
 * tell them apart: "is there a row on ANOTHER account with this number" and
 * "which people of this name are on this number". Both used to be sifted out
 * of one windowed result in JS, which silently skipped rows once a number
 * carried more patients than the window held.
 *
 * Dispatching on the SQL rather than on call order, so an added query upstream
 * cannot quietly reassign these.
 */
function stagePhoneQueries(opts: { clash?: unknown[]; candidates?: unknown[] }) {
  vi.mocked(prisma.$queryRaw).mockImplementation(((strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? Array.from(strings).join(' ') : String(strings);
    if (sql.includes('user_id IS NULL OR user_id')) return Promise.resolve(opts.clash ?? []);
    if (sql.includes('btrim(lower(')) return Promise.resolve(opts.candidates ?? []);
    return Promise.resolve([]);
  }) as never);
}

describe('PatientsService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('create', () => {
    it('should create a patient with generated MRN', async () => {
      mockAccountHolderPath();
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.patient.create).mockResolvedValue({
        id: 'p1', mrn: 'MRN-20260309-0001', firstName: 'John', lastName: 'Doe',
        tenantId: 'tenant-1', gender: 'male', dateOfBirth: new Date(),
      } as any);
      const result = await patientsService.create('tenant-1', {
        firstName: 'John', lastName: 'Doe', gender: 'male',
        dateOfBirth: '1990-01-01', phone: '1234567890',
      });
      expect(result).toBeDefined();
      expect(prisma.patient.create).toHaveBeenCalled();
    });

    it('should map gender values correctly', async () => {
      mockAccountHolderPath();
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.patient.create).mockResolvedValue({ id: 'p1', gender: 'male' } as any);
      await patientsService.create('tenant-1', {
        firstName: 'Jane', lastName: 'Doe', gender: 'female',
        dateOfBirth: '1990-01-01', phone: '1234567890',
      });
      expect(prisma.patient.create).toHaveBeenCalled();
    });

    it('should throw conflict if phone already exists', async () => {
      mockAccountHolderPath();
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as any);
      // The phone duplicate check is a RAW query now — it compares the last 10
      // digits so +91XXXXXXXXXX and XXXXXXXXXX collide as one number — so the
      // clash has to be staged on $queryRaw, not on patient.findFirst.
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        { id: 'existing', user_id: null },
      ] as any);
      await expect(
        patientsService.create('tenant-1', {
          firstName: 'John', lastName: 'Doe', gender: 'male',
          dateOfBirth: '1990-01-01', phone: '1234567890',
        }),
      ).rejects.toThrow(AppError);
    });

    // Front desk registering the SAME person a second time. The phone guard
    // above deliberately lets an account holder's family share one number, and
    // nothing checked that the "family member" was actually a different human —
    // so three clicks made three MRNs for one patient, and the portal then
    // offered them a choice between themselves.
    it('refuses to register the same person twice on one phone', async () => {
      mockAccountHolderPath();
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as any);
      stagePhoneQueries({ candidates: [
        {
          id: 'existing', user_id: 'account-user-1', mrn: 'MRN-OLD-1',
          first_name: 'John', last_name: 'Doe', date_of_birth: new Date('1990-01-01'),
        },
      ] });

      await expect(
        patientsService.create('tenant-1', {
          firstName: 'John', lastName: 'Doe', gender: 'male',
          dateOfBirth: '1990-01-01', phone: '1234567890',
        }),
      // The existing MRN is named so front desk can open it instead of guessing.
      ).rejects.toThrow(/MRN-OLD-1/);
      expect(prisma.patient.create).not.toHaveBeenCalled();
    });

    it('still lets a real family member share the phone', async () => {
      mockAccountHolderPath();
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as any);
      stagePhoneQueries({ candidates: [
        {
          id: 'existing', user_id: 'account-user-1', mrn: 'MRN-OLD-1',
          first_name: 'John', last_name: 'Doe', date_of_birth: new Date('1990-01-01'),
        },
      ] });
      vi.mocked(prisma.patient.create).mockResolvedValue({ id: 'p2' } as any);

      // A mother booked on her son's phone — the case the allowance exists for.
      await patientsService.create('tenant-1', {
        firstName: 'Meera', lastName: 'Doe', gender: 'female',
        dateOfBirth: '1965-03-02', phone: '1234567890',
      });

      expect(prisma.patient.create).toHaveBeenCalled();
    });

    it('allows the same name when the date of birth differs', async () => {
      mockAccountHolderPath();
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as any);
      stagePhoneQueries({ candidates: [
        {
          id: 'existing', user_id: 'account-user-1', mrn: 'MRN-OLD-1',
          first_name: 'John', last_name: 'Doe', date_of_birth: new Date('1990-01-01'),
        },
      ] });
      vi.mocked(prisma.patient.create).mockResolvedValue({ id: 'p2' } as any);

      // A son named after his father is a real thing; a name alone must not
      // block him.
      await patientsService.create('tenant-1', {
        firstName: 'John', lastName: 'Doe', gender: 'male',
        dateOfBirth: '2015-08-09', phone: '1234567890',
      });

      expect(prisma.patient.create).toHaveBeenCalled();
    });

    it('treats two rows with no date of birth as the same person', async () => {
      mockAccountHolderPath();
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as any);
      stagePhoneQueries({ candidates: [
        {
          id: 'existing', user_id: 'account-user-1', mrn: 'MRN-OLD-1',
          first_name: 'John', last_name: 'Doe', date_of_birth: null,
        },
      ] });

      // Front desk skipping the field twice is likelier than untracked twins.
      await expect(
        patientsService.create('tenant-1', {
          firstName: 'John', lastName: 'Doe', gender: 'male', phone: '1234567890',
        }),
      ).rejects.toThrow(/already registered/i);
    });

    it('matches the name past case and spacing', async () => {
      mockAccountHolderPath();
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as any);
      stagePhoneQueries({ candidates: [
        {
          id: 'existing', user_id: 'account-user-1', mrn: 'MRN-OLD-1',
          first_name: 'John', last_name: 'Doe', date_of_birth: new Date('1990-01-01'),
        },
      ] });

      await expect(
        patientsService.create('tenant-1', {
          firstName: '  jOHN ', lastName: 'doe', gender: 'male',
          dateOfBirth: '1990-01-01', phone: '1234567890',
        }),
      ).rejects.toThrow(/already registered/i);
    });

    it('lets an explicit override through, for two people who really do match', async () => {
      mockAccountHolderPath();
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as any);
      stagePhoneQueries({ candidates: [
        {
          id: 'existing', user_id: 'account-user-1', mrn: 'MRN-OLD-1',
          first_name: 'John', last_name: 'Doe', date_of_birth: new Date('1990-01-01'),
        },
      ] });
      vi.mocked(prisma.patient.create).mockResolvedValue({ id: 'p2' } as any);

      await patientsService.create('tenant-1', {
        firstName: 'John', lastName: 'Doe', gender: 'male',
        dateOfBirth: '1990-01-01', phone: '1234567890', allowDuplicate: true,
      });

      expect(prisma.patient.create).toHaveBeenCalled();
    });

    it('should throw conflict if email already exists', async () => {
      vi.mocked(prisma.patient.findFirst)
        .mockResolvedValueOnce(null) // MRN findFirst
        .mockResolvedValueOnce(null) // MRN uniqueness check
        .mockResolvedValueOnce(null) // phone duplicate check (no dup)
        .mockResolvedValueOnce({ id: 'existing' } as any); // email duplicate
      await expect(
        patientsService.create('tenant-1', {
          firstName: 'John', lastName: 'Doe', gender: 'male',
          dateOfBirth: '1990-01-01', phone: '9999999999', email: 'dup@test.com',
        }),
      ).rejects.toThrow(AppError);
    });

    it('should map prefer_not_to_say gender to other', async () => {
      mockAccountHolderPath();
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.patient.create).mockResolvedValue({ id: 'p1', gender: 'other' } as any);
      await patientsService.create('tenant-1', {
        firstName: 'Alex', lastName: 'Smith', gender: 'prefer_not_to_say',
        dateOfBirth: '1990-01-01', phone: '5551234567',
      });
      const createCall = vi.mocked(prisma.patient.create).mock.calls[0][0];
      expect((createCall as any).data.gender).toBe('other');
    });
  });

  describe('provisionLocalPatient', () => {
    const ACCOUNT = 'account-user-1';
    // A parent and their child share one login and one phone number.
    const child = {
      id: 'child-away', tenantId: 'other-hospital', userId: ACCOUNT,
      firstName: 'Anaya', lastName: 'Kumar', dateOfBirth: new Date('2018-07-07'),
      gender: 'female', phone: '9777888999', abhaNumber: null,
    };
    const parentHere = {
      id: 'parent-here', tenantId: 'tenant-1', userId: ACCOUNT,
      firstName: 'Ravi', lastName: 'Kumar', dateOfBirth: new Date('1980-03-03'),
      gender: 'male', phone: '9777888999', abhaNumber: null,
    };

    beforeEach(() => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
    });

    // Matching on the shared account alone handed back whichever relative was
    // registered here first, so a child selected in the cross-hospital picker
    // came back as their parent and everything booked after was filed against
    // the wrong person.
    it('never returns a relative who shares the account', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue(child as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue([parentHere] as never);
      mockAccountHolderPath();
      vi.mocked(prisma.patient.findUnique).mockResolvedValue(child as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue([parentHere] as never);
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null as never);
      vi.mocked(prisma.patient.create).mockResolvedValue({ id: 'child-here', mrn: 'MRN-NEW' } as never);

      const result = await patientsService.provisionLocalPatient('tenant-1', 'child-away');

      expect(result).toMatchObject({ id: 'child-here' });
      expect(prisma.patient.create).toHaveBeenCalled();
    });

    it('returns the existing record when it is the same person', async () => {
      const childHere = { ...child, id: 'child-here', tenantId: 'tenant-1', mrn: 'MRN-EXISTING' };
      vi.mocked(prisma.patient.findUnique).mockResolvedValue(child as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue([parentHere, childHere] as never);

      const result = await patientsService.provisionLocalPatient('tenant-1', 'child-away');

      // Idempotent — the whole point of the function.
      expect(result).toMatchObject({ id: 'child-here' });
      expect(prisma.patient.create).not.toHaveBeenCalled();
    });

    it('identifies them by ABHA even when the name has changed', async () => {
      const src = { ...child, abhaNumber: '11-2222-3333-4444' };
      const married = {
        ...parentHere, id: 'same-person', firstName: 'Anaya', lastName: 'Sharma',
        abhaNumber: '11-2222-3333-4444',
      };
      vi.mocked(prisma.patient.findUnique).mockResolvedValue(src as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue([married] as never);

      const result = await patientsService.provisionLocalPatient('tenant-1', 'child-away');

      expect(result).toMatchObject({ id: 'same-person' });
      expect(prisma.patient.create).not.toHaveBeenCalled();
    });

    it('refuses a source patient that does not exist', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue(null as never);
      await expect(
        patientsService.provisionLocalPatient('tenant-1', 'nope'),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('getGlobalPatientHistory', () => {
    const child = {
      id: 'child', userId: 'acct', phone: '9666555444', abhaNumber: null,
      firstName: 'Ishaan', lastName: 'Rao', dateOfBirth: new Date('2019-09-09'), gender: 'male',
    };
    const row = (over: Record<string, unknown>) => ({
      tenantId: 't1', mrn: 'M', tenant: { name: 'Hospital' }, abhaNumber: null, ...over,
    });
    const childRow = row({
      id: 'child', firstName: 'Ishaan', lastName: 'Rao', dateOfBirth: new Date('2019-09-09'),
    });
    // Same account, same phone — and a different human.
    const parentRow = row({
      id: 'parent', firstName: 'Sunil', lastName: 'Rao', dateOfBirth: new Date('1975-02-02'),
    });

    function stubRecordQueries() {
      for (const m of ['visit', 'admission', 'prescription', 'labOrder', 'imagingRequest', 'bill'] as const) {
        vi.mocked((prisma as never as Record<string, { findMany: ReturnType<typeof vi.fn> }>)[m].findMany)
          .mockResolvedValue([] as never);
      }
    }

    /** Which patient ids the timeline was actually built from. */
    function idsQueried() {
      const call = vi.mocked(prisma.visit.findMany).mock.calls[0]![0]! as never as {
        where: { patientId: { in: string[] } };
      };
      return call.where.patientId.in;
    }

    // An account holder's login and number cover a whole family. Treating that
    // as "the same human" put a relative's visits, prescriptions, results and
    // bills into this patient's unified history, where they read as their own.
    it('never pulls a relative on the same account into the timeline', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(child as never);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue([childRow, parentRow] as never);
      stubRecordQueries();

      await patientsService.getGlobalPatientHistory('t1', 'child');

      expect(idsQueried()).toEqual(['child']);
    });

    it('still merges the same person across hospitals', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(child as never);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
      const elsewhere = row({
        id: 'child-elsewhere', tenantId: 't2', firstName: 'Ishaan', lastName: 'Rao',
        dateOfBirth: new Date('2019-09-09'),
      });
      vi.mocked(prisma.patient.findMany).mockResolvedValue([childRow, elsewhere, parentRow] as never);
      stubRecordQueries();

      await patientsService.getGlobalPatientHistory('t1', 'child');

      // The whole point of the view — but only for the one person.
      expect(idsQueried()).toEqual(['child', 'child-elsewhere']);
    });

    it('accepts an ABHA match even when the name has changed', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({
        ...child, abhaNumber: '11-2222-3333-4444',
      } as never);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
      const renamed = row({
        id: 'renamed', firstName: 'Ishaani', lastName: 'Sharma',
        dateOfBirth: new Date('2019-09-09'), abhaNumber: '11-2222-3333-4444',
      });
      vi.mocked(prisma.patient.findMany).mockResolvedValue([childRow, renamed, parentRow] as never);
      stubRecordQueries();

      await patientsService.getGlobalPatientHistory('t1', 'child');

      expect(idsQueried()).toEqual(['child', 'renamed']);
    });
  });

  describe('globalPatientSearch', () => {
    const row = (over: Record<string, unknown>) => ({
      tenantId: 'tenant-1', userId: 'acct', mrn: 'M', phone: '9555111222',
      abhaNumber: null, gender: 'male', tenant: { id: 'tenant-1', name: 'Hospital' },
      ...over,
    });

    beforeEach(() => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
    });

    async function search(rows: unknown[]) {
      vi.mocked(prisma.patient.findMany).mockResolvedValue(rows as never);
      return (await patientsService.globalPatientSearch('tenant-1', 'Nair')) as unknown as {
        firstName: string; localPatientId: string | null;
      }[];
    }

    // Keying one entry per ACCOUNT folded a whole family into a single result,
    // so a desk searching the family surname could only ever see one of them —
    // and the local record offered alongside could belong to the other.
    it('lists each family member on a shared account separately', async () => {
      const out = await search([
        row({ id: 'parent', firstName: 'Vikram', lastName: 'Nair', dateOfBirth: new Date('1978-04-04') }),
        row({ id: 'child', firstName: 'Diya', lastName: 'Nair', dateOfBirth: new Date('2020-11-11') }),
      ]);

      expect(out.map((r) => r.firstName).sort()).toEqual(['Diya', 'Vikram']);
      // Each points at their OWN local record.
      expect(out.find((r) => r.firstName === 'Diya')?.localPatientId).toBe('child');
      expect(out.find((r) => r.firstName === 'Vikram')?.localPatientId).toBe('parent');
    });

    it('still shows one person at two hospitals as one entry', async () => {
      const out = await search([
        row({ id: 'here', firstName: 'Vikram', lastName: 'Nair', dateOfBirth: new Date('1978-04-04') }),
        row({
          id: 'away', tenantId: 'tenant-2', firstName: 'Vikram', lastName: 'Nair',
          dateOfBirth: new Date('1978-04-04'), tenant: { id: 'tenant-2', name: 'Other' },
        }),
      ]);

      expect(out).toHaveLength(1);
      // And the local row is the one in the caller's hospital.
      expect(out[0]!.localPatientId).toBe('here');
    });

    it('treats an ABHA number as the person outright', async () => {
      const out = await search([
        row({ id: 'a1', firstName: 'Vikram', lastName: 'Nair', dateOfBirth: new Date('1978-04-04'), abhaNumber: '11-2222-3333-4444' }),
        // Same human, name since changed — ABHA still ties them together.
        row({ id: 'a2', tenantId: 'tenant-2', firstName: 'Vikram', lastName: 'Menon', dateOfBirth: new Date('1978-04-04'), abhaNumber: '11-2222-3333-4444', tenant: { id: 'tenant-2', name: 'Other' } }),
      ]);

      expect(out).toHaveLength(1);
    });

    it('keeps two households who share a name apart', async () => {
      const out = await search([
        row({ id: 'x', userId: 'acct-a', firstName: 'Vikram', lastName: 'Nair', dateOfBirth: new Date('1978-04-04') }),
        row({ id: 'y', userId: 'acct-b', phone: '9000000000', firstName: 'Vikram', lastName: 'Nair', dateOfBirth: new Date('1978-04-04') }),
      ]);

      expect(out).toHaveLength(2);
    });
  });

  describe('globalLookup', () => {
    const row = (over: Record<string, unknown>) => ({
      tenantId: 't1', userId: 'acct', isSelf: false, relationship: 'child',
      firstName: 'Diya', lastName: 'Nair', dateOfBirth: new Date('2020-11-11'),
      gender: 'female', bloodGroup: null, phone: '9555111222', email: null,
      addressLine1: null, city: null, state: null, country: null, postalCode: null,
      maritalStatus: null, nationality: null, occupation: null,
      abhaNumber: null, abhaAddress: null, idProofNumber: null,
      tenant: { id: 't1', name: 'Hospital' }, ...over,
    });

    async function lookup(rows: unknown[]) {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ id: 'x' }] as never);
      vi.mocked(prisma.patient.findMany).mockResolvedValue(rows as never);
      return (await patientsService.globalLookup({ phone: '9555111222' })) as unknown as {
        found: boolean;
        patient: { firstName: string } | null;
        people: { firstName: string; hospitals: unknown[] }[];
      };
    }

    // A number belongs to a household. Handing back one "representative" gave
    // the caller whoever was the account holder, so a form pre-filling from it
    // replaced the child being registered with the parent.
    it('does not pick a representative when a household shares the number', async () => {
      const res = await lookup([
        row({ id: 'parent', firstName: 'Vikram', dateOfBirth: new Date('1978-04-04'), isSelf: true, relationship: 'self' }),
        row({ id: 'child', firstName: 'Diya' }),
      ]);

      expect(res.found).toBe(true);
      expect(res.people.map((p) => p.firstName).sort()).toEqual(['Diya', 'Vikram']);
      // Nothing to pre-fill from — the caller has to ask which of them it is.
      expect(res.patient).toBeNull();
    });

    it('still answers outright when the number is one person', async () => {
      const res = await lookup([
        row({ id: 'only', firstName: 'Vikram', dateOfBirth: new Date('1978-04-04'), isSelf: true }),
      ]);

      expect(res.people).toHaveLength(1);
      expect(res.patient).toMatchObject({ firstName: 'Vikram' });
    });

    it('counts one person at two hospitals once, and names both', async () => {
      const res = await lookup([
        row({ id: 'here', firstName: 'Vikram', dateOfBirth: new Date('1978-04-04'), isSelf: true }),
        row({
          id: 'away', tenantId: 't2', firstName: 'Vikram', dateOfBirth: new Date('1978-04-04'),
          isSelf: true, tenant: { id: 't2', name: 'Other' },
        }),
      ]);

      expect(res.people).toHaveLength(1);
      expect(res.patient).toMatchObject({ firstName: 'Vikram' });
      expect(res.people[0]!.hospitals).toHaveLength(2);
    });
  });

  describe('findAll', () => {
    it('should return paginated patients', async () => {
      vi.mocked(prisma.patient.findMany).mockResolvedValue([{ id: 'p1' }] as any);
      vi.mocked(prisma.patient.count).mockResolvedValue(1);
      const result = await patientsService.findAll('tenant-1', {});
      expect(result.patients).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should use default pagination values', async () => {
      vi.mocked(prisma.patient.findMany).mockResolvedValue([]);
      vi.mocked(prisma.patient.count).mockResolvedValue(0);
      const result = await patientsService.findAll('tenant-1', {});
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('should filter by search term', async () => {
      vi.mocked(prisma.patient.findMany).mockResolvedValue([]);
      vi.mocked(prisma.patient.count).mockResolvedValue(0);
      await patientsService.findAll('tenant-1', { search: 'John' });
      expect(prisma.patient.findMany).toHaveBeenCalled();
    });

    it('should filter by gender', async () => {
      vi.mocked(prisma.patient.findMany).mockResolvedValue([]);
      vi.mocked(prisma.patient.count).mockResolvedValue(0);
      await patientsService.findAll('tenant-1', { gender: 'male' } as any);
      expect(prisma.patient.findMany).toHaveBeenCalled();
    });

    it('should filter by blood group', async () => {
      vi.mocked(prisma.patient.findMany).mockResolvedValue([]);
      vi.mocked(prisma.patient.count).mockResolvedValue(0);
      await patientsService.findAll('tenant-1', { bloodGroup: 'O+' } as any);
      expect(prisma.patient.findMany).toHaveBeenCalled();
    });

    it('should apply custom sort', async () => {
      vi.mocked(prisma.patient.findMany).mockResolvedValue([]);
      vi.mocked(prisma.patient.count).mockResolvedValue(0);
      await patientsService.findAll('tenant-1', { sortBy: 'firstName', sortOrder: 'asc' } as any);
      expect(prisma.patient.findMany).toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('should return patient with related records', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({
        id: 'p1', firstName: 'John', emergencyContacts: [], allergies: [],
        familyHistory: [], documents: [],
      } as any);
      const result = await patientsService.findById('tenant-1', 'p1');
      expect(result).toBeDefined();
      expect(result.id).toBe('p1');
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);
      await expect(patientsService.findById('tenant-1', 'nonexistent'))
        .rejects.toThrow(AppError);
    });

    it('should include emergency contacts, allergies, family history, and documents', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({
        id: 'p1', emergencyContacts: [{ id: 'ec1' }],
        allergies: [{ id: 'a1' }], familyHistory: [{ id: 'fh1' }],
        documents: [{ id: 'd1' }],
      } as any);
      const result = await patientsService.findById('tenant-1', 'p1');
      expect(result.emergencyContacts).toHaveLength(1);
      expect(result.allergies).toHaveLength(1);
      expect(result.familyHistory).toHaveLength(1);
      expect(result.documents).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('should update patient fields', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'p1', phone: '111' } as any);
      vi.mocked(prisma.patient.update).mockResolvedValue({ id: 'p1', firstName: 'Updated' } as any);
      const result = await patientsService.update('tenant-1', 'p1', { firstName: 'Updated' });
      expect(result.firstName).toBe('Updated');
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);
      await expect(patientsService.update('tenant-1', 'nonexistent', {}))
        .rejects.toThrow(AppError);
    });

    it('should throw conflict if updated phone already belongs to another patient', async () => {
      vi.mocked(prisma.patient.findFirst)
        .mockResolvedValueOnce({ id: 'p1', phone: '111', email: null } as any) // existing patient
        .mockResolvedValueOnce({ id: 'p2', phone: '222' } as any); // phone duplicate
      await expect(
        patientsService.update('tenant-1', 'p1', { phone: '222' }),
      ).rejects.toThrow(AppError);
    });

    it('should throw conflict if updated email already belongs to another patient', async () => {
      vi.mocked(prisma.patient.findFirst)
        .mockResolvedValueOnce({ id: 'p1', phone: '111', email: 'old@test.com' } as any)
        .mockResolvedValueOnce({ id: 'p2', email: 'taken@test.com' } as any); // email duplicate
      await expect(
        patientsService.update('tenant-1', 'p1', { email: 'taken@test.com' }),
      ).rejects.toThrow(AppError);
    });
  });

  describe('search', () => {
    it('should return matching patients', async () => {
      vi.mocked(prisma.patient.findMany).mockResolvedValue([
        { id: 'p1', firstName: 'John' },
      ] as any);
      const result = await patientsService.search('tenant-1', { search: 'John' });
      expect(result).toHaveLength(1);
    });

    it('should return empty array if search term is empty', async () => {
      const result = await patientsService.search('tenant-1', { search: '' });
      expect(result).toEqual([]);
    });

    it('should return empty array if no search term provided', async () => {
      const result = await patientsService.search('tenant-1', {});
      expect(result).toEqual([]);
    });
  });

  describe('addEmergencyContact', () => {
    it('should create emergency contact', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({ id: 'p1' } as any);
      vi.mocked(prisma.patientEmergencyContact.create).mockResolvedValue({
        id: 'ec1', patientId: 'p1', name: 'Jane', relationship: 'spouse',
      } as any);
      const result = await patientsService.addEmergencyContact('p1', {
        name: 'Jane', relationship: 'spouse', phone: '5555555555', isPrimary: false,
      });
      expect(result).toBeDefined();
      expect(result.name).toBe('Jane');
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue(null);
      await expect(
        patientsService.addEmergencyContact('nonexistent', {
          name: 'Jane', relationship: 'spouse', phone: '5555555555', isPrimary: false,
        }),
      ).rejects.toThrow(AppError);
    });

    it('should unset existing primary contacts when adding a new primary', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({ id: 'p1' } as any);
      vi.mocked(prisma.patientEmergencyContact.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(prisma.patientEmergencyContact.create).mockResolvedValue({
        id: 'ec2', patientId: 'p1', name: 'Bob', isPrimary: true,
      } as any);
      await patientsService.addEmergencyContact('p1', {
        name: 'Bob', relationship: 'brother', phone: '5555555556', isPrimary: true,
      });
      expect(prisma.patientEmergencyContact.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { patientId: 'p1', isPrimary: true },
          data: { isPrimary: false },
        }),
      );
    });
  });

  describe('addAllergy', () => {
    beforeEach(() => {
      // Ensure findFirst is available on patientAllergy (may not be in global setup mock)
      if (!(prisma.patientAllergy as any).findFirst) {
        (prisma.patientAllergy as any).findFirst = vi.fn();
      }
    });

    it('should create allergy record', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({ id: 'p1' } as any);
      vi.mocked((prisma.patientAllergy as any).findFirst).mockResolvedValue(null);
      vi.mocked(prisma.patientAllergy.create).mockResolvedValue({
        id: 'a1', patientId: 'p1', allergen: 'Peanuts',
      } as any);
      const result = await patientsService.addAllergy('p1', {
        allergen: 'Peanuts', severity: 'severe', type: 'food',
      });
      expect(result).toBeDefined();
      expect(result.allergen).toBe('Peanuts');
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue(null);
      await expect(
        patientsService.addAllergy('nonexistent', {
          allergen: 'Peanuts', severity: 'severe', type: 'food',
        }),
      ).rejects.toThrow(AppError);
    });

    it('should throw conflict if allergy already recorded', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({ id: 'p1' } as any);
      vi.mocked((prisma.patientAllergy as any).findFirst).mockResolvedValue({
        id: 'a1', allergen: 'Peanuts',
      });
      await expect(
        patientsService.addAllergy('p1', {
          allergen: 'Peanuts', severity: 'severe', type: 'food',
        }),
      ).rejects.toThrow(AppError);
    });
  });

  describe('addFamilyHistory', () => {
    it('should create family history', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({ id: 'p1' } as any);
      vi.mocked(prisma.patientFamilyHistory.create).mockResolvedValue({
        id: 'fh1', patientId: 'p1', conditionName: 'Diabetes',
      } as any);
      const result = await patientsService.addFamilyHistory('p1', {
        condition: 'Diabetes', relationship: 'father', isDeceased: false,
      });
      expect(result).toBeDefined();
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue(null);
      await expect(
        patientsService.addFamilyHistory('nonexistent', {
          condition: 'Diabetes', relationship: 'father', isDeceased: false,
        }),
      ).rejects.toThrow(AppError);
    });
  });

  describe('addDocument', () => {
    it('should create patient document', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({ id: 'p1' } as any);
      vi.mocked(prisma.patientDocument.create).mockResolvedValue({
        id: 'd1', patientId: 'p1', title: 'X-Ray Report',
      } as any);
      const result = await patientsService.addDocument('p1', {
        title: 'X-Ray Report', type: 'imaging', fileUrl: 'https://cdn.example.com/xray.pdf',
        fileName: 'xray.pdf',
      });
      expect(result).toBeDefined();
      expect(result.title).toBe('X-Ray Report');
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue(null);
      await expect(
        patientsService.addDocument('nonexistent', {
          title: 'X-Ray', type: 'imaging', fileUrl: 'https://cdn.example.com/xray.pdf',
          fileName: 'xray.pdf',
        }),
      ).rejects.toThrow(AppError);
    });

    it('should map document type correctly', async () => {
      vi.mocked(prisma.patient.findUnique).mockResolvedValue({ id: 'p1' } as any);
      vi.mocked(prisma.patientDocument.create).mockResolvedValue({
        id: 'd1', patientId: 'p1', documentType: 'insurance_card',
      } as any);
      await patientsService.addDocument('p1', {
        title: 'Insurance Card', type: 'insurance', fileUrl: 'https://cdn.example.com/ins.pdf',
        fileName: 'ins.pdf',
      });
      const createCall = vi.mocked(prisma.patientDocument.create).mock.calls[0][0];
      expect((createCall as any).data.documentType).toBe('insurance_card');
    });
  });

  // There was no read side at all: the portal saved "My Documents" rows and
  // nothing could list them, so a referral letter a patient uploaded FOR their
  // doctor never reached one.
  describe('getDocuments', () => {
    const setup = (docs: unknown[], personRows: unknown[] = [{ userId: 'patient-user' }]) => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'p1' } as any);
      vi.mocked(prisma.patientDocument.findMany).mockResolvedValue(docs as any);
      vi.mocked(prisma.patient.findMany).mockResolvedValue(personRows as any);
    };

    it('flags a portal upload as coming from the patient', async () => {
      setup([
        {
          id: 'd1', documentType: 'other', title: 'Referral letter', fileUrl: '/uploads/a.pdf',
          mimeType: 'application/pdf', fileSizeBytes: BigInt(1024), notes: null, isVerified: false,
          createdAt: new Date(), uploadedBy: 'patient-user',
          uploader: { id: 'patient-user', firstName: 'Asha', lastName: 'Menon' },
          patient: { id: 'p1', tenantId: 'tenant-1', tenant: { name: 'Green city' } },
        },
      ]);

      const [doc] = await patientsService.getDocuments('tenant-1', 'p1');

      expect(doc).toMatchObject({ title: 'Referral letter', uploadedByPatient: true });
    });

    it('does not flag a staff upload as a patient upload', async () => {
      setup([
        {
          id: 'd2', documentType: 'other', title: 'Consent form', fileUrl: '/uploads/b.pdf',
          mimeType: 'application/pdf', fileSizeBytes: null, notes: null, isVerified: true,
          createdAt: new Date(), uploadedBy: 'staff-user',
          uploader: { id: 'staff-user', firstName: 'Front', lastName: 'Desk' },
          patient: { id: 'p1', tenantId: 'tenant-1', tenant: { name: 'Green city' } },
        },
      ]);

      const [doc] = await patientsService.getDocuments('tenant-1', 'p1');

      expect(doc.uploadedByPatient).toBe(false);
      expect(doc.sourceHospital).toBeNull();
    });

    // One human has a separate Patient row per hospital. A document uploaded
    // once belongs to the person, so it shows here — labelled with where it
    // came from, since that changes how a clinician reads it.
    it('names the other hospital when the file was filed there', async () => {
      setup([
        {
          id: 'd3', documentType: 'other', title: 'Old discharge summary',
          fileUrl: '/uploads/c.pdf', mimeType: 'application/pdf', fileSizeBytes: null,
          notes: null, isVerified: false, createdAt: new Date(), uploadedBy: 'patient-user',
          uploader: { id: 'patient-user', firstName: 'Asha', lastName: null },
          patient: { id: 'p2', tenantId: 'tenant-2', tenant: { name: 'City Care' } },
        },
      ]);

      const [doc] = await patientsService.getDocuments('tenant-1', 'p1');

      expect(doc.sourceHospital).toBe('City Care');
    });

    it('throws notFound when the patient is not in this tenant', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);
      await expect(patientsService.getDocuments('tenant-1', 'nope')).rejects.toThrow(AppError);
    });
  });

  describe('getVisitHistory', () => {
    it('should return patient visit history', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'p1' } as any);
      vi.mocked(prisma.visit.findMany).mockResolvedValue([
        { id: 'v1', patientId: 'p1', type: 'op' },
      ] as any);
      const result = await patientsService.getVisitHistory('tenant-1', 'p1');
      expect(result).toHaveLength(1);
    });

    it('should throw notFound if patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue(null);
      await expect(
        patientsService.getVisitHistory('tenant-1', 'nonexistent'),
      ).rejects.toThrow(AppError);
    });

    it('should return empty array if no visits exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'p1' } as any);
      vi.mocked(prisma.visit.findMany).mockResolvedValue([]);
      const result = await patientsService.getVisitHistory('tenant-1', 'p1');
      expect(result).toHaveLength(0);
    });
  });
});
