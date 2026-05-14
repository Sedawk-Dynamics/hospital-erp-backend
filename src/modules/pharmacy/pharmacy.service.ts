import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateCategoryInput,
  UpdateCategoryInput,
  CreateFormularyInput,
  UpdateFormularyInput,
  GetFormularyQuery,
  CreateBatchInput,
  UpdateBatchInput,
  GetBatchesQuery,
  GetExpiringBatchesQuery,
  CreateDispenseInput,
  GetDispenseQuery,
  CreateReturnInput,
  GetReturnsQuery,
  ProcessReturnInput,
} from './pharmacy.validation';

// ============================================================
// Drug Categories
// ============================================================

export async function createDrugCategory(tenantId: string, data: CreateCategoryInput) {
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

export async function updateDrugCategory(tenantId: string, id: string, data: UpdateCategoryInput) {
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

export async function createFormularyItem(tenantId: string, data: CreateFormularyInput) {
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

export async function getFormulary(tenantId: string, query: GetFormularyQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.dosageForm) where.dosageForm = query.dosageForm;
  if (query.isActive !== undefined) where.isActive = query.isActive;

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
      },
      orderBy: { drugName: 'asc' },
    }),
    prisma.drugFormulary.count({ where }),
  ]);

  return { items, total, page, limit };
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
  id: string,
  data: UpdateFormularyInput,
) {
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

export async function createBatch(tenantId: string, data: CreateBatchInput) {
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
        drug: { select: { id: true, drugName: true, genericName: true } },
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

export async function updateBatch(tenantId: string, id: string, data: UpdateBatchInput) {
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

// Resolves the supplier-specified selling price for a batch — used by the
// auto-bill so the patient gets charged the batch-level price actually used.
function pickDispenseUnitPrice(batch: { sellingPrice: any; purchasePrice: any }) {
  return Number(batch.sellingPrice ?? batch.purchasePrice ?? 0);
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
          select: { drug: { select: { drugName: true } }, sellingPrice: true, purchasePrice: true, batchNumber: true },
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

export async function createDispense(tenantId: string, userId: string, data: CreateDispenseInput) {
  // Validate the drug batch exists and has enough stock
  const drugBatch = await prisma.drugBatch.findFirst({
    where: { id: data.drugBatchId, tenantId },
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

export async function createReturn(tenantId: string, data: CreateReturnInput) {
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
