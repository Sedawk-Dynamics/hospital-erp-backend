import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateDepartmentInput,
  UpdateDepartmentInput,
  ListDepartmentsQuery,
  CreateFloorInput,
  UpdateFloorInput,
  ListFloorsQuery,
  CreateWardInput,
  UpdateWardInput,
  ListWardsQuery,
  CreateBedInput,
  BulkCreateBedsInput,
  UpdateBedInput,
  ListBedsQuery,
  BedAvailabilityQuery,
} from './infrastructure.validation';

// ═══════════════════════════════════════════════════════════════════════════════
// DEPARTMENTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function createDepartment(tenantId: string, data: CreateDepartmentInput) {
  const existing = await prisma.department.findFirst({
    where: { tenantId, name: { equals: data.name, mode: 'insensitive' } },
  });
  if (existing) {
    throw AppError.conflict('A department with this name already exists');
  }

  if (data.code) {
    const existingByCode = await prisma.department.findFirst({
      where: { tenantId, code: { equals: data.code, mode: 'insensitive' } },
    });
    if (existingByCode) {
      throw AppError.conflict('A department with this code already exists');
    }
  }

  const department = await prisma.department.create({
    data: {
      tenantId,
      name: data.name,
      code: data.code,
      description: data.description,
      headUserId: data.headUserId,
      isActive: data.isActive ?? true,
    },
  });

  return department;
}

export async function getDepartments(tenantId: string, query: ListDepartmentsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.search) {
    const search = query.search.trim();
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { code: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (query.isActive !== undefined) {
    where.isActive = query.isActive;
  }

  const orderBy: any = {};
  if (query.sortBy) {
    orderBy[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [departments, total] = await Promise.all([
    prisma.department.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        headUser: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        _count: { select: { wards: true } },
      },
    }),
    prisma.department.count({ where }),
  ]);

  return { departments, total, page, limit };
}

export async function getDepartmentById(tenantId: string, id: string) {
  const department = await prisma.department.findFirst({
    where: { id, tenantId },
    include: {
      headUser: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      wards: {
        where: { isActive: true },
        orderBy: { name: 'asc' },
      },
      _count: { select: { wards: true } },
    },
  });

  if (!department) {
    throw AppError.notFound('Department not found');
  }

  return department;
}

export async function updateDepartment(tenantId: string, id: string, data: UpdateDepartmentInput) {
  const existing = await prisma.department.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Department not found');
  }

  if (data.name && data.name !== existing.name) {
    const duplicate = await prisma.department.findFirst({
      where: { tenantId, name: { equals: data.name, mode: 'insensitive' }, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict('A department with this name already exists');
    }
  }

  if (data.code && data.code !== existing.code) {
    const duplicate = await prisma.department.findFirst({
      where: { tenantId, code: { equals: data.code, mode: 'insensitive' }, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict('A department with this code already exists');
    }
  }

  const department = await prisma.department.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.code !== undefined && { code: data.code }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.headUserId !== undefined && { headUserId: data.headUserId }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
  });

  return department;
}

export async function deleteDepartment(tenantId: string, id: string) {
  const existing = await prisma.department.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Department not found');
  }

  const activeWards = await prisma.ward.count({
    where: { departmentId: id, tenantId, isActive: true },
  });

  if (activeWards > 0) {
    throw AppError.badRequest(
      'Cannot delete department with active wards. Deactivate or reassign wards first.',
    );
  }

  const department = await prisma.department.update({
    where: { id },
    data: { isActive: false },
  });

  return department;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FLOORS
// ═══════════════════════════════════════════════════════════════════════════════

export async function createFloor(tenantId: string, data: CreateFloorInput) {
  const existingByName = await prisma.floor.findFirst({
    where: { tenantId, name: { equals: data.name, mode: 'insensitive' } },
  });
  if (existingByName) {
    throw AppError.conflict('A floor with this name already exists');
  }

  const existingByLevel = await prisma.floor.findFirst({
    where: { tenantId, level: data.level },
  });
  if (existingByLevel) {
    throw AppError.conflict(`A floor with level ${data.level} already exists`);
  }

  const floor = await prisma.floor.create({
    data: {
      tenantId,
      name: data.name,
      level: data.level,
      description: data.description,
      isActive: data.isActive ?? true,
    },
  });

  return floor;
}

export async function getFloors(tenantId: string, query: ListFloorsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.search) {
    const search = query.search.trim();
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }

  where.isActive = query.isActive ?? true;

  const orderBy: any = query.sortBy
    ? { [query.sortBy]: query.sortOrder || 'asc' }
    : { level: 'asc' };

  const [floors, total] = await Promise.all([
    prisma.floor.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        _count: { select: { wards: true } },
      },
    }),
    prisma.floor.count({ where }),
  ]);

  return { floors, total, page, limit };
}

export async function getFloorById(tenantId: string, id: string) {
  const floor = await prisma.floor.findFirst({
    where: { id, tenantId },
    include: {
      wards: {
        where: { isActive: true },
        orderBy: { name: 'asc' },
        include: { _count: { select: { beds: true } } },
      },
      _count: { select: { wards: true } },
    },
  });

  if (!floor) {
    throw AppError.notFound('Floor not found');
  }

  return floor;
}

export async function updateFloor(tenantId: string, id: string, data: UpdateFloorInput) {
  const existing = await prisma.floor.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Floor not found');
  }

  if (data.name && data.name !== existing.name) {
    const duplicate = await prisma.floor.findFirst({
      where: { tenantId, name: { equals: data.name, mode: 'insensitive' }, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict('A floor with this name already exists');
    }
  }

  if (data.level !== undefined && data.level !== existing.level) {
    const duplicate = await prisma.floor.findFirst({
      where: { tenantId, level: data.level, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict(`A floor with level ${data.level} already exists`);
    }
  }

  const floor = await prisma.floor.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.level !== undefined && { level: data.level }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
  });

  return floor;
}

export async function deleteFloor(tenantId: string, id: string) {
  const existing = await prisma.floor.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Floor not found');
  }

  const activeWards = await prisma.ward.count({
    where: { floorId: id, tenantId, isActive: true },
  });

  if (activeWards > 0) {
    throw AppError.badRequest(
      'Cannot delete floor with active wards. Move or deactivate the wards first.',
    );
  }

  // Hard delete so the (tenantId, name) and (tenantId, level) unique
  // constraints free up — otherwise the user can never re-create a
  // floor with the same name. Detach any soft-deleted wards still
  // pointing at this floor first to avoid FK violations.
  return prisma.$transaction(async (tx) => {
    await tx.ward.updateMany({
      where: { floorId: id, tenantId },
      data: { floorId: null },
    });
    return tx.floor.delete({ where: { id } });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// WARDS
// ═══════════════════════════════════════════════════════════════════════════════

export async function createWard(tenantId: string, data: CreateWardInput) {
  if (data.departmentId) {
    const department = await prisma.department.findFirst({
      where: { id: data.departmentId, tenantId },
    });
    if (!department) {
      throw AppError.notFound('Department not found');
    }
  }

  if (data.floorId) {
    const floor = await prisma.floor.findFirst({
      where: { id: data.floorId, tenantId },
    });
    if (!floor) {
      throw AppError.notFound('Floor not found');
    }
  }

  const existing = await prisma.ward.findFirst({
    where: {
      tenantId,
      isActive: true,
      name: { equals: data.name, mode: 'insensitive' },
    },
  });
  if (existing) {
    throw AppError.conflict('A ward with this name already exists');
  }

  const ward = await prisma.ward.create({
    data: {
      tenantId,
      name: data.name,
      departmentId: data.departmentId,
      floorId: data.floorId,
      wardType: data.wardType as any,
      totalBeds: data.totalBeds ?? 0,
      isActive: data.isActive ?? true,
    },
    include: {
      floor: { select: { id: true, name: true, level: true } },
      department: { select: { id: true, name: true } },
    },
  });

  return ward;
}

export async function getWards(tenantId: string, query: ListWardsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.search) {
    const search = query.search.trim();
    where.OR = [{ name: { contains: search, mode: 'insensitive' } }];
  }

  if (query.departmentId) where.departmentId = query.departmentId;
  if (query.floorId) where.floorId = query.floorId;
  if (query.wardType) where.wardType = query.wardType;
  where.isActive = query.isActive ?? true;

  const orderBy: any = query.sortBy
    ? { [query.sortBy]: query.sortOrder || 'desc' }
    : { createdAt: 'desc' };

  const [wards, total] = await Promise.all([
    prisma.ward.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        department: { select: { id: true, name: true } },
        floor: { select: { id: true, name: true, level: true } },
        _count: { select: { beds: true } },
      },
    }),
    prisma.ward.count({ where }),
  ]);

  return { wards, total, page, limit };
}

export async function getWardById(tenantId: string, id: string) {
  const ward = await prisma.ward.findFirst({
    where: { id, tenantId },
    include: {
      department: { select: { id: true, name: true } },
      floor: { select: { id: true, name: true, level: true } },
      beds: {
        orderBy: { bedNumber: 'asc' },
      },
      _count: { select: { beds: true } },
    },
  });

  if (!ward) {
    throw AppError.notFound('Ward not found');
  }

  return ward;
}

export async function updateWard(tenantId: string, id: string, data: UpdateWardInput) {
  const existing = await prisma.ward.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Ward not found');
  }

  if (data.departmentId) {
    const department = await prisma.department.findFirst({
      where: { id: data.departmentId, tenantId },
    });
    if (!department) {
      throw AppError.notFound('Department not found');
    }
  }

  if (data.floorId) {
    const floor = await prisma.floor.findFirst({
      where: { id: data.floorId, tenantId },
    });
    if (!floor) {
      throw AppError.notFound('Floor not found');
    }
  }

  if (data.name && data.name !== existing.name) {
    const duplicate = await prisma.ward.findFirst({
      where: {
        tenantId,
        isActive: true,
        name: { equals: data.name, mode: 'insensitive' },
        id: { not: id },
      },
    });
    if (duplicate) {
      throw AppError.conflict('A ward with this name already exists');
    }
  }

  const ward = await prisma.ward.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.departmentId !== undefined && { departmentId: data.departmentId }),
      ...(data.floorId !== undefined && { floorId: data.floorId }),
      ...(data.wardType !== undefined && { wardType: data.wardType as any }),
      ...(data.totalBeds !== undefined && { totalBeds: data.totalBeds }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
    include: {
      floor: { select: { id: true, name: true, level: true } },
      department: { select: { id: true, name: true } },
    },
  });

  return ward;
}

export async function deleteWard(tenantId: string, id: string) {
  const existing = await prisma.ward.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Ward not found');
  }

  const activeBeds = await prisma.bed.count({
    where: { wardId: id, tenantId, status: { in: ['occupied', 'reserved'] } },
  });

  if (activeBeds > 0) {
    throw AppError.badRequest(
      'Cannot delete ward with occupied or reserved beds. Discharge patients or free beds first.',
    );
  }

  const ward = await prisma.ward.update({
    where: { id },
    data: { isActive: false },
  });

  return ward;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BEDS
// ═══════════════════════════════════════════════════════════════════════════════

export async function createBed(tenantId: string, data: CreateBedInput) {
  const ward = await prisma.ward.findFirst({
    where: { id: data.wardId, tenantId },
  });
  if (!ward) {
    throw AppError.notFound('Ward not found');
  }

  const existing = await prisma.bed.findFirst({
    where: {
      tenantId,
      wardId: data.wardId,
      bedNumber: { equals: data.bedNumber, mode: 'insensitive' },
    },
  });
  if (existing) {
    throw AppError.conflict('A bed with this number already exists in this ward');
  }

  const bed = await prisma.bed.create({
    data: {
      tenantId,
      wardId: data.wardId,
      bedNumber: data.bedNumber,
      bedType: data.bedType as any,
      status: (data.status as any) ?? 'available',
    },
    include: {
      ward: {
        select: {
          id: true,
          name: true,
          floor: { select: { id: true, name: true, level: true } },
        },
      },
    },
  });

  return bed;
}

export async function bulkCreateBeds(tenantId: string, data: BulkCreateBedsInput) {
  const ward = await prisma.ward.findFirst({
    where: { id: data.wardId, tenantId },
  });
  if (!ward) {
    throw AppError.notFound('Ward not found');
  }

  // Reject duplicates within the incoming payload (case-insensitive)
  const seen = new Set<string>();
  const dupesInPayload: string[] = [];
  for (const b of data.beds) {
    const key = b.bedNumber.trim().toLowerCase();
    if (seen.has(key)) dupesInPayload.push(b.bedNumber);
    seen.add(key);
  }
  if (dupesInPayload.length) {
    throw AppError.badRequest(
      `Duplicate bed numbers in request: ${dupesInPayload.join(', ')}`,
    );
  }

  // Reject any number that already exists in this ward (case-insensitive)
  const existing = await prisma.bed.findMany({
    where: {
      tenantId,
      wardId: data.wardId,
      bedNumber: { in: data.beds.map((b) => b.bedNumber), mode: 'insensitive' },
    },
    select: { bedNumber: true },
  });
  if (existing.length) {
    throw AppError.conflict(
      `Bed numbers already exist in this ward: ${existing.map((b) => b.bedNumber).join(', ')}`,
    );
  }

  const result = await prisma.bed.createMany({
    data: data.beds.map((b) => ({
      tenantId,
      wardId: data.wardId,
      bedNumber: b.bedNumber,
      bedType: (b.bedType ?? data.bedType) as any,
      status: 'available' as any,
    })),
  });

  const created = await prisma.bed.findMany({
    where: {
      tenantId,
      wardId: data.wardId,
      bedNumber: { in: data.beds.map((b) => b.bedNumber) },
    },
    include: {
      ward: {
        select: {
          id: true,
          name: true,
          floor: { select: { id: true, name: true, level: true } },
        },
      },
    },
    orderBy: { bedNumber: 'asc' },
  });

  return { count: result.count, beds: created };
}

export async function getBeds(tenantId: string, query: ListBedsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.search) {
    const search = query.search.trim();
    where.OR = [{ bedNumber: { contains: search, mode: 'insensitive' } }];
  }

  if (query.wardId) {
    where.wardId = query.wardId;
  } else if (query.floorId) {
    where.ward = { floorId: query.floorId, isActive: true };
  } else {
    // Hide beds whose ward has been soft-deleted so counts match the
    // visible ward list. An explicit wardId still surfaces all beds
    // (e.g., for admin recovery flows).
    where.ward = { isActive: true };
  }
  if (query.bedType) where.bedType = query.bedType;
  if (query.status) {
    if (query.status === 'available' && query.forPatientId) {
      // Broaden "available" to include beds reserved/occupied for this
      // specific patient so admission/transfer flows can keep the patient on
      // a bed that was pre-blocked for them.
      where.OR = [
        { status: 'available' },
        { status: { in: ['reserved', 'occupied'] }, currentPatientId: query.forPatientId },
      ];
    } else {
      where.status = query.status;
    }
  }

  const orderBy: any = query.sortBy
    ? { [query.sortBy]: query.sortOrder || 'desc' }
    : { createdAt: 'desc' };

  const [beds, total] = await Promise.all([
    prisma.bed.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        ward: {
          select: {
            id: true,
            name: true,
            wardType: true,
            floor: { select: { id: true, name: true, level: true } },
          },
        },
        currentPatient: {
          select: { id: true, firstName: true, lastName: true, mrn: true },
        },
      },
    }),
    prisma.bed.count({ where }),
  ]);

  return { beds, total, page, limit };
}

export async function getBedById(tenantId: string, id: string) {
  const bed = await prisma.bed.findFirst({
    where: { id, tenantId },
    include: {
      ward: {
        select: {
          id: true,
          name: true,
          wardType: true,
          departmentId: true,
          department: { select: { id: true, name: true } },
          floor: { select: { id: true, name: true, level: true } },
        },
      },
      currentPatient: {
        select: { id: true, firstName: true, lastName: true, mrn: true },
      },
    },
  });

  if (!bed) {
    throw AppError.notFound('Bed not found');
  }

  return bed;
}

export async function updateBed(tenantId: string, id: string, data: UpdateBedInput) {
  const existing = await prisma.bed.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Bed not found');
  }

  if (data.wardId && data.wardId !== existing.wardId) {
    const ward = await prisma.ward.findFirst({
      where: { id: data.wardId, tenantId },
    });
    if (!ward) {
      throw AppError.notFound('Ward not found');
    }
  }

  const targetWardId = data.wardId ?? existing.wardId;
  if (data.bedNumber && (data.bedNumber !== existing.bedNumber || data.wardId !== existing.wardId)) {
    const duplicate = await prisma.bed.findFirst({
      where: {
        tenantId,
        wardId: targetWardId,
        bedNumber: { equals: data.bedNumber, mode: 'insensitive' },
        id: { not: id },
      },
    });
    if (duplicate) {
      throw AppError.conflict('A bed with this number already exists in this ward');
    }
  }

  const bed = await prisma.bed.update({
    where: { id },
    data: {
      ...(data.wardId !== undefined && { wardId: data.wardId }),
      ...(data.bedNumber !== undefined && { bedNumber: data.bedNumber }),
      ...(data.bedType !== undefined && { bedType: data.bedType as any }),
      ...(data.status !== undefined && { status: data.status as any }),
    },
  });

  return bed;
}

export async function deleteBed(tenantId: string, id: string) {
  const existing = await prisma.bed.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Bed not found');
  }

  if (existing.status === 'occupied') {
    throw AppError.badRequest(
      'Cannot delete an occupied bed. Discharge the patient first.',
    );
  }

  // Hard delete when there's no patient-history FK pointing at the bed
  // (admissions, transfers, nurse assignments, reservations). Otherwise
  // we'd be lying to the user — a soft-delete-as-maintenance leaves the
  // bed in the count and looks identical to a bed actually under
  // maintenance. With patient history we keep it as maintenance to
  // preserve the audit trail.
  const [admissions, transfersFrom, transfersTo, assignments, reservations] = await Promise.all([
    prisma.admission.count({ where: { bedId: id } }),
    prisma.patientTransfer.count({ where: { fromBedId: id } }),
    prisma.patientTransfer.count({ where: { toBedId: id } }),
    prisma.nurseAssignment.count({ where: { bedId: id } }),
    prisma.reservation.count({ where: { bedId: id } }),
  ]);

  const hasHistory = admissions + transfersFrom + transfersTo + assignments + reservations > 0;

  if (hasHistory) {
    return prisma.bed.update({
      where: { id },
      data: { status: 'maintenance' },
    });
  }

  return prisma.bed.delete({ where: { id } });
}

export async function getBedAvailability(tenantId: string, query: BedAvailabilityQuery) {
  const where: any = { tenantId };

  if (query.wardId) where.wardId = query.wardId;
  if (query.floorId) where.ward = { ...(where.ward || {}), floorId: query.floorId };
  if (query.departmentId) where.ward = { ...(where.ward || {}), departmentId: query.departmentId };

  const [total, available, occupied, maintenance, reserved] = await Promise.all([
    prisma.bed.count({ where }),
    prisma.bed.count({ where: { ...where, status: 'available' } }),
    prisma.bed.count({ where: { ...where, status: 'occupied' } }),
    prisma.bed.count({ where: { ...where, status: 'maintenance' } }),
    prisma.bed.count({ where: { ...where, status: 'reserved' } }),
  ]);

  const wards = await prisma.ward.findMany({
    where: {
      tenantId,
      isActive: true,
      ...(query.wardId && { id: query.wardId }),
      ...(query.floorId && { floorId: query.floorId }),
      ...(query.departmentId && { departmentId: query.departmentId }),
    },
    select: {
      id: true,
      name: true,
      wardType: true,
      totalBeds: true,
      floor: { select: { id: true, name: true, level: true } },
      beds: {
        select: {
          id: true,
          bedNumber: true,
          bedType: true,
          status: true,
        },
      },
    },
    orderBy: { name: 'asc' },
  });

  const wardSummaries = wards.map((ward) => ({
    wardId: ward.id,
    wardName: ward.name,
    wardType: ward.wardType,
    floor: ward.floor,
    totalBeds: ward.beds.length,
    available: ward.beds.filter((b) => b.status === 'available').length,
    occupied: ward.beds.filter((b) => b.status === 'occupied').length,
    maintenance: ward.beds.filter((b) => b.status === 'maintenance').length,
    reserved: ward.beds.filter((b) => b.status === 'reserved').length,
  }));

  return {
    summary: { total, available, occupied, maintenance, reserved },
    wards: wardSummaries,
  };
}

export async function getOccupancy(
  tenantId: string,
  query: { wardId?: string; floorId?: string; departmentId?: string },
) {
  const where: any = { tenantId, isActive: true };
  if (query.wardId) where.id = query.wardId;
  if (query.floorId) where.floorId = query.floorId;
  if (query.departmentId) where.departmentId = query.departmentId;

  const wards = await prisma.ward.findMany({
    where,
    include: {
      beds: {
        select: {
          id: true,
          status: true,
          currentPatientId: true,
        },
      },
      department: { select: { id: true, name: true } },
      floor: { select: { id: true, name: true, level: true } },
    },
    orderBy: [{ floor: { level: 'asc' } }, { name: 'asc' }],
  });

  return wards.map((ward) => {
    const total = ward.beds.length;
    const occupied = ward.beds.filter((b) => b.status === 'occupied').length;
    const available = ward.beds.filter((b) => b.status === 'available').length;
    const maintenance = ward.beds.filter(
      (b) => b.status === 'maintenance' || b.status === 'reserved',
    ).length;

    return {
      wardId: ward.id,
      wardName: ward.name,
      wardType: ward.wardType,
      department: ward.department?.name ?? null,
      floor: ward.floor,
      totalBeds: total,
      occupied,
      available,
      maintenance,
      occupancyPercent: total > 0 ? Math.round((occupied / total) * 100) : 0,
    };
  });
}
