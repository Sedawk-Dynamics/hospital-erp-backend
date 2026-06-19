import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  resolveInwardLine,
  matchInwardLines,
  getDistributorMappings,
  deleteDistributorMapping,
} from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';
const ADMIN_ROLES = ['pharmacy_admin'];

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Product Resolution Engine (Pharmacy Module spec, Section 2). Resolution must
 * follow the confidence hierarchy: GTIN → learned distributor map → multi-factor
 * similarity → none.
 */
describe('Pharmacy — Product Resolution Engine', () => {
  describe('resolveInwardLine — tier priority', () => {
    it('Tier 1: resolves by consumer GTIN-13 with full confidence', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({
        id: 'f1', drugName: 'Crocin Advance 650', genericName: 'Paracetamol', manufacturer: 'GSK',
        dosageForm: 'tablet', strength: '650mg', packSize: 15, price: 2,
        gtin: '8901234567890', casePackGtin: null, unitsPerCase: null,
      });
      const r = await resolveInwardLine(TENANT_ID, { drugName: 'CROCIN ADV 650', gtin: '8901234567890' });
      expect(r.resolvedVia).toBe('gtin');
      expect(r.recommendation).toBe('map');
      expect(r.confidence).toBe(100);
      expect(r.suggestedFormularyId).toBe('f1');
      expect(r.caseMultiplier).toBe(1);
      // distributor map + similarity tiers must NOT be consulted on a GTIN hit
      expect(prisma.distributorProductMap.findFirst).not.toHaveBeenCalled();
    });

    it('Tier 1: a GTIN-14 case scan returns the unitsPerCase multiplier', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({
        id: 'f1', drugName: 'Crocin Advance 650', genericName: 'Paracetamol', manufacturer: 'GSK',
        dosageForm: 'tablet', strength: '650mg', packSize: 15, price: 2,
        gtin: '8901234567890', casePackGtin: '18901234567897', unitsPerCase: 50,
      });
      const r = await resolveInwardLine(TENANT_ID, { drugName: 'CROCIN ADV 650 CASE', gtin: '18901234567897' });
      expect(r.resolvedVia).toBe('gtin');
      expect(r.caseMultiplier).toBe(50);
    });

    it('Tier 2: falls to the learned distributor map when no GTIN drug exists', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue(null); // no GTIN match
      (prisma.distributorProductMap.findFirst as any).mockResolvedValue({
        id: 'm1', confidence: 100,
        drugFormulary: { id: 'f9', drugName: 'Telma 40', genericName: 'Telmisartan', manufacturer: 'Glenmark', dosageForm: 'tablet', strength: '40mg', packSize: 15, price: 5, gtin: null },
      });
      const r = await resolveInwardLine(TENANT_ID, { drugName: 'TELMA 40 TAB', supplierId: 's1' });
      expect(r.resolvedVia).toBe('distributor_map');
      expect(r.recommendation).toBe('map');
      expect(r.suggestedFormularyId).toBe('f9');
      // similarity tier (drugFormulary.findMany) must not run once the map resolves
      expect(prisma.drugFormulary.findMany).not.toHaveBeenCalled();
    });

    it('Tier 3: falls back to fuzzy similarity when nothing is learned', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue(null);
      (prisma.distributorProductMap.findFirst as any).mockResolvedValue(null);
      (prisma.drugFormulary.findMany as any).mockResolvedValue([
        { id: 'f5', drugName: 'Pantacid 40', genericName: 'Pantoprazole', manufacturer: 'Sun', dosageForm: 'tablet', strength: '40mg', packSize: 15, price: 4, drugMasterId: null, drugBatches: [] },
      ]);
      const r = await resolveInwardLine(TENANT_ID, { drugName: 'Pantacid 40 Tab' });
      expect(r.resolvedVia).toBe('similarity');
      // a near-identical name should map or at least review, with a real score
      expect(['map', 'review']).toContain(r.recommendation);
      expect(r.confidence).toBeGreaterThan(0);
      expect(r.suggestedFormularyId).toBe('f5');
    });

    it('Tier 4: recommends create when nothing is close', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue(null);
      (prisma.distributorProductMap.findFirst as any).mockResolvedValue(null);
      (prisma.drugFormulary.findMany as any).mockResolvedValue([]); // no candidates
      const r = await resolveInwardLine(TENANT_ID, { drugName: 'Zyxylquinzarbital 999' });
      expect(r.recommendation).toBe('create');
      expect(r.suggestedFormularyId).toBeNull();
    });
  });

  describe('matchInwardLines — fans resolution over lines + threads supplier', () => {
    it('returns resolvedVia/confidence per line', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue({
        id: 'f1', drugName: 'Crocin Advance 650', genericName: 'Paracetamol', manufacturer: 'GSK',
        dosageForm: 'tablet', strength: '650mg', packSize: 15, price: 2, gtin: '8901234567890', casePackGtin: null, unitsPerCase: null,
      });
      const r = await matchInwardLines(TENANT_ID, [{ drugName: 'CROCIN ADV 650', gtin: '8901234567890' }], 's1');
      expect(r.lines[0].resolvedVia).toBe('gtin');
      expect(r.lines[0].recommendation).toBe('map');
      expect(r.lines[0].suggestedFormularyId).toBe('f1');
    });
  });

  describe('getDistributorMappings', () => {
    it('shapes learned mappings for the admin surface', async () => {
      (prisma.distributorProductMap.findMany as any).mockResolvedValue([
        { id: 'm1', externalName: 'CROCIN ADV 650MG', gtin: '8901234567890', supplierId: 's1', drugFormularyId: 'f1', confidence: 100, timesSeen: 4, lastSeenAt: new Date('2026-06-01'), supplier: { id: 's1', name: 'Acme' }, drugFormulary: { id: 'f1', drugName: 'Crocin Advance 650', strength: '650mg' } },
      ]);
      const r = await getDistributorMappings(TENANT_ID, {});
      expect(r.total).toBe(1);
      expect(r.items[0]).toMatchObject({ externalName: 'CROCIN ADV 650MG', supplier: 'Acme', drugName: 'Crocin Advance 650', timesSeen: 4 });
    });
  });

  describe('deleteDistributorMapping', () => {
    it('blocks non-admins', async () => {
      await expect(deleteDistributorMapping(TENANT_ID, ['pharmacist'], 'm1')).rejects.toThrow();
    });

    it('deletes an existing mapping for an admin', async () => {
      (prisma.distributorProductMap.findFirst as any).mockResolvedValue({ id: 'm1', tenantId: TENANT_ID });
      (prisma.distributorProductMap.delete as any).mockResolvedValue({ id: 'm1' });
      const r = await deleteDistributorMapping(TENANT_ID, ADMIN_ROLES, 'm1');
      expect(r).toEqual({ id: 'm1', deleted: true });
      expect(prisma.distributorProductMap.delete).toHaveBeenCalledWith({ where: { id: 'm1' } });
    });

    it('404s when the mapping is missing', async () => {
      (prisma.distributorProductMap.findFirst as any).mockResolvedValue(null);
      await expect(deleteDistributorMapping(TENANT_ID, ADMIN_ROLES, 'nope')).rejects.toThrow('not found');
    });
  });
});
