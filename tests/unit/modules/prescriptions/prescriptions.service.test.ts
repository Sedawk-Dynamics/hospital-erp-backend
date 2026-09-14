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
  checkInteractions,
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

    it('rejects a retail product even when its formulary id is submitted directly', async () => {
      vi.mocked(prisma.patient.findFirst).mockResolvedValueOnce({ id: 'pat-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce({ id: 'doc-1' } as any);
      vi.mocked(prisma.visit.findFirst).mockResolvedValueOnce({ id: 'visit-1' } as any);
      vi.mocked(prisma.drugFormulary.findFirst).mockResolvedValueOnce({
        id: 'product-1',
        drugName: 'Baby Bottle',
        category: 'product',
      } as any);

      await expect(
        createPrescription(TENANT_ID, USER_ID, {
          patientId: 'pat-1',
          doctorId: 'doc-1',
          visitId: 'visit-1',
          prescriptionType: 'medication',
          items: [{
            drugId: 'product-1',
            drugName: 'Baby Bottle',
            dosage: '1',
            frequency: 'once',
          }],
        } as any),
      ).rejects.toThrow('retail product and cannot be prescribed');
      expect(prisma.prescription.create).not.toHaveBeenCalled();
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

// ============================================================
// Interactions: the curated list and the catalogue together
// ============================================================

/**
 * Two sources answer the same question. The curated list is 41 clinician-written
 * pairs and is the only one allowed to block a prescription; the catalogue is
 * the vendor's per-product data on 175,216 products, which warns. Where both
 * fire on the same pair only one alert may reach the prescriber.
 */
describe('checkInteractions — merging the two sources', () => {
  beforeEach(() => {
    (prisma.drugFormulary.findMany as any).mockResolvedValue([]);
    (prisma.drugMaster.findMany as any).mockResolvedValue([]);
    (prisma.drugText.findMany as any).mockResolvedValue([]);
  });

  it('keeps the curated pair and marks its source', async () => {
    const res = await checkInteractions(TENANT_ID, { drugs: ['Warfarin', 'Aspirin'] });
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0].source).toBe('curated');
    expect(res.pairs[0].severity).toBe('major');
    expect(res.highestSeverity).toBe('major');
  });

  it('adds a catalogue pair the curated list does not know', async () => {
    (prisma.drugMaster.findMany as any).mockImplementation(({ where }: any) => {
      if (where?.id?.in) {
        return Promise.resolve([
          {
            id: 'm1',
            name: 'Ecosprin 75 Tablet',
            saltsJson: [{ norm: 'aspirin' }],
            drugInteractions: { drug: ['Warfarin'], effect: ['Severe'] },
            monograph: null,
          },
        ]);
      }
      return Promise.resolve([{ id: 'm1', name: 'Ecosprin 75 Tablet', drugInteractions: { drug: ['Warfarin'] } }]);
    });

    const res = await checkInteractions(TENANT_ID, { drugs: ['Ecosprin 75 Tablet', 'Warfarin'] });
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0].source).toBe('catalogue');
    expect(res.pairs[0].severity).toBe('major');
  });

  it('does not report the same pair twice when both sources fire', async () => {
    (prisma.drugMaster.findMany as any).mockImplementation(({ where }: any) => {
      if (where?.id?.in) {
        return Promise.resolve([
          {
            id: 'm1',
            name: 'Warfarin',
            saltsJson: [{ norm: 'warfarin' }],
            drugInteractions: { drug: ['Aspirin'], effect: ['Moderate'] },
            monograph: null,
          },
          { id: 'm2', name: 'Aspirin', saltsJson: [{ norm: 'aspirin' }], drugInteractions: null, monograph: null },
        ]);
      }
      return Promise.resolve([
        { id: 'm1', name: 'Warfarin', drugInteractions: { drug: ['Aspirin'] } },
        { id: 'm2', name: 'Aspirin', drugInteractions: null },
      ]);
    });

    const res = await checkInteractions(TENANT_ID, { drugs: ['Warfarin', 'Aspirin'] });
    expect(res.pairs).toHaveLength(1);
    // The curated pair is 'major' and the catalogue's only 'moderate' — the
    // reviewed advice stays, and the weaker duplicate is dropped.
    expect(res.pairs[0].source).toBe('curated');
    expect(res.pairs[0].severity).toBe('major');
  });

  it('still answers with the curated pairs when the catalogue read fails', async () => {
    (prisma.drugMaster.findMany as any).mockRejectedValue(new Error('catalogue down'));
    const res = await checkInteractions(TENANT_ID, { drugs: ['Warfarin', 'Aspirin'] });
    expect(res.pairs).toHaveLength(1);
    expect(res.pairs[0].source).toBe('curated');
  });

  it('orders the worst pair first', async () => {
    const res = await checkInteractions(TENANT_ID, {
      // warfarin+aspirin is major; ssri+nsaid (fluoxetine + ibuprofen) is lower.
      drugs: ['Fluoxetine', 'Ibuprofen', 'Warfarin', 'Aspirin'],
    });
    const ranks = res.pairs.map((p) => ['contraindicated', 'major', 'moderate', 'minor'].indexOf(p.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
