/**
 * Backfill phone numbers for phone-only patient login.
 *
 * Patients now sign in ONLY by phone + OTP, so every patient account needs a
 * phone number. Legacy patients who signed up when phone was optional may have
 * none. This assigns each such patient account a random, obviously-synthetic
 * placeholder number (prefix +910000…, outside the real Indian mobile range so
 * it never collides with a genuine number) — front desk / the patient can
 * replace it with the real number later.
 *
 * Scope: platform-tenant users that carry the `patient` role and have no phone.
 *
 * Safe to re-run (only touches accounts that still lack a phone).
 *   npm run db:seed:patient-phones
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomAutoPhone } from '../../src/shared/account-holder';

const prisma = new PrismaClient();

async function uniqueAutoPhone(): Promise<string> {
  // Avoid clashing with an existing number (auto or real).
  for (let i = 0; i < 25; i++) {
    const candidate = randomAutoPhone();
    const clash = await prisma.user.findFirst({ where: { phone: candidate }, select: { id: true } });
    if (!clash) return candidate;
  }
  // Extremely unlikely; fall back to a time-seeded value.
  return `+910000${Date.now().toString().slice(-7)}`;
}

async function main() {
  console.log('=== Backfill patient phone numbers ===');

  const patients = await prisma.user.findMany({
    where: {
      userRoles: { some: { role: { name: 'patient' } } },
      OR: [{ phone: null }, { phone: '' }],
    },
    select: { id: true, email: true, firstName: true },
  });

  console.log(`[patients] ${patients.length} account(s) without a phone`);

  let updated = 0;
  for (const p of patients) {
    const phone = await uniqueAutoPhone();
    await prisma.user.update({ where: { id: p.id }, data: { phone } });
    updated++;
    console.log(`  ${p.firstName ?? '(no name)'} <${p.email}> → ${phone}`);
  }

  console.log(`=== done — assigned ${updated} number(s) ===`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
