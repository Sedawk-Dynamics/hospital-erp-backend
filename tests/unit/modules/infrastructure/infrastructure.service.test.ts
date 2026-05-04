import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createDepartment,
  getDepartments,
  getDepartmentById,
  updateDepartment,
  deleteDepartment,
  createFloor,
  getFloorById,
  updateFloor,
  deleteFloor,
  createWard,
  deleteWard,
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

      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null);
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
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce({ id: 'x' } as any);

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

      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(existing as any);
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.department.update).mockResolvedValueOnce(updated as any);

      const result = await updateDepartment(TENANT_ID, 'dept-1', { name: 'New Name' });

      expect(result.name).toBe('New Name');
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
// FLOORS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Infrastructure Service - Floors', () => {
  describe('createFloor', () => {
    it('should create a floor when name and level are unique', async () => {
      const input = { name: 'Ground', level: 0, isActive: true };
      vi.mocked(prisma.floor.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.floor.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.floor.create).mockResolvedValueOnce({
        id: 'floor-1',
        tenantId: TENANT_ID,
        ...input,
      } as any);

      const result = await createFloor(TENANT_ID, input);

      expect(result.name).toBe('Ground');
    });

    it('should throw conflict when floor name already exists', async () => {
      vi.mocked(prisma.floor.findFirst).mockResolvedValueOnce({ id: 'f' } as any);

      await expect(
        createFloor(TENANT_ID, { name: 'Ground', level: 0, isActive: true }),
      ).rejects.toThrow('A floor with this name already exists');
    });

    it('should throw conflict when floor level already exists', async () => {
      vi.mocked(prisma.floor.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.floor.findFirst).mockResolvedValueOnce({ id: 'f' } as any);

      await expect(
        createFloor(TENANT_ID, { name: 'First', level: 1, isActive: true }),
      ).rejects.toThrow('A floor with level 1 already exists');
    });
  });

  describe('getFloorById', () => {
    it('should throw notFound when floor does not exist', async () => {
      vi.mocked(prisma.floor.findFirst).mockResolvedValueOnce(null);
      await expect(getFloorById(TENANT_ID, 'no-floor')).rejects.toThrow('Floor not found');
    });
  });

  describe('updateFloor', () => {
    it('should update a floor successfully', async () => {
      const existing = { id: 'floor-1', tenantId: TENANT_ID, name: 'Ground', level: 0 };
      vi.mocked(prisma.floor.findFirst).mockResolvedValueOnce(existing as any);
      vi.mocked(prisma.floor.update).mockResolvedValueOnce({ ...existing, name: 'GF' } as any);

      const result = await updateFloor(TENANT_ID, 'floor-1', { name: 'GF' });
      expect(result.name).toBe('GF');
    });
  });

  describe('deleteFloor', () => {
    it('should throw badRequest when floor has active wards', async () => {
      vi.mocked(prisma.floor.findFirst).mockResolvedValueOnce({ id: 'floor-1' } as any);
      vi.mocked(prisma.ward.count).mockResolvedValueOnce(2);

      await expect(deleteFloor(TENANT_ID, 'floor-1')).rejects.toThrow(
        'Cannot delete floor with active wards',
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WARDS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Infrastructure Service - Wards', () => {
  describe('createWard', () => {
    it('should create a ward and verify department + floor exist', async () => {
      const input = {
        name: 'Ward A',
        departmentId: 'dept-1',
        floorId: 'floor-1',
        wardType: 'general' as const,
        totalBeds: 0,
        isActive: true,
      };
      const created = { id: 'ward-1', tenantId: TENANT_ID, ...input };

      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce({ id: 'dept-1' } as any);
      vi.mocked(prisma.floor.findFirst).mockResolvedValueOnce({ id: 'floor-1' } as any);
      vi.mocked(prisma.ward.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.ward.create).mockResolvedValueOnce(created as any);

      const result = await createWard(TENANT_ID, input);

      expect(result.id).toBe('ward-1');
      expect(prisma.floor.findFirst).toHaveBeenCalled();
    });

    it('should throw notFound when department does not exist', async () => {
      vi.mocked(prisma.department.findFirst).mockResolvedValueOnce(null);

      await expect(
        createWard(TENANT_ID, {
          name: 'Ward B',
          departmentId: 'bad-dept',
          totalBeds: 0,
          isActive: true,
        }),
      ).rejects.toThrow('Department not found');
    });

    it('should throw notFound when floor does not exist', async () => {
      vi.mocked(prisma.floor.findFirst).mockResolvedValueOnce(null);

      await expect(
        createWard(TENANT_ID, {
          name: 'Ward C',
          floorId: 'bad-floor',
          totalBeds: 0,
          isActive: true,
        }),
      ).rejects.toThrow('Floor not found');
    });
  });

  describe('deleteWard', () => {
    it('should throw badRequest when ward has occupied beds', async () => {
      vi.mocked(prisma.ward.findFirst).mockResolvedValueOnce({ id: 'ward-1' } as any);
      vi.mocked(prisma.bed.count).mockResolvedValueOnce(5);

      await expect(deleteWard(TENANT_ID, 'ward-1')).rejects.toThrow(
        'Cannot delete ward with occupied or reserved beds',
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BEDS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Infrastructure Service - Beds', () => {
  describe('createBed', () => {
    it('should create a bed when ward exists and no duplicate bed number', async () => {
      vi.mocked(prisma.ward.findFirst).mockResolvedValueOnce({ id: 'ward-1' } as any);
      vi.mocked(prisma.bed.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.bed.create).mockResolvedValueOnce({
        id: 'bed-1',
        bedNumber: 'B1',
        wardId: 'ward-1',
        status: 'available',
      } as any);

      const result = await createBed(TENANT_ID, {
        wardId: 'ward-1',
        bedNumber: 'B1',
        bedType: 'standard',
        status: 'available',
      });

      expect(result.status).toBe('available');
    });

    it('should throw notFound when ward does not exist', async () => {
      vi.mocked(prisma.ward.findFirst).mockResolvedValueOnce(null);

      await expect(
        createBed(TENANT_ID, {
          wardId: 'no-ward',
          bedNumber: 'B1',
          status: 'available',
        }),
      ).rejects.toThrow('Ward not found');
    });
  });

  describe('getBedById', () => {
    it('should throw notFound when bed does not exist', async () => {
      vi.mocked(prisma.bed.findFirst).mockResolvedValueOnce(null);

      await expect(getBedById(TENANT_ID, 'no-bed')).rejects.toThrow('Bed not found');
    });
  });

  describe('deleteBed', () => {
    it('should hard-delete a bed with no patient history', async () => {
      const existing = { id: 'bed-1', tenantId: TENANT_ID, status: 'available' };
      vi.mocked(prisma.bed.findFirst).mockResolvedValueOnce(existing as any);
      vi.mocked(prisma.admission.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.patientTransfer.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.patientTransfer.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.nurseAssignment.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.reservation.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.bed.delete).mockResolvedValueOnce(existing as any);

      const result = await deleteBed(TENANT_ID, 'bed-1');

      expect(prisma.bed.delete).toHaveBeenCalledWith({ where: { id: 'bed-1' } });
      expect(result.id).toBe('bed-1');
    });

    it('should soft-delete (mark maintenance) when bed has admission history', async () => {
      const existing = { id: 'bed-2', tenantId: TENANT_ID, status: 'available' };
      vi.mocked(prisma.bed.findFirst).mockResolvedValueOnce(existing as any);
      vi.mocked(prisma.admission.count).mockResolvedValueOnce(1);
      vi.mocked(prisma.patientTransfer.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.patientTransfer.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.nurseAssignment.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.reservation.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.bed.update).mockResolvedValueOnce({ ...existing, status: 'maintenance' } as any);

      const result = await deleteBed(TENANT_ID, 'bed-2');

      expect(prisma.bed.delete).not.toHaveBeenCalled();
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
