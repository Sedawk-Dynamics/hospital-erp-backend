import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../src/config/database';
import { seedTenantLabCatalogs } from '../../../src/seeds/tenant-lab-catalog';

// The platform's lab TEMPLATES are seeded on every boot, but what a doctor
// searches when raising an order is LabTestCatalog, which is PER TENANT and was
// only ever filled by an admin pressing "clone all" by hand. A hospital nobody
// had pressed it for had an empty catalog, so the doctor's search came back
// with nothing however well the search itself worked.

const cloneTemplatesIntoTenant = vi.fn();
vi.mock('../../../src/modules/lab/lab-templates.service', () => ({
  cloneTemplatesIntoTenant: (...a: unknown[]) => cloneTemplatesIntoTenant(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  cloneTemplatesIntoTenant.mockResolvedValue({ created: 36, updated: 0, skipped: 0, total: 36 });
  vi.mocked(prisma.labTestTemplate.count).mockResolvedValue(36 as never);
});

const run = () => seedTenantLabCatalogs(prisma as never);

describe('provisioning a hospital lab catalog', () => {
  it('clones the templates into a hospital that has none', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([{ id: 't1', name: 'Green city' }] as never);
    vi.mocked(prisma.labTestCatalog.count).mockResolvedValue(0 as never);

    await run();

    expect(cloneTemplatesIntoTenant).toHaveBeenCalledWith('t1', { overwriteExisting: false });
  });

  it('leaves a hospital that already has a catalog completely alone', async () => {
    // Theirs is curated — prices edited, tests they do not run deactivated.
    // Topping it up on every deploy would re-add what an admin removed.
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([{ id: 't1', name: 'Green city' }] as never);
    vi.mocked(prisma.labTestCatalog.count).mockResolvedValue(37 as never);

    await run();

    expect(cloneTemplatesIntoTenant).not.toHaveBeenCalled();
  });

  it('counts custom tests as a catalog, so a hospital curating its own is not touched', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([{ id: 't1', name: 'Green city' }] as never);
    vi.mocked(prisma.labTestCatalog.count).mockResolvedValue(1 as never);

    await run();

    // The count is unfiltered on purpose — one hand-authored test still means
    // someone has started curating.
    const where = vi.mocked(prisma.labTestCatalog.count).mock.calls[0][0]!.where as any;
    expect(where).toEqual({ tenantId: 't1' });
    expect(cloneTemplatesIntoTenant).not.toHaveBeenCalled();
  });

  it('skips the platform tenant, which is not a hospital', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([] as never);

    await run();

    const where = vi.mocked(prisma.tenant.findMany).mock.calls[0][0]!.where as any;
    expect(where.slug).toEqual({ not: '__platform__' });
    expect(where.isActive).toBe(true);
  });

  it('does nothing when there are no templates to clone yet', async () => {
    vi.mocked(prisma.labTestTemplate.count).mockResolvedValue(0 as never);

    await run();

    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
    expect(cloneTemplatesIntoTenant).not.toHaveBeenCalled();
  });

  it('provisions each empty hospital independently', async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: 't1', name: 'A' },
      { id: 't2', name: 'B' },
    ] as never);
    vi.mocked(prisma.labTestCatalog.count)
      .mockResolvedValueOnce(0 as never)
      .mockResolvedValueOnce(12 as never);

    await run();

    expect(cloneTemplatesIntoTenant).toHaveBeenCalledTimes(1);
    expect(cloneTemplatesIntoTenant).toHaveBeenCalledWith('t1', { overwriteExisting: false });
  });
});
