import { PrismaClient } from '@prisma/client';
async function main() {
  const p = new PrismaClient();
  const [t]: any[] = await p.$queryRawUnsafe(
    `SELECT id, name FROM tenants WHERE name ILIKE '%green%' LIMIT 1`);
  console.log('tenant:', t?.name, t?.id);

  const narc: any[] = await p.$queryRawUnsafe(
    `SELECT f.id, f.drug_name, f.schedule, f.controlled_class, f.vault_controlled, f.is_narcotic
     FROM drug_formulary f WHERE f.tenant_id = $1 AND (f.vault_controlled = true OR f.is_narcotic = true)
     LIMIT 5`, t.id);
  console.log(`\nvault/narcotic formulary drugs: ${narc.length}`);
  for (const d of narc) console.log(`  ${d.drug_name} | ${d.schedule} | ${d.controlled_class} | vault=${d.vault_controlled} narc=${d.is_narcotic}`);

  const batches: any[] = await p.$queryRawUnsafe(
    `SELECT b.id, b.batch_number, b.quantity_in_stock, f.drug_name
     FROM drug_batches b JOIN drug_formulary f ON f.id = b.drug_id
     WHERE b.tenant_id = $1 AND f.vault_controlled = true AND b.quantity_in_stock > 10
     LIMIT 3`, t.id);
  console.log(`\nvault batches with stock: ${batches.length}`);
  for (const b of batches) console.log(`  ${b.drug_name} ${b.batch_number} qty=${b.quantity_in_stock} id=${b.id}`);

  const users: any[] = await p.$queryRawUnsafe(
    `SELECT id, email, first_name FROM users WHERE tenant_id = $1 LIMIT 4`, t.id);
  console.log(`\nusers: ${users.map((u) => u.email).join(', ')}`);

  const depts: any[] = await p.$queryRawUnsafe(
    `SELECT id, name FROM departments WHERE tenant_id = $1 LIMIT 4`, t.id);
  console.log(`departments: ${depts.map((d) => d.name).join(', ')}`);
  await p.$disconnect();
}
main();
