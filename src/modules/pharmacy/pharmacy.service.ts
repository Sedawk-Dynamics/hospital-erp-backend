import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateCategoryInput,
  UpdateCategoryInput,
  CreateFormularyInput,
  UpdateFormularyInput,
  ImportFormularyInput,
  GetFormularyQuery,
  CreateBatchInput,
  UpdateBatchInput,
  GetBatchesQuery,
  GetExpiringBatchesQuery,
  CreateDispenseInput,
  CreatePharmacySaleInput,
  GetDispenseQuery,
  CreateReturnInput,
  GetReturnsQuery,
  ProcessReturnInput,
  RecallBatchInput,
  RecallDrugInput,
  GetRecalledItemsQuery,
  GetGstReportQuery,
} from './pharmacy.validation';

// ============================================================
// Role guard — master/stock management is pharmacy_admin only
// ============================================================
// pharmacist holds pharmacy:create/update so it can DISPENSE and take patient
// RETURNS, but those same perms must not let it manage the formulary, drug
// categories or stock batches. This service-level guard enforces the 2-role
// split (mirrors lab's assertCanCloneTemplates). admin/super_admin always pass.
const PHARMACY_ADMIN_ROLES = new Set(['super_admin', 'admin', 'pharmacy_admin']);

function assertPharmacyAdmin(roles: string[], action = 'manage pharmacy master data'): void {
  if (!roles.some((r) => PHARMACY_ADMIN_ROLES.has(r))) {
    throw AppError.forbidden(`Only a pharmacy admin can ${action}.`);
  }
}

// ============================================================
// Drug Categories
// ============================================================

export async function createDrugCategory(
  tenantId: string,
  roles: string[],
  data: CreateCategoryInput,
) {
  assertPharmacyAdmin(roles, 'create drug categories');
  const existing = await prisma.drugCategory.findFirst({
    where: { tenantId, name: data.name },
  });

  if (existing) {
    throw AppError.conflict('A drug category with this name already exists');
  }

  const category = await prisma.drugCategory.create({
    data: {
      tenantId,
      name: data.name,
      description: data.description,
    },
  });

  logger.info({ tenantId, categoryId: category.id }, 'Drug category created');
  return category;
}

export async function getDrugCategories(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { description: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [categories, total] = await Promise.all([
    prisma.drugCategory.findMany({
      where,
      skip,
      take,
      orderBy: { name: 'asc' },
    }),
    prisma.drugCategory.count({ where }),
  ]);

  return { categories, total, page, limit };
}

export async function updateDrugCategory(
  tenantId: string,
  roles: string[],
  id: string,
  data: UpdateCategoryInput,
) {
  assertPharmacyAdmin(roles, 'edit drug categories');
  const existing = await prisma.drugCategory.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Drug category not found');
  }

  if (data.name && data.name !== existing.name) {
    const duplicate = await prisma.drugCategory.findFirst({
      where: { tenantId, name: data.name, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict('A drug category with this name already exists');
    }
  }

  const updateData: any = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;

  const category = await prisma.drugCategory.update({
    where: { id },
    data: updateData,
  });

  logger.info({ tenantId, categoryId: id }, 'Drug category updated');
  return category;
}

export async function deleteDrugCategory(tenantId: string, id: string) {
  const existing = await prisma.drugCategory.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Drug category not found');
  }

  // Check if any formulary items reference this category
  const formularyCount = await prisma.drugFormulary.count({
    where: { tenantId, categoryId: id },
  });

  if (formularyCount > 0) {
    throw AppError.badRequest(
      `Cannot delete category. ${formularyCount} formulary item(s) are linked to this category.`,
    );
  }

  await prisma.drugCategory.delete({ where: { id } });

  logger.info({ tenantId, categoryId: id }, 'Drug category deleted');
}

// ============================================================
// Formulary
// ============================================================

export async function createFormularyItem(
  tenantId: string,
  roles: string[],
  data: CreateFormularyInput,
) {
  assertPharmacyAdmin(roles, 'add formulary drugs');
  // Validate category exists if provided
  if (data.categoryId) {
    const category = await prisma.drugCategory.findFirst({
      where: { id: data.categoryId, tenantId },
    });
    if (!category) {
      throw AppError.notFound('Drug category not found');
    }
  }

  const formularyItem = await prisma.drugFormulary.create({
    data: {
      tenantId,
      drugName: data.drugName,
      genericName: data.genericName,
      categoryId: data.categoryId,
      manufacturer: data.manufacturer,
      dosageForm: data.dosageForm as any,
      strength: data.strength,
      unitOfMeasurement: data.unitOfMeasurement,
      price: data.price,
      packSize: data.packSize,
      looseUnitLabel: data.looseUnitLabel,
      taxPercent: data.taxPercent,
      indications: data.indications,
      contraindications: data.contraindications,
      isActive: data.isActive ?? true,
    },
    include: {
      category: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, formularyId: formularyItem.id }, 'Formulary item created');
  return formularyItem;
}

/**
 * NPPA / DPCO price-control watch (READ-ONLY). Lists the scheduled
 * (price-controlled) drugs THIS hospital stocks and compares the hospital's own
 * per-unit price (active batch selling price, else formulary price) against the
 * official NPPA ceiling. Never writes anything — the hospital decides whether to
 * re-price. The ceiling lives on the shared DrugMaster; each tenant's own price
 * is independent.
 */
export async function getPriceControlWatch(tenantId: string) {
  const rows = await prisma.drugFormulary.findMany({
    where: { tenantId, drugMaster: { isScheduled: true } },
    select: {
      id: true,
      drugName: true,
      genericName: true,
      price: true,
      drugMaster: {
        select: {
          ceilingPrice: true,
          ceilingUnit: true,
          nppaNotification: true,
          ceilingEffectiveDate: true,
        },
      },
      drugBatches: {
        where: { isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } },
        select: { sellingPrice: true },
        orderBy: { expiryDate: 'asc' },
        take: 1,
      },
    },
    orderBy: { drugName: 'asc' },
  });

  const items = rows.map((r) => {
    const batchPrice = r.drugBatches[0]?.sellingPrice;
    const hospitalPrice =
      batchPrice != null ? Number(batchPrice) : r.price != null ? Number(r.price) : null;
    const ceiling = r.drugMaster?.ceilingPrice != null ? Number(r.drugMaster.ceilingPrice) : null;
    const isOverCeiling = hospitalPrice != null && ceiling != null && hospitalPrice > ceiling;
    return {
      formularyId: r.id,
      drugName: r.drugName,
      genericName: r.genericName,
      hospitalPrice,
      priceSource: batchPrice != null ? 'batch' : r.price != null ? 'formulary' : null,
      ceilingPrice: ceiling,
      ceilingUnit: r.drugMaster?.ceilingUnit ?? null,
      nppaNotification: r.drugMaster?.nppaNotification ?? null,
      ceilingEffectiveDate: r.drugMaster?.ceilingEffectiveDate ?? null,
      isOverCeiling,
    };
  });

  return {
    items,
    total: items.length,
    overCeilingCount: items.filter((i) => i.isOverCeiling).length,
  };
}

/**
 * Import a drug from the platform-wide DrugMaster catalog into this tenant's
 * formulary (the "clone" step — mirrors lab template -> catalog cloning). If
 * the tenant already imported the same catalog entry, the existing formulary
 * row is returned instead of creating a duplicate.
 */
export async function importFormularyItem(
  tenantId: string,
  roles: string[],
  data: ImportFormularyInput,
) {
  assertPharmacyAdmin(roles, 'import drugs into the formulary');
  const master = await prisma.drugMaster.findUnique({ where: { id: data.drugMasterId } });
  if (!master) throw AppError.notFound('Drug not found in catalog');
  if (!master.isPublished) throw AppError.badRequest('Drug is not published in the catalog');

  if (data.categoryId) {
    const category = await prisma.drugCategory.findFirst({
      where: { id: data.categoryId, tenantId },
    });
    if (!category) throw AppError.notFound('Drug category not found');
  }

  // Dedupe: a tenant should only have one formulary row per catalog entry.
  const existing = await prisma.drugFormulary.findFirst({
    where: { tenantId, drugMasterId: master.id },
    include: { category: { select: { id: true, name: true } } },
  });
  if (existing) return { item: existing, status: 'already_imported' as const };

  const item = await prisma.drugFormulary.create({
    data: {
      tenantId,
      drugMasterId: master.id,
      drugName: master.name,
      // Catalog columns are wider than the formulary's — clamp to the formulary
      // column widths (genericName 255, unitOfMeasurement 20) to avoid overflow.
      genericName: master.genericName?.slice(0, 255) ?? null,
      categoryId: data.categoryId ?? null,
      manufacturer: master.manufacturer,
      dosageForm: master.dosageForm,
      strength: master.strength,
      unitOfMeasurement: master.packSizeLabel?.slice(0, 20) ?? null,
      // Default selling price from the catalog MRP; the hospital can override
      // at import time or edit later.
      price: data.price ?? master.mrp ?? undefined,
      isActive: true,
    },
    include: { category: { select: { id: true, name: true } } },
  });

  logger.info(
    { tenantId, formularyId: item.id, drugMasterId: master.id },
    'Formulary item imported from catalog',
  );
  return { item, status: 'created' as const };
}

/**
 * Bulk import — copy many catalog drugs into the tenant formulary in one call.
 * Dedupes against already-imported entries (by drugMasterId) so re-running is
 * safe. MRP becomes the default selling price; the hospital edits prices after.
 */
export async function importFormularyItemsBulk(
  tenantId: string,
  roles: string[],
  data: { drugMasterIds: string[]; categoryId?: string },
) {
  assertPharmacyAdmin(roles, 'import drugs into the formulary');
  const ids = Array.from(new Set(data.drugMasterIds));

  if (data.categoryId) {
    const category = await prisma.drugCategory.findFirst({
      where: { id: data.categoryId, tenantId },
    });
    if (!category) throw AppError.notFound('Drug category not found');
  }

  const [masters, already] = await Promise.all([
    prisma.drugMaster.findMany({ where: { id: { in: ids }, isPublished: true } }),
    prisma.drugFormulary.findMany({
      where: { tenantId, drugMasterId: { in: ids } },
      select: { drugMasterId: true },
    }),
  ]);

  const importedSet = new Set(already.map((a) => a.drugMasterId));
  const toCreate = masters.filter((m) => !importedSet.has(m.id));

  if (toCreate.length) {
    await prisma.drugFormulary.createMany({
      data: toCreate.map((m) => ({
        tenantId,
        drugMasterId: m.id,
        drugName: m.name,
        // Clamp to the formulary column widths (catalog columns are wider):
        // genericName 255 (catalog 500), unitOfMeasurement 20 (packSizeLabel 255).
        genericName: m.genericName?.slice(0, 255) ?? null,
        categoryId: data.categoryId ?? null,
        manufacturer: m.manufacturer,
        dosageForm: m.dosageForm,
        strength: m.strength,
        unitOfMeasurement: m.packSizeLabel?.slice(0, 20) ?? null,
        price: m.mrp ?? undefined,
        isActive: true,
      })),
    });
  }

  logger.info(
    { tenantId, requested: ids.length, created: toCreate.length },
    'Bulk formulary import from catalog',
  );
  return {
    requested: ids.length,
    created: toCreate.length,
    skipped: ids.length - toCreate.length,
  };
}

/**
 * Tenant-facing catalog browse — paginated view of the platform DrugMaster with
 * an `imported` flag per row (and the tenant formularyId when already copied), so
 * a hospital can browse the full catalog and see what it has / hasn't imported.
 * Supports text search, dosage-form / schedule filters, and an imported filter.
 */
export async function getTenantCatalog(tenantId: string, query: any) {
  const { skip, take, page, limit } = getPaginationParams(query);

  // The tenant's already-imported catalog ids → drives the flag + filter.
  const importedRows = await prisma.drugFormulary.findMany({
    where: { tenantId, drugMasterId: { not: null } },
    select: { id: true, drugMasterId: true },
  });
  const importedMap = new Map<string, string>(); // drugMasterId → formularyId
  for (const r of importedRows) if (r.drugMasterId) importedMap.set(r.drugMasterId, r.id);
  const importedIds = [...importedMap.keys()];

  const where: any = { isPublished: true, isDiscontinued: false };
  if (query.search) {
    const terms = String(query.search)
      .toLowerCase()
      .split(/\s+/)
      .map((t: string) => t.trim())
      .filter(Boolean);
    where.AND = terms.map((term: string) => ({
      searchTokens: { contains: term, mode: 'insensitive' as const },
    }));
  }
  if (query.dosageForm) where.dosageForm = query.dosageForm;
  if (query.schedule) where.schedule = query.schedule;
  if (query.imported === 'yes') {
    where.id = { in: importedIds }; // empty → no rows, which is correct
  } else if (query.imported === 'no' && importedIds.length) {
    where.id = { notIn: importedIds };
  }

  const [rows, total] = await Promise.all([
    prisma.drugMaster.findMany({
      where,
      skip,
      take,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        genericName: true,
        manufacturer: true,
        dosageForm: true,
        strength: true,
        packSizeLabel: true,
        mrp: true,
        schedule: true,
        isScheduled: true,
        ceilingPrice: true,
      },
    }),
    prisma.drugMaster.count({ where }),
  ]);

  const items = rows.map((r) => ({
    ...r,
    imported: importedMap.has(r.id),
    formularyId: importedMap.get(r.id) ?? null,
  }));

  return { items, total, page, limit };
}

export async function getFormulary(tenantId: string, query: GetFormularyQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.dosageForm) where.dosageForm = query.dosageForm;
  if (query.isActive !== undefined) where.isActive = query.isActive;

  // Stock filter — derived from available (non-expired, non-recalled, qty>0)
  // batches via a relation filter so the pharmacy can see what is / isn't stocked.
  const availableBatchFilter = {
    isExpired: false,
    isRecalled: false,
    quantityInStock: { gt: 0 },
  };
  if ((query as any).stockStatus === 'in') {
    where.drugBatches = { some: availableBatchFilter };
  } else if ((query as any).stockStatus === 'out') {
    where.drugBatches = { none: availableBatchFilter };
  }

  if (query.search) {
    where.OR = [
      { drugName: { contains: query.search, mode: 'insensitive' } },
      { genericName: { contains: query.search, mode: 'insensitive' } },
      { manufacturer: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.drugFormulary.findMany({
      where,
      skip,
      take,
      include: {
        category: { select: { id: true, name: true } },
        // Only the in-stock batches — drives the per-row stock summary.
        drugBatches: {
          where: availableBatchFilter,
          select: { quantityInStock: true, expiryDate: true },
        },
      },
      orderBy: { drugName: 'asc' },
    }),
    prisma.drugFormulary.count({ where }),
  ]);

  // Roll batch rows up into a stock summary so the formulary list can show
  // In Stock (qty) / Out of Stock without a second round-trip.
  const shaped = items.map((it) => {
    const { drugBatches, ...rest } = it;
    const totalStock = drugBatches.reduce((s, b) => s + b.quantityInStock, 0);
    const nearestExpiry = drugBatches.length
      ? drugBatches
          .map((b) => b.expiryDate)
          .reduce((min, d) => (d < min ? d : min))
      : null;
    return {
      ...rest,
      totalStock,
      batchCount: drugBatches.length,
      inStock: totalStock > 0,
      nearestExpiry,
    };
  });

  return { items: shaped, total, page, limit };
}

export async function getFormularyItemById(tenantId: string, id: string) {
  const item = await prisma.drugFormulary.findFirst({
    where: { id, tenantId },
    include: {
      category: { select: { id: true, name: true } },
      drugBatches: {
        where: { isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } },
        select: {
          id: true,
          batchNumber: true,
          expiryDate: true,
          quantityInStock: true,
          sellingPrice: true,
        },
        orderBy: { expiryDate: 'asc' },
      },
    },
  });

  if (!item) {
    throw AppError.notFound('Formulary item not found');
  }

  return item;
}

export async function updateFormularyItem(
  tenantId: string,
  roles: string[],
  id: string,
  data: UpdateFormularyInput,
) {
  assertPharmacyAdmin(roles, 'edit formulary drugs');
  const existing = await prisma.drugFormulary.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Formulary item not found');
  }

  // Validate category if being changed
  if (data.categoryId) {
    const category = await prisma.drugCategory.findFirst({
      where: { id: data.categoryId, tenantId },
    });
    if (!category) {
      throw AppError.notFound('Drug category not found');
    }
  }

  const updateData: any = {};
  if (data.drugName !== undefined) updateData.drugName = data.drugName;
  if (data.genericName !== undefined) updateData.genericName = data.genericName;
  if (data.categoryId !== undefined) updateData.categoryId = data.categoryId;
  if (data.manufacturer !== undefined) updateData.manufacturer = data.manufacturer;
  if (data.dosageForm !== undefined) updateData.dosageForm = data.dosageForm;
  if (data.strength !== undefined) updateData.strength = data.strength;
  if (data.unitOfMeasurement !== undefined) updateData.unitOfMeasurement = data.unitOfMeasurement;
  if (data.price !== undefined) updateData.price = data.price;
  if (data.packSize !== undefined) updateData.packSize = data.packSize;
  if (data.looseUnitLabel !== undefined) updateData.looseUnitLabel = data.looseUnitLabel;
  if (data.taxPercent !== undefined) updateData.taxPercent = data.taxPercent;
  if (data.indications !== undefined) updateData.indications = data.indications;
  if (data.contraindications !== undefined) updateData.contraindications = data.contraindications;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  if (data.isRecalled !== undefined) updateData.isRecalled = data.isRecalled;

  const item = await prisma.drugFormulary.update({
    where: { id },
    data: updateData,
    include: {
      category: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, formularyId: id }, 'Formulary item updated');
  return item;
}

export async function deleteFormularyItem(tenantId: string, id: string) {
  const existing = await prisma.drugFormulary.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Formulary item not found');
  }

  // Check if any batches reference this drug
  const batchCount = await prisma.drugBatch.count({
    where: { drugId: id },
  });

  if (batchCount > 0) {
    throw AppError.badRequest(
      `Cannot delete formulary item. ${batchCount} batch(es) are linked to this drug.`,
    );
  }

  await prisma.drugFormulary.delete({ where: { id } });

  logger.info({ tenantId, formularyId: id }, 'Formulary item deleted');
}

// ============================================================
// Batches
// ============================================================

export async function createBatch(tenantId: string, roles: string[], data: CreateBatchInput) {
  assertPharmacyAdmin(roles, 'add stock batches');
  // Validate drug exists
  const drug = await prisma.drugFormulary.findFirst({
    where: { id: data.drugId, tenantId },
  });

  if (!drug) {
    throw AppError.notFound('Drug not found in formulary');
  }

  // Validate supplier if provided
  if (data.supplierId) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: data.supplierId, tenantId },
    });
    if (!supplier) {
      throw AppError.notFound('Supplier not found');
    }
  }

  // Check for duplicate batch number within the same drug
  const existingBatch = await prisma.drugBatch.findFirst({
    where: { tenantId, drugId: data.drugId, batchNumber: data.batchNumber },
  });

  if (existingBatch) {
    throw AppError.conflict('A batch with this number already exists for this drug');
  }

  const batch = await prisma.drugBatch.create({
    data: {
      tenantId,
      drugId: data.drugId,
      batchNumber: data.batchNumber,
      manufacturingDate: data.manufacturingDate ? new Date(data.manufacturingDate) : undefined,
      expiryDate: new Date(data.expiryDate),
      supplierId: data.supplierId,
      purchasePrice: data.purchasePrice,
      sellingPrice: data.sellingPrice,
      quantityReceived: data.quantityReceived,
      quantityInStock: data.quantityReceived,
    },
    include: {
      drug: { select: { id: true, drugName: true, genericName: true } },
      supplier: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, batchId: batch.id, drugId: data.drugId }, 'Drug batch created');
  return batch;
}

export async function getBatches(tenantId: string, query: GetBatchesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.drugId) where.drugId = query.drugId;
  if ((query as any).availableOnly) {
    where.isExpired = false;
    where.isRecalled = false;
    where.quantityInStock = { gt: 0 };
  } else if (query.isExpired !== undefined) {
    where.isExpired = query.isExpired;
  }

  if (query.search) {
    where.OR = [
      { batchNumber: { contains: query.search, mode: 'insensitive' } },
      { drug: { drugName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [batches, total] = await Promise.all([
    prisma.drugBatch.findMany({
      where,
      skip,
      take,
      include: {
        drug: {
          select: {
            id: true,
            drugName: true,
            genericName: true,
            dosageForm: true,
            strength: true,
            packSize: true,
            looseUnitLabel: true,
            taxPercent: true,
          },
        },
        supplier: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.drugBatch.count({ where }),
  ]);

  return { batches, total, page, limit };
}

export async function getBatchById(tenantId: string, id: string) {
  const batch = await prisma.drugBatch.findFirst({
    where: { id, tenantId },
    include: {
      drug: { select: { id: true, drugName: true, genericName: true, strength: true, dosageForm: true } },
      supplier: { select: { id: true, name: true } },
    },
  });

  if (!batch) {
    throw AppError.notFound('Drug batch not found');
  }

  return batch;
}

export async function updateBatch(
  tenantId: string,
  roles: string[],
  id: string,
  data: UpdateBatchInput,
) {
  assertPharmacyAdmin(roles, 'edit stock batches');
  const existing = await prisma.drugBatch.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Drug batch not found');
  }

  // Validate supplier if being changed
  if (data.supplierId) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: data.supplierId, tenantId },
    });
    if (!supplier) {
      throw AppError.notFound('Supplier not found');
    }
  }

  const updateData: any = {};
  if (data.batchNumber !== undefined) updateData.batchNumber = data.batchNumber;
  if (data.manufacturingDate !== undefined) {
    updateData.manufacturingDate = data.manufacturingDate ? new Date(data.manufacturingDate) : null;
  }
  if (data.expiryDate !== undefined) updateData.expiryDate = new Date(data.expiryDate);
  if (data.supplierId !== undefined) updateData.supplierId = data.supplierId;
  if (data.purchasePrice !== undefined) updateData.purchasePrice = data.purchasePrice;
  if (data.sellingPrice !== undefined) updateData.sellingPrice = data.sellingPrice;
  if (data.quantityInStock !== undefined) updateData.quantityInStock = data.quantityInStock;
  if (data.isExpired !== undefined) updateData.isExpired = data.isExpired;
  if (data.isRecalled !== undefined) updateData.isRecalled = data.isRecalled;
  if (data.recallReason !== undefined) updateData.recallReason = data.recallReason;

  const batch = await prisma.drugBatch.update({
    where: { id },
    data: updateData,
    include: {
      drug: { select: { id: true, drugName: true, genericName: true } },
      supplier: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, batchId: id }, 'Drug batch updated');
  return batch;
}

export async function getExpiringBatches(tenantId: string, query: GetExpiringBatchesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const days = query.days ?? 30;
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() + days);

  const where: any = {
    tenantId,
    isExpired: false,
    isRecalled: false,
    quantityInStock: { gt: 0 },
    expiryDate: { lte: thresholdDate },
  };

  const [batches, total] = await Promise.all([
    prisma.drugBatch.findMany({
      where,
      skip,
      take,
      include: {
        drug: { select: { id: true, drugName: true, genericName: true, strength: true } },
        supplier: { select: { id: true, name: true } },
      },
      orderBy: { expiryDate: 'asc' },
    }),
    prisma.drugBatch.count({ where }),
  ]);

  return { batches, total, page, limit };
}

// ============================================================
// Dispensing
// ============================================================

// Best-effort notification helper (failures must not break dispense)
async function safePharmacyNotify(params: {
  tenantId: string;
  userId: string;
  title: string;
  message: string;
  referenceType?: string;
  referenceId?: string;
}) {
  try {
    await prisma.notification.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        title: params.title,
        message: params.message,
        notificationType: 'general',
        channel: 'in_app',
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      },
    });
  } catch (err) {
    logger.warn({ err, ...params }, 'Failed to dispatch pharmacy notification');
  }
}

// Recomputes a prescription's status based on its items' dispensed totals.
// Called from inside the dispense transaction so the queue is always coherent.
async function recomputePrescriptionStatus(
  tx: typeof prisma,
  prescriptionId: string,
) {
  const rx = await tx.prescription.findUnique({
    where: { id: prescriptionId },
    include: {
      prescriptionItems: {
        include: {
          dispensingRecords: { select: { quantityDispensed: true } },
        },
      },
    },
  });
  if (!rx || rx.status === 'cancelled') return;

  let totalOrderedItems = 0;
  let fullyDispensedItems = 0;
  let anyDispensed = false;

  for (const it of rx.prescriptionItems) {
    totalOrderedItems += 1;
    const dispensed = it.dispensingRecords.reduce(
      (sum, r) => sum + r.quantityDispensed,
      0,
    );
    if (dispensed > 0) anyDispensed = true;
    // Only "fully" dispensed if the prescription item has an explicit quantity
    // and dispensed total >= ordered quantity.
    if (it.quantity != null && dispensed >= it.quantity) {
      fullyDispensedItems += 1;
    } else if (it.quantity == null && dispensed > 0) {
      // No explicit quantity means PRN / continuous — treat any dispense as
      // fulfilled for queue-clearing purposes.
      fullyDispensedItems += 1;
    }
  }

  let nextStatus: 'active' | 'partially_dispensed' | 'dispensed' = 'active';
  if (totalOrderedItems > 0 && fullyDispensedItems === totalOrderedItems) {
    nextStatus = 'dispensed';
  } else if (anyDispensed) {
    nextStatus = 'partially_dispensed';
  }

  if (nextStatus !== rx.status) {
    await tx.prescription.update({
      where: { id: prescriptionId },
      data: { status: nextStatus },
    });
  }

  return { nextStatus, prev: rx.status };
}

// Resolves the unit price to bill for a dispense. Strictly the HOSPITAL's own
// price — never the platform catalog MRP. Preference order, all tenant-owned:
//   1. the batch's selling price (the real price for the stock actually used),
//   2. the hospital's formulary default price,
//   3. the batch purchase price (cost) as a last resort.
// This keeps every hospital's pricing independent (1000+ tenants can each price
// the same drug differently) and unaffected by catalog refreshes.
function pickDispenseUnitPrice(batch: {
  sellingPrice: any;
  purchasePrice: any;
  drug?: { price?: any } | null;
}) {
  const formularyPrice = batch.drug?.price;
  return Number(batch.sellingPrice ?? formularyPrice ?? batch.purchasePrice ?? 0);
}

// Auto-link a dispense to the patient's draft bill on the same visit. Idempotent
// on (billId, referenceType, referenceId).
export async function autoLinkDispenseToBill(
  tx: typeof prisma,
  tenantId: string,
  dispensingId: string,
) {
  try {
    const record = await tx.dispensingRecord.findFirst({
      where: { id: dispensingId, tenantId },
      include: {
        prescription: { select: { visitId: true } },
        drugBatch: {
          select: {
            drug: { select: { drugName: true, price: true } },
            sellingPrice: true,
            purchasePrice: true,
            batchNumber: true,
          },
        },
      },
    });
    if (!record || !record.prescription?.visitId) return;
    const visitId = record.prescription.visitId;

    let bill = await tx.bill.findFirst({
      where: { tenantId, visitId, status: 'draft' },
    });
    if (!bill) {
      const billNumber = `BILL-${Date.now()}`;
      bill = await tx.bill.create({
        data: {
          tenantId,
          billNumber,
          patientId: record.patientId,
          visitId,
          billDate: new Date(),
          status: 'draft',
        },
      });
    }

    const existing = await tx.billItem.findFirst({
      where: {
        billId: bill.id,
        referenceType: 'dispensing_record',
        referenceId: dispensingId,
      },
    });
    if (existing) return;

    const unit = pickDispenseUnitPrice(record.drugBatch as any);
    const total = unit * record.quantityDispensed;
    const drugName = (record.drugBatch as any)?.drug?.drugName ?? 'Medication';
    const batchTag = (record.drugBatch as any)?.batchNumber ? ` (Batch ${(record.drugBatch as any).batchNumber})` : '';

    await tx.billItem.create({
      data: {
        billId: bill.id,
        description: `${drugName}${batchTag}`,
        category: 'pharmacy',
        quantity: record.quantityDispensed,
        unitPrice: unit,
        totalAmount: total,
        referenceType: 'dispensing_record',
        referenceId: dispensingId,
        isAutoPulled: true,
      },
    });

    const items = await tx.billItem.findMany({ where: { billId: bill.id } });
    const subtotal = items.reduce((sum, x) => sum + Number(x.totalAmount ?? 0), 0);
    await tx.bill.update({
      where: { id: bill.id },
      data: {
        subtotal,
        totalAmount: subtotal,
        patientPayableAmount: subtotal,
        balanceDue: subtotal - Number(bill.amountPaid ?? 0),
      },
    });
  } catch (err) {
    logger.warn({ err, dispensingId }, 'Failed to auto-link dispense to bill');
  }
}

/**
 * Pre-flight NPPA price check for a cart of batches. The POS calls this before
 * dispensing so it can collect a single override authorisation up front (rather
 * than failing mid-loop). Returns the scheduled drugs whose hospital per-unit
 * price exceeds the ceiling. Read-only.
 */
export async function checkDispensePricing(
  tenantId: string,
  items: Array<{ drugBatchId: string }>,
) {
  const batchIds = Array.from(new Set(items.map((i) => i.drugBatchId)));
  const batches = await prisma.drugBatch.findMany({
    where: { id: { in: batchIds }, tenantId },
    select: {
      id: true,
      sellingPrice: true,
      drug: {
        select: {
          drugName: true,
          price: true,
          drugMaster: { select: { isScheduled: true, ceilingPrice: true, ceilingUnit: true } },
        },
      },
    },
  });

  const violations = batches
    .map((b) => {
      const m = b.drug?.drugMaster;
      const ceiling = m?.ceilingPrice != null ? Number(m.ceilingPrice) : null;
      const unitPrice =
        b.sellingPrice != null
          ? Number(b.sellingPrice)
          : b.drug?.price != null
            ? Number(b.drug.price)
            : null;
      const isOver = !!m?.isScheduled && ceiling != null && unitPrice != null && unitPrice > ceiling;
      return isOver
        ? {
            drugBatchId: b.id,
            drugName: b.drug?.drugName ?? 'Drug',
            unitPrice,
            ceilingPrice: ceiling,
            ceilingUnit: m?.ceilingUnit ?? null,
          }
        : null;
    })
    .filter(Boolean);

  return { violations, hasViolations: violations.length > 0 };
}

export async function createDispense(tenantId: string, userId: string, data: CreateDispenseInput) {
  // Validate the drug batch exists and has enough stock. Pull the linked
  // formulary drug + its platform NPPA ceiling so we can enforce price control.
  const drugBatch = await prisma.drugBatch.findFirst({
    where: { id: data.drugBatchId, tenantId },
    include: {
      drug: {
        select: {
          drugName: true,
          price: true,
          drugMaster: {
            select: { isScheduled: true, ceilingPrice: true, ceilingUnit: true },
          },
        },
      },
    },
  });

  if (!drugBatch) {
    throw AppError.notFound('Drug batch not found');
  }

  if (drugBatch.isExpired) {
    throw AppError.badRequest('Cannot dispense from an expired batch');
  }

  if (drugBatch.isRecalled) {
    throw AppError.badRequest('Cannot dispense from a recalled batch');
  }

  // NPPA / DPCO price control is ADVISORY here — the hospital dispenses at its
  // own price (operational truth). The ceiling is never enforced or used for
  // billing; it only surfaces as guidance (POS warning + Price Control watch)
  // for hospitals that choose to follow it. If the pharmacist recorded a note
  // about pricing above the ceiling, we keep it on the record for audit.
  const priceOverrideReason: string | undefined = data.overrideReason?.trim() || undefined;

  if (drugBatch.quantityInStock < data.quantityDispensed) {
    throw AppError.badRequest(
      `Insufficient stock. Available: ${drugBatch.quantityInStock}, Requested: ${data.quantityDispensed}`,
    );
  }

  // Validate patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });

  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Create dispensing record, decrement stock, recompute Rx status, and
  // auto-link to the patient bill — all in one transaction so the queue,
  // inventory, prescription, and billing surfaces stay consistent.
  const result = await prisma.$transaction(async (tx) => {
    const record = await tx.dispensingRecord.create({
      data: {
        tenantId,
        prescriptionId: data.prescriptionId,
        prescriptionItemId: data.prescriptionItemId,
        patientId: data.patientId,
        drugBatchId: data.drugBatchId,
        quantityDispensed: data.quantityDispensed,
        dispensedBy: userId,
        notes: data.notes,
        priceOverrideReason,
      },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        drugBatch: {
          select: {
            id: true,
            batchNumber: true,
            drug: { select: { id: true, drugName: true } },
          },
        },
      },
    });

    // Decrement stock
    await tx.drugBatch.update({
      where: { id: data.drugBatchId },
      data: {
        quantityInStock: { decrement: data.quantityDispensed },
      },
    });

    // Mark prescription as partially_dispensed / dispensed based on totals
    await recomputePrescriptionStatus(tx as any, data.prescriptionId);

    // Auto-add a line item to the patient's draft bill
    await autoLinkDispenseToBill(tx as any, tenantId, record.id);

    return record;
  });

  // Post-commit notifications — never inside the transaction
  try {
    const rx = await prisma.prescription.findUnique({
      where: { id: data.prescriptionId },
      include: {
        patient: { select: { firstName: true, lastName: true, userId: true } },
        doctor: { select: { userId: true } },
      },
    });
    if (rx?.doctor?.userId) {
      const patientName = rx.patient ? `${rx.patient.firstName} ${rx.patient.lastName ?? ''}`.trim() : 'Patient';
      void safePharmacyNotify({
        tenantId,
        userId: rx.doctor.userId,
        title: 'Medication dispensed',
        message: `${result.drugBatch.drug.drugName} (${result.quantityDispensed}) dispensed to ${patientName}.`,
        referenceType: 'dispensing_record',
        referenceId: result.id,
      });
    }
    if (rx?.patient?.userId) {
      void safePharmacyNotify({
        tenantId,
        userId: rx.patient.userId,
        title: 'Your medication is ready',
        message: `${result.drugBatch.drug.drugName} (${result.quantityDispensed}) has been dispensed at the pharmacy.`,
        referenceType: 'dispensing_record',
        referenceId: result.id,
      });
    }
  } catch (err) {
    logger.warn({ err, dispensingId: result.id }, 'Pharmacy post-dispense notify failed');
  }

  logger.info(
    { tenantId, dispensingId: result.id, drugBatchId: data.drugBatchId, quantity: data.quantityDispensed },
    'Drug dispensed',
  );
  return result;
}

// ============================================================
// Counter billing (POS sale) — the "proper" pharmacy bill
// ============================================================
// Bills an entire cart as ONE invoice (Bill + BillItems + Payment) inside a
// single transaction. Supports:
//   • partial-of-prescription (sell fewer units than ordered),
//   • loose / sub-unit sales (break a strip — saleUnit='loose'),
//   • walk-in / OTC (no prescriptionId),
//   • free-typed quantities,
//   • GST-inclusive pricing with a per-item tax breakup,
//   • payment capture (amount tendered → change/balance).
// Stock and price are tracked per BASE unit; packSize converts packs→base units.

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Human-friendly, collision-free pharmacy invoice number: PH-YYYYMMDD-#### per
// tenant per day. Counter throughput is low enough that a count+1 is safe.
async function nextPharmacyInvoiceNumber(tx: typeof prisma, tenantId: string) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const prefix = `PH-${y}${m}${d}-`;
  const todays = await tx.bill.count({
    where: { tenantId, billNumber: { startsWith: prefix } },
  });
  return `${prefix}${String(todays + 1).padStart(4, '0')}`;
}

// Reusable per-tenant "Walk-in" customer so OTC sales (no patient selected)
// still attach to a Bill. Idempotent on the (tenantId, mrn) unique key.
const WALK_IN_MRN = 'WALK-IN';
async function getOrCreateWalkInPatient(tenantId: string): Promise<string> {
  const existing = await prisma.patient.findFirst({
    where: { tenantId, mrn: WALK_IN_MRN },
    select: { id: true },
  });
  if (existing) return existing.id;
  try {
    const created = await prisma.patient.create({
      data: { tenantId, mrn: WALK_IN_MRN, firstName: 'Walk-in', lastName: 'Customer', isNew: false },
      select: { id: true },
    });
    return created.id;
  } catch {
    // Lost a race on the unique key — re-read the row the other request created.
    const again = await prisma.patient.findFirst({
      where: { tenantId, mrn: WALK_IN_MRN },
      select: { id: true },
    });
    if (again) return again.id;
    throw AppError.badRequest('Could not resolve a walk-in customer for this sale');
  }
}

export async function createPharmacySale(
  tenantId: string,
  userId: string,
  data: CreatePharmacySaleInput,
) {
  // Resolve the patient. A Bill is always patient-scoped, so a walk-in / OTC
  // sale (no patientId) is billed against the tenant's reusable "Walk-in" patient.
  let patientId: string;
  if (data.patientId) {
    const patient = await prisma.patient.findFirst({
      where: { id: data.patientId, tenantId },
      select: { id: true },
    });
    if (!patient) throw AppError.notFound('Patient not found');
    patientId = patient.id;
  } else {
    patientId = await getOrCreateWalkInPatient(tenantId);
  }

  if (data.prescriptionId) {
    const rx = await prisma.prescription.findFirst({
      where: { id: data.prescriptionId, tenantId },
      select: { id: true },
    });
    if (!rx) throw AppError.notFound('Prescription not found');
  }

  const billId = await prisma.$transaction(async (tx) => {
    // 1. Validate every line and pre-compute its economics.
    const lines = [] as Array<{
      batchId: string;
      batchNumber: string;
      drugName: string;
      prescriptionItemId: string | null;
      saleUnit: 'pack' | 'loose';
      baseQty: number;
      unitPrice: number;
      discPct: number;
      discAmt: number;
      net: number;
      taxPct: number;
      taxAmt: number;
    }>;

    for (const item of data.items) {
      const batch = await tx.drugBatch.findFirst({
        where: { id: item.drugBatchId, tenantId },
        include: {
          drug: {
            select: {
              drugName: true,
              price: true,
              packSize: true,
              looseUnitLabel: true,
              taxPercent: true,
            },
          },
        },
      });
      if (!batch) throw AppError.notFound(`Drug batch ${item.drugBatchId} not found`);
      if (batch.isExpired) throw AppError.badRequest('Cannot sell from an expired batch');
      if (batch.isRecalled) throw AppError.badRequest('Cannot sell from a recalled batch');

      const packSize = batch.drug?.packSize && batch.drug.packSize > 0 ? batch.drug.packSize : 1;
      const saleUnit = item.saleUnit ?? 'pack';
      // Loose sales must be whole sub-units; pack sales convert packs→base units.
      const baseQty = saleUnit === 'loose'
        ? Math.round(item.quantity)
        : Math.round(item.quantity) * packSize;
      if (baseQty <= 0) throw AppError.badRequest('Quantity must be at least one unit');
      if (batch.quantityInStock < baseQty) {
        throw AppError.badRequest(
          `Insufficient stock for ${batch.drug?.drugName ?? 'drug'}. Available: ${batch.quantityInStock}, requested: ${baseQty}`,
        );
      }

      const unitPrice = item.unitPrice != null
        ? item.unitPrice
        : pickDispenseUnitPrice(batch as any);
      const gross = round2(unitPrice * baseQty);
      const discPct = item.discountPercent ?? 0;
      const discAmt = round2(gross * (discPct / 100));
      const net = round2(gross - discAmt);
      // Prices are MRP (tax-inclusive) → derive the embedded GST for the breakup.
      const taxPct = batch.drug?.taxPercent != null ? Number(batch.drug.taxPercent) : 12;
      const taxAmt = round2(net - net / (1 + taxPct / 100));

      lines.push({
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        drugName: batch.drug?.drugName ?? 'Medication',
        prescriptionItemId: item.prescriptionItemId ?? null,
        saleUnit,
        baseQty,
        unitPrice,
        discPct,
        discAmt,
        net,
        taxPct,
        taxAmt,
      });
    }

    // 2. Roll up the invoice totals.
    const subtotal = round2(lines.reduce((s, l) => s + l.unitPrice * l.baseQty, 0));
    const discountAmount = round2(lines.reduce((s, l) => s + l.discAmt, 0));
    const taxAmount = round2(lines.reduce((s, l) => s + l.taxAmt, 0));
    const totalAmount = round2(lines.reduce((s, l) => s + l.net, 0));

    // Default to paid-in-full at the counter unless an explicit amount is given.
    const applied = data.amountPaid != null
      ? round2(Math.min(data.amountPaid, totalAmount))
      : totalAmount;
    const balanceDue = round2(totalAmount - applied);
    const status: any = balanceDue <= 0 ? 'paid' : applied > 0 ? 'partially_paid' : 'pending';

    let visitId: string | null = null;
    if (data.prescriptionId) {
      const rx = await tx.prescription.findUnique({
        where: { id: data.prescriptionId },
        select: { visitId: true },
      });
      visitId = rx?.visitId ?? null;
    }

    const billNumber = await nextPharmacyInvoiceNumber(tx as any, tenantId);
    const bill = await tx.bill.create({
      data: {
        tenantId,
        billNumber,
        patientId,
        visitId,
        billDate: new Date(),
        subtotal,
        discountAmount,
        taxAmount,
        totalAmount,
        patientPayableAmount: totalAmount,
        amountPaid: applied,
        balanceDue,
        status,
        generatedBy: userId,
      },
    });

    // 3. One DispensingRecord + BillItem per line; decrement stock.
    const overrideReason = data.overrideReason?.trim() || undefined;
    for (const l of lines) {
      const rec = await tx.dispensingRecord.create({
        data: {
          tenantId,
          prescriptionId: data.prescriptionId ?? null,
          prescriptionItemId: l.prescriptionItemId,
          patientId,
          drugBatchId: l.batchId,
          quantityDispensed: l.baseQty,
          dispensedBy: userId,
          notes: data.notes,
          saleUnit: l.saleUnit,
          unitPrice: l.unitPrice,
          discountPercent: l.discPct,
          taxPercent: l.taxPct,
          lineTotal: l.net,
          billId: bill.id,
          priceOverrideReason: overrideReason,
        },
      });

      await tx.drugBatch.update({
        where: { id: l.batchId },
        data: { quantityInStock: { decrement: l.baseQty } },
      });

      await tx.billItem.create({
        data: {
          billId: bill.id,
          description: `${l.drugName} (Batch ${l.batchNumber})${l.saleUnit === 'loose' ? ' — loose' : ''}`,
          category: 'pharmacy',
          quantity: l.baseQty,
          unitPrice: l.unitPrice,
          discountPercent: l.discPct,
          discountAmount: l.discAmt,
          taxPercent: l.taxPct,
          taxAmount: l.taxAmt,
          totalAmount: l.net,
          referenceType: 'dispensing_record',
          referenceId: rec.id,
          isAutoPulled: true,
        },
      });
    }

    // 4. Record the payment taken at the counter.
    if (applied > 0) {
      await tx.payment.create({
        data: {
          tenantId,
          billId: bill.id,
          patientId,
          paymentDate: new Date(),
          amount: applied,
          paymentMethod: (data.paymentMethod ?? 'cash') as any,
          paymentSource: 'frontdesk',
          status: 'completed',
          processedBy: userId,
          notes: 'Pharmacy counter sale',
        },
      });
    }

    // 5. Keep the prescription queue coherent for Rx-linked sales.
    if (data.prescriptionId) {
      await recomputePrescriptionStatus(tx as any, data.prescriptionId);
    }

    return bill.id;
  });

  logger.info({ tenantId, billId, items: data.items.length }, 'Pharmacy counter sale billed');
  return getPharmacySale(tenantId, billId);
}

// Full invoice payload for the POS receipt / reprint.
export async function getPharmacySale(tenantId: string, billId: string) {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          gender: true,
          dateOfBirth: true,
          phone: true,
        },
      },
      billItems: { orderBy: { createdAt: 'asc' } },
      payments: {
        select: { id: true, amount: true, paymentMethod: true, paymentDate: true },
        orderBy: { paymentDate: 'asc' },
      },
      generator: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!bill) throw AppError.notFound('Bill not found');

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      name: true,
      logoUrl: true,
      address: true,
      city: true,
      state: true,
      phone: true,
      email: true,
    },
  });

  return { bill, hospital: tenant };
}

export async function getDispenseRecords(tenantId: string, query: GetDispenseQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) where.patientId = query.patientId;

  if (query.fromDate) {
    where.dispensedAt = { ...where.dispensedAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.dispensedAt = { ...where.dispensedAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { drugBatch: { drug: { drugName: { contains: query.search, mode: 'insensitive' } } } },
    ];
  }

  const [records, total] = await Promise.all([
    prisma.dispensingRecord.findMany({
      where,
      skip,
      take,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        drugBatch: {
          select: {
            id: true,
            batchNumber: true,
            drug: { select: { id: true, drugName: true, genericName: true } },
          },
        },
        dispenser: { select: { id: true, firstName: true, lastName: true } },
        verifier: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { dispensedAt: 'desc' },
    }),
    prisma.dispensingRecord.count({ where }),
  ]);

  return { records, total, page, limit };
}

export async function getDispenseById(tenantId: string, id: string) {
  const record = await prisma.dispensingRecord.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      drugBatch: {
        select: {
          id: true,
          batchNumber: true,
          expiryDate: true,
          drug: { select: { id: true, drugName: true, genericName: true, strength: true, dosageForm: true } },
        },
      },
      dispenser: { select: { id: true, firstName: true, lastName: true } },
      verifier: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!record) {
    throw AppError.notFound('Dispensing record not found');
  }

  return record;
}

export async function verifyDispense(tenantId: string, id: string, verifiedBy: string) {
  const record = await prisma.dispensingRecord.findFirst({
    where: { id, tenantId },
  });

  if (!record) {
    throw AppError.notFound('Dispensing record not found');
  }

  if (record.verifiedBy) {
    throw AppError.badRequest('This dispensing record has already been verified');
  }

  if (record.dispensedBy === verifiedBy) {
    throw AppError.badRequest('The dispenser cannot verify their own dispensing record');
  }

  const updated = await prisma.dispensingRecord.update({
    where: { id },
    data: { verifiedBy },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true } },
      drugBatch: {
        select: {
          id: true,
          batchNumber: true,
          drug: { select: { id: true, drugName: true } },
        },
      },
      dispenser: { select: { id: true, firstName: true, lastName: true } },
      verifier: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, dispensingId: id, verifiedBy }, 'Dispensing record verified');
  return updated;
}

// ============================================================
// Returns
// ============================================================

export async function createReturn(tenantId: string, roles: string[], data: CreateReturnInput) {
  // Patient returns are an everyday counter task (pharmacist). Vendor returns
  // (damaged/unsold stock back to the supplier) are a stock-management action,
  // so they're restricted to pharmacy_admin.
  if (data.returnType === 'vendor_return') {
    assertPharmacyAdmin(roles, 'record vendor returns');
  }

  // Validate drug batch exists
  const drugBatch = await prisma.drugBatch.findFirst({
    where: { id: data.drugBatchId, tenantId },
  });

  if (!drugBatch) {
    throw AppError.notFound('Drug batch not found');
  }

  // Validate patient if patient return
  if (data.returnType === 'patient_return') {
    if (!data.patientId) {
      throw AppError.badRequest('Patient ID is required for patient returns');
    }
    const patient = await prisma.patient.findFirst({
      where: { id: data.patientId, tenantId },
    });
    if (!patient) {
      throw AppError.notFound('Patient not found');
    }
  }

  // Validate supplier if vendor return
  if (data.returnType === 'vendor_return') {
    if (!data.supplierId) {
      throw AppError.badRequest('Supplier ID is required for vendor returns');
    }
    const supplier = await prisma.supplier.findFirst({
      where: { id: data.supplierId, tenantId },
    });
    if (!supplier) {
      throw AppError.notFound('Supplier not found');
    }
  }

  const drugReturn = await prisma.drugReturn.create({
    data: {
      tenantId,
      returnType: data.returnType as any,
      drugBatchId: data.drugBatchId,
      patientId: data.patientId,
      supplierId: data.supplierId,
      quantity: data.quantity,
      reason: data.reason,
      status: 'pending',
    },
    include: {
      drugBatch: {
        select: {
          id: true,
          batchNumber: true,
          drug: { select: { id: true, drugName: true } },
        },
      },
      patient: { select: { id: true, firstName: true, lastName: true } },
      supplier: { select: { id: true, name: true } },
    },
  });

  logger.info(
    { tenantId, returnId: drugReturn.id, returnType: data.returnType },
    'Drug return created',
  );
  return drugReturn;
}

export async function getReturns(tenantId: string, query: GetReturnsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.returnType) where.returnType = query.returnType;
  if (query.status) where.status = query.status;

  if (query.search) {
    where.OR = [
      { drugBatch: { batchNumber: { contains: query.search, mode: 'insensitive' } } },
      { drugBatch: { drug: { drugName: { contains: query.search, mode: 'insensitive' } } } },
      { reason: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [returns, total] = await Promise.all([
    prisma.drugReturn.findMany({
      where,
      skip,
      take,
      include: {
        drugBatch: {
          select: {
            id: true,
            batchNumber: true,
            drug: { select: { id: true, drugName: true } },
          },
        },
        patient: { select: { id: true, firstName: true, lastName: true } },
        supplier: { select: { id: true, name: true } },
        processor: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.drugReturn.count({ where }),
  ]);

  return { returns, total, page, limit };
}

export async function processReturn(
  tenantId: string,
  id: string,
  userId: string,
  data: ProcessReturnInput,
) {
  const drugReturn = await prisma.drugReturn.findFirst({
    where: { id, tenantId },
  });

  if (!drugReturn) {
    throw AppError.notFound('Drug return not found');
  }

  if (drugReturn.status !== 'pending') {
    throw AppError.badRequest('Only pending returns can be processed');
  }

  // If approving (processed), add stock back to batch
  if (data.status === 'processed') {
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.drugReturn.update({
        where: { id },
        data: {
          status: 'processed',
          processedBy: userId,
        },
        include: {
          drugBatch: {
            select: {
              id: true,
              batchNumber: true,
              drug: { select: { id: true, drugName: true } },
            },
          },
          patient: { select: { id: true, firstName: true, lastName: true } },
          supplier: { select: { id: true, name: true } },
          processor: { select: { id: true, firstName: true, lastName: true } },
        },
      });

      // Restock the returned quantity
      await tx.drugBatch.update({
        where: { id: drugReturn.drugBatchId },
        data: {
          quantityInStock: { increment: drugReturn.quantity },
        },
      });

      return updated;
    });

    logger.info({ tenantId, returnId: id, status: 'processed', processedBy: userId }, 'Drug return processed');
    return result;
  }

  // Rejected -- no stock adjustment
  const updated = await prisma.drugReturn.update({
    where: { id },
    data: {
      status: 'rejected',
      processedBy: userId,
    },
    include: {
      drugBatch: {
        select: {
          id: true,
          batchNumber: true,
          drug: { select: { id: true, drugName: true } },
        },
      },
      patient: { select: { id: true, firstName: true, lastName: true } },
      supplier: { select: { id: true, name: true } },
      processor: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, returnId: id, status: 'rejected', processedBy: userId }, 'Drug return rejected');
  return updated;
}

// ============================================================
// Analytics — drives the Pharmacy Reports page
// ============================================================
// One endpoint, four bundled reports (Sales / Expiry / Stock Usage / Batch-wise)
// so the frontend can render the whole dashboard from a single fetch and avoid
// flicker across sections.

export async function getPharmacyAnalytics(
  tenantId: string,
  range: { fromDate?: string; toDate?: string },
) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date(today); monthAgo.setDate(monthAgo.getDate() - 30);
  const ninetyDaysFromNow = new Date(today); ninetyDaysFromNow.setDate(ninetyDaysFromNow.getDate() + 90);

  const dispenseWhere: any = { tenantId };
  if (range.fromDate) dispenseWhere.dispensedAt = { ...dispenseWhere.dispensedAt, gte: new Date(range.fromDate) };
  if (range.toDate) dispenseWhere.dispensedAt = { ...dispenseWhere.dispensedAt, lte: new Date(range.toDate) };

  const [
    allDispenses,
    todayDispenses,
    weekDispenses,
    monthDispenses,
    expiringBatches,
    expiredBatches,
    activeBatches,
  ] = await Promise.all([
    prisma.dispensingRecord.findMany({
      where: dispenseWhere,
      include: {
        drugBatch: {
          select: {
            sellingPrice: true,
            purchasePrice: true,
            drug: { select: { id: true, drugName: true, category: { select: { id: true, name: true } } } },
          },
        },
      },
    }),
    prisma.dispensingRecord.findMany({
      where: { tenantId, dispensedAt: { gte: today } },
      include: { drugBatch: { select: { sellingPrice: true } } },
    }),
    prisma.dispensingRecord.findMany({
      where: { tenantId, dispensedAt: { gte: weekAgo } },
      include: { drugBatch: { select: { sellingPrice: true } } },
    }),
    prisma.dispensingRecord.findMany({
      where: { tenantId, dispensedAt: { gte: monthAgo } },
      include: { drugBatch: { select: { sellingPrice: true } } },
    }),
    prisma.drugBatch.findMany({
      where: {
        tenantId,
        isExpired: false,
        isRecalled: false,
        expiryDate: { gte: today, lte: ninetyDaysFromNow },
        quantityInStock: { gt: 0 },
      },
      include: { drug: { select: { drugName: true } } },
      orderBy: { expiryDate: 'asc' },
    }),
    prisma.drugBatch.findMany({
      where: { tenantId, OR: [{ isExpired: true }, { expiryDate: { lt: today } }] },
      include: { drug: { select: { drugName: true } } },
      take: 50,
    }),
    prisma.drugBatch.findMany({
      where: { tenantId, isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } },
      include: { drug: { select: { drugName: true } } },
    }),
  ]);

  const lineRevenue = (r: { quantityDispensed: number; drugBatch: { sellingPrice: any } | null }) =>
    Number(r.drugBatch?.sellingPrice ?? 0) * r.quantityDispensed;

  const lineMargin = (r: {
    quantityDispensed: number;
    drugBatch: { sellingPrice: any; purchasePrice: any } | null;
  }) => (Number(r.drugBatch?.sellingPrice ?? 0) - Number(r.drugBatch?.purchasePrice ?? 0)) * r.quantityDispensed;

  const totalRevenue = allDispenses.reduce((s, r) => s + lineRevenue(r), 0);
  const totalMargin = allDispenses.reduce((s, r) => s + lineMargin(r), 0);

  // Top-dispensed drugs
  const drugTally = new Map<string, { drugId: string; drugName: string; qty: number; revenue: number }>();
  for (const r of allDispenses) {
    const drug = r.drugBatch?.drug;
    if (!drug) continue;
    const k = drug.id;
    const prev = drugTally.get(k);
    const inc = lineRevenue(r);
    if (prev) {
      prev.qty += r.quantityDispensed;
      prev.revenue += inc;
    } else {
      drugTally.set(k, { drugId: drug.id, drugName: drug.drugName, qty: r.quantityDispensed, revenue: inc });
    }
  }
  const topDrugs = Array.from(drugTally.values()).sort((a, b) => b.qty - a.qty).slice(0, 15);

  // Revenue by category
  const categoryTally = new Map<string, { categoryId: string; categoryName: string; revenue: number }>();
  for (const r of allDispenses) {
    const cat = r.drugBatch?.drug?.category;
    if (!cat) continue;
    const prev = categoryTally.get(cat.id);
    const inc = lineRevenue(r);
    if (prev) prev.revenue += inc;
    else categoryTally.set(cat.id, { categoryId: cat.id, categoryName: cat.name, revenue: inc });
  }
  const revenueByCategory = Array.from(categoryTally.values()).sort((a, b) => b.revenue - a.revenue);

  // Sum helpers for sale windows
  const sumRevenue = (rows: typeof todayDispenses) =>
    rows.reduce((s, r) => s + Number(r.drugBatch?.sellingPrice ?? 0) * r.quantityDispensed, 0);

  // Batch-wise summary
  const totalStockValue = activeBatches.reduce(
    (s, b) => s + Number(b.purchasePrice ?? 0) * b.quantityInStock,
    0,
  );
  const totalRetailValue = activeBatches.reduce(
    (s, b) => s + Number(b.sellingPrice ?? 0) * b.quantityInStock,
    0,
  );

  // Expiry "value at risk" = retail value of soon-to-expire stock
  const valueAtRisk = expiringBatches.reduce(
    (s, b) => s + Number(b.sellingPrice ?? 0) * b.quantityInStock,
    0,
  );

  // Slow movers — active batches that haven't been dispensed at all in range
  const dispensedBatchIds = new Set(allDispenses.map((r) => (r as any).drugBatchId));
  const slowMovers = activeBatches
    .filter((b) => !dispensedBatchIds.has(b.id))
    .slice(0, 25)
    .map((b) => ({
      batchId: b.id,
      drugName: b.drug.drugName,
      batchNumber: b.batchNumber,
      quantityInStock: b.quantityInStock,
      expiryDate: b.expiryDate,
    }));

  return {
    sales: {
      today: sumRevenue(todayDispenses),
      week: sumRevenue(weekDispenses),
      month: sumRevenue(monthDispenses),
      rangeRevenue: totalRevenue,
      rangeMargin: totalMargin,
      rangeTransactions: allDispenses.length,
      revenueByCategory,
    },
    topDrugs,
    expiry: {
      soonCount: expiringBatches.length,
      expiredCount: expiredBatches.length,
      valueAtRisk: Number(valueAtRisk.toFixed(2)),
      upcoming: expiringBatches.slice(0, 25).map((b) => ({
        batchId: b.id,
        drugName: b.drug.drugName,
        batchNumber: b.batchNumber,
        quantityInStock: b.quantityInStock,
        expiryDate: b.expiryDate,
        sellingPrice: Number(b.sellingPrice ?? 0),
      })),
    },
    stockUsage: {
      activeBatches: activeBatches.length,
      slowMovers,
    },
    batchSummary: {
      activeBatches: activeBatches.length,
      totalStockValue: Number(totalStockValue.toFixed(2)),
      totalRetailValue: Number(totalRetailValue.toFixed(2)),
      potentialMargin: Number((totalRetailValue - totalStockValue).toFixed(2)),
    },
  };
}

// ============================================================
// Recall Management
// ============================================================
// Marks a batch (or all batches of a drug) as recalled. The dispense path
// already rejects recalled batches, so once flagged the stock is auto-blocked.
// Returns the list of patients who received doses of the batch so the clinic
// can contact them.

export async function recallBatch(
  tenantId: string,
  batchId: string,
  userId: string,
  data: RecallBatchInput,
) {
  const batch = await prisma.drugBatch.findFirst({
    where: { id: batchId, tenantId },
  });
  if (!batch) throw AppError.notFound('Drug batch not found');

  const updated = await prisma.drugBatch.update({
    where: { id: batchId },
    data: {
      isRecalled: true,
      recallReason: data.recallReason,
    },
    include: {
      drug: { select: { id: true, drugName: true, genericName: true } },
      supplier: { select: { id: true, name: true } },
    },
  });

  // Notify pharmacy admins
  try {
    const pharmacyUsers = await prisma.user.findMany({
      where: {
        tenantId,
        isActive: true,
        userRoles: {
          some: { role: { name: { in: ['pharmacy_admin', 'pharmacist', 'admin'] } } },
        },
      },
      select: { id: true },
      take: 25,
    });
    for (const u of pharmacyUsers) {
      void safePharmacyNotify({
        tenantId,
        userId: u.id,
        title: 'Batch recalled',
        message: `${updated.drug.drugName} batch ${updated.batchNumber} has been recalled. Reason: ${data.recallReason}`,
        referenceType: 'drug_batch',
        referenceId: batchId,
      });
    }
  } catch (err) {
    logger.warn({ err, batchId }, 'Failed to notify recall');
  }

  logger.info({ tenantId, batchId, userId }, 'Batch recalled');
  return updated;
}

export async function unrecallBatch(tenantId: string, batchId: string) {
  const batch = await prisma.drugBatch.findFirst({ where: { id: batchId, tenantId } });
  if (!batch) throw AppError.notFound('Drug batch not found');
  if (!batch.isRecalled) throw AppError.badRequest('Batch is not recalled');

  return prisma.drugBatch.update({
    where: { id: batchId },
    data: { isRecalled: false, recallReason: null },
    include: {
      drug: { select: { id: true, drugName: true, genericName: true } },
    },
  });
}

export async function recallDrug(
  tenantId: string,
  drugId: string,
  userId: string,
  data: RecallDrugInput,
) {
  const drug = await prisma.drugFormulary.findFirst({ where: { id: drugId, tenantId } });
  if (!drug) throw AppError.notFound('Drug not found');

  // Flag the formulary entry + cascade to every batch.
  await prisma.$transaction([
    prisma.drugFormulary.update({
      where: { id: drugId },
      data: { isRecalled: true },
    }),
    prisma.drugBatch.updateMany({
      where: { tenantId, drugId },
      data: { isRecalled: true, recallReason: data.recallReason },
    }),
  ]);

  logger.info({ tenantId, drugId, userId }, 'Drug recalled (all batches)');
  return { drugId, batchesRecalled: true };
}

/**
 * For a given recalled batch, return the patients (with dispense dates &
 * quantities) who actually received the drug. Used to print a contact list.
 */
export async function getRecallAffectedPatients(tenantId: string, batchId: string) {
  const batch = await prisma.drugBatch.findFirst({
    where: { id: batchId, tenantId },
    include: {
      drug: { select: { id: true, drugName: true, genericName: true } },
    },
  });
  if (!batch) throw AppError.notFound('Drug batch not found');

  const records = await prisma.dispensingRecord.findMany({
    where: { tenantId, drugBatchId: batchId },
    include: {
      patient: {
        select: {
          id: true, mrn: true, firstName: true, lastName: true,
          phone: true, email: true, dateOfBirth: true,
        },
      },
      prescription: {
        select: {
          id: true,
          doctor: { select: { user: { select: { firstName: true, lastName: true } } } },
        },
      },
      dispenser: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { dispensedAt: 'desc' },
  });

  // Group by patient for the call sheet, summing the quantity received.
  const grouped = new Map<string, {
    patientId: string;
    mrn: string;
    name: string;
    phone: string | null;
    email: string | null;
    totalQuantity: number;
    dispenses: { dispensedAt: Date; quantity: number; prescriptionId: string | null; doctorName: string | null }[];
  }>();

  for (const r of records) {
    const p = r.patient;
    const key = p.id;
    const existing = grouped.get(key);
    const doctorName = r.prescription?.doctor?.user
      ? `${r.prescription.doctor.user.firstName} ${r.prescription.doctor.user.lastName}`.trim()
      : null;
    const dispense = {
      dispensedAt: r.dispensedAt,
      quantity: r.quantityDispensed,
      prescriptionId: r.prescriptionId,
      doctorName,
    };
    if (existing) {
      existing.totalQuantity += r.quantityDispensed;
      existing.dispenses.push(dispense);
    } else {
      grouped.set(key, {
        patientId: p.id,
        mrn: p.mrn,
        name: `${p.firstName} ${p.lastName ?? ''}`.trim(),
        phone: p.phone,
        email: p.email,
        totalQuantity: r.quantityDispensed,
        dispenses: [dispense],
      });
    }
  }

  return {
    batch: {
      id: batch.id,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      isRecalled: batch.isRecalled,
      recallReason: batch.recallReason,
      drug: batch.drug,
    },
    totalPatients: grouped.size,
    totalDispenses: records.length,
    patients: Array.from(grouped.values()).sort((a, b) => b.totalQuantity - a.totalQuantity),
  };
}

/**
 * Combined view for the Pharmacy Recall page: recalled formulary drugs +
 * recalled batches with affected-patient counts.
 */
export async function getRecalledItems(tenantId: string, query: GetRecalledItemsQuery) {
  const showBatch = query.type === 'all' || query.type === 'batch';
  const showDrug = query.type === 'all' || query.type === 'drug';

  const [recalledBatches, recalledDrugs] = await Promise.all([
    showBatch
      ? prisma.drugBatch.findMany({
          where: { tenantId, isRecalled: true },
          include: {
            drug: { select: { id: true, drugName: true, genericName: true } },
            supplier: { select: { id: true, name: true } },
            _count: { select: { dispensingRecords: true } },
          },
          orderBy: { updatedAt: 'desc' },
          take: 100,
        })
      : Promise.resolve([] as any[]),
    showDrug
      ? prisma.drugFormulary.findMany({
          where: { tenantId, isRecalled: true },
          include: {
            category: { select: { id: true, name: true } },
            _count: { select: { drugBatches: true } },
          },
          orderBy: { updatedAt: 'desc' },
          take: 100,
        })
      : Promise.resolve([] as any[]),
  ]);

  return { recalledBatches, recalledDrugs };
}

// ============================================================
// GST Report
// ============================================================
// We don't have HSN codes per drug yet — but we can derive GST liability
// from dispense × selling price × configured rate (default 12% if the
// caller doesn't pass one). Categorises by drug category so the
// finance/pharmacy team can file by HSN once that field is added.

export async function getGstReport(tenantId: string, query: GetGstReportQuery) {
  const gstRate = query.gstRate ?? 12;

  const where: any = { tenantId };
  if (query.fromDate) where.dispensedAt = { ...where.dispensedAt, gte: new Date(query.fromDate) };
  if (query.toDate) where.dispensedAt = { ...where.dispensedAt, lte: new Date(query.toDate) };

  const records = await prisma.dispensingRecord.findMany({
    where,
    include: {
      drugBatch: {
        select: {
          sellingPrice: true,
          drug: {
            select: {
              id: true,
              drugName: true,
              category: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });

  // Total taxable & gst per category
  const categories = new Map<string, {
    categoryId: string;
    categoryName: string;
    taxableValue: number;
    gstAmount: number;
    totalAmount: number;
    transactions: number;
  }>();

  let totalTaxable = 0;
  let totalGst = 0;
  let totalSales = 0;

  for (const r of records) {
    const sellingPrice = Number(r.drugBatch?.sellingPrice ?? 0);
    const lineTotal = sellingPrice * r.quantityDispensed;
    // Treat sellingPrice as GST-inclusive (most retail pharmacy pricing).
    // Reverse-calc taxable: total / (1 + rate/100).
    const taxable = lineTotal / (1 + gstRate / 100);
    const gst = lineTotal - taxable;

    totalSales += lineTotal;
    totalTaxable += taxable;
    totalGst += gst;

    const cat = r.drugBatch?.drug?.category;
    const catId = cat?.id ?? '__uncat__';
    const catName = cat?.name ?? 'Uncategorised';
    const existing = categories.get(catId);
    if (existing) {
      existing.taxableValue += taxable;
      existing.gstAmount += gst;
      existing.totalAmount += lineTotal;
      existing.transactions += 1;
    } else {
      categories.set(catId, {
        categoryId: catId,
        categoryName: catName,
        taxableValue: taxable,
        gstAmount: gst,
        totalAmount: lineTotal,
        transactions: 1,
      });
    }
  }

  // CGST + SGST is a 50/50 split of the total GST for intra-state sales.
  const cgst = totalGst / 2;
  const sgst = totalGst / 2;

  return {
    gstRate,
    summary: {
      totalSales: Number(totalSales.toFixed(2)),
      taxableValue: Number(totalTaxable.toFixed(2)),
      totalGst: Number(totalGst.toFixed(2)),
      cgst: Number(cgst.toFixed(2)),
      sgst: Number(sgst.toFixed(2)),
      igst: 0,
      transactions: records.length,
    },
    byCategory: Array.from(categories.values())
      .map((c) => ({
        ...c,
        taxableValue: Number(c.taxableValue.toFixed(2)),
        gstAmount: Number(c.gstAmount.toFixed(2)),
        totalAmount: Number(c.totalAmount.toFixed(2)),
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount),
  };
}

// ============================================================
// Auto-Expiry Job — called by scheduler (or manually) to flag any batch
// whose expiryDate has passed but isExpired = false. Idempotent.
// ============================================================

export async function flagExpiredBatches(tenantId?: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const where: any = {
    isExpired: false,
    expiryDate: { lt: today },
  };
  if (tenantId) where.tenantId = tenantId;

  const result = await prisma.drugBatch.updateMany({
    where,
    data: { isExpired: true },
  });

  if (result.count > 0) {
    logger.info({ tenantId, count: result.count }, 'Auto-flagged expired batches');
  }
  return { flagged: result.count };
}
