import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  resolveInwardLine,
  matchInwardLines,
} from '../../../../src/modules/pharmacy/pharmacy.service';

const TENANT_ID = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Product Resolution Engine (Pharmacy Module spec, Section 2). Resolution must
 * follow the confidence hierarchy: GTIN → multi-factor similarity → none.
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

    it('Tier 2: falls back to fuzzy similarity when no GTIN drug exists', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue(null);
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

    it('Tier 3: recommends create when nothing is close', async () => {
      (prisma.drugFormulary.findFirst as any).mockResolvedValue(null);
      (prisma.drugFormulary.findMany as any).mockResolvedValue([]); // no formulary candidates
      (prisma.drugMaster.findMany as any).mockResolvedValue([]); // no catalog candidates either
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
});
