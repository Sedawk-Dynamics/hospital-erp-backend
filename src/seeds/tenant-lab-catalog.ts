/**
 * Give every hospital a lab catalog to order from.
 *
 * The platform's `LabTestTemplate` rows are seeded on every boot, but the thing
 * a doctor actually searches when raising a lab order is `LabTestCatalog`,
 * which is PER TENANT. It was only ever populated by a hospital admin pressing
 * "clone all" by hand — so a hospital nobody had pressed it for had an empty
 * catalog, and the doctor's search came back with nothing no matter what they
 * typed. That is the "not showing all lab test names in production" report.
 *
 * Deliberately only fills an EMPTY catalog:
 *
 *   • A hospital that already has one has made it theirs — edited prices,
 *     renamed tests, deactivated the ones it does not run. Topping that up on
 *     every deploy would be this seed writing into live clinical config
 *     unasked, and re-adding tests an admin had deliberately removed.
 *   • Custom tests (templateId null) are invisible to the clone either way.
 *
 * So it is a provisioning step, not a sync. A hospital that wants newly shipped
 * templates still presses "clone all", which is what that button is for.
 */
import type { PrismaClient } from '@prisma/client';
import { logger } from '../config/logger';
import { cloneTemplatesIntoTenant } from '../modules/lab/lab-templates.service';

export async function seedTenantLabCatalogs(prisma: PrismaClient): Promise<void> {
  const published = await prisma.labTestTemplate.count({ where: { isPublished: true } });
  if (published === 0) {
    // Nothing to clone yet — the template seed runs before this one, but if it
    // failed, cloning zero rows into every tenant is not worth the queries.
    logger.info('[auto-seed] lab catalog: no published templates, nothing to clone');
    return;
  }

  const tenants = await prisma.tenant.findMany({
    where: {
      isActive: true,
      // The platform tenant is not a hospital — nobody orders a lab test there.
      slug: { not: '__platform__' },
    },
    select: { id: true, name: true },
  });

  let provisioned = 0;
  for (const tenant of tenants) {
    // "Empty" means no catalog rows at all, custom ones included: a hospital
    // that authored its own tests has started curating, and this must not
    // start adding to that.
    const existing = await prisma.labTestCatalog.count({ where: { tenantId: tenant.id } });
    if (existing > 0) continue;

    const res = await cloneTemplatesIntoTenant(tenant.id, { overwriteExisting: false });
    provisioned += 1;
    logger.info(
      { tenantId: tenant.id, tenant: tenant.name, created: res.created },
      '[auto-seed] lab catalog provisioned for hospital with none',
    );
  }

  if (provisioned === 0) {
    logger.info(`[auto-seed] lab catalog: all ${tenants.length} hospital(s) already have one`);
  }
}
