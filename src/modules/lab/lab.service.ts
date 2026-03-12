import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateLabDepartmentInput,
  UpdateLabDepartmentInput,
  GetLabDepartmentsQuery,
  CreateTestInput,
  UpdateTestInput,
  GetTestsQuery,
  CreateLabOrderInput,
  UpdateLabOrderInput,
  GetLabOrdersQuery,
  CollectSampleInput,
  GetSamplesQuery,
  UpdateSampleStatusInput,
  RejectSampleInput,
  EnterResultsInput,
  GetResultsQuery,
  GetLabReportsQuery,
} from './lab.validation';

// ============================================================
// Lab Departments
// ============================================================

export async function createLabDepartment(tenantId: string, data: CreateLabDepartmentInput) {
  const existing = await prisma.labDepartment.findFirst({
    where: { tenantId, name: data.name },
  });

  if (existing) {
    throw AppError.conflict('A lab department with this name already exists');
  }

  const department = await prisma.labDepartment.create({
    data: {
      tenantId,
      name: data.name,
      isActive: data.isActive,
    },
  });

  logger.info({ tenantId, departmentId: department.id }, 'Lab department created');
  return department;
}

export async function getLabDepartments(tenantId: string, query: GetLabDepartmentsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.isActive !== undefined) {
    where.isActive = query.isActive;
  }

  if (query.search) {
    where.name = { contains: query.search, mode: 'insensitive' };
  }

  const [departments, total] = await Promise.all([
    prisma.labDepartment.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.labDepartment.count({ where }),
  ]);

  return { departments, total, page, limit };
}

export async function updateLabDepartment(
  tenantId: string,
  id: string,
  data: UpdateLabDepartmentInput,
) {
  const department = await prisma.labDepartment.findFirst({
    where: { id, tenantId },
  });

  if (!department) {
    throw AppError.notFound('Lab department not found');
  }

  if (data.name && data.name !== department.name) {
    const duplicate = await prisma.labDepartment.findFirst({
      where: { tenantId, name: data.name, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict('A lab department with this name already exists');
    }
  }

  const updated = await prisma.labDepartment.update({
    where: { id },
    data,
  });

  logger.info({ tenantId, departmentId: id }, 'Lab department updated');
  return updated;
}

export async function deleteLabDepartment(tenantId: string, id: string) {
  const department = await prisma.labDepartment.findFirst({
    where: { id, tenantId },
  });

  if (!department) {
    throw AppError.notFound('Lab department not found');
  }

  // Soft-delete by deactivating
  const updated = await prisma.labDepartment.update({
    where: { id },
    data: { isActive: false },
  });

  logger.info({ tenantId, departmentId: id }, 'Lab department deactivated');
  return updated;
}

// ============================================================
// Test Catalog
// ============================================================

export async function createTest(tenantId: string, data: CreateTestInput) {
  // Verify department exists and belongs to tenant
  const department = await prisma.labDepartment.findFirst({
    where: { id: data.labDepartmentId, tenantId },
  });

  if (!department) {
    throw AppError.notFound('Lab department not found');
  }

  if (data.testCode) {
    const duplicate = await prisma.labTestCatalog.findFirst({
      where: { tenantId, testCode: data.testCode },
    });
    if (duplicate) {
      throw AppError.conflict('A test with this code already exists');
    }
  }

  const test = await prisma.labTestCatalog.create({
    data: {
      tenantId,
      labDepartmentId: data.labDepartmentId,
      testName: data.testName,
      testCode: data.testCode,
      description: data.description,
      normalRange: data.normalRange,
      unit: data.unit,
      price: data.price,
      turnaroundHours: data.turnaroundHours,
      sampleType: data.sampleType,
      isActive: data.isActive,
    },
    include: {
      labDepartment: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, testId: test.id }, 'Lab test created');
  return test;
}

export async function getTests(tenantId: string, query: GetTestsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.labDepartmentId) {
    where.labDepartmentId = query.labDepartmentId;
  }

  if (query.isActive !== undefined) {
    where.isActive = query.isActive;
  }

  if (query.sampleType) {
    where.sampleType = { contains: query.sampleType, mode: 'insensitive' };
  }

  if (query.search) {
    where.OR = [
      { testName: { contains: query.search, mode: 'insensitive' } },
      { testCode: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const [tests, total] = await Promise.all([
    prisma.labTestCatalog.findMany({
      where,
      skip,
      take,
      include: {
        labDepartment: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.labTestCatalog.count({ where }),
  ]);

  return { tests, total, page, limit };
}

export async function getTestById(tenantId: string, id: string) {
  const test = await prisma.labTestCatalog.findFirst({
    where: { id, tenantId },
    include: {
      labDepartment: { select: { id: true, name: true } },
    },
  });

  if (!test) {
    throw AppError.notFound('Lab test not found');
  }

  return test;
}

export async function updateTest(tenantId: string, id: string, data: UpdateTestInput) {
  const test = await prisma.labTestCatalog.findFirst({
    where: { id, tenantId },
  });

  if (!test) {
    throw AppError.notFound('Lab test not found');
  }

  if (data.labDepartmentId) {
    const department = await prisma.labDepartment.findFirst({
      where: { id: data.labDepartmentId, tenantId },
    });
    if (!department) {
      throw AppError.notFound('Lab department not found');
    }
  }

  if (data.testCode && data.testCode !== test.testCode) {
    const duplicate = await prisma.labTestCatalog.findFirst({
      where: { tenantId, testCode: data.testCode, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict('A test with this code already exists');
    }
  }

  const updated = await prisma.labTestCatalog.update({
    where: { id },
    data,
    include: {
      labDepartment: { select: { id: true, name: true } },
    },
  });

  logger.info({ tenantId, testId: id }, 'Lab test updated');
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
            },
          },
          labResults: true,
        },
      },
      labSamples: true,
      labReport: true,
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

export async function cancelLabOrder(tenantId: string, id: string) {
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

  const updated = await prisma.$transaction(async (tx) => {
    // Cancel all pending order items
    await tx.labOrderItem.updateMany({
      where: { labOrderId: id, status: 'pending' },
      data: { status: 'cancelled' },
    });

    return tx.labOrder.update({
      where: { id },
      data: { status: 'cancelled' },
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
            patient: {
              select: { id: true, mrn: true, firstName: true, lastName: true },
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
  data: UpdateSampleStatusInput,
) {
  const sample = await prisma.labSample.findFirst({
    where: { id, labOrder: { tenantId } },
  });

  if (!sample) {
    throw AppError.notFound('Sample not found');
  }

  const updateData: any = { status: data.status };

  if (data.status === 'received') {
    updateData.receivedAt = new Date();
  }

  const updated = await prisma.labSample.update({
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

  logger.info({ tenantId, sampleId: id, status: data.status }, 'Sample status updated');
  return updated;
}

export async function rejectSample(tenantId: string, id: string, data: RejectSampleInput) {
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
  return updated;
}

// ============================================================
// Results
// ============================================================

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

  const results = await prisma.$transaction(async (tx) => {
    const created = await Promise.all(
      data.results.map((result) =>
        tx.labResult.create({
          data: {
            labOrderItemId: data.labOrderItemId,
            labOrderId: data.labOrderId,
            patientId: data.patientId,
            parameterName: result.parameterName,
            value: result.value,
            unit: result.unit,
            normalRange: result.normalRange,
            isAbnormal: result.isAbnormal,
            enteredBy: userId,
            enteredAt: new Date(),
          },
        }),
      ),
    );

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

export async function verifyResult(tenantId: string, id: string, userId: string) {
  const result = await prisma.labResult.findFirst({
    where: { id, labOrder: { tenantId } },
    include: {
      labOrderItem: { include: { labOrder: true } },
    },
  });

  if (!result) {
    throw AppError.notFound('Lab result not found');
  }

  // For now we don't have verifiedBy on LabResult in schema,
  // but we can mark the order item as completed once all results for it are verified.
  // We'll update the order item status to completed.
  const orderItem = result.labOrderItem;

  const updatedItem = await prisma.$transaction(async (tx) => {
    // Mark order item as completed
    const updated = await tx.labOrderItem.update({
      where: { id: orderItem.id },
      data: { status: 'completed' },
      include: {
        test: { select: { id: true, testName: true, testCode: true } },
        labResults: true,
      },
    });

    // Check if all order items are completed; if so, mark the order as completed
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

    return updated;
  });

  logger.info({ tenantId, resultId: id, verifiedBy: userId }, 'Lab result verified');
  return updatedItem;
}

// ============================================================
// Reports
// ============================================================

export async function generateLabReport(
  tenantId: string,
  orderId: string,
  userId: string,
  reportContent?: string,
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

  // Check if a report already exists for this order
  const existing = await prisma.labReport.findUnique({
    where: { labOrderId: orderId },
  });

  if (existing) {
    throw AppError.conflict('A report already exists for this order');
  }

  const report = await prisma.labReport.create({
    data: {
      labOrderId: orderId,
      patientId: order.patientId,
      reportContent: reportContent || null,
      status: 'draft',
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

  logger.info({ tenantId, reportId: report.id, orderId }, 'Lab report generated');
  return report;
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
    },
  });

  if (!report) {
    throw AppError.notFound('Lab report not found');
  }

  return report;
}
