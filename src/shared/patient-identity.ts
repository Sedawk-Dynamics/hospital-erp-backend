import { prisma } from '../config/database';
import { phoneLast10 } from './account-holder';

// ============================================================
// "Which patient rows are the same human being?"
// ============================================================
//
// A person gets one Patient row per hospital (per-tenant MRN — see the global
// patient identity work), and the front desk can also end up with duplicate
// rows inside a single hospital. Person-level clinical facts — allergies,
// family history, lifestyle/personal history — belong to the human, not to the
// row, so they are resolved across every row that IS that human.
//
// Picking the identity key is a patient-safety decision, not a convenience:
//
//   • `userId` alone is WRONG. One portal account owns a whole family's
//     profiles (Patient.relationship / isSelf), so grouping on userId would
//     merge a mother's and her child's allergies.
//   • `phone` alone is WRONG for the same reason — families share a number.
//     (`globalPatientSearch` groups on userId/phone, but only to de-duplicate
//     a *search list*; nothing clinical is merged there.)
//
// So we require an identifier that is unique to one human:
//
//   1. ABHA number — government identity, `@unique` on the column.
//   2. Otherwise, same account AND same person within it: identical userId
//      plus matching name + date of birth.
//   3. Otherwise, matching name + date of birth + phone (last 10 digits) —
//      all three, so a mother and child on one number stay separate.
//
// Anything weaker returns the single row it was given.

/** Normalised name key — case/spacing insensitive. */
function nameKey(first: string | null, last: string | null): string {
  return `${(first ?? '').trim().toLowerCase()} ${(last ?? '').trim().toLowerCase()}`.trim();
}

function dobKey(dob: Date | null): string {
  return dob ? dob.toISOString().slice(0, 10) : '';
}

interface IdentityRow {
  id: string;
  userId: string | null;
  abhaNumber: string | null;
  firstName: string;
  lastName: string | null;
  dateOfBirth: Date | null;
  phone: string | null;
}

const IDENTITY_SELECT = {
  id: true,
  userId: true,
  abhaNumber: true,
  firstName: true,
  lastName: true,
  dateOfBirth: true,
  phone: true,
} as const;

/**
 * Every active patient row that is the same person as `patientId`, including
 * `patientId` itself. Always returns at least that one id.
 *
 * Deliberately NOT tenant-scoped: an allergy recorded at one hospital has to
 * be visible at the next one. Callers still authorise access to the patientId
 * they were handed (verifyPatientTenant) before calling this.
 */
export async function resolvePersonPatientIds(patientId: string): Promise<string[]> {
  const self = await prisma.patient.findUnique({
    where: { id: patientId },
    select: IDENTITY_SELECT,
  });
  if (!self) return [patientId];

  // 1. ABHA — unique per individual, so it stands alone.
  if (self.abhaNumber) {
    const rows = await prisma.patient.findMany({
      where: { isActive: true, abhaNumber: self.abhaNumber },
      select: { id: true },
    });
    return dedupe([patientId, ...rows.map((r) => r.id)]);
  }

  const selfName = nameKey(self.firstName, self.lastName);
  const selfDob = dobKey(self.dateOfBirth);
  // Without a date of birth the name alone is too weak to merge on safely.
  if (!selfDob || !selfName) return [patientId];

  // 2. Same account, same human inside it.
  if (self.userId) {
    const rows = await prisma.patient.findMany({
      where: { isActive: true, userId: self.userId },
      select: IDENTITY_SELECT,
    });
    return dedupe([patientId, ...rows.filter((r) => samePerson(r, selfName, selfDob)).map((r) => r.id)]);
  }

  // 3. No account: name + DOB + phone must all line up.
  const last10 = self.phone ? phoneLast10(self.phone) : '';
  if (last10.length < 7) return [patientId];
  const idRows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM patients
    WHERE is_active = true
      AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${last10}
    LIMIT 200
  `;
  if (idRows.length === 0) return [patientId];
  const candidates = await prisma.patient.findMany({
    where: { id: { in: idRows.map((r) => r.id) } },
    select: IDENTITY_SELECT,
  });
  return dedupe([
    patientId,
    ...candidates.filter((r) => samePerson(r, selfName, selfDob)).map((r) => r.id),
  ]);
}

function samePerson(row: IdentityRow, name: string, dob: string): boolean {
  return nameKey(row.firstName, row.lastName) === name && dobKey(row.dateOfBirth) === dob;
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

/**
 * The single row that person-level singleton data (personal history) is stored
 * on, so a person never ends up with one lifestyle record per hospital.
 * Deterministic: the row that already carries personal history, else the
 * oldest row by creation, else the id we were given.
 */
export async function resolvePersonCanonicalPatientId(patientId: string): Promise<string> {
  const ids = await resolvePersonPatientIds(patientId);
  if (ids.length <= 1) return patientId;

  const existing = await prisma.patientPersonalHistory.findMany({
    where: { patientId: { in: ids } },
    select: { patientId: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (existing.length > 0) return existing[0].patientId;

  const oldest = await prisma.patient.findMany({
    where: { id: { in: ids } },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 1,
  });
  return oldest[0]?.id ?? patientId;
}
