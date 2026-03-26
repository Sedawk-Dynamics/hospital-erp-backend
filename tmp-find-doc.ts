import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
const p = new PrismaClient();
async function main() {
  const hash = await bcrypt.hash('Admin@123', 12);
  await p.user.update({
    where: { id: '7313ea73-73fa-4582-8956-ca4c4cc35100' },
    data: { passwordHash: hash },
  });
  console.log('Patient password reset to Admin@123 for demopatient@test.com');
  await p.$disconnect();
}
main();
