import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  CreateDepartmentInput,
  UpdateDepartmentInput,
  ListDepartmentsQuery,
  CreateWardInput,
  UpdateWardInput,
  ListWardsQuery,
  CreateRoomInput,
  UpdateRoomInput,
  ListRoomsQuery,
  CreateBedInput,
  UpdateBedInput,
  ListBedsQuery,
  BedAvailabilityQuery,
} from './infrastructure.validation';

// ═══════════════════════════════════════════════════════════════════════════════
// DEPARTMENTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function createDepartment(tenantId: string, data: CreateDepartmentInput) {
  // Check for duplicate name within the tenant
  const existing = await prisma.department.findFirst({
    where: { tenantId, name: { equals: data.name, mode: 'insensitive' } },
  });
  if (existing) {
    throw AppError.conflict('A department with this name already exists');
  }

  // Check for duplicate code if provided
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

  // Check for duplicate name if being updated
  if (data.name && data.name !== existing.name) {
    const duplicate = await prisma.department.findFirst({
      where: { tenantId, name: { equals: data.name, mode: 'insensitive' }, id: { not: id } },
    });
    if (duplicate) {
      throw AppError.conflict('A department with this name already exists');
    }
  }

  // Check for duplicate code if being updated
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

  // Check for active wards before deleting
  const activeWards = await prisma.ward.count({
    where: { departmentId: id, tenantId, isActive: true },
  });

  if (activeWards > 0) {
    throw AppError.badRequest(
      'Cannot delete department with active wards. Deactivate or reassign wards first.',
    );
  }

  // Soft delete by deactivating
  const department = await prisma.department.update({
    where: { id },
    data: { isActive: false },
  });

  return department;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WARDS
// ═══════════════════════════════════════════════════════════════════════════════

export async function createWard(tenantId: string, data: CreateWardInput) {
  // Verify department exists if provided
  if (data.departmentId) {
    const department = await prisma.department.findFirst({
      where: { id: data.departmentId, tenantId },
    });
    if (!department) {
      throw AppError.notFound('Department not found');
    }
  }

  // Check for duplicate name within tenant
  const existing = await prisma.ward.findFirst({
    where: { tenantId, name: { equals: data.name, mode: 'insensitive' } },
  });
  if (existing) {
    throw AppError.conflict('A ward with this name already exists');
  }

  const ward = await prisma.ward.create({
    data: {
      tenantId,
      name: data.name,
      departmentId: data.departmentId,
      wardType: data.wardType as any,
      floor: data.floor,
      totalBeds: data.totalBeds ?? 0,
      isActive: data.isActive ?? true,
    },
  });

  return ward;
}

export async function getWards(tenantId: string, query: ListWardsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.search) {
    const search = query.search.trim();
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (query.departmentId) {
    where.departmentId = query.departmentId;
  }

  if (query.wardType) {
    where.wardType = query.wardType;
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

  const [wards, total] = await Promise.all([
    prisma.ward.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { rooms: true } },
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
      rooms: {
        where: { isActive: true },
        orderBy: { roomNumber: 'asc' },
        include: {
          _count: { select: { beds: true } },
        },
      },
      _count: { select: { rooms: true } },
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

  // Verify department exists if being updated
  if (data.departmentId) {
    const department = await prisma.department.findFirst({
      where: { id: data.departmentId, tenantId },
    });
    if (!department) {
      throw AppError.notFound('Department not found');
    }
  }

  // Check for duplicate name if being updated
  if (data.name && data.name !== existing.name) {
    const duplicate = await prisma.ward.findFirst({
      where: { tenantId, name: { equals: data.name, mode: 'insensitive' }, id: { not: id } },
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
      ...(data.wardType !== undefined && { wardType: data.wardType as any }),
      ...(data.floor !== undefined && { floor: data.floor }),
      ...(data.totalBeds !== undefined && { totalBeds: data.totalBeds }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
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

  // Check for active rooms before deleting
  const activeRooms = await prisma.room.count({
    where: { wardId: id, tenantId, isActive: true },
  });

  if (activeRooms > 0) {
    throw AppError.badRequest(
      'Cannot delete ward with active rooms. Deactivate or reassign rooms first.',
    );
  }

  const ward = await prisma.ward.update({
    where: { id },
    data: { isActive: false },
  });

  return ward;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOMS
// ═══════════════════════════════════════════════════════════════════════════════

export async function createRoom(tenantId: string, data: CreateRoomInput) {
  // Verify ward exists
  const ward = await prisma.ward.findFirst({
    where: { id: data.wardId, tenantId },
  });
  if (!ward) {
    throw AppError.notFound('Ward not found');
  }

  // Check for duplicate room number within the same ward
  const existing = await prisma.room.findFirst({
    where: {
      tenantId,
      wardId: data.wardId,
      roomNumber: { equals: data.roomNumber, mode: 'insensitive' },
    },
  });
  if (existing) {
    throw AppError.conflict('A room with this number already exists in this ward');
  }

  const room = await prisma.room.create({
    data: {
      tenantId,
      wardId: data.wardId,
      roomNumber: data.roomNumber,
      roomType: data.roomType as any,
      floor: data.floor,
      isActive: data.isActive ?? true,
    },
  });

  return room;
}

export async function getRooms(tenantId: string, query: ListRoomsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.search) {
    const search = query.search.trim();
    where.OR = [
      { roomNumber: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (query.wardId) {
    where.wardId = query.wardId;
  }

  if (query.roomType) {
    where.roomType = query.roomType;
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

  const [rooms, total] = await Promise.all([
    prisma.room.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        ward: { select: { id: true, name: true } },
        _count: { select: { beds: true } },
      },
    }),
    prisma.room.count({ where }),
  ]);

  return { rooms, total, page, limit };
}

export async function getRoomById(tenantId: string, id: string) {
  const room = await prisma.room.findFirst({
    where: { id, tenantId },
    include: {
      ward: {
        select: { id: true, name: true, departmentId: true },
      },
      beds: {
        orderBy: { bedNumber: 'asc' },
      },
      _count: { select: { beds: true } },
    },
  });

  if (!room) {
    throw AppError.notFound('Room not found');
  }

  return room;
}

export async function updateRoom(tenantId: string, id: string, data: UpdateRoomInput) {
  const existing = await prisma.room.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Room not found');
  }

  // Verify ward exists if being changed
  if (data.wardId && data.wardId !== existing.wardId) {
    const ward = await prisma.ward.findFirst({
      where: { id: data.wardId, tenantId },
    });
    if (!ward) {
      throw AppError.notFound('Ward not found');
    }
  }

  // Check for duplicate room number if being updated
  const targetWardId = data.wardId ?? existing.wardId;
  if (data.roomNumber && (data.roomNumber !== existing.roomNumber || data.wardId !== existing.wardId)) {
    const duplicate = await prisma.room.findFirst({
      where: {
        tenantId,
        wardId: targetWardId,
        roomNumber: { equals: data.roomNumber, mode: 'insensitive' },
        id: { not: id },
      },
    });
    if (duplicate) {
      throw AppError.conflict('A room with this number already exists in this ward');
    }
  }

  const room = await prisma.room.update({
    where: { id },
    data: {
      ...(data.wardId !== undefined && { wardId: data.wardId }),
      ...(data.roomNumber !== undefined && { roomNumber: data.roomNumber }),
      ...(data.roomType !== undefined && { roomType: data.roomType as any }),
      ...(data.floor !== undefined && { floor: data.floor }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
  });

  return room;
}

export async function deleteRoom(tenantId: string, id: string) {
  const existing = await prisma.room.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Room not found');
  }

  // Check for beds that are occupied or reserved
  const activeBeds = await prisma.bed.count({
    where: {
      roomId: id,
      tenantId,
      status: { in: ['occupied', 'reserved'] },
    },
  });

  if (activeBeds > 0) {
    throw AppError.badRequest(
      'Cannot delete room with occupied or reserved beds. Discharge patients or free beds first.',
    );
  }

  const room = await prisma.room.update({
    where: { id },
    data: { isActive: false },
  });

  return room;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BEDS
// ═══════════════════════════════════════════════════════════════════════════════

export async function createBed(tenantId: string, data: CreateBedInput) {
  // Verify room exists
  const room = await prisma.room.findFirst({
    where: { id: data.roomId, tenantId },
  });
  if (!room) {
    throw AppError.notFound('Room not found');
  }

  // Check for duplicate bed number within the same room
  const existing = await prisma.bed.findFirst({
    where: {
      tenantId,
      roomId: data.roomId,
      bedNumber: { equals: data.bedNumber, mode: 'insensitive' },
    },
  });
  if (existing) {
    throw AppError.conflict('A bed with this number already exists in this room');
  }

  const bed = await prisma.bed.create({
    data: {
      tenantId,
      roomId: data.roomId,
      bedNumber: data.bedNumber,
      bedType: data.bedType as any,
      status: (data.status as any) ?? 'available',
    },
  });

  return bed;
}

export async function getBeds(tenantId: string, query: ListBedsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.search) {
    const search = query.search.trim();
    where.OR = [
      { bedNumber: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (query.roomId) {
    where.roomId = query.roomId;
  }

  if (query.wardId) {
    where.room = { wardId: query.wardId };
  }

  if (query.bedType) {
    where.bedType = query.bedType;
  }

  if (query.status) {
    where.status = query.status;
  }

  const orderBy: any = {};
  if (query.sortBy) {
    orderBy[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [beds, total] = await Promise.all([
    prisma.bed.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        room: {
          select: {
            id: true,
            roomNumber: true,
            ward: { select: { id: true, name: true } },
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
      room: {
        select: {
          id: true,
          roomNumber: true,
          roomType: true,
          ward: {
            select: {
              id: true,
              name: true,
              departmentId: true,
              department: { select: { id: true, name: true } },
            },
          },
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

  // Verify room exists if being changed
  if (data.roomId && data.roomId !== existing.roomId) {
    const room = await prisma.room.findFirst({
      where: { id: data.roomId, tenantId },
    });
    if (!room) {
      throw AppError.notFound('Room not found');
    }
  }

  // Check for duplicate bed number if being updated
  const targetRoomId = data.roomId ?? existing.roomId;
  if (data.bedNumber && (data.bedNumber !== existing.bedNumber || data.roomId !== existing.roomId)) {
    const duplicate = await prisma.bed.findFirst({
      where: {
        tenantId,
        roomId: targetRoomId,
        bedNumber: { equals: data.bedNumber, mode: 'insensitive' },
        id: { not: id },
      },
    });
    if (duplicate) {
      throw AppError.conflict('A bed with this number already exists in this room');
    }
  }

  const bed = await prisma.bed.update({
    where: { id },
    data: {
      ...(data.roomId !== undefined && { roomId: data.roomId }),
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

  // Set status to maintenance as a soft delete
  const bed = await prisma.bed.update({
    where: { id },
    data: { status: 'maintenance' },
  });

  return bed;
}

export async function getBedAvailability(tenantId: string, query: BedAvailabilityQuery) {
  const where: any = { tenantId };

  if (query.wardId) {
    where.room = { wardId: query.wardId };
  }

  if (query.departmentId) {
    where.room = {
      ...where.room,
      ward: { departmentId: query.departmentId },
    };
  }

  const [total, available, occupied, maintenance, reserved] = await Promise.all([
    prisma.bed.count({ where }),
    prisma.bed.count({ where: { ...where, status: 'available' } }),
    prisma.bed.count({ where: { ...where, status: 'occupied' } }),
    prisma.bed.count({ where: { ...where, status: 'maintenance' } }),
    prisma.bed.count({ where: { ...where, status: 'reserved' } }),
  ]);

  // Get per-ward breakdown
  const wards = await prisma.ward.findMany({
    where: {
      tenantId,
      isActive: true,
      ...(query.wardId && { id: query.wardId }),
      ...(query.departmentId && { departmentId: query.departmentId }),
    },
    select: {
      id: true,
      name: true,
      wardType: true,
      totalBeds: true,
      rooms: {
        where: { isActive: true },
        select: {
          id: true,
          roomNumber: true,
          beds: {
            select: {
              id: true,
              bedNumber: true,
              bedType: true,
              status: true,
            },
          },
        },
      },
    },
    orderBy: { name: 'asc' },
  });

  const wardSummaries = wards.map((ward) => {
    const allBeds = ward.rooms.flatMap((room) => room.beds);
    return {
      wardId: ward.id,
      wardName: ward.name,
      wardType: ward.wardType,
      totalBeds: allBeds.length,
      available: allBeds.filter((b) => b.status === 'available').length,
      occupied: allBeds.filter((b) => b.status === 'occupied').length,
      maintenance: allBeds.filter((b) => b.status === 'maintenance').length,
      reserved: allBeds.filter((b) => b.status === 'reserved').length,
    };
  });

  return {
    summary: { total, available, occupied, maintenance, reserved },
    wards: wardSummaries,
  };
}

export async function getOccupancy(tenantId: string, query: { wardId?: string; departmentId?: string }) {
  const where: any = { tenantId, isActive: true };
  if (query.wardId) where.id = query.wardId;
  if (query.departmentId) where.departmentId = query.departmentId;

  const wards = await prisma.ward.findMany({
    where,
    include: {
      rooms: {
        include: {
          beds: {
            select: {
              id: true,
              status: true,
              currentPatientId: true,
            },
          },
        },
      },
      department: { select: { id: true, name: true } },
    },
    orderBy: { name: 'asc' },
  });

  return wards.map((ward) => {
    const allBeds = ward.rooms.flatMap((r) => r.beds);
    const total = allBeds.length;
    const occupied = allBeds.filter((b) => b.status === 'occupied').length;
    const available = allBeds.filter((b) => b.status === 'available').length;
    const maintenance = allBeds.filter((b) => b.status === 'maintenance' || b.status === 'reserved').length;

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
