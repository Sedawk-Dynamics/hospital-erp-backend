import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createPrescription,
  updatePrescription,
  cancelPrescription,
  addPrescriptionItem,
  removePrescriptionItem,
  recordAdministration,
  getPrescriptions,
  getPrescriptionById,
} from '../../../../src/modules/prescriptions/prescriptions.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// Prescriptions
// ============================================================

describe('Prescriptions Service', () => {
  describe('createPrescription', () => {
    it('should create a prescription when patient, doctor, and visit exist', async () => {
      const input = {
        patientId: 'pat-1',
        doctorId: 'doc-1',
        visitId: 'visit-1',
        prescriptionType: 'medication',
      };

      vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce({ id: 'pat-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce({ id: 'doc-1' } as any);
      vi.mocked(prisma.visit.findFirst).mockResolvedValueOnce({ id: 'visit-1' } as any);
      vi.mocked(prisma.prescription.create).mockResolvedValueOnce({
        id: 'presc-1',
        tenantId: TENANT_ID,
        status: 'active',
        ...input,
      } as any);

      const result = await createPrescription(TENANT_ID, USER_ID, input as any);

      expect(result.id).toBe('presc-1');
      expect(result.status).toBe('active');
      expect(prisma.prescription.create).toHaveBeenCalledOnce();
    });

    it('should throw notFound when patient does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce(null);

      await expect(
        createPrescription(TENANT_ID, USER_ID, {
          patientId: 'bad',
          doctorId: 'doc-1',
          visitId: 'visit-1',
          prescriptionType: 'medication',
        } as any),
      ).rejects.toThrow('Patient not found');
    });

    it('should throw notFound when doctor does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce({ id: 'pat-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce(null);

      await expect(
        createPrescription(TENANT_ID, USER_ID, {
          patientId: 'pat-1',
          doctorId: 'bad',
          visitId: 'visit-1',
          prescriptionType: 'medication',
        } as any),
      ).rejects.toThrow('Doctor not found');
    });

    it('should throw notFound when visit does not exist', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce({ id: 'pat-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce({ id: 'doc-1' } as any);
      vi.mocked(prisma.visit.findFirst).mockResolvedValueOnce(null);

      await expect(
        createPrescription(TENANT_ID, USER_ID, {
          patientId: 'pat-1',
          doctorId: 'doc-1',
          visitId: 'bad',
          prescriptionType: 'medication',
        } as any),
      ).rejects.toThrow('Visit not found');
    });
  });

  describe('updatePrescription', () => {
    it('should update an active prescription', async () => {
      const existing = { id: 'presc-1', tenantId: TENANT_ID, status: 'active' };
      const updated = { ...existing, notes: 'Updated notes' };

      vi.mocked(prisma.prescription.findFirst).mockResolvedValueOnce(existing as any);
      vi.mocked(prisma.prescription.update).mockResolvedValueOnce(updated as any);

      const result = await updatePrescription(TENANT_ID, 'presc-1', { notes: 'Updated notes' } as any);

      expect(result.notes).toBe('Updated notes');
    });

    it('should throw badRequest when updating a cancelled prescription', async () => {
      vi.mocked(prisma.prescription.findFirst).mockResolvedValueOnce({
        id: 'presc-1',
        status: 'cancelled',
      } as any);

      await expect(
        updatePrescription(TENANT_ID, 'presc-1', { notes: 'x' } as any),
      ).rejects.toThrow('Cannot update a cancelled prescription');
    });

    it('should throw notFound when prescription does not exist', async () => {
      vi.mocked(prisma.prescription.findFirst).mockResolvedValueOnce(null);

      await expect(
        updatePrescription(TENANT_ID, 'bad-id', { notes: 'x' } as any),
      ).rejects.toThrow('Prescription not found');
    });
  });

  describe('addPrescriptionItem', () => {
    it('should add an item to an active prescription', async () => {
      vi.mocked(prisma.prescription.findFirst).mockResolvedValueOnce({
        id: 'presc-1',
        status: 'active',
      } as any);

      vi.mocked(prisma.prescriptionItem.create).mockResolvedValueOnce({
        id: 'item-1',
        prescriptionId: 'presc-1',
        drugName: 'Paracetamol',
      } as any);

      const result = await addPrescriptionItem(TENANT_ID, 'presc-1', {
        drugName: 'Paracetamol',
        dosage: '500mg',
        frequency: 'TID',
      } as any);

      expect(result.drugName).toBe('Paracetamol');
    });

    it('should throw badRequest when prescription is cancelled', async () => {
      vi.mocked(prisma.prescription.findFirst).mockResolvedValueOnce({
        id: 'presc-1',
        status: 'cancelled',
      } as any);

      await expect(
        addPrescriptionItem(TENANT_ID, 'presc-1', {
          drugName: 'Paracetamol',
          dosage: '500mg',
          frequency: 'TID',
        } as any),
      ).rejects.toThrow('Cannot modify items on a cancelled prescription');
    });
  });

  describe('removePrescriptionItem', () => {
    it('should remove an item when no administration records exist', async () => {
      vi.mocked(prisma.prescription.findFirst).mockResolvedValueOnce({
        id: 'presc-1',
        status: 'active',
      } as any);
      vi.mocked(prisma.prescriptionItem.findFirst).mockResolvedValueOnce({
        id: 'item-1',
        prescriptionId: 'presc-1',
      } as any);
      vi.mocked(prisma.medicationAdministration.count).mockResolvedValueOnce(0);
      vi.mocked(prisma.prescriptionItem.delete).mockResolvedValueOnce({} as any);

      const result = await removePrescriptionItem(TENANT_ID, 'presc-1', 'item-1');

      expect(result.deleted).toBe(true);
    });

    it('should throw badRequest when item has administration records', async () => {
      vi.mocked(prisma.prescription.findFirst).mockResolvedValueOnce({
        id: 'presc-1',
        status: 'active',
      } as any);
      vi.mocked(prisma.prescriptionItem.findFirst).mockResolvedValueOnce({
        id: 'item-1',
        prescriptionId: 'presc-1',
      } as any);
      vi.mocked(prisma.medicationAdministration.count).mockResolvedValueOnce(3);

      await expect(
        removePrescriptionItem(TENANT_ID, 'presc-1', 'item-1'),
      ).rejects.toThrow('Cannot remove item with existing administration records');
    });
  });

  describe('recordAdministration', () => {
    it('should record medication administration successfully', async () => {
      vi.mocked(prisma.prescriptionItem.findFirst).mockResolvedValueOnce({
        id: 'item-1',
        prescription: { id: 'presc-1', status: 'active', tenantId: TENANT_ID },
      } as any);
      vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce({ id: 'pat-1' } as any);
      vi.mocked(prisma.medicationAdministration.create).mockResolvedValueOnce({
        id: 'admin-1',
        status: 'administered',
        prescriptionItemId: 'item-1',
      } as any);

      const result = await recordAdministration(TENANT_ID, USER_ID, {
        prescriptionItemId: 'item-1',
        patientId: 'pat-1',
        administeredAt: new Date().toISOString(),
        doseGiven: '500mg',
        status: 'administered',
      } as any);

      expect(result.status).toBe('administered');
    });

    it('should throw badRequest when prescription is cancelled', async () => {
      vi.mocked(prisma.prescriptionItem.findFirst).mockResolvedValueOnce({
        id: 'item-1',
        prescription: { id: 'presc-1', status: 'cancelled', tenantId: TENANT_ID },
      } as any);

      await expect(
        recordAdministration(TENANT_ID, USER_ID, {
          prescriptionItemId: 'item-1',
          patientId: 'pat-1',
          administeredAt: new Date().toISOString(),
          doseGiven: '500mg',
          status: 'administered',
        } as any),
      ).rejects.toThrow('Cannot administer medication for a cancelled prescription');
    });
  });
});
