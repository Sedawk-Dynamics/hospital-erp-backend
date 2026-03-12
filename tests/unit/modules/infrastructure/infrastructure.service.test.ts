import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createDepartment,
  getDepartments,
  getDepartmentById,
  updateDepartment,
  deleteDepartment,
  createWard,
  updateWard,
  deleteWard,
  createRoom,
  getRoomById,
  createBed,
  getBedById,
  deleteBed,
} from '../../../../src/modules/infrastructure/infrastructure.service';

const TENANT_ID = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEPARTMENTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Infrastructure Service - Departments', () => {
  describe('createDepartment', () => {
    it('should create a department successfully', async () => {
      const input = { name: 'Cardiology', code: 'CARD', description: 'Heart dept' };
      const created = { id: 'dept-1', tenantId: TENANT_ID, ...input, isActive: true };

      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null); // no duplicate name
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null); // no duplicate code
      vi.mocked(prisma.department.create).mockResolvedValueOnce(created as any);

      const result = await createDepartment(TENANT_ID, input);

      expect(result).toEqual(created);
      expect(prisma.department.create).toHaveBeenCalledOnce();
    });

    it('should throw conflict when department name already exists', async () => {
      const existing = { id: 'dept-existing', tenantId: TENANT_ID, name: 'Cardiology' };
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(existing as any);

      await expect(
        createDepartment(TENANT_ID, { name: 'Cardiology' }),
      ).rejects.toThrow('A department with this name already exists');
    });

    it('should throw conflict when department code already exists', async () => {
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null); // name check passes
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce({ id: 'x' } as any); // code duplicated

      await expect(
        createDepartment(TENANT_ID, { name: 'Neuro', code: 'NEURO' }),
      ).rejects.toThrow('A department with this code already exists');
    });
  });

  describe('getDepartments', () => {
    it('should return paginated departments', async () => {
      const departments = [{ id: 'dept-1', name: 'Cardiology' }];
      vi.mocked(prisma.department.findMany).mockResolvedValueOnce(departments as any);
      vi.mocked(prisma.department.count).mockResolvedValueOnce(1);

      const result = await getDepartments(TENANT_ID, { page: 1, limit: 20, sortOrder: 'desc' });

      expect(result.departments).toEqual(departments);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });
  });

  describe('getDepartmentById', () => {
    it('should throw notFound when department does not exist', async () => {
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null);

      await expect(getDepartmentById(TENANT_ID, 'non-existent')).rejects.toThrow(
        'Department not found',
      );
    });
  });

  describe('updateDepartment', () => {
    it('should update a department successfully', async () => {
      const existing = { id: 'dept-1', tenantId: TENANT_ID, name: 'Old Name', code: 'OLD' };
      const updated = { ...existing, name: 'New Name' };

      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(existing as any); // exists
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null); // no duplicate name
      vi.mocked(prisma.department.update).mockResolvedValueOnce(updated as any);

      const result = await updateDepartment(TENANT_ID, 'dept-1', { name: 'New Name' });

      expect(result.name).toBe('New Name');
    });

    it('should throw notFound when updating non-existent department', async () => {
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null);

      await expect(
        updateDepartment(TENANT_ID, 'bad-id', { name: 'X' }),
      ).rejects.toThrow('Department not found');
    });
  });

  describe('deleteDepartment', () => {
    it('should soft-delete a department with no active wards', async () => {
      const existing = { id: 'dept-1', tenantId: TENANT_ID, name: 'Cardiology', isActive: true };
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(existing as any);
      vi.mocked(prisma.ward.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.department.update).mockResolvedValueOnce({ ...existing, isActive: false } as any);

      const result = await deleteDepartment(TENANT_ID, 'dept-1');

      expect(result.isActive).toBe(false);
    });

    it('should throw badRequest when department has active wards', async () => {
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce({ id: 'dept-1' } as any);
      vi.mocked(prisma.ward.count).mockResolvedValueOnce(3);

      await expect(deleteDepartment(TENANT_ID, 'dept-1')).rejects.toThrow(
        'Cannot delete department with active wards',
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WARDS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Infrastructure Service - Wards', () => {
  describe('createWard', () => {
    it('should create a ward and verify department exists', async () => {
      const input = { name: 'Ward A', departmentId: 'dept-1', wardType: 'general', floor: 1 };
      const created = { id: 'ward-1', tenantId: TENANT_ID, ...input, isActive: true, totalBeds: 0 };

      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce({ id: 'dept-1' } as any);
      vi.mocked(prisma.ward.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.ward.create).mockResolvedValueOnce(created as any);

      const result = await createWard(TENANT_ID, input);

      expect(result.id).toBe('ward-1');
      expect(prisma.department.findFirst).toHaveBeenCalled();
    });

    it('should throw notFound when department does not exist', async () => {
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null);

      await expect(
        createWard(TENANT_ID, { name: 'Ward B', departmentId: 'bad-dept' }),
      ).rejects.toThrow('Department not found');
    });
  });

  describe('deleteWard', () => {
    it('should throw badRequest when ward has active rooms', async () => {
      vi.mocked(prisma.ward.findFirst).mockResolvedValueOnce({ id: 'ward-1' } as any);
      vi.mocked(prisma.room.count).mockResolvedValueOnce(5);

      await expect(deleteWard(TENANT_ID, 'ward-1')).rejects.toThrow(
        'Cannot delete ward with active rooms',
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROOMS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Infrastructure Service - Rooms', () => {
  describe('createRoom', () => {
    it('should create a room when ward exists and no duplicate room number', async () => {
      vi.mocked(prisma.ward.findFirst).mockResolvedValueOnce({ id: 'ward-1' } as any);
      vi.mocked(prisma.room.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.room.create).mockResolvedValueOnce({
        id: 'room-1',
        roomNumber: '101',
        wardId: 'ward-1',
      } as any);

      const result = await createRoom(TENANT_ID, {
        wardId: 'ward-1',
        roomNumber: '101',
        roomType: 'general',
      });

      expect(result.roomNumber).toBe('101');
    });
  });

  describe('getRoomById', () => {
    it('should throw notFound when room does not exist', async () => {
      vi.mocked(prisma.room.findFirst).mockResolvedValueOnce(null);

      await expect(getRoomById(TENANT_ID, 'no-room')).rejects.toThrow('Room not found');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BEDS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Infrastructure Service - Beds', () => {
  describe('createBed', () => {
    it('should create a bed when room exists and no duplicate bed number', async () => {
      vi.mocked(prisma.room.findFirst).mockResolvedValueOnce({ id: 'room-1' } as any);
      vi.mocked(prisma.bed.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.bed.create).mockResolvedValueOnce({
        id: 'bed-1',
        bedNumber: 'B1',
        roomId: 'room-1',
        status: 'available',
      } as any);

      const result = await createBed(TENANT_ID, {
        roomId: 'room-1',
        bedNumber: 'B1',
        bedType: 'standard',
      });

      expect(result.status).toBe('available');
    });
  });

  describe('getBedById', () => {
    it('should throw notFound when bed does not exist', async () => {
      vi.mocked(prisma.bed.findFirst).mockResolvedValueOnce(null);

      await expect(getBedById(TENANT_ID, 'no-bed')).rejects.toThrow('Bed not found');
    });
  });

  describe('deleteBed', () => {
    it('should set bed status to maintenance when deleting a non-occupied bed', async () => {
      const existing = { id: 'bed-1', tenantId: TENANT_ID, status: 'available' };
      vi.mocked(prisma.bed.findFirst).mockResolvedValueOnce(existing as any);
      vi.mocked(prisma.bed.update).mockResolvedValueOnce({ ...existing, status: 'maintenance' } as any);

      const result = await deleteBed(TENANT_ID, 'bed-1');

      expect(result.status).toBe('maintenance');
    });

    it('should throw badRequest when trying to delete an occupied bed', async () => {
      vi.mocked(prisma.bed.findFirst).mockResolvedValueOnce({ id: 'bed-1', status: 'occupied' } as any);

      await expect(deleteBed(TENANT_ID, 'bed-1')).rejects.toThrow(
        'Cannot delete an occupied bed',
      );
    });
  });
});
