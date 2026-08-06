import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import {
  safeLabAudit,
  safeLabReportEmail,
  safeLabReportCorrectedEmail,
} from './lab.audit';
import { Prisma, type LabOrderStatus } from '@prisma/client';
import { buildSearchTokens, normaliseAliases, normaliseTags } from './lab-templates.service';
import type { ParameterSpec } from './lab.validation';
import type {
  CreateTestInput,
  UpdateTestInput,
  UpdateTestPriceInput,
  GetTestsQuery,
  CreateLabOrderInput,
  UpdateLabOrderInput,
  GetLabOrdersQuery,
  AcceptLabOrderInput,
  CollectSampleInput,
  GetSamplesQuery,
  UpdateSampleStatusInput,
  RejectSampleInput,
  EnterResultsInput,
  GetResultsQuery,
  VerifyResultInput,
  GetLabReportsQuery,
  CorrectLabReportInput,
} from './lab.validation';

// Catalog edit role guard. Full schema edits (parameters, normal range, unit,
// name, etc.) are an admin/super_admin power; lab_supervisor + lab_technician
// can only touch price + TAT via the dedicated /price endpoint.
const FULL_CATALOG_EDITORS = new Set(['admin', 'super_admin']);

function canEditFullCatalog(roles: string[]): boolean {
  return roles.some((r) => FULL_CATALOG_EDITORS.has(r));
}

// Helper: send in-app notification (failures must not break the workflow)
async function safeNotify(params: {
  tenantId: string;
  userId: string;
  title: string;
  message: string;
  notificationType: 'lab_result' | 'general' | 'alert';
  channel?: 'in_app' | 'email' | 'sms' | 'push';
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
        notificationType: params.notificationType,
        channel: params.channel ?? 'in_app',
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      },
    });
  } catch (err) {
    logger.warn({ err, ...params }, 'Failed to dispatch lab notification');
  }
}

// Notify every lab_supervisor in the tenant. Used when a technician submits
// a lab report for approval so the supervisor sees a pending-review item on
// their dashboard / notifications.
async function notifyLabSupervisors(
  tenantId: string,
  title: string,
  message: string,
  referenceType: string,
  referenceId: string,
) {
  try {
    const supervisors = await prisma.user.findMany({
      where: {
        tenantId,
        isActive: true,
        userRoles: { some: { role: { name: 'lab_supervisor' } } },
      },
      select: { id: true },
    });
    await Promise.all(
      supervisors.map((s) =>
        safeNotify({
          tenantId,
          userId: s.id,
          title,
          message,
          notificationType: 'lab_result',
          referenceType,
          referenceId,
        }),
      ),
    );
  } catch (err) {
    logger.warn({ err, tenantId }, 'Failed to notify lab supervisors');
  }
}

// Helper: auto-link lab order tests to a draft bill on the patient's visit
export async function autoLinkLabOrderToBill(tenantId: string, labOrderId: string) {
  try {
    const order = await prisma.labOrder.findFirst({
      where: { id: labOrderId, tenantId },
      include: {
        labOrderItems: { include: { test: true } },
      },
    });
    if (!order) return;

    // Find or create a draft bill for the visit
    let bill = await prisma.bill.findFirst({
      where: { tenantId, visitId: order.visitId, status: 'draft' },
    });
    if (!bill) {
      const billNumber = `BILL-${Date.now()}`;
      bill = await prisma.bill.create({
        data: {
          tenantId,
          billNumber,
          patientId: order.patientId,
          visitId: order.visitId,
          billDate: new Date(),
          status: 'draft',
        },
      });
    }

    // Add items per test (idempotent on referenceId+description)
    for (const it of order.labOrderItems) {
      const existing = await prisma.billItem.findFirst({
        where: {
          billId: bill.id,
          referenceType: 'lab_order_item',
          referenceId: it.id,
        },
      });
      if (existing) continue;

      const price = Number(it.test.price ?? 0);
      await prisma.billItem.create({
        data: {
          billId: bill.id,
          description: it.test.testName,
          category: 'lab',
          quantity: 1,
          unitPrice: price,
          totalAmount: price,
          referenceType: 'lab_order_item',
          referenceId: it.id,
          isAutoPulled: true,
        },
      });
    }

    // Recompute totals on the bill
    const items = await prisma.billItem.findMany({ where: { billId: bill.id } });
    const subtotal = items.reduce((sum, x) => sum + Number(x.totalAmount ?? 0), 0);
    await prisma.bill.update({
      where: { id: bill.id },
      data: {
        subtotal,
        totalAmount: subtotal,
        patientPayableAmount: subtotal,
        balanceDue: subtotal - Number(bill.amountPaid ?? 0),
      },
    });
  } catch (err) {
    logger.warn({ err, labOrderId }, 'Failed to auto-link lab order to bill');
  }
}

/**
 * Payment gate for lab result work. An outpatient order must have its linked
 * bill settled before a technician may enter values, upload a result, or mark a
 * test done — mirroring the radiology payment-verify gate. Inpatient orders are
 * billed on the consolidated stay bill (settled later), so they are not gated.
 */
async function assertLabOrderPaid(
  tenantId: string,
  order: { id: string; visitId: string },
): Promise<void> {
  // Inpatient? Lab is part of the admission bill — don't block at the counter.
  const admission = await prisma.admission.findFirst({
    where: { visitId: order.visitId, status: { not: 'discharged' } },
    select: { id: true },
  });
  if (admission) return;

  const items = await prisma.labOrderItem.findMany({
    where: { labOrderId: order.id },
    select: { id: true },
  });
  if (!items.length) return;

  const billItems = await prisma.billItem.findMany({
    where: {
      referenceType: 'lab_order_item',
      referenceId: { in: items.map((i) => i.id) },
      bill: { tenantId },
    },
    include: { bill: { select: { status: true, balanceDue: true } } },
  });
  if (!billItems.length) return; // not billed yet — nothing to gate on

  const unpaid = billItems.some(
    (bi) => bi.bill.status !== 'paid' && Number(bi.bill.balanceDue ?? 0) > 0,
  );
  if (unpaid) {
    throw AppError.badRequest(
      'Payment is pending for this lab order. Collect payment at the front desk before entering or uploading results.',
    );
  }
}

/** Public payment gate by orderId — for the result-file upload route (LP5). */
export async function assertLabOrderPaymentCleared(
  tenantId: string,
  orderId: string,
): Promise<void> {
  const order = await prisma.labOrder.findFirst({
    where: { id: orderId, tenantId },
    select: { id: true, visitId: true },
  });
  if (!order) return; // downstream will surface not-found
  await assertLabOrderPaid(tenantId, order);
}

// ============================================================
// Test Catalog
// ============================================================

export async function createTest(tenantId: string, roles: string[], data: CreateTestInput) {
  // Catalog authoring is an admin-only action. Lab supervisor/technician roles
  // get the read-only catalog + price-only PATCH instead.
  if (!canEditFullCatalog(roles)) {
    throw AppError.forbidden('Only hospital admins can create lab tests');
  }

  if (data.testCode) {
    const duplicate = await prisma.labTestCatalog.findFirst({
      where: { tenantId, testCode: data.testCode },
    });
    if (duplicate) {
      throw AppError.conflict('A test with this code already exists');
    }
  }

  const aliases = normaliseAliases(data.aliases ?? []);
  const tags = normaliseTags(data.tags ?? []);
  const params = (data.parameters as ParameterSpec[] | undefined) ?? null;
  const searchTokens = buildSearchTokens({
    name: data.testName,
    code: data.testCode,
    sampleType: data.sampleType,
    aliases,
    tags,
    parameters: params,
  });

  const test = await prisma.labTestCatalog.create({
    data: {
      tenantId,
      testName: data.testName,
      testCode: data.testCode,
      description: data.description,
      normalRange: data.normalRange,
      unit: data.unit,
      price: data.price,
      turnaroundHours: data.turnaroundHours,
      sampleType: data.sampleType,
      specimen: data.specimen,
      instructions: data.instructions,
      parameters: data.parameters
        ? (data.parameters as unknown as Prisma.InputJsonValue)
        : undefined,
      interpretation: data.interpretation,
      aliases,
      tags,
      searchTokens,
      // Custom rows live independently of master data — they have no
      // templateId and are skipped by re-clone-all. Hospital-authored
      // tests default to isCustom = true even if the caller forgot to set it.
      isCustom: data.isCustom ?? true,
      isActive: data.isActive,
    },
  });

  logger.info({ tenantId, testId: test.id, isCustom: test.isCustom }, 'Lab test created');
  return test;
}

export async function getTests(tenantId: string, query: GetTestsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.isActive !== undefined) {
    where.isActive = query.isActive;
  }

  if (query.sampleType) {
    where.sampleType = { contains: query.sampleType, mode: 'insensitive' };
  }

  if (query.search) {
    const q = query.search;
    // Dynamic search: match the canonical test name/code AND the
    // denormalised searchTokens column (aliases / tags / parameter names).
    // Hospitals using "FBC" or "Hemogram" for what we call "Complete Blood
    // Count (CBC)" hit the right row.
    where.OR = [
      { testName: { contains: q, mode: 'insensitive' } },
      { testCode: { contains: q, mode: 'insensitive' } },
      { searchTokens: { contains: q.toLowerCase() } },
      { aliases: { has: q } },
      { tags: { has: q.toLowerCase() } },
    ];
  }

  const [tests, total] = await Promise.all([
    prisma.labTestCatalog.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.labTestCatalog.count({ where }),
  ]);

  return { tests, total, page, limit };
}

export async function getTestById(tenantId: string, id: string) {
  const test = await prisma.labTestCatalog.findFirst({
    where: { id, tenantId },
  });

  if (!test) {
    throw AppError.notFound('Lab test not found');
  }

  return test;
}

export async function updateTest(
  tenantId: string,
  roles: string[],
  id: string,
  data: UpdateTestInput,
) {
  // Full catalog edits (name / parameters / unit / range / interpretation)
  // are admin-only. Lab supervisor / technician must use updateTestPrice for
  // price + TAT updates.
  if (!canEditFullCatalog(roles)) {
    throw AppError.forbidden(
      'Only hospital admins can edit a lab test. Lab supervisors can update price + TAT via the price endpoint.',
    );
  }

  const test = await prisma.labTestCatalog.findFirst({
    where: { id, tenantId },
  });

  if (!test) {
    throw AppError.notFound('Lab test not found');
  }

  if (data.testCode && data.testCode !== test.testCode) {
    const duplicate = await prisma.labTestCatalog.findFirst({
      where: { tenantId, testCode: data.testCode, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict('A test with this code already exists');
    }
  }

  // Recompute searchTokens from the merged state so a single-field edit
  // (e.g. just adding an alias) keeps the index consistent.
  const aliases = data.aliases !== undefined ? normaliseAliases(data.aliases) : test.aliases ?? [];
  const tags = data.tags !== undefined ? normaliseTags(data.tags) : test.tags ?? [];
  const nextParameters =
    data.parameters !== undefined
      ? (data.parameters as ParameterSpec[] | null)
      : (test.parameters as unknown as ParameterSpec[] | null);
  const searchTokens = buildSearchTokens({
    name: data.testName ?? test.testName,
    code: data.testCode ?? test.testCode,
    sampleType: data.sampleType ?? test.sampleType,
    aliases,
    tags,
    parameters: nextParameters,
  });

  const updated = await prisma.labTestCatalog.update({
    where: { id },
    data: {
      testName: data.testName,
      testCode: data.testCode,
      description: data.description,
      normalRange: data.normalRange,
      unit: data.unit,
      price: data.price,
      turnaroundHours: data.turnaroundHours,
      sampleType: data.sampleType,
      specimen: data.specimen,
      instructions: data.instructions,
      parameters:
        data.parameters === undefined
          ? undefined
          : data.parameters === null
            ? Prisma.JsonNull
            : (data.parameters as unknown as Prisma.InputJsonValue),
      interpretation: data.interpretation,
      aliases: data.aliases !== undefined ? aliases : undefined,
      tags: data.tags !== undefined ? tags : undefined,
      searchTokens,
      isActive: data.isActive,
    },
  });

  logger.info({ tenantId, testId: id }, 'Lab test updated');
  return updated;
}

// Narrow PATCH for lab_supervisor: price + TAT only. Hospital admins can use
// this too, but they have the full updateTest above for everything else.
export async function updateTestPrice(
  tenantId: string,
  id: string,
  data: UpdateTestPriceInput,
) {
  const test = await prisma.labTestCatalog.findFirst({ where: { id, tenantId } });
  if (!test) throw AppError.notFound('Lab test not found');

  const updated = await prisma.labTestCatalog.update({
    where: { id },
    data: {
      price: data.price,
      turnaroundHours: data.turnaroundHours,
    },
  });
  logger.info({ tenantId, testId: id }, 'Lab test price/TAT updated');
  return updated;
}

export async function deleteTest(tenantId: string, id: string) {
  const test = await prisma.labTestCatalog.findFirst({
    where: { id, tenantId },
  });

  if (!test) {
    throw AppError.notFound('Lab test not found');
  }

  const updated = await prisma.labTestCatalog.update({
    where: { id },
    data: { isActive: false },
  });

  logger.info({ tenantId, testId: id }, 'Lab test deactivated');
  return updated;
}

// ============================================================
// Lab Orders
// ============================================================

export async function createLabOrder(tenantId: string, userId: string, data: CreateLabOrderInput) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify visit exists
  const visit = await prisma.visit.findFirst({
    where: { id: data.visitId, tenantId },
  });
  if (!visit) {
    throw AppError.notFound('Visit not found');
  }

  // Verify all tests exist
  const testIds = data.items.map((item) => item.testId);
  const tests = await prisma.labTestCatalog.findMany({
    where: { id: { in: testIds }, tenantId, isActive: true },
  });
  if (tests.length !== testIds.length) {
    throw AppError.badRequest('One or more test IDs are invalid or inactive');
  }

  const order = await prisma.$transaction(async (tx) => {
    const labOrder = await tx.labOrder.create({
      data: {
        tenantId,
        patientId: data.patientId,
        visitId: data.visitId,
        orderedBy: userId,
        urgency: data.urgency,
        isThirdParty: data.isThirdParty,
        thirdPartyLabName: data.thirdPartyLabName,
        notes: data.notes,
        status: 'ordered',
      },
    });

    await tx.labOrderItem.createMany({
      data: data.items.map((item) => ({
        labOrderId: labOrder.id,
        testId: item.testId,
        status: 'pending',
      })),
    });

    return tx.labOrder.findUnique({
      where: { id: labOrder.id },
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        orderer: {
          select: { id: true, firstName: true, lastName: true },
        },
        labOrderItems: {
          include: {
            test: { select: { id: true, testName: true, testCode: true } },
          },
        },
      },
    });
  });

  logger.info({ tenantId, orderId: order?.id }, 'Lab order created');

  // Auto-link to draft bill (best-effort, must not fail order creation)
  if (order?.id) {
    void autoLinkLabOrderToBill(tenantId, order.id);
    void safeLabAudit({
      tenantId,
      userId,
      action: 'create',
      entityType: 'lab_order',
      entityId: order.id,
      description: `Lab order created with ${order.labOrderItems?.length ?? 0} test(s)`,
      newValues: {
        urgency: data.urgency,
        isThirdParty: data.isThirdParty,
        thirdPartyLabName: data.thirdPartyLabName,
        items: order.labOrderItems?.map((it) => it.test?.testName ?? it.testId),
      },
    });
  }

  return order;
}

export async function getLabOrders(tenantId: string, query: GetLabOrdersQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if (query.status) {
    where.status = query.status;
  }

  if (query.urgency) {
    where.urgency = query.urgency;
  }

  if (query.assignedTo) {
    where.assignedToId = query.assignedTo;
  }

  // Outsourced filter (alias for isThirdParty)
  if (query.outsourced !== undefined) {
    where.isThirdParty = query.outsourced;
  } else if (query.isThirdParty !== undefined) {
    where.isThirdParty = query.isThirdParty;
  }

  if (query.accepted !== undefined) {
    where.acceptedAt = query.accepted ? { not: null } : null;
  }

  // Single-day date filter (UTC -> tenant-day approximation; Asia/Kolkata clients send IST date)
  if (query.date) {
    const start = new Date(query.date);
    if (!isNaN(start.getTime())) {
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      where.createdAt = { ...where.createdAt, gte: start, lt: end };
    }
  }

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [orders, total] = await Promise.all([
    prisma.labOrder.findMany({
      where,
      skip,
      take,
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true, phone: true },
        },
        orderer: {
          select: { id: true, firstName: true, lastName: true },
        },
        assignedTo: {
          select: { id: true, firstName: true, lastName: true },
        },
        labOrderItems: {
          include: {
            test: { select: { id: true, testName: true, testCode: true } },
          },
        },
        labSamples: {
          select: {
            id: true,
            status: true,
            sampleType: true,
            barcode: true,
          },
        },
        // Pull the lab-signed report so doctor / nurse views can show a
        // "Lab Report" link when present, distinct from a patient-uploaded
        // file (handled via the order's externalReportUrl).
        labReport: {
          select: {
            id: true,
            status: true,
            pdfUrl: true,
            publishedAt: true,
            signedAt: true,
          },
        },
        // Per-test file counts feed the doctor / nurse "N files" badge in IP
        // workspace order rows without shipping the full attachment list.
        _count: {
          select: {
            attachments: { where: { deletedAt: null } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.labOrder.count({ where }),
  ]);

  return { orders, total, page, limit };
}

export async function getLabOrderById(tenantId: string, id: string) {
  const order = await prisma.labOrder.findFirst({
    where: { id, tenantId },
    include: {
      patient: {
        select: {
          id: true,
          mrn: true,
          firstName: true,
          lastName: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
        },
      },
      orderer: {
        select: { id: true, firstName: true, lastName: true },
      },
      labOrderItems: {
        include: {
          test: {
            select: {
              id: true,
              testName: true,
              testCode: true,
              sampleType: true,
              normalRange: true,
              unit: true,
              // Structured parameter schema — drives the lab UI's result-
              // entry grid in structured mode.
              parameters: true,
              interpretation: true,
              specimen: true,
              instructions: true,
            },
          },
          labResults: true,
        },
      },
      labSamples: true,
      labReport: true,
      attachments: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        include: { uploader: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  });

  if (!order) {
    throw AppError.notFound('Lab order not found');
  }

  return order;
}

export async function updateLabOrder(
  tenantId: string,
  id: string,
  data: UpdateLabOrderInput,
) {
  const order = await prisma.labOrder.findFirst({
    where: { id, tenantId },
  });

  if (!order) {
    throw AppError.notFound('Lab order not found');
  }

  if (order.status === 'cancelled') {
    throw AppError.badRequest('Cannot update a cancelled order');
  }

  if (order.status === 'completed') {
    throw AppError.badRequest('Cannot update a completed order');
  }

  const updated = await prisma.labOrder.update({
    where: { id },
    data,
    include: {
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      orderer: {
        select: { id: true, firstName: true, lastName: true },
      },
      labOrderItems: {
        include: {
          test: { select: { id: true, testName: true, testCode: true } },
        },
      },
    },
  });

  logger.info({ tenantId, orderId: id }, 'Lab order updated');
  return updated;
}

export async function acceptLabOrder(
  tenantId: string,
  id: string,
  acceptorUserId: string,
  data: AcceptLabOrderInput,
) {
  const order = await prisma.labOrder.findFirst({
    where: { id, tenantId },
  });
  if (!order) throw AppError.notFound('Lab order not found');
  if (order.status === 'cancelled') throw AppError.badRequest('Cannot accept a cancelled order');
  if (order.status === 'completed') throw AppError.badRequest('Cannot accept a completed order');

  // Validate technician belongs to tenant
  if (data.assignedToId) {
    const tech = await prisma.user.findFirst({
      where: { id: data.assignedToId, tenantId, isActive: true },
    });
    if (!tech) throw AppError.badRequest('Assigned user not found in tenant');
  }

  const updated = await prisma.labOrder.update({
    where: { id },
    data: {
      assignedToId: data.assignedToId ?? order.assignedToId,
      acceptedAt: new Date(),
      acceptedBy: acceptorUserId,
      // Move ordered → received once accepted (sample may already be in transit)
      status: order.status === 'ordered' ? 'received' : order.status,
      notes: data.notes ?? order.notes,
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      orderer: { select: { id: true, firstName: true, lastName: true } },
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
      labOrderItems: {
        include: {
          test: { select: { id: true, testName: true, testCode: true } },
        },
      },
    },
  });

  logger.info({ tenantId, orderId: id, assignedToId: data.assignedToId }, 'Lab order accepted');
  void safeLabAudit({
    tenantId,
    userId: acceptorUserId,
    action: 'update',
    entityType: 'lab_order',
    entityId: id,
    description: 'Lab order accepted by lab',
    newValues: {
      assignedToId: updated.assignedToId,
      acceptedAt: updated.acceptedAt,
      status: updated.status,
    },
  });
  return updated;
}

export async function cancelLabOrder(tenantId: string, id: string, reason?: string) {
  const order = await prisma.labOrder.findFirst({
    where: { id, tenantId },
  });

  if (!order) {
    throw AppError.notFound('Lab order not found');
  }

  if (order.status === 'cancelled') {
    throw AppError.badRequest('Order is already cancelled');
  }

  if (order.status === 'completed') {
    throw AppError.badRequest('Cannot cancel a completed order');
  }

  // Persist the cancellation reason (stored inline in notes — there is no
  // dedicated column). This is what the worklist shows against a cancelled order.
  const trimmedReason = reason?.trim();
  const notesWithReason = trimmedReason
    ? `${order.notes ? `${order.notes}\n` : ''}[Cancelled: ${trimmedReason}]`
    : order.notes;

  const updated = await prisma.$transaction(async (tx) => {
    // Cancel all pending order items
    await tx.labOrderItem.updateMany({
      where: { labOrderId: id, status: 'pending' },
      data: { status: 'cancelled' },
    });

    return tx.labOrder.update({
      where: { id },
      data: { status: 'cancelled', ...(trimmedReason ? { notes: notesWithReason } : {}) },
      include: {
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
        labOrderItems: {
          include: {
            test: { select: { id: true, testName: true, testCode: true } },
          },
        },
      },
    });
  });

  logger.info({ tenantId, orderId: id }, 'Lab order cancelled');
  return updated;
}

// ============================================================
// Samples
// ============================================================

export async function collectSample(tenantId: string, userId: string, data: CollectSampleInput) {
  // Verify the order exists and belongs to tenant
  const order = await prisma.labOrder.findFirst({
    where: { id: data.labOrderId, tenantId },
  });

  if (!order) {
    throw AppError.notFound('Lab order not found');
  }

  if (order.status === 'cancelled') {
    throw AppError.badRequest('Cannot collect sample for a cancelled order');
  }

  if (data.barcode) {
    const existingBarcode = await prisma.labSample.findUnique({
      where: { barcode: data.barcode },
    });
    if (existingBarcode) {
      throw AppError.conflict('A sample with this barcode already exists');
    }
  }

  const sample = await prisma.$transaction(async (tx) => {
    const newSample = await tx.labSample.create({
      data: {
        labOrderId: data.labOrderId,
        sampleType: data.sampleType,
        barcode: data.barcode,
        collectedBy: userId,
        collectedAt: new Date(),
        status: 'collected',
        notes: data.notes,
      },
      include: {
        labOrder: {
          select: { id: true, status: true, tenantId: true },
        },
        collector: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    // Update order status to sample_collected if it's still in ordered state
    if (order.status === 'ordered') {
      await tx.labOrder.update({
        where: { id: data.labOrderId },
        data: { status: 'sample_collected' },
      });
    }

    return newSample;
  });

  logger.info({ tenantId, sampleId: sample.id, orderId: data.labOrderId }, 'Sample collected');
  void safeLabAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'lab_sample',
    entityId: sample.id,
    description: `Sample collected (${data.sampleType})`,
    newValues: { labOrderId: data.labOrderId, sampleType: data.sampleType, barcode: data.barcode },
  });
  return sample;
}

export async function getSamples(tenantId: string, query: GetSamplesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    labOrder: { tenantId },
  };

  if (query.labOrderId) {
    where.labOrderId = query.labOrderId;
  }

  if (query.status) {
    where.status = query.status;
  }

  if (query.search) {
    where.OR = [
      { barcode: { contains: query.search, mode: 'insensitive' } },
      { sampleType: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [samples, total] = await Promise.all([
    prisma.labSample.findMany({
      where,
      skip,
      take,
      include: {
        labOrder: {
          select: {
            id: true,
            status: true,
            urgency: true,
            patient: {
              select: { id: true, mrn: true, firstName: true, lastName: true },
            },
            // Which tests this sample is FOR. Without it the ward's sample list
            // could only show an opaque id — a nurse holding a tube needs to
            // know what it is being drawn for.
            labOrderItems: {
              select: { test: { select: { id: true, testName: true } } },
            },
          },
        },
        collector: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.labSample.count({ where }),
  ]);

  return { samples, total, page, limit };
}

export async function updateSampleStatus(
  tenantId: string,
  id: string,
  userId: string,
  data: UpdateSampleStatusInput,
) {
  const sample = await prisma.labSample.findFirst({
    where: { id, labOrder: { tenantId } },
    include: { labOrder: { select: { id: true, status: true } } },
  });

  if (!sample) {
    throw AppError.notFound('Sample not found');
  }

  const updateData: any = { status: data.status };

  if (data.status === 'received') {
    updateData.receivedAt = new Date();
  }

  // Carry the sample's progress onto its ORDER. Without this the order sat at
  // `sample_collected` from collection until results were entered, so the ward
  // could see a sample it had sent down still reading "collected" long after
  // the lab had it — the "status updates should be visible" complaint.
  // Only ever moves forward, and never past a completed/cancelled order.
  const SAMPLE_TO_ORDER: Partial<Record<string, LabOrderStatus>> = {
    collected: 'sample_collected',
    in_transit: 'in_transit',
    received: 'received',
    processing: 'in_progress',
  };
  const ORDER_PROGRESSION: LabOrderStatus[] = [
    'ordered', 'sample_collected', 'in_transit', 'received', 'in_progress', 'completed',
  ];
  const nextOrderStatus = SAMPLE_TO_ORDER[data.status];
  const currentIndex = ORDER_PROGRESSION.indexOf(sample.labOrder?.status as LabOrderStatus);
  const nextIndex = nextOrderStatus ? ORDER_PROGRESSION.indexOf(nextOrderStatus) : -1;
  const shouldAdvanceOrder =
    nextOrderStatus !== undefined && currentIndex >= 0 && nextIndex > currentIndex;

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.labSample.update({
      where: { id },
      data: updateData,
      include: {
        labOrder: {
          select: { id: true, status: true },
        },
        collector: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    if (shouldAdvanceOrder) {
      await tx.labOrder.update({
        where: { id: row.labOrderId },
        data: { status: nextOrderStatus },
      });
      row.labOrder = { ...row.labOrder, status: nextOrderStatus };
    }

    return row;
  });

  logger.info({ tenantId, sampleId: id, status: data.status }, 'Sample status updated');
  void safeLabAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_sample',
    entityId: id,
    description: `Sample status → ${data.status}`,
    newValues: { status: data.status },
  });
  return updated;
}

export async function rejectSample(
  tenantId: string,
  id: string,
  userId: string,
  data: RejectSampleInput,
) {
  const sample = await prisma.labSample.findFirst({
    where: { id, labOrder: { tenantId } },
  });

  if (!sample) {
    throw AppError.notFound('Sample not found');
  }

  if (sample.status === 'rejected') {
    throw AppError.badRequest('Sample is already rejected');
  }

  const updated = await prisma.labSample.update({
    where: { id },
    data: {
      status: 'rejected',
      rejectionReason: data.rejectionReason,
    },
    include: {
      labOrder: {
        select: { id: true, status: true },
      },
    },
  });

  logger.info({ tenantId, sampleId: id }, 'Sample rejected');
  void safeLabAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_sample',
    entityId: id,
    description: `Sample rejected: ${data.rejectionReason}`,
    newValues: { status: 'rejected', rejectionReason: data.rejectionReason },
  });
  return updated;
}

// ============================================================
// Results
// ============================================================

/**
 * Determine whether a numeric result value falls outside the supplied reference range.
 * Supports common formats: "10-20", "<5", ">100", "10.5-20.5", "≤5", "≥10".
 * Returns null when the range or value is non-numeric so callers fall back to user-supplied flag.
 */
export function evaluateAbnormal(value: string | undefined, normalRange: string | undefined): boolean | null {
  if (!value || !normalRange) return null;
  const num = Number(String(value).trim());
  if (Number.isNaN(num)) return null;
  const r = String(normalRange).trim().replace(/\s+/g, '');
  // <X or ≤X
  let m = r.match(/^[<≤]=?(-?\d+\.?\d*)$/);
  if (m) return num >= Number(m[1]);
  // >X or ≥X
  m = r.match(/^[>≥]=?(-?\d+\.?\d*)$/);
  if (m) return num <= Number(m[1]);
  // X-Y range
  m = r.match(/^(-?\d+\.?\d*)\s*[-–to]+\s*(-?\d+\.?\d*)$/i);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    return num < lo || num > hi;
  }
  return null;
}

// A report a lab supervisor has finalized (signed/approved/published, or
// corrected) is locked: its underlying results and attachments may no longer
// be edited in place. Amendments must go through the explicit correction flow
// (correctLabReport), never silent edits. Only `draft` / `review` reports —
// and orders with no report yet — are editable. Throws if locked.
export async function assertOrderReportEditable(tenantId: string, labOrderId: string) {
  const report = await prisma.labReport.findFirst({
    where: { labOrderId, labOrder: { tenantId } },
    select: { status: true },
  });
  if (report && report.status !== 'draft' && report.status !== 'review') {
    throw AppError.badRequest(
      `Report is already ${report.status} and locked by the lab supervisor — use the correction flow to amend it.`,
    );
  }
}

export async function enterResults(tenantId: string, userId: string, data: EnterResultsInput) {
  // Verify the order item exists and belongs to tenant
  const orderItem = await prisma.labOrderItem.findFirst({
    where: {
      id: data.labOrderItemId,
      labOrder: { tenantId },
    },
    include: { labOrder: true },
  });

  if (!orderItem) {
    throw AppError.notFound('Lab order item not found');
  }

  if (orderItem.status === 'cancelled') {
    throw AppError.badRequest('Cannot enter results for a cancelled order item');
  }

  // Payment gate — OP orders must be paid before results are entered (LP5).
  await assertLabOrderPaid(tenantId, {
    id: data.labOrderId,
    visitId: orderItem.labOrder.visitId,
  });

  // Block in-place edits once the supervisor has finalized the report.
  await assertOrderReportEditable(tenantId, data.labOrderId);

  const results = await prisma.$transaction(async (tx) => {
    // Re-entering a parameter must REPLACE its value, not add a second row.
    // Without this, correcting a flagged value (e.g. a wrong RBC in a CBC) via
    // the entry grid created a duplicate LabResult, so the report printed the
    // parameter twice with neither flagged. Dedup the incoming payload by
    // parameter (keep the last), then delete any existing row for that
    // parameter before inserting the fresh (status='entered') one — which also
    // clears a 'corrected' flag once the technician re-enters the value.
    const byParam = new Map<string, (typeof data.results)[number]>();
    for (const r of data.results) byParam.set(r.parameterName, r);

    const created = [];
    for (const result of byParam.values()) {
      const auto = evaluateAbnormal(result.value, result.normalRange);
      const isAbnormal = auto !== null ? auto : !!result.isAbnormal;
      await tx.labResult.deleteMany({
        where: { labOrderItemId: data.labOrderItemId, parameterName: result.parameterName },
      });
      created.push(
        await tx.labResult.create({
          data: {
            labOrderItemId: data.labOrderItemId,
            labOrderId: data.labOrderId,
            patientId: data.patientId,
            parameterName: result.parameterName,
            value: result.value,
            unit: result.unit,
            normalRange: result.normalRange,
            isAbnormal,
            status: 'entered',
            enteredBy: userId,
            enteredAt: new Date(),
          },
        }),
      );
    }

    // Update order item status to in_progress
    if (orderItem.status === 'pending') {
      await tx.labOrderItem.update({
        where: { id: data.labOrderItemId },
        data: { status: 'in_progress' },
      });
    }

    // Update order status to in_progress if still at an earlier stage
    const order = orderItem.labOrder;
    if (order.status !== 'in_progress' && order.status !== 'completed' && order.status !== 'cancelled') {
      await tx.labOrder.update({
        where: { id: data.labOrderId },
        data: { status: 'in_progress' },
      });
    }

    return created;
  });

  logger.info(
    { tenantId, orderItemId: data.labOrderItemId, count: results.length },
    'Lab results entered',
  );
  void safeLabAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'lab_result',
    entityId: data.labOrderItemId,
    description: `Entered ${results.length} result(s)`,
    newValues: {
      labOrderId: data.labOrderId,
      parameters: data.results.map((r) => r.parameterName),
    },
  });

  // CDSS critical-value hook — best-effort, non-blocking. Late import to
  // avoid a circular dep between lab and cdss modules.
  void (async () => {
    try {
      const { evaluateLabResults } = await import('../cdss/cdss.service');
      await evaluateLabResults(tenantId, userId, {
        labOrderId: data.labOrderId,
        patientId: data.patientId,
        results: data.results.map((r) => ({
          parameterName: r.parameterName,
          value: r.value ?? '',
          unit: r.unit,
        })),
      });
    } catch (err) {
      logger.warn({ err }, 'CDSS critical-value evaluation failed (non-blocking)');
    }
  })();

  return results;
}

export async function getResults(tenantId: string, query: GetResultsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    labOrder: { tenantId },
  };

  if (query.labOrderId) {
    where.labOrderId = query.labOrderId;
  }

  if (query.labOrderItemId) {
    where.labOrderItemId = query.labOrderItemId;
  }

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  const [results, total] = await Promise.all([
    prisma.labResult.findMany({
      where,
      skip,
      take,
      include: {
        labOrderItem: {
          include: {
            test: { select: { id: true, testName: true, testCode: true } },
          },
        },
        enterer: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { enteredAt: 'desc' },
    }),
    prisma.labResult.count({ where }),
  ]);

  return { results, total, page, limit };
}

export async function verifyResult(
  tenantId: string,
  id: string,
  userId: string,
  body?: VerifyResultInput,
) {
  const action = body?.action ?? 'approve';

  const result = await prisma.labResult.findFirst({
    where: { id, labOrder: { tenantId } },
    include: {
      labOrderItem: { include: { labOrder: true } },
    },
  });

  if (!result) {
    throw AppError.notFound('Lab result not found');
  }

  const orderItem = result.labOrderItem;

  const updated = await prisma.$transaction(async (tx) => {
    if (action === 'request_correction') {
      const r = await tx.labResult.update({
        where: { id },
        data: {
          status: 'corrected',
          correctionNotes: body?.correctionNotes ?? null,
        },
      });
      return { result: r, orderItem };
    }

    // Approve flow
    const r = await tx.labResult.update({
      where: { id },
      data: {
        status: 'approved',
        verifiedBy: userId,
        verifiedAt: new Date(),
        correctionNotes: null,
      },
    });

    // If all results for this order item are approved, mark the item completed
    const pendingResults = await tx.labResult.count({
      where: {
        labOrderItemId: orderItem.id,
        status: { not: 'approved' },
      },
    });

    if (pendingResults === 0) {
      await tx.labOrderItem.update({
        where: { id: orderItem.id },
        data: { status: 'completed' },
      });

      const pendingItems = await tx.labOrderItem.count({
        where: {
          labOrderId: orderItem.labOrderId,
          status: { not: 'completed' },
        },
      });
      if (pendingItems === 0) {
        await tx.labOrder.update({
          where: { id: orderItem.labOrderId },
          data: { status: 'completed' },
        });
      }
    }

    return { result: r, orderItem };
  });

  logger.info({ tenantId, resultId: id, action, userId }, 'Lab result review action');
  void safeLabAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_result',
    entityId: id,
    description: action === 'approve' ? 'Result approved by supervisor' : 'Result returned for correction',
    newValues: { action, correctionNotes: body?.correctionNotes ?? null },
  });
  return updated.result;
}

// ============================================================
// Reports
// ============================================================

export async function generateLabReport(
  tenantId: string,
  orderId: string,
  userId: string,
  reportContent?: string,
  hospitalBranding?: any,
) {
  const order = await prisma.labOrder.findFirst({
    where: { id: orderId, tenantId },
    include: {
      labOrderItems: {
        include: {
          test: true,
          labResults: true,
        },
      },
      patient: true,
    },
  });

  if (!order) {
    throw AppError.notFound('Lab order not found');
  }

  const existing = await prisma.labReport.findUnique({
    where: { labOrderId: orderId },
  });
  if (existing) {
    throw AppError.conflict('A report already exists for this order');
  }

  // Pull tenant info for default branding when not supplied
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const branding = {
    name: hospitalBranding?.name ?? tenant?.name ?? 'Hospital',
    logoUrl: hospitalBranding?.logoUrl ?? null,
    address: hospitalBranding?.address ?? null,
    phone: hospitalBranding?.phone ?? null,
    accreditation: hospitalBranding?.accreditation ?? null,
  };

  // Build a structured snapshot inside reportContent for downstream renderers
  const structured = {
    branding,
    patient: {
      id: order.patient.id,
      mrn: order.patient.mrn,
      name: `${order.patient.firstName} ${order.patient.lastName ?? ''}`.trim(),
      dateOfBirth: order.patient.dateOfBirth,
      gender: order.patient.gender,
    },
    items: order.labOrderItems.map((it) => ({
      testName: it.test.testName,
      testCode: it.test.testCode,
      sampleType: it.test.sampleType,
      results: it.labResults.map((r) => ({
        parameter: r.parameterName,
        value: r.value,
        unit: r.unit,
        normalRange: r.normalRange,
        isAbnormal: r.isAbnormal,
      })),
    })),
    notes: reportContent ?? null,
    generatedAt: new Date().toISOString(),
  };

  // QR points to the patient-portal report page; concrete domain configured per tenant
  const qrCodeUrl = `${process.env.PUBLIC_PORTAL_URL ?? ''}/r/lab/${orderId}`;

  const report = await prisma.labReport.create({
    data: {
      labOrderId: orderId,
      patientId: order.patientId,
      reportContent: JSON.stringify(structured),
      hospitalBranding: branding as any,
      qrCodeUrl,
      status: 'draft',
      version: 1,
    },
    include: {
      labOrder: {
        select: {
          id: true,
          status: true,
          urgency: true,
          labOrderItems: {
            include: {
              test: { select: { id: true, testName: true, testCode: true } },
              labResults: true,
            },
          },
        },
      },
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
    },
  });

  logger.info({ tenantId, reportId: report.id, orderId, generatedBy: userId }, 'Lab report generated');
  void safeLabAudit({
    tenantId,
    userId,
    action: 'create',
    entityType: 'lab_report',
    entityId: report.id,
    description: 'Lab report draft generated',
    newValues: { orderId, version: report.version },
  });
  return report;
}

export async function signLabReport(tenantId: string, reportId: string, userId: string) {
  const report = await prisma.labReport.findFirst({
    where: { id: reportId, labOrder: { tenantId } },
  });
  if (!report) throw AppError.notFound('Lab report not found');
  if (report.status === 'published') throw AppError.badRequest('Report is already published');

  const updated = await prisma.labReport.update({
    where: { id: reportId },
    data: {
      signedBy: userId,
      signedAt: new Date(),
      approvedBy: userId,
      approvedAt: new Date(),
      status: 'approved',
    },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
      labOrder: { select: { id: true, patientId: true, orderedBy: true } },
      signer: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  logger.info({ tenantId, reportId, userId }, 'Lab report signed');
  void safeLabAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_report',
    entityId: reportId,
    description: 'Lab report signed and approved',
    newValues: { status: 'approved', signedBy: userId, signedAt: updated.signedAt },
  });
  return updated;
}

export async function publishLabReport(
  tenantId: string,
  reportId: string,
  userId: string,
  notify: boolean,
) {
  const report = await prisma.labReport.findFirst({
    where: { id: reportId, labOrder: { tenantId } },
    include: {
      labOrder: { select: { id: true, orderedBy: true, patient: true } },
    },
  });
  if (!report) throw AppError.notFound('Lab report not found');
  if (report.status === 'published') {
    throw AppError.badRequest('Report is already published');
  }

  // Supervisor approval = sign + approve + publish in one action. We stamp
  // signedBy/signedAt and approvedBy/approvedAt if they aren't already set
  // (the legacy two-step sign-then-publish path may have stamped them).
  const now = new Date();
  const updated = await prisma.labReport.update({
    where: { id: reportId },
    data: {
      status: 'published',
      signedBy: report.signedBy ?? userId,
      signedAt: report.signedAt ?? now,
      approvedBy: report.approvedBy ?? userId,
      approvedAt: report.approvedAt ?? now,
      publishedAt: now,
    },
    include: {
      labOrder: {
        include: {
          orderer: { select: { id: true, firstName: true, lastName: true } },
          patient: { select: { id: true, firstName: true, lastName: true, mrn: true, userId: true } as any },
        },
      },
      patient: { select: { id: true, firstName: true, lastName: true, mrn: true } },
      signer: { select: { id: true, firstName: true, lastName: true } },
    } as any,
  });

  if (notify) {
    const patientName = `${report.labOrder.patient.firstName} ${report.labOrder.patient.lastName ?? ''}`.trim();
    const message = `Lab report for ${patientName} is ready.`;

    // Notify ordering doctor
    if (report.labOrder.orderedBy) {
      await safeNotify({
        tenantId,
        userId: report.labOrder.orderedBy,
        title: 'Lab report ready',
        message,
        notificationType: 'lab_result',
        referenceType: 'lab_report',
        referenceId: reportId,
      });
    }

    // Notify the patient (if a portal account exists)
    const patient = await prisma.patient.findUnique({ where: { id: report.patientId } });
    const patientUserId = (patient as any)?.userId as string | undefined;
    if (patientUserId) {
      await safeNotify({
        tenantId,
        userId: patientUserId,
        title: 'Your lab report is ready',
        message: 'Your lab report has been published. Tap to view.',
        notificationType: 'lab_result',
        referenceType: 'lab_report',
        referenceId: reportId,
      });
    }

    // Email the patient (best-effort, only if patient has an email on file).
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const order = await prisma.labOrder.findUnique({
      where: { id: report.labOrderId },
      include: { labOrderItems: { include: { test: { select: { testName: true } } } } },
    });
    const testSummary = order?.labOrderItems.map((it) => it.test.testName).join(', ') || 'Lab test';
    void safeLabReportEmail({
      toEmail: patient?.email ?? null,
      patientName,
      reportDate: new Date().toLocaleDateString('en-IN'),
      hospitalName: tenant?.name ?? 'Hospital',
      testSummary,
    });

    // Email the ordering doctor too — they often manage results outside the portal.
    if (report.labOrder.orderedBy) {
      const doctor = await prisma.user.findUnique({
        where: { id: report.labOrder.orderedBy },
        select: { email: true, firstName: true, lastName: true },
      });
      void safeLabReportEmail({
        toEmail: doctor?.email ?? null,
        patientName: `Dr. ${doctor?.firstName ?? ''} ${doctor?.lastName ?? ''}`.trim(),
        reportDate: new Date().toLocaleDateString('en-IN'),
        hospitalName: tenant?.name ?? 'Hospital',
        testSummary: `${patientName} — ${testSummary}`,
      });
    }
  }

  logger.info({ tenantId, reportId, userId }, 'Lab report published');
  void safeLabAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_report',
    entityId: reportId,
    description: 'Lab report published to patient EMR',
    newValues: { status: 'published', publishedAt: updated.publishedAt },
  });
  return updated;
}

// One-shot submit — generate (if needed) and queue the report for supervisor
// approval (status='review'). Gated by `lab_reports.create` so technicians
// can submit. The patient portal stays gated by status='published'|'corrected'
// so the report is invisible to the patient until a supervisor approves and
// publishes it via publishLabReport. The `notify` arg is reused: when true
// we ping the lab supervisor(s); patient + ordering doctor notifications now
// fire from publishLabReport instead.
export async function submitLabReport(
  tenantId: string,
  orderId: string,
  userId: string,
  notify = true,
  reportContent?: string,
  hospitalBranding?: any,
) {
  const order = await prisma.labOrder.findFirst({
    where: { id: orderId, tenantId },
    include: {
      patient: true,
      labOrderItems: { include: { test: true, labResults: true } },
    },
  });
  if (!order) throw AppError.notFound('Lab order not found');

  const existing = await prisma.labReport.findUnique({ where: { labOrderId: orderId } });

  // Build (or rebuild) the structured snapshot every submit so the published
  // payload reflects whatever results were entered up to this point. The
  // upload+mark-done path stores no reportContent — that's fine because the
  // uploaded files render in patient/clinician views directly.
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const branding = {
    name: hospitalBranding?.name ?? tenant?.name ?? 'Hospital',
    logoUrl: hospitalBranding?.logoUrl ?? null,
    address: hospitalBranding?.address ?? null,
    phone: hospitalBranding?.phone ?? null,
    accreditation: hospitalBranding?.accreditation ?? null,
  };
  const structured = {
    branding,
    patient: {
      id: order.patient.id,
      mrn: order.patient.mrn,
      name: `${order.patient.firstName} ${order.patient.lastName ?? ''}`.trim(),
      dateOfBirth: order.patient.dateOfBirth,
      gender: order.patient.gender,
    },
    items: order.labOrderItems.map((it) => ({
      testName: it.test.testName,
      testCode: it.test.testCode,
      sampleType: it.test.sampleType,
      results: it.labResults.map((r) => ({
        parameter: r.parameterName,
        value: r.value,
        unit: r.unit,
        normalRange: r.normalRange,
        isAbnormal: r.isAbnormal,
      })),
    })),
    notes: reportContent ?? null,
    generatedAt: new Date().toISOString(),
  };
  const qrCodeUrl = existing?.qrCodeUrl ?? `${process.env.PUBLIC_PORTAL_URL ?? ''}/r/lab/${orderId}`;

  const reportRow = await prisma.$transaction(async (tx) => {
    // Mark every non-cancelled item completed and the order itself completed
    // so the header status, worklist filters, and report-tab visibility all
    // line up. Mirrors the upload+mark-done flow.
    await tx.labOrderItem.updateMany({
      where: { labOrderId: orderId, status: { notIn: ['cancelled', 'completed'] } },
      data: { status: 'completed' },
    });
    if (order.status !== 'completed') {
      await tx.labOrder.update({
        where: { id: orderId },
        data: { status: 'completed' },
      });
    }

    // Re-submit (e.g. tech edited results after supervisor sent it back) is
    // allowed only when the existing report is still in a tech-editable
    // state. Published / approved / corrected reports must be amended via
    // the dedicated correctLabReport flow.
    if (existing && existing.status !== 'draft' && existing.status !== 'review') {
      throw AppError.badRequest(
        `Report is already ${existing.status} — use the correction flow to amend it.`,
      );
    }

    const row = existing
      ? await tx.labReport.update({
          where: { id: existing.id },
          data: {
            // Refresh the structured snapshot on every submit so the queued
            // payload reflects whatever results were entered up to this point.
            reportContent: JSON.stringify(structured),
            hospitalBranding: branding as any,
            status: 'review',
          },
        })
      : await tx.labReport.create({
          data: {
            labOrderId: orderId,
            patientId: order.patientId,
            reportContent: JSON.stringify(structured),
            hospitalBranding: branding as any,
            qrCodeUrl,
            status: 'review',
            version: 1,
          },
        });

    // Backfill labReportId on order attachments so the supervisor's review
    // surface includes any uploaded files. Patient portal still filters by
    // status='published'|'corrected' so these stay hidden until approval.
    await tx.labAttachment.updateMany({
      where: { labOrderId: orderId, labReportId: null, deletedAt: null },
      data: { labReportId: row.id },
    });

    // Mirror the first report_pdf attachment onto LabReport.pdfUrl so the
    // supervisor preview / branded print can fall back to it during review.
    if (!row.pdfUrl) {
      const firstPdf = await tx.labAttachment.findFirst({
        where: { labOrderId: orderId, category: 'report_pdf', deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { fileUrl: true },
      });
      if (firstPdf) {
        await tx.labReport.update({
          where: { id: row.id },
          data: { pdfUrl: firstPdf.fileUrl },
        });
      }
    }

    return row;
  });

  // Bill auto-link happens whether or not the supervisor has approved —
  // patient owes for the test once it's been performed.
  void autoLinkLabOrderToBill(tenantId, orderId).catch((err) =>
    logger.warn({ err, orderId }, 'autoLinkLabOrderToBill failed (submit)'),
  );

  if (notify) {
    const patientName = `${order.patient.firstName} ${order.patient.lastName ?? ''}`.trim();
    void notifyLabSupervisors(
      tenantId,
      'Lab report awaiting approval',
      `Report for ${patientName} (${order.patient.mrn ?? ''}) is ready for review.`,
      'lab_report',
      reportRow.id,
    );
  }

  void safeLabAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_report',
    entityId: reportRow.id,
    description: existing ? 'Lab report re-submitted for approval' : 'Lab report submitted for approval',
    newValues: { status: 'review', orderId, submittedBy: userId },
  });

  logger.info({ tenantId, reportId: reportRow.id, orderId, userId }, 'Lab report submitted for review');
  return reportRow;
}

// Lab order item completion — paired with the per-test "Upload + Mark Done"
// flow. Files uploaded against the item ARE the report. Once every item is
// marked done, the order auto-completes and a LabReport is created in
// `review` state (awaiting supervisor approval). The report becomes visible
// to the patient ONLY when a supervisor publishes it via publishLabReport.
export async function completeLabOrderItem(
  tenantId: string,
  userId: string,
  orderId: string,
  itemId: string,
) {
  const item = await prisma.labOrderItem.findFirst({
    where: { id: itemId, labOrderId: orderId, labOrder: { tenantId } },
    include: {
      labOrder: { select: { id: true, status: true, patientId: true, orderedBy: true, visitId: true } },
    },
  });
  if (!item) throw AppError.notFound('Lab order item not found');
  if (item.status === 'cancelled') {
    throw AppError.badRequest('Cancelled tests cannot be marked done');
  }

  // Payment gate — OP orders must be paid before a test is marked done (LP5).
  await assertLabOrderPaid(tenantId, { id: orderId, visitId: item.labOrder.visitId });

  // Require at least one attachment on this item — the upload IS the report,
  // so a "done" with no file would queue an empty report for the supervisor.
  const attachmentCount = await prisma.labAttachment.count({
    where: { labOrderItemId: itemId, deletedAt: null },
  });
  if (attachmentCount === 0 && item.status !== 'completed') {
    throw AppError.badRequest('Upload a report file before marking this test done');
  }

  const { order, report, justSubmitted } = await prisma.$transaction(async (tx) => {
    if (item.status !== 'completed') {
      await tx.labOrderItem.update({
        where: { id: itemId },
        data: { status: 'completed' },
      });
    }

    const remaining = await tx.labOrderItem.count({
      where: { labOrderId: orderId, status: { not: 'completed' } },
    });

    let orderState = item.labOrder;
    let reportRow: Awaited<ReturnType<typeof tx.labReport.findUnique>> | null = null;
    let submitted = false;

    if (remaining === 0) {
      if (item.labOrder.status !== 'completed') {
        await tx.labOrder.update({
          where: { id: orderId },
          data: { status: 'completed' },
        });
        orderState = { ...item.labOrder, status: 'completed' };
      }

      // Create-or-update the report in `review` state — supervisor must
      // publish before the patient sees anything. Do NOT stamp signedAt /
      // approvedAt / publishedAt: those mark supervisor sign-off and happen
      // in publishLabReport.
      const existing = await tx.labReport.findUnique({ where: { labOrderId: orderId } });
      if (existing) {
        if (existing.status === 'draft' || existing.status === 'review') {
          reportRow = await tx.labReport.update({
            where: { id: existing.id },
            data: { status: 'review' },
          });
          submitted = existing.status !== 'review';
        } else {
          // Already approved/published/corrected — leave as-is.
          reportRow = existing;
        }
      } else {
        reportRow = await tx.labReport.create({
          data: {
            labOrderId: orderId,
            patientId: item.labOrder.patientId,
            status: 'review',
            version: 1,
            qrCodeUrl: `${process.env.PUBLIC_PORTAL_URL ?? ''}/r/lab/${orderId}`,
          },
        });
        submitted = true;
      }

      // Backfill labReportId on every order attachment that doesn't already
      // point at a report. Lets the supervisor see uploaded files when
      // reviewing the report; the patient portal still filters by
      // status='published'|'corrected' so they stay hidden until approval.
      if (reportRow) {
        await tx.labAttachment.updateMany({
          where: { labOrderId: orderId, labReportId: null, deletedAt: null },
          data: { labReportId: reportRow.id },
        });

        // Mirror the first report_pdf attachment onto LabReport.pdfUrl. The
        // supervisor preview / branded print uses this field as a fallback;
        // the patient won't see it until publish.
        if (!reportRow.pdfUrl) {
          const firstPdf = await tx.labAttachment.findFirst({
            where: {
              labOrderId: orderId,
              category: 'report_pdf',
              deletedAt: null,
            },
            orderBy: { createdAt: 'asc' },
            select: { fileUrl: true },
          });
          if (firstPdf) {
            await tx.labReport.update({
              where: { id: reportRow.id },
              data: { pdfUrl: firstPdf.fileUrl },
            });
          }
        }
      }
    }

    return { order: orderState, report: reportRow, justSubmitted: submitted };
  });

  void safeLabAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_order_item',
    entityId: itemId,
    description: 'Lab order item marked done — report queued for supervisor approval',
    newValues: {
      orderId,
      status: 'completed',
      orderCompleted: order.status === 'completed',
      reportStatus: report?.status,
    },
  });

  // Re-link to bill once order completes (idempotent inside the helper).
  if (order.status === 'completed') {
    void autoLinkLabOrderToBill(tenantId, orderId).catch((err) =>
      logger.warn({ err, orderId }, 'autoLinkLabOrderToBill failed'),
    );
  }

  // When the technician just queued the report for review, ping the lab
  // supervisor(s) so they know there's something to approve.
  if (justSubmitted && report) {
    void (async () => {
      try {
        const patient = await prisma.patient.findUnique({
          where: { id: item.labOrder.patientId },
          select: { firstName: true, lastName: true, mrn: true },
        });
        const patientName = patient
          ? `${patient.firstName} ${patient.lastName ?? ''}`.trim()
          : 'Patient';
        await notifyLabSupervisors(
          tenantId,
          'Lab report awaiting approval',
          `Report for ${patientName} (${patient?.mrn ?? ''}) is ready for review.`,
          'lab_report',
          report.id,
        );
      } catch (err) {
        logger.warn({ err, orderId }, 'Supervisor notification failed (non-blocking)');
      }
    })();
  }

  // Refetch the item with its test relation so callers can render immediately.
  return prisma.labOrderItem.findUnique({
    where: { id: itemId },
    include: { test: { select: { id: true, testName: true, testCode: true } } },
  });
}

export async function correctLabReport(
  tenantId: string,
  reportId: string,
  userId: string,
  data: CorrectLabReportInput,
) {
  const report = await prisma.labReport.findFirst({
    where: { id: reportId, labOrder: { tenantId } },
    include: { labOrder: { select: { orderedBy: true, patientId: true } } },
  });
  if (!report) throw AppError.notFound('Lab report not found');

  // Upload flow: the corrected file is uploaded separately to
  // /lab/orders/:orderId/attachments with this report's id. The correction
  // itself just bumps the version, records the reason, refreshes publishedAt
  // and keeps the report visible to the patient — there is no "re-sign"
  // step now that uploads ARE the report content.
  const updated = await prisma.labReport.update({
    where: { id: reportId },
    data: {
      version: report.version + 1,
      correctionNotes: data.correctionNotes,
      reportContent: data.reportContent ?? report.reportContent,
      status: 'corrected',
      signedBy: report.signedBy ?? userId,
      signedAt: report.signedAt ?? new Date(),
      approvedBy: report.approvedBy ?? userId,
      approvedAt: report.approvedAt ?? new Date(),
      publishedAt: new Date(),
    },
  });

  if (data.notify) {
    const message = 'Your lab report has been corrected and re-issued.';
    if (report.labOrder.orderedBy) {
      await safeNotify({
        tenantId,
        userId: report.labOrder.orderedBy,
        title: 'Lab report corrected',
        message,
        notificationType: 'lab_result',
        referenceType: 'lab_report',
        referenceId: reportId,
      });
    }
    const patient = await prisma.patient.findUnique({ where: { id: report.patientId } });
    const patientUserId = (patient as any)?.userId as string | undefined;
    if (patientUserId) {
      await safeNotify({
        tenantId,
        userId: patientUserId,
        title: 'Lab report corrected',
        message,
        notificationType: 'lab_result',
        referenceType: 'lab_report',
        referenceId: reportId,
      });
    }

    // Email patient + ordering doctor that an updated version is available.
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    const patientName = patient ? `${patient.firstName} ${patient.lastName ?? ''}`.trim() : 'Patient';
    void safeLabReportCorrectedEmail({
      toEmail: patient?.email ?? null,
      patientName,
      reportDate: new Date().toLocaleDateString('en-IN'),
      hospitalName: tenant?.name ?? 'Hospital',
      correctionNotes: data.correctionNotes,
    });
    if (report.labOrder.orderedBy) {
      const doctor = await prisma.user.findUnique({
        where: { id: report.labOrder.orderedBy },
        select: { email: true, firstName: true, lastName: true },
      });
      void safeLabReportCorrectedEmail({
        toEmail: doctor?.email ?? null,
        patientName: `Dr. ${doctor?.firstName ?? ''} ${doctor?.lastName ?? ''}`.trim(),
        reportDate: new Date().toLocaleDateString('en-IN'),
        hospitalName: tenant?.name ?? 'Hospital',
        correctionNotes: `${patientName} — ${data.correctionNotes}`,
      });
    }
  }

  logger.info(
    { tenantId, reportId, userId, version: updated.version },
    'Lab report corrected; re-sign required',
  );
  void safeLabAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: 'lab_report',
    entityId: reportId,
    description: `Lab report corrected (v${updated.version})`,
    oldValues: { version: report.version, status: report.status },
    newValues: { version: updated.version, status: 'corrected', correctionNotes: data.correctionNotes },
  });
  return updated;
}

export async function getLabReportAnalytics(
  tenantId: string,
  range: { fromDate?: string; toDate?: string },
) {
  const where: any = { tenantId };
  if (range.fromDate) where.createdAt = { ...where.createdAt, gte: new Date(range.fromDate) };
  if (range.toDate) where.createdAt = { ...where.createdAt, lte: new Date(range.toDate) };

  const [orders, completedOrders, totalSamples, openOrders] = await Promise.all([
    prisma.labOrder.findMany({
      where,
      select: {
        id: true,
        createdAt: true,
        status: true,
        labOrderItems: { select: { id: true, testId: true } },
      },
    }),
    prisma.labOrder.findMany({
      where: { ...where, status: 'completed' },
      include: {
        labReport: { select: { publishedAt: true } },
      },
    }),
    prisma.labSample.count({ where: { labOrder: where } }),
    prisma.labOrder.count({ where: { ...where, status: { not: 'completed' } } }),
  ]);

  // Test volume per test
  const volumeMap = new Map<string, number>();
  for (const o of orders) {
    for (const it of o.labOrderItems) {
      volumeMap.set(it.testId, (volumeMap.get(it.testId) ?? 0) + 1);
    }
  }
  const tests = await prisma.labTestCatalog.findMany({
    where: { tenantId, id: { in: Array.from(volumeMap.keys()) } },
    select: { id: true, testName: true },
  });
  const testVolume = tests
    .map((t) => ({
      testId: t.id,
      testName: t.testName,
      count: volumeMap.get(t.id) ?? 0,
    }))
    .sort((a, b) => b.count - a.count);

  // TAT (in hours) order createdAt → labReport.publishedAt
  const tats: number[] = [];
  for (const o of completedOrders) {
    const pub = o.labReport?.publishedAt;
    if (pub) {
      tats.push((pub.getTime() - o.createdAt.getTime()) / (1000 * 60 * 60));
    }
  }
  const avgTatHours = tats.length ? tats.reduce((a, b) => a + b, 0) / tats.length : 0;
  const medianTatHours = tats.length
    ? [...tats].sort((a, b) => a - b)[Math.floor(tats.length / 2)]
    : 0;

  return {
    summary: {
      totalOrders: orders.length,
      completedOrders: completedOrders.length,
      openOrders,
      totalSamples,
      avgTatHours: Number(avgTatHours.toFixed(2)),
      medianTatHours: Number(medianTatHours.toFixed(2)),
    },
    testVolume: testVolume.slice(0, 50),
  };
}

export async function getLabReports(tenantId: string, query: GetLabReportsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = {
    labOrder: { tenantId },
  };

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if (query.status) {
    where.status = query.status;
  }

  if (query.fromDate) {
    where.createdAt = { ...where.createdAt, gte: new Date(query.fromDate) };
  }
  if (query.toDate) {
    where.createdAt = { ...where.createdAt, lte: new Date(query.toDate) };
  }

  if (query.search) {
    where.OR = [
      { patient: { firstName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { lastName: { contains: query.search, mode: 'insensitive' } } },
      { patient: { mrn: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  const [reports, total] = await Promise.all([
    prisma.labReport.findMany({
      where,
      skip,
      take,
      include: {
        labOrder: {
          select: {
            id: true,
            status: true,
            urgency: true,
            orderer: { select: { id: true, firstName: true, lastName: true } },
          },
        },
        patient: {
          select: { id: true, mrn: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.labReport.count({ where }),
  ]);

  return { reports, total, page, limit };
}

export async function getLabReportById(tenantId: string, id: string) {
  const report = await prisma.labReport.findFirst({
    where: { id, labOrder: { tenantId } },
    include: {
      labOrder: {
        include: {
          patient: {
            select: {
              id: true,
              mrn: true,
              firstName: true,
              lastName: true,
              phone: true,
              dateOfBirth: true,
              gender: true,
            },
          },
          orderer: {
            select: { id: true, firstName: true, lastName: true },
          },
          labOrderItems: {
            include: {
              test: {
                select: {
                  id: true,
                  testName: true,
                  testCode: true,
                  sampleType: true,
                  normalRange: true,
                  unit: true,
                },
              },
              labResults: true,
            },
          },
          labSamples: true,
        },
      },
      patient: {
        select: { id: true, mrn: true, firstName: true, lastName: true },
      },
      reviewer: {
        select: { id: true, firstName: true, lastName: true },
      },
      approver: {
        select: { id: true, firstName: true, lastName: true },
      },
      signer: {
        select: { id: true, firstName: true, lastName: true },
      },
      attachments: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        include: { uploader: { select: { id: true, firstName: true, lastName: true } } },
      },
    },
  });

  if (!report) {
    throw AppError.notFound('Lab report not found');
  }

  return report;
}

// ============================================================
// Public report verification (QR landing)
// ============================================================
// Returns a minimal, privacy-preserving authenticity card. Used by the
// `qrCodeUrl` printed on the branded lab report — anyone with the QR can
// confirm the report exists and is genuine, without seeing PHI.
export async function getPublicLabReportSummary(orderId: string) {
  const report = await prisma.labReport.findUnique({
    where: { labOrderId: orderId },
    include: {
      labOrder: {
        select: {
          id: true,
          tenantId: true,
          patient: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  if (!report) return null;

  const tenant = await prisma.tenant.findUnique({
    where: { id: report.labOrder.tenantId },
    select: { name: true },
  });

  const initials = `${(report.labOrder.patient.firstName ?? '').slice(0, 1)}${(report.labOrder.patient.lastName ?? '').slice(0, 1)}`.toUpperCase();

  return {
    reportId: report.id,
    orderId: report.labOrderId,
    hospitalName: tenant?.name ?? 'Hospital',
    patientInitials: initials || 'XX',
    status: report.status,
    version: report.version,
    issuedAt: report.publishedAt ?? report.signedAt,
    isPublished: report.status === 'published',
    isCorrectedCopy: report.status === 'corrected',
  };
}

// ============================================================
// Investigation History (aggregated per patient)
// ============================================================
// Returns every lab order for the patient within the tenant, with:
//   - per-item test info + status
//   - all results grouped under the item that produced them
//   - linked report status (if any)
// Also returns a flat "abnormal" roll-up for quick display.

/**
 * A lab report is RELEASED — safe to show outside the lab — only once the
 * supervisor has published it. `completeLabOrderItem` parks a finished report in
 * `review`; everything before publish is still inside the lab's own checking
 * loop and may be re-run, corrected or rejected.
 *
 * Same rule the patient portal already applies. Clinical surfaces (the doctor's
 * investigation history, the discharge summary) must use it too — a value the
 * supervisor has not signed off is not a result yet, and a doctor acting on one
 * is acting on a draft.
 */
export function isLabReportReleased(status?: string | null): boolean {
  return status === 'published' || status === 'corrected';
}

export async function getInvestigationHistory(tenantId: string, patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, tenantId },
    select: { id: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');

  const orders = await prisma.labOrder.findMany({
    where: { tenantId, patientId },
    orderBy: { createdAt: 'desc' },
    include: {
      orderer: { select: { id: true, firstName: true, lastName: true } },
      visit: { select: { id: true, visitType: true, visitDate: true } },
      labOrderItems: {
        include: {
          test: { select: { id: true, testName: true, testCode: true } },
          labResults: {
            orderBy: { enteredAt: 'desc' },
          },
        },
      },
      labReport: {
        select: { id: true, status: true, publishedAt: true, signedAt: true, pdfUrl: true },
      },
      attachments: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          category: true,
          fileName: true,
          fileUrl: true,
          mimeType: true,
          sizeBytes: true,
          description: true,
          createdAt: true,
        },
      },
    },
  });

  const abnormalFlat: Array<{
    orderId: string;
    testName: string;
    parameterName: string;
    value: string | null;
    unit: string | null;
    normalRange: string | null;
    enteredAt: Date;
  }> = [];

  // Strip the CONTENT of any report the supervisor has not released — the
  // values and the uploaded files both. The order itself stays visible, flagged
  // `awaitingApproval`, so the doctor can see the test is running and chase it;
  // they just cannot read a number nobody has signed off. This endpoint used to
  // return everything the moment a technician typed it.
  const scoped = orders.map((o) => {
    const released = isLabReportReleased(o.labReport?.status);
    if (released) return { ...o, released, awaitingApproval: false };
    return {
      ...o,
      released,
      // A report exists but is still inside the lab's review loop. No report at
      // all just means results have not been entered yet.
      awaitingApproval: !!o.labReport,
      labOrderItems: o.labOrderItems.map((it) => ({ ...it, labResults: [] })),
      attachments: [],
    };
  });

  for (const o of scoped) {
    if (!o.released) continue;
    for (const it of o.labOrderItems) {
      for (const r of it.labResults) {
        if (r.isAbnormal) {
          abnormalFlat.push({
            orderId: o.id,
            testName: (it as any).test?.testName || 'Test',
            parameterName: r.parameterName,
            value: r.value,
            unit: r.unit,
            normalRange: r.normalRange,
            enteredAt: r.enteredAt,
          });
        }
      }
    }
  }

  return { orders: scoped, abnormalFlat };
}

// ============================================================
// Lab Dashboard (real-time worklist counts + recent activity)
// ============================================================
// Returns the headline numbers a lab user wants on first paint:
//   - incoming orders awaiting acceptance
//   - samples in collection lifecycle
//   - results awaiting verification
//   - reports awaiting sign / awaiting publish
//   - today's published count
//   - abnormal results pending review (last 24h)
// Plus: a recent-activity feed of the last ~20 actions (orders + reports).
export async function getLabDashboard(tenantId: string) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    incomingOrders,
    inProgressOrders,
    samplesCollected,
    samplesInTransit,
    samplesReceived,
    samplesProcessing,
    resultsAwaitingVerify,
    reportsAwaitingSign,
    reportsAwaitingPublish,
    publishedToday,
    correctedReports,
    abnormalRecent,
    recentOrders,
    recentPublishedReports,
    overdueOrders,
  ] = await Promise.all([
    prisma.labOrder.count({ where: { tenantId, status: 'ordered', acceptedAt: null } }),
    prisma.labOrder.count({ where: { tenantId, status: 'in_progress' } }),
    prisma.labSample.count({ where: { labOrder: { tenantId }, status: 'collected' } }),
    prisma.labSample.count({ where: { labOrder: { tenantId }, status: 'in_transit' } }),
    prisma.labSample.count({ where: { labOrder: { tenantId }, status: 'received' } }),
    prisma.labSample.count({ where: { labOrder: { tenantId }, status: 'processing' } }),
    prisma.labResult.count({ where: { labOrder: { tenantId }, status: 'entered' } }),
    prisma.labReport.count({ where: { labOrder: { tenantId }, status: { in: ['draft', 'review', 'corrected'] }, signedAt: null } }),
    prisma.labReport.count({ where: { labOrder: { tenantId }, status: 'approved' } }),
    prisma.labReport.count({
      where: { labOrder: { tenantId }, status: 'published', publishedAt: { gte: startOfToday } },
    }),
    prisma.labReport.count({ where: { labOrder: { tenantId }, status: 'corrected' } }),
    prisma.labResult.count({
      where: { labOrder: { tenantId }, isAbnormal: true, enteredAt: { gte: yesterday } },
    }),
    prisma.labOrder.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        createdAt: true,
        status: true,
        urgency: true,
        acceptedAt: true,
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        orderer: { select: { id: true, firstName: true, lastName: true } },
        labOrderItems: { select: { id: true } },
      },
    }),
    prisma.labReport.findMany({
      where: { labOrder: { tenantId }, status: 'published' },
      orderBy: { publishedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        publishedAt: true,
        version: true,
        patient: { select: { firstName: true, lastName: true, mrn: true } },
        labOrder: { select: { id: true } },
      },
    }),
    // Orders open longer than 24h with no published report — surfaces SLA risks.
    prisma.labOrder.findMany({
      where: {
        tenantId,
        status: { notIn: ['completed', 'cancelled'] },
        createdAt: { lt: yesterday },
      },
      orderBy: { createdAt: 'asc' },
      take: 10,
      select: {
        id: true,
        createdAt: true,
        status: true,
        urgency: true,
        patient: { select: { firstName: true, lastName: true, mrn: true } },
      },
    }),
  ]);

  return {
    summary: {
      incomingOrders,
      inProgressOrders,
      samplesCollected,
      samplesInTransit,
      samplesReceived,
      samplesProcessing,
      resultsAwaitingVerify,
      reportsAwaitingSign,
      reportsAwaitingPublish,
      publishedToday,
      correctedReports,
      abnormalRecent,
      overdueOrders: overdueOrders.length,
    },
    recentOrders,
    recentPublishedReports,
    overdueOrders,
  };
}

// ============================================================
// Enriched analytics (per-test TAT, breach counts, daily trend)
// ============================================================
// Layered onto getLabReportAnalytics: same date window, but adds the
// per-test breakdowns + breach counts that supervisors need to manage SLAs.
export async function getLabAnalyticsExtended(
  tenantId: string,
  range: { fromDate?: string; toDate?: string },
) {
  const where: any = { tenantId };
  if (range.fromDate) where.createdAt = { ...where.createdAt, gte: new Date(range.fromDate) };
  if (range.toDate) where.createdAt = { ...where.createdAt, lte: new Date(range.toDate) };

  const completedOrders = await prisma.labOrder.findMany({
    where: { ...where, status: 'completed' },
    select: {
      id: true,
      createdAt: true,
      labReport: { select: { publishedAt: true } },
      labOrderItems: {
        select: {
          test: { select: { id: true, testName: true, turnaroundHours: true } },
        },
      },
    },
  });

  // TAT per test (in hours) — tracks SLA breach against catalog turnaroundHours.
  const tatByTest = new Map<string, { name: string; tats: number[]; tatLimitHours: number | null; breaches: number }>();
  let overallBreaches = 0;
  for (const order of completedOrders) {
    const pub = order.labReport?.publishedAt;
    if (!pub) continue;
    const tatHours = (pub.getTime() - order.createdAt.getTime()) / (1000 * 60 * 60);
    for (const item of order.labOrderItems) {
      const id = item.test.id;
      const cur = tatByTest.get(id) ?? {
        name: item.test.testName,
        tats: [],
        tatLimitHours: item.test.turnaroundHours ?? null,
        breaches: 0,
      };
      cur.tats.push(tatHours);
      if (cur.tatLimitHours && tatHours > cur.tatLimitHours) {
        cur.breaches += 1;
        overallBreaches += 1;
      }
      tatByTest.set(id, cur);
    }
  }
  const perTestTat = Array.from(tatByTest.entries())
    .map(([testId, v]) => {
      const sorted = [...v.tats].sort((a, b) => a - b);
      const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
      return {
        testId,
        testName: v.name,
        sampleCount: sorted.length,
        avgTatHours: Number(avg.toFixed(2)),
        medianTatHours: Number(median.toFixed(2)),
        p95TatHours: Number(p95.toFixed(2)),
        tatLimitHours: v.tatLimitHours,
        breaches: v.breaches,
        breachRate: sorted.length ? Number(((v.breaches / sorted.length) * 100).toFixed(1)) : 0,
      };
    })
    .sort((a, b) => b.sampleCount - a.sampleCount);

  // Daily orders trend over the window
  const dailyOrders = await prisma.labOrder.findMany({
    where,
    select: { createdAt: true },
  });
  const dayMap = new Map<string, number>();
  for (const o of dailyOrders) {
    const day = new Date(o.createdAt);
    day.setHours(0, 0, 0, 0);
    const key = day.toISOString().slice(0, 10);
    dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
  }
  const dailyTrend = Array.from(dayMap.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // Abnormal vs total result counts
  const [abnormalResults, totalResults] = await Promise.all([
    prisma.labResult.count({ where: { labOrder: { tenantId }, isAbnormal: true } }),
    prisma.labResult.count({ where: { labOrder: { tenantId } } }),
  ]);

  return {
    perTestTat: perTestTat.slice(0, 50),
    overallBreaches,
    dailyTrend,
    abnormalResults,
    totalResults,
    abnormalRate: totalResults ? Number(((abnormalResults / totalResults) * 100).toFixed(2)) : 0,
  };
}
