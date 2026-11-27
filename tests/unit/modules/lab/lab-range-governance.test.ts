import { evaluateAbnormal } from '../../../../src/modules/lab/lab.service';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import { getRolePermissions } from '../../../../src/shared/role-permissions';
import { parseRangeReply, buildRangePrompt } from '../../../../src/modules/lab/lab-range-ai';
import {
  approveRangeProposals,
  canApproveRanges,
  confirmCurrentRanges,
  getRangeStatus,
  listPendingProposals,
  proposeRange,
  rejectRangeProposal,
  suggestRangeWithAi,
} from '../../../../src/modules/lab/lab-range-proposals.service';
import {
  liveRangeFor,
  normaliseUnit,
  rangeHash,
  rangeNameKey,
  splitRangeEdits,
  type LiveRange,
} from '../../../../src/modules/lab/lab-range';
import {
  createTest,
  enterResults,
  extractResultsFromAttachment,
  updateTest,
  updateTestPrice,
  createLabOrder,
} from '../../../../src/modules/lab/lab.service';
import { cloneTemplatesIntoTenant } from '../../../../src/modules/lab/lab-templates.service';
import { parseLabReportFile } from '../../../../src/modules/lab/lab.ocr';
import { getPriceReview } from '../../../../src/modules/lab/lab-price-guard';
import { previewRetire, retireDuplicate } from '../../../../src/modules/lab/lab-catalog-retire.service';
import { commitImport, previewImport } from '../../../../src/modules/lab/lab-catalog-import.service';

const generateText = vi.fn();
const resolveAiConfig = vi.fn();
vi.mock('../../../../src/services/ai', () => ({
  generateText: (...a: unknown[]) => generateText(...a),
  resolveAiConfig: (...a: unknown[]) => resolveAiConfig(...a),
}));
vi.mock('../../../../src/modules/lab/lab.ocr', () => ({
  parseLabReportFile: vi.fn(),
  canOcrLabFile: vi.fn(() => true),
}));

const T = 'tenant-1';

// ─── A small in-memory catalogue + proposals table, with rollback ───

type Any = Record<string, any>;
let tests: Any[] = [];
let proposals: Any[] = [];
let templates: Any[] = [];
let seq = 0;

function matches(row: Any, where: Any = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'test' || k === 'OR') return true;
    if (v === undefined) return true;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('not' in v) return row[k] !== v.not && row[k] !== undefined;
      if ('equals' in v) return String(row[k] ?? '').toLowerCase() === String(v.equals).toLowerCase();
      if ('gt' in v) return row[k] > v.gt;
      if ('notIn' in v) return !v.notIn.includes(row[k]);
    }
    return (row[k] ?? null) === v;
  });
}

function apply(row: Any, data: Any) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && 'increment' in (v as Any)) row[k] = (row[k] ?? 0) + (v as Any).increment;
    else row[k] = v && typeof v === 'object' && !(v instanceof Date) ? JSON.parse(JSON.stringify(v)) : v;
  }
}

function wire(model: string, get: () => Any[]) {
  const m = (prisma as any)[model];
  const copy = (r: Any | undefined) => (r ? { ...r } : null);
  m.findFirst.mockImplementation(async ({ where }: Any) => copy(get().find((r) => matches(r, where))));
  m.findFirstOrThrow.mockImplementation(async ({ where }: Any) => copy(get().find((r) => matches(r, where))));
  m.findMany.mockImplementation(async ({ where }: Any = {}) => get().filter((r) => matches(r, where)).map((r) => ({ ...r, test: tests.find((t) => t.id === r.testId) })));
  m.count.mockImplementation(async ({ where }: Any = {}) => get().filter((r) => matches(r, where)).length);
  m.create.mockImplementation(async ({ data }: Any) => {
    const row: Any = { id: `${model}-${++seq}`, rangeVersion: 0, proposedAt: new Date(seq * 1000), isActive: true, aliases: [], tags: [] };
    apply(row, data);
    get().push(row);
    return { ...row };
  });
  m.createMany.mockImplementation(async ({ data }: Any) => {
    for (const d of data) await m.create({ data: d });
    return { count: data.length };
  });
  m.updateMany.mockImplementation(async ({ where, data }: Any) => {
    const hit = get().filter((r) => matches(r, where));
    hit.forEach((r) => apply(r, data));
    return { count: hit.length };
  });
  m.update.mockImplementation(async ({ where, data }: Any) => {
    const row = get().find((r) => r.id === where.id)!;
    apply(row, data);
    return { ...row };
  });
}

const users: Record<string, string[]> = {
  path1: ['lab_supervisor'],
  path2: ['pathologist'],
  admin: ['admin'],
  tech: ['lab_technician'],
  doctor: ['doctor'],
  super: ['super_admin'],
  adminPath: ['admin', 'lab_supervisor'],
  techPath: ['lab_technician', 'lab_supervisor'],
};

const hb = (over: Any = {}) => ({
  id: 'p-hb', name: 'Hemoglobin', unit: 'g/dL', refLow: 13, refHigh: 17, refRangeText: null, inputType: 'number', ...over,
});

const cbc = (over: Any = {}) => ({
  id: 'cbc', tenantId: T, testName: 'CBC', testCode: 'CBC', sampleType: 'Blood', specimen: 'EDTA', normalRange: null, unit: null,
  price: 350, isActive: true, rangeVersion: 0, aliases: [], tags: [],
  parameters: [hb(), { id: 'p-wbc', name: 'WBC', unit: '10^3/uL', refLow: 4, refHigh: 11, refRangeText: null, inputType: 'number' }],
  ...over,
});

const live = (key = 'p-hb', id = 'cbc') => liveRangeFor(tests.find((t) => t.id === id) as any, key) as LiveRange;
const liveHash = (key = 'p-hb', id = 'cbc') => rangeHash(live(key, id));
const param = (key = 'p-hb', id = 'cbc') => tests.find((t) => t.id === id)!.parameters.find((p: Any) => p.id === key);

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  tests = [cbc()];
  proposals = [];
  templates = [];
  wire('labTestCatalog', () => tests);
  wire('labRangeProposal', () => proposals);
  wire('labTestTemplate', () => templates);
  (prisma as any).labRangeProposal.groupBy.mockImplementation(async () => {
    const by = new Map<string, number>();
    proposals.filter((p) => p.status === 'pending').forEach((p) => by.set(p.testId, (by.get(p.testId) ?? 0) + 1));
    return [...by].map(([testId, n]) => ({ testId, _count: { _all: n } }));
  });
  // Rolls back both tables when the callback throws, as the database would.
  (prisma.$transaction as any).mockImplementation(async (fn: any) => {
    const before = JSON.stringify([tests, proposals]);
    try {
      return await fn(prisma);
    } catch (e) {
      [tests, proposals] = JSON.parse(before);
      throw e;
    }
  });
  (prisma as any).user.findFirst.mockImplementation(async ({ where }: Any) =>
    users[where.id] && where.tenantId === T
      ? { firstName: where.id, lastName: '', userRoles: users[where.id].map((name) => ({ role: { name, tenantId: T } })) }
      : null,
  );
  (prisma as any).user.findUnique.mockResolvedValue({ firstName: 'Some', lastName: 'One' });
  resolveAiConfig.mockResolvedValue({ ready: true });
});

const aiReply = (o: unknown) => ({ text: typeof o === 'string' ? o : JSON.stringify(o), provider: 'gemini', model: 'm-1' });
const good = { unit: 'g/dL', low: 12, high: 16, groups: null, rationale: 'Standard adult interval.' };

async function aiProposal() {
  generateText.mockResolvedValueOnce(aiReply(good));
  return suggestRangeWithAi(T, 'path1', 'cbc', 'p-hb');
}

// ============================================================

describe('AI suggestions', () => {
  it('stores a pending suggestion and leaves the live range alone', async () => {
    const before = JSON.stringify(tests);
    const p = await aiProposal();
    expect(p).toMatchObject({ source: 'ai', status: 'pending', refLow: 12, refHigh: 16, aiModel: 'm-1' });
    expect(JSON.stringify(tests)).toBe(before);
  });

  it('sends only test, parameter, unit and specimen', async () => {
    await aiProposal();
    const [opts] = generateText.mock.calls[0];
    const sent = JSON.parse(opts.messages[0].content);
    expect(Object.keys(sent).sort()).toEqual(['parameter', 'specimen', 'testName', 'unit']);
    expect(sent).toEqual({ testName: 'CBC', parameter: 'Hemoglobin', unit: 'g/dL', specimen: 'Blood' });
    expect(opts.messages).toHaveLength(1);
    for (const m of ['patient', 'labOrder', 'labResult', 'visit']) {
      expect((prisma as any)[m].findFirst).not.toHaveBeenCalled();
      expect((prisma as any)[m].findMany).not.toHaveBeenCalled();
    }
    // The current range is not sent either: the model must not just echo it.
    expect(JSON.stringify(opts)).not.toContain('13');
  });

  it('does not send placeholder specimen text', () => {
    const p = buildRangePrompt({ testName: 'a', parameter: 'b', unit: null, specimen: null });
    expect(JSON.parse(p.messages[0].content).specimen).toBeNull();
  });

  it('says so when AI is not configured, calls nothing, and manual still works', async () => {
    resolveAiConfig.mockResolvedValue({ ready: false });
    await expect(suggestRangeWithAi(T, 'path1', 'cbc', 'p-hb')).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    expect(generateText).not.toHaveBeenCalled();
    const p = await proposeRange(T, 'tech', 'cbc', 'p-hb', { refLow: 12, refHigh: 16 });
    expect(p).toMatchObject({ source: 'manual', status: 'pending' });
  });

  it('reports a provider failure and saves nothing', async () => {
    generateText.mockRejectedValueOnce(new Error('quota'));
    await expect(suggestRangeWithAi(T, 'path1', 'cbc', 'p-hb')).rejects.toMatchObject({ code: 'AI_FAILED' });
    expect(proposals).toHaveLength(0);
  });

  it('refuses a second AI suggestion while one is waiting', async () => {
    await aiProposal();
    await expect(suggestRangeWithAi(T, 'path1', 'cbc', 'p-hb')).rejects.toMatchObject({ code: 'AI_SUGGESTION_PENDING' });
  });

  const req = { testName: 'CBC', parameter: 'Hemoglobin', unit: 'g/dL', specimen: 'Blood' };
  const slot = (): LiveRange => ({ key: 'p-hb', name: 'Hemoglobin', inputType: 'number', sampleType: 'Blood', unit: 'g/dL', refLow: 13, refHigh: 17, refText: null });

  it.each([
    ['prose', 'The range is 12 to 16'],
    ['prose around JSON', `Sure! ${JSON.stringify(good)}`],
    ['truncated JSON', '{"unit":"g/dL","low":12'],
    ['an array', [good]],
    ['low above high', { ...good, low: 16, high: 12 }],
    ['low equal to high', { ...good, low: 12, high: 12 }],
    ['numbers as strings', { ...good, low: '12' }],
    ['wrong unit', { ...good, unit: 'g/L' }],
    ['no unit when one is set', { ...good, unit: null }],
    ['no limits', { ...good, low: null, high: null }],
    ['both a range and groups', { ...good, groups: [{ sex: 'male', low: 13, high: 17 }] }],
    ['an unknown key', { ...good, diagnosis: 'x' }],
    ['no rationale', { unit: 'g/dL', low: 1, high: 2 }],
    ['a bad group', { ...good, low: null, high: null, groups: [{ sex: 'male', low: 17, high: 13 }] }],
    ['absurd numbers', { ...good, high: 1e12 }],
  ])('rejects %s', (_n, reply) => {
    const t = typeof reply === 'string' ? reply : JSON.stringify(reply);
    expect(() => parseRangeReply(t, req, slot())).toThrow(/could not be used/);
  });

  it('accepts a clean reply, fenced or not, and equivalent unit spelling', () => {
    expect(parseRangeReply('```json\n' + JSON.stringify({ ...good, unit: 'g / dl' }) + '\n```', req, slot()).values)
      .toEqual({ unit: 'g/dL', refLow: 12, refHigh: 16, refText: null });
  });

  it('keeps units that differ in meaning apart', () => {
    expect(normaliseUnit('mU/L')).not.toBe(normaliseUnit('MU/L'));
    expect(normaliseUnit('µmol/l')).toBe(normaliseUnit('umol/L'));
  });

  it('passes on a decline, and warns on sex groups and tenfold gaps', () => {
    expect(() => parseRangeReply(JSON.stringify({ ...good, low: null, high: null, unable: true }), req, slot())).toThrow(/could not suggest/);
    const g = parseRangeReply(JSON.stringify({ ...good, low: null, high: null, groups: [{ sex: 'male', low: 13, high: 17 }, { sex: 'female', low: 12, high: 15 }] }), req, slot());
    expect(g.values).toMatchObject({ refLow: null, refHigh: null });
    expect(g.values.refText).toContain('Female');
    expect(g.warnings[0]).toMatch(/NOT flag/);
    const far = parseRangeReply(JSON.stringify({ ...good, low: 130, high: 170 }), req, slot());
    expect(far.warnings.join()).toMatch(/ten times/);
  });

  it('does not ask about a non-numeric parameter', async () => {
    tests = [cbc({ parameters: [hb({ inputType: 'text' })] })];
    await expect(suggestRangeWithAi(T, 'path1', 'cbc', 'p-hb')).rejects.toMatchObject({ code: 'RANGE_NOT_NUMERIC' });
  });
});

describe('a pending range reaches nothing', () => {
  const enter = (value: string, normalRange?: string, unit?: string) => {
    (prisma as any).labOrderItem.findFirst.mockResolvedValue({
      id: 'item', status: 'in_progress', labOrder: { id: 'o', status: 'in_progress' }, test: tests[0],
    });
    (prisma as any).labOrder.findFirst.mockResolvedValue({ acceptedAt: new Date(), paymentVerified: true, paymentDeferredReason: null });
    (prisma as any).labResult.create.mockImplementation(async ({ data }: Any) => data);
    return enterResults(T, 'tech', {
      labOrderItemId: 'item', labOrderId: 'o', patientId: 'pt',
      results: [{ parameterName: 'Hemoglobin', value, unit, normalRange, isAbnormal: false }],
    } as any);
  };

  it('flags and stores the live range, not the suggestion', async () => {
    await aiProposal(); // suggests 12-16; live is 13-17
    const [r] = await enter('12.5');
    expect(r).toMatchObject({ normalRange: '13–17', isAbnormal: true });
    const [ok] = await enter('16.5');
    expect(ok.isAbnormal).toBe(false);
  });

  it('ignores a range sent from the browser for a catalogue parameter', async () => {
    const [r] = await enter('12.5', '12-16');
    expect(r).toMatchObject({ normalRange: '13–17', isAbnormal: true });
  });

  it('prints no range for a new parameter whose range is still pending', async () => {
    tests = [cbc({ parameters: [hb({ refLow: null, refHigh: null })] })];
    const [r] = await enter('3', '13-17');
    expect(r.normalRange).toBeUndefined();
    expect(r.isAbnormal).toBe(false);
  });

  it('refuses a value typed against a different unit', async () => {
    await expect(enter('130', undefined, 'g/L')).rejects.toMatchObject({ code: 'LAB_UNIT_CHANGED' });
  });

  it('a stored result keeps its range after a new one is approved', async () => {
    const [before] = await enter('12.5');
    const p = await aiProposal();
    await approveRangeProposals(T, 'path1', [{ id: p.id, expectedLiveHash: liveHash() }]);
    expect(before).toMatchObject({ normalRange: '13–17', isAbnormal: true });
    expect((prisma as any).labResult.update).not.toHaveBeenCalled();
    expect((prisma as any).labResult.updateMany).not.toHaveBeenCalled();
    expect((prisma as any).labReport.update).not.toHaveBeenCalled();
    expect((prisma as any).labReport.updateMany).not.toHaveBeenCalled();
    const [after] = await enter('12.5');
    expect(after).toMatchObject({ normalRange: '12–16', isAbnormal: false });
  });

  it('never borrows a newer range for a report that is already out', async () => {
    (prisma as any).labAttachment.findFirst.mockResolvedValue({
      id: 'a', fileUrl: '/uploads/x.pdf', fileName: 'x.pdf', mimeType: 'application/pdf', labOrderItemId: 'item',
      labOrder: {
        id: 'o', patientId: 'pt', labReport: { status: 'published', publishedAt: new Date(2000) },
        labOrderItems: [{ id: 'item', testId: 'cbc', test: tests[0] }],
      },
    });
    (prisma as any).labOrder.findFirst.mockResolvedValue({ acceptedAt: new Date(), paymentVerified: true });
    (prisma as any).labResult.findMany.mockResolvedValue([]);
    (prisma as any).labResult.create.mockImplementation(async ({ data }: Any) => data);
    vi.mocked(parseLabReportFile).mockResolvedValue({
      model: 'm', warnings: [], parameters: [{ testName: null, parameterName: 'Hemoglobin', value: '12', unit: 'g/dL', normalRange: null }],
    } as any);
    const stored = () => (prisma as any).labResult.create.mock.calls.at(-1)[0].data.normalRange;

    await extractResultsFromAttachment(T, 'a', 'tech');
    expect(stored()).toBe('13-17');
    proposals.push({ tenantId: T, testId: 'cbc', status: 'approved', origin: 'ai_suggest', reviewedAt: new Date(3000) });
    await extractResultsFromAttachment(T, 'a', 'tech');
    expect(stored()).toBeNull();
  });
});

describe('who may approve', () => {
  it.each([
    ['path1', true], ['path2', true], ['admin', false], ['tech', false], ['doctor', false],
    ['super', false], ['adminPath', false], ['techPath', false],
  ])('%s -> %s', async (userId, allowed) => {
    const p = await aiProposal();
    const run = () => approveRangeProposals(T, userId, [{ id: p.id, expectedLiveHash: liveHash() }]);
    if (allowed) await expect(run()).resolves.toHaveLength(1);
    else {
      await expect(run()).rejects.toMatchObject({ statusCode: 403 });
      expect(param().refLow).toBe(13);
      await expect(rejectRangeProposal(T, userId, p.id, 'because')).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        confirmCurrentRanges(T, userId, 'cbc', [{ parameterKey: 'p-hb', expectedLiveHash: liveHash() }]),
      ).rejects.toMatchObject({ statusCode: 403 });
    }
  });

  it('the permission alone is not enough: the hospital admin holds it', () => {
    const perms = getRolePermissions();
    const has = (r: string) => perms[r].some((p) => p.module === 'lab_reports' && p.action === 'approve');
    expect(has('admin')).toBe(true);
    expect(canApproveRanges(['admin'])).toBe(false);
    expect(has('lab_supervisor')).toBe(true);
    expect(has('lab_technician')).toBe(false);
    expect(canApproveRanges(['Lab Supervisor'])).toBe(true);
  });

  it('a role held in another hospital does not count', async () => {
    const p = await aiProposal();
    (prisma as any).user.findFirst.mockResolvedValue({
      firstName: 'x', lastName: '', userRoles: [{ role: { name: 'lab_supervisor', tenantId: 'other' } }],
    });
    await expect(approveRangeProposals(T, 'path1', [{ id: p.id, expectedLiveHash: liveHash() }])).rejects.toMatchObject({ statusCode: 403 });
  });

  it('nobody approves their own manual range; another pathologist can', async () => {
    const p = await proposeRange(T, 'path1', 'cbc', 'p-hb', { refLow: 12, refHigh: 16 });
    const item = { id: p.id, expectedLiveHash: liveHash() };
    await expect(approveRangeProposals(T, 'path1', [item])).rejects.toMatchObject({ code: 'SELF_APPROVAL' });
    // Editing while approving is not a way round it.
    await expect(approveRangeProposals(T, 'path1', [{ ...item, edits: { refLow: 11, refHigh: 15 } }])).rejects.toMatchObject({ code: 'SELF_APPROVAL' });
    expect(param().refLow).toBe(13);
    await approveRangeProposals(T, 'path2', [item]);
    expect(param()).toMatchObject({ refLow: 12, refHigh: 16 });
  });
});

describe('approval', () => {
  it('writes the live range, reviewer and previous value, and signs it off', async () => {
    const p = await aiProposal();
    await approveRangeProposals(T, 'path1', [{ id: p.id, expectedLiveHash: liveHash(), note: 'ok' }]);
    expect(param()).toMatchObject({ refLow: 12, refHigh: 16, unit: 'g/dL' });
    expect(proposals[0]).toMatchObject({
      status: 'approved', reviewedById: 'path1', reviewNote: 'ok',
      previousLive: { refLow: 13, refHigh: 17 }, appliedLive: { refLow: 12, refHigh: 16 },
    });
    const row = (await getRangeStatus(T)).tests[0].ranges.find((r) => r.key === 'p-hb')!;
    expect(row.status).toBe('signed_off');
    const audits = (prisma as any).auditLog.create.mock.calls.map((c: Any) => c[0].data.entityType);
    expect(audits).toContain('lab_range_proposal');
  });

  it('applies and records edits', async () => {
    const p = await aiProposal();
    await approveRangeProposals(T, 'path1', [{ id: p.id, expectedLiveHash: liveHash(), edits: { refLow: 12.5, refHigh: 16.5 } }]);
    expect(param()).toMatchObject({ refLow: 12.5, refHigh: 16.5 });
    expect(proposals[0].editedValues).toMatchObject({ refLow: 12.5, refHigh: 16.5 });
    expect(proposals[0]).toMatchObject({ refLow: 12, refHigh: 16 });
  });

  it('refuses edits that are not a range', async () => {
    const p = await aiProposal();
    await expect(
      approveRangeProposals(T, 'path1', [{ id: p.id, expectedLiveHash: liveHash(), edits: { refLow: 20, refHigh: 10 } }]),
    ).rejects.toMatchObject({ code: 'RANGE_INVALID' });
    expect(proposals[0].status).toBe('pending');
  });

  it('409 when the live range moved since it was read', async () => {
    const p = await aiProposal();
    const seen = liveHash();
    param().refHigh = 18;
    await expect(approveRangeProposals(T, 'path1', [{ id: p.id, expectedLiveHash: seen }])).rejects.toMatchObject({ statusCode: 409 });
    expect(proposals[0].status).toBe('pending');
  });

  it('409 when the parameter under that id is now a different analyte', async () => {
    const p = await aiProposal();
    param().name = 'Potassium';
    await expect(approveRangeProposals(T, 'path1', [{ id: p.id, expectedLiveHash: liveHash() }])).rejects.toMatchObject({ statusCode: 409 });
  });

  it('409 and full rollback when the catalogue row moves mid-transaction', async () => {
    const p = await aiProposal();
    const real = (prisma as any).labTestCatalog.updateMany.getMockImplementation();
    (prisma as any).labTestCatalog.updateMany.mockImplementationOnce(async (a: Any) => {
      tests[0].rangeVersion += 1;
      return real(a);
    });
    await expect(approveRangeProposals(T, 'path1', [{ id: p.id, expectedLiveHash: liveHash() }])).rejects.toMatchObject({ statusCode: 409 });
    expect(proposals[0].status).toBe('pending');
    expect(param().refLow).toBe(13);
  });

  it('only one of two reviewers wins', async () => {
    const p = await aiProposal();
    const item = { id: p.id, expectedLiveHash: liveHash() };
    await approveRangeProposals(T, 'path1', [item]);
    await expect(approveRangeProposals(T, 'path2', [item])).rejects.toMatchObject({ statusCode: 409 });
    await expect(rejectRangeProposal(T, 'path2', p.id, 'too late')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('a lost claim race is a 409 and leaves the live range alone', async () => {
    const p = await aiProposal();
    (prisma as any).labRangeProposal.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(approveRangeProposals(T, 'path1', [{ id: p.id, expectedLiveHash: liveHash() }])).rejects.toMatchObject({ statusCode: 409 });
    expect(param().refLow).toBe(13);
  });

  it('a batch is all or nothing', async () => {
    const a = await proposeRange(T, 'tech', 'cbc', 'p-hb', { refLow: 12, refHigh: 16 });
    const b = await proposeRange(T, 'tech', 'cbc', 'p-wbc', { refLow: 5, refHigh: 10 });
    await expect(
      approveRangeProposals(T, 'path1', [
        { id: a.id, expectedLiveHash: liveHash() },
        { id: b.id, expectedLiveHash: 'f'.repeat(64) },
      ]),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(param().refLow).toBe(13);
    expect(proposals.every((p) => p.status === 'pending')).toBe(true);
  });

  it('rejecting records the reason and changes nothing live', async () => {
    const p = await aiProposal();
    await rejectRangeProposal(T, 'path1', p.id, 'Wrong population');
    expect(proposals[0]).toMatchObject({ status: 'rejected', reviewNote: 'Wrong population' });
    expect(param().refLow).toBe(13);
  });
});

describe('existing ranges and sign-off status', () => {
  it('stay live but read as not signed off until confirmed', async () => {
    expect((await getRangeStatus(T)).totals).toMatchObject({ signedOff: 0, notSignedOff: 2, testsNotSignedOff: 1 });
    await confirmCurrentRanges(T, 'path1', 'cbc', [{ parameterKey: 'p-hb', expectedLiveHash: liveHash() }]);
    expect(param()).toMatchObject({ refLow: 13, refHigh: 17 });
    expect((await getRangeStatus(T)).totals).toMatchObject({ signedOff: 1, notSignedOff: 1 });
  });

  it.each([
    ['the numbers', () => { param().refHigh = 18; }],
    ['the unit', () => { param().unit = 'g/L'; }],
    ['the analyte name', () => { param().name = 'Something else'; }],
    ['the sample type', () => { tests[0].sampleType = 'Urine'; }],
  ])('lose the sign-off when %s change', async (_n, change) => {
    await confirmCurrentRanges(T, 'path1', 'cbc', [{ parameterKey: 'p-hb', expectedLiveHash: liveHash() }]);
    change();
    expect((await getRangeStatus(T)).tests[0].ranges.find((r) => r.key === 'p-hb')!.status).toBe('not_signed_off');
  });

  it('cannot confirm a range that moved or does not exist', async () => {
    await expect(confirmCurrentRanges(T, 'path1', 'cbc', [{ parameterKey: 'p-hb', expectedLiveHash: 'a'.repeat(64) }])).rejects.toMatchObject({ statusCode: 409 });
    tests = [cbc({ parameters: [hb({ refLow: null, refHigh: null })] })];
    await expect(confirmCurrentRanges(T, 'path1', 'cbc', [{ parameterKey: 'p-hb', expectedLiveHash: liveHash() }])).rejects.toMatchObject({ code: 'RANGE_MISSING' });
  });
});

describe('editing the catalogue never moves a live range', () => {
  const save = (parameters: Any[], extra: Any = {}) =>
    updateTest(T, ['admin'], 'cbc', { testName: 'CBC', parameters, ...extra } as any, { userId: 'admin' });

  it('turns an edited range into a proposal and saves the rest', async () => {
    const out = await save([hb({ refHigh: 18, decimals: 1 }), tests[0].parameters[1]]);
    expect(param()).toMatchObject({ refLow: 13, refHigh: 17, decimals: 1 });
    expect(out.rangeProposals).toBe(1);
    expect(proposals[0]).toMatchObject({ origin: 'test_edit', refHigh: 18, proposedById: 'admin', status: 'pending' });
  });

  it('saving the same edit twice queues it once', async () => {
    await save([hb({ refHigh: 18 }), tests[0].parameters[1]]);
    await save([hb({ refHigh: 18 }), tests[0].parameters[1]]);
    expect(proposals).toHaveLength(1);
  });

  it('an unchanged save proposes nothing', async () => {
    await save(tests[0].parameters);
    expect(proposals).toHaveLength(0);
  });

  it('a unit change on a ranged parameter waits with the range', async () => {
    await save([hb({ unit: 'g/L' }), tests[0].parameters[1]]);
    expect(param().unit).toBe('g/dL');
    expect(proposals[0]).toMatchObject({ unit: 'g/L' });
  });

  it('clearing a range waits too', async () => {
    await save([hb({ refLow: null, refHigh: null }), tests[0].parameters[1]]);
    expect(param()).toMatchObject({ refLow: 13, refHigh: 17 });
    expect(proposals[0]).toMatchObject({ refLow: null, refHigh: null });
  });

  it('a new parameter starts without a range', async () => {
    await save([...tests[0].parameters, { id: 'p-plt', name: 'Platelets', unit: 'x', refLow: 150, refHigh: 400 }]);
    expect(param('p-plt')).toMatchObject({ refLow: null, refHigh: null });
    expect(proposals[0]).toMatchObject({ parameterKey: 'p-plt', refLow: 150 });
  });

  it('a range never follows a rename', async () => {
    const renamed = [hb({ name: 'Potassium' }), tests[0].parameters[1]];
    await expect(save(renamed)).rejects.toMatchObject({ code: 'RANGE_RENAME' });
    expect(param().name).toBe('Hemoglobin');
    await save(renamed, { confirmRangeReset: true });
    expect(param()).toMatchObject({ name: 'Potassium', refLow: null, refHigh: null });
    expect(proposals[0]).toMatchObject({ parameterName: 'Potassium', refLow: 13, status: 'pending' });
  });

  it('spelling variants are not a rename; bracketed qualifiers are', () => {
    expect(rangeNameKey('Haemoglobin')).toBe(rangeNameKey('hemoglobin'));
    expect(rangeNameKey('Glucose (Fasting)')).not.toBe(rangeNameKey('Glucose (PP)'));
    expect(rangeNameKey('Free T3')).not.toBe(rangeNameKey('Free T4'));
  });

  it('swapping ids between two parameters does not swap their ranges', () => {
    const [a, b] = tests[0].parameters;
    const out = splitRangeEdits({
      existing: tests[0] as any,
      next: { parameters: [{ ...a, id: b.id }, { ...b, id: a.id }] },
      onRename: 'refuse',
    });
    expect(out.drafts).toHaveLength(0);
    expect(out.live.parameters!.find((p) => p.name === 'WBC')).toMatchObject({ refLow: 4 });
  });

  it('two parameters with one id are refused', () => {
    expect(() =>
      splitRangeEdits({ existing: tests[0] as any, next: { parameters: [hb(), hb({ name: 'X' })] }, onRename: 'refuse' }),
    ).toThrow(/share the same id/);
  });

  it('a stale form, or an approval landing mid-save, is a 409', async () => {
    await expect(save(tests[0].parameters, { expectedRangeVersion: 7 })).rejects.toMatchObject({ statusCode: 409 });
    const real = (prisma as any).labTestCatalog.updateMany.getMockImplementation();
    (prisma as any).labTestCatalog.updateMany.mockImplementationOnce(async (a: Any) => {
      tests[0].rangeVersion += 1;
      return real(a);
    });
    await expect(save(tests[0].parameters)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('a new test is created with no live range at all', async () => {
    const out = await createTest(T, ['admin'], {
      testName: 'Ferritin', isActive: true, normalRange: '20-250', unit: 'ng/mL', parameters: undefined,
    } as any, { userId: 'admin' });
    expect(tests.at(-1)).toMatchObject({ testName: 'Ferritin', normalRange: null, unit: 'ng/mL' });
    expect(out.rangeProposals).toBe(1);
    await approveRangeProposals(T, 'path1', [{ id: proposals[0].id, expectedLiveHash: liveHash('__test__', out.id) }]);
    expect(tests.at(-1)!.normalRange).toBe('20-250');
  });

  it('templates: a new clone has no ranges, a re-sync keeps the live ones', async () => {
    templates = [
      { id: 'tplA', name: 'Electrolytes', isPublished: true, parameters: [{ id: 'na', name: 'Sodium', unit: 'mmol/L', refLow: 135, refHigh: 145 }], aliases: [], tags: [] },
      { id: 'tplB', name: 'CBC', isPublished: true, parameters: [hb({ refLow: 11 })], aliases: [], tags: [] },
    ];
    tests[0].templateId = 'tplB';
    await cloneTemplatesIntoTenant(T, { overwriteExisting: true }, 'admin');
    const added = tests.find((t) => t.testName === 'Electrolytes')!;
    expect(added.parameters[0]).toMatchObject({ refLow: null, refHigh: null });
    expect(param()).toMatchObject({ refLow: 13 });
    expect(proposals.map((p) => p.origin)).toEqual(['template', 'template']);
    expect(await listPendingProposals(T)).toHaveLength(2);
  });
});

describe('price guard', () => {
  beforeEach(() => {
    tests = [cbc(), { ...cbc(), id: 'hb', testName: 'Haemoglobin', testCode: 'HB', price: 700, parameters: null }];
  });
  const price = (p: number, confirmation?: Any) =>
    updateTestPrice(T, 'hb', { price: p, priceConfirmation: confirmation } as any, { userId: 'admin' });

  it('lists existing rows without touching them', async () => {
    const [row] = await getPriceReview(T);
    expect(row).toMatchObject({ testId: 'hb', panelId: 'cbc', confirmed: false });
    expect(row.message).toContain('₹700.00');
    expect(tests[1].price).toBe(700);
  });

  it('stops a price above the panel until confirmed with a reason, then audits it', async () => {
    await expect(price(600)).rejects.toMatchObject({ statusCode: 409, code: 'PRICE_ABOVE_PANEL' });
    await expect(price(600, { confirmed: true, reason: '  ' })).rejects.toMatchObject({ code: 'PRICE_ABOVE_PANEL' });
    expect(tests[1].price).toBe(700);
    await price(600, { confirmed: true, reason: 'Outsourced assay' });
    expect(tests[1]).toMatchObject({ price: 600, priceOverridePrice: 600, priceOverrideReason: 'Outsourced assay' });
    expect((prisma as any).auditLog.create.mock.calls.at(-1)[0].data.description).toContain('Outsourced assay');
    expect((await getPriceReview(T))[0].confirmed).toBe(true);
  });

  it('a confirmation lapses when the price moves by another route', async () => {
    await price(600, { confirmed: true, reason: 'Outsourced assay' });
    tests[1].price = 650;
    expect((await getPriceReview(T))[0].confirmed).toBe(false);
  });

  it('allows an equal or lower price, and an unrelated edit of an already flagged row', async () => {
    await expect(price(350)).resolves.toBeTruthy();
    tests[1].price = 700;
    await expect(
      updateTest(T, ['admin'], 'hb', { testName: 'Haemoglobin', price: 700, instructions: 'x' } as any, { userId: 'admin' }),
    ).resolves.toBeTruthy();
  });

  it('also covers cutting the panel below the test, and reactivating', async () => {
    tests[1].price = 300;
    await expect(updateTestPrice(T, 'cbc', { price: 250 } as any, {})).rejects.toMatchObject({ code: 'PRICE_ABOVE_PANEL' });
    tests[1].price = 700;
    tests[1].isActive = false;
    await expect(updateTest(T, ['admin'], 'hb', { isActive: true } as any, {})).rejects.toMatchObject({ code: 'PRICE_ABOVE_PANEL' });
  });

  it('applies when creating', async () => {
    await expect(createTest(T, ['admin'], { testName: 'WBC', price: 900, isActive: true } as any, {})).rejects.toMatchObject({ code: 'PRICE_ABOVE_PANEL' });
  });
});

describe('retiring a duplicate', () => {
  const thyroid = (id: string, over: Any = {}) => ({
    ...cbc(), id, testName: id === 'keep' ? 'Thyroid Profile (T3, T4, TSH)' : 'Thyroid profile total', testCode: id.toUpperCase(),
    specimen: 'Serum', parameters: [{ id: 'tsh', name: 'TSH', unit: 'uIU/mL' }], aliases: [], ...over,
  });
  beforeEach(() => {
    tests = [thyroid('keep'), thyroid('dup', { aliases: ['TFT'] })];
    (prisma as any).labOrderItem.count.mockResolvedValue(3);
    (prisma as any).payerServiceRate.findMany.mockResolvedValue([{ id: 'r', serviceCode: 'DUP', serviceName: 'x' }]);
    (prisma as any).payerPackageRate.findMany.mockResolvedValue([]);
    (prisma as any).serviceTariff.findMany.mockResolvedValue([]);
  });

  it('previews what refers to it', async () => {
    const p = await previewRetire(T, ['lab_supervisor'], 'dup', 'keep');
    expect(p.references).toMatchObject({ orderItems: 3 });
    expect(p.references.needsAttention[0]).toMatchObject({ kind: 'Payer rate' });
  });

  it('switches it off, points searches at the kept test, and leaves history alone', async () => {
    await retireDuplicate(T, 'admin', ['admin'], 'dup', { keepTestId: 'keep' });
    const dup = tests.find((t) => t.id === 'dup')!;
    expect(dup).toMatchObject({ isActive: false, replacedByTestId: 'keep', retiredById: 'admin' });
    const keep = tests.find((t) => t.id === 'keep')!;
    expect(keep.aliases).toEqual(['Thyroid profile total', 'TFT']);
    expect(keep.searchTokens).toContain('tft');
    for (const m of ['labTestCatalog', 'labOrderItem']) {
      expect((prisma as any)[m].delete).not.toHaveBeenCalled();
      expect((prisma as any)[m].deleteMany).not.toHaveBeenCalled();
    }
    expect((prisma as any).labOrderItem.updateMany).not.toHaveBeenCalled();
  });

  it('refuses different tests until confirmed with a reason', async () => {
    tests[1].parameters = [{ id: 'tsh', name: 'TSH', unit: 'mIU/mL' }, { id: 'ft4', name: 'Free T4', unit: 'ng/dL' }];
    tests[1].specimen = 'Plasma';
    const go = (x: Any) => retireDuplicate(T, 'admin', ['admin'], 'dup', { keepTestId: 'keep', ...x });
    await expect(go({})).rejects.toMatchObject({ code: 'TESTS_DIFFER' });
    await expect(go({ confirmDifferences: true })).rejects.toMatchObject({ code: 'TESTS_DIFFER' });
    expect(tests[1].isActive).toBe(true);
    const out = await go({ confirmDifferences: true, reason: 'Pathologist agreed' });
    expect(out.differences.join()).toMatch(/Free T4/);
  });

  it('is limited to admin and lab supervisor, and to one winner', async () => {
    for (const r of ['lab_technician', 'doctor']) {
      await expect(retireDuplicate(T, 'u', [r], 'dup', { keepTestId: 'keep' })).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(retireDuplicate(T, 'u', ['admin'], 'dup', { keepTestId: 'dup' })).rejects.toMatchObject({ statusCode: 400 });
    await retireDuplicate(T, 'u', ['lab_supervisor'], 'dup', { keepTestId: 'keep' });
    await expect(retireDuplicate(T, 'u', ['admin'], 'dup', { keepTestId: 'keep' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(retireDuplicate(T, 'u', ['admin'], 'keep', { keepTestId: 'dup' })).rejects.toMatchObject({ code: 'KEEP_INACTIVE' });
  });

  it('a new order for a retired test names the one to order instead', async () => {
    await retireDuplicate(T, 'admin', ['admin'], 'dup', { keepTestId: 'keep' });
    (prisma as any).patient.findFirst.mockResolvedValue({ id: 'p' });
    (prisma as any).visit.findFirst.mockResolvedValue({ id: 'v' });
    await expect(
      createLabOrder(T, 'doc', { patientId: 'p', visitId: 'v', items: [{ testId: 'dup' }] } as any),
    ).rejects.toThrow(/order Thyroid Profile \(T3, T4, TSH\) instead/);
  });
});

describe('catalogue import', () => {
  const row = (n: number, o: Any) => ({ rowNumber: n, ...o });
  const confirm = (p: Any, extra: Any = {}) => ({ key: p.key, action: p.action, testId: p.testId, stamp: p.stamp, ...extra });

  it('previews without writing', async () => {
    const before = JSON.stringify(tests);
    const out = await previewImport(T, ['admin'], [
      row(2, { testCode: 'CBC', testName: 'CBC', parameterName: 'Hemoglobin', refLow: 12, refHigh: 16 }),
      row(3, { testCode: 'FER', testName: 'Ferritin', price: '₹1,200', parameterName: 'Ferritin', parameterUnit: 'ng/mL', refLow: 20, refHigh: 250 }),
    ]);
    expect(out.summary).toMatchObject({ create: 1, update: 1, errors: 0 });
    expect(out.tests[0].rangeChanges[0]).toContain('12–16');
    expect(JSON.stringify(tests)).toBe(before);
    expect(proposals).toHaveLength(0);
  });

  it('saves ticked tests only; ranges become pending', async () => {
    const rows = [
      row(2, { testCode: 'CBC', testName: 'CBC', parameterName: 'Hemoglobin', refLow: 12, refHigh: 16 }),
      row(3, { testCode: 'FER', testName: 'Ferritin', price: 1200, parameterName: 'Ferritin', refLow: 20, refHigh: 250 }),
      row(4, { testCode: 'B12', testName: 'Vitamin B12', price: 900 }),
    ];
    const { tests: plans } = await previewImport(T, ['admin'], rows);
    const out = await commitImport(T, 'admin', ['admin'], rows, plans.filter((p) => p.testCode !== 'B12').map((p) => confirm(p)));
    expect(out).toMatchObject({ saved: 2, failed: 0 });
    expect(tests.map((t) => t.testName)).toEqual(['CBC', 'Ferritin']);
    expect(param()).toMatchObject({ refLow: 13, refHigh: 17 });
    expect(tests[1].parameters[0]).toMatchObject({ refLow: null });
    expect(proposals.map((p) => [p.origin, p.status])).toEqual([['import', 'pending'], ['import', 'pending']]);
  });

  it.each([
    ['low above high', { parameterName: 'Hemoglobin', refLow: 20, refHigh: 10 }, /below the high limit/],
    ['a text limit', { parameterName: 'Hemoglobin', refLow: 'abc' }, /must be numbers/],
    ['a negative price', { price: -5 }, /Price/],
    ['placeholder text', { instructions: 'description patient instructions' }, /placeholder/],
    ['a code that belongs to another name', { testName: 'Something else' }, /Rename it on the test screen/],
  ])('rejects %s', async (_n, o, msg) => {
    const { tests: plans } = await previewImport(T, ['admin'], [row(2, { testCode: 'CBC', testName: 'CBC', ...o })]);
    expect(plans[0].errors.join()).toMatch(msg);
    const out = await commitImport(T, 'admin', ['admin'], [row(2, { testCode: 'CBC', testName: 'CBC', ...o })], [confirm(plans[0])]);
    expect(out).toMatchObject({ saved: 0, failed: 1 });
  });

  it('rejects near-duplicates, in the catalogue and inside the file', async () => {
    tests.push({ ...cbc(), id: 'th', testName: 'Thyroid Profile (T3, T4, TSH)', testCode: 'TH' });
    const out = await previewImport(T, ['admin'], [
      row(2, { testName: 'Thyroid profile' }),
      row(3, { testCode: 'L1', testName: 'Lipid Profile' }),
      row(4, { testCode: 'L2', testName: 'Lipid profile (basic)' }),
    ]);
    expect(out.tests[0].errors.join()).toMatch(/near-identical/);
    expect(out.tests[1].errors.join()).toMatch(/near-identical/);
  });

  it('applies the price guard per test', async () => {
    const rows = [row(2, { testCode: 'HB', testName: 'Haemoglobin', price: 700 })];
    const { tests: plans, summary } = await previewImport(T, ['admin'], rows);
    expect(summary.needPriceReason).toBe(1);
    expect(await commitImport(T, 'admin', ['admin'], rows, [confirm(plans[0])])).toMatchObject({ saved: 0, failed: 1 });
    expect(await commitImport(T, 'admin', ['admin'], rows, [confirm(plans[0], { priceReason: 'Agreed rate' })])).toMatchObject({ saved: 1 });
  });

  it('refuses a test that moved since the preview, and a second submit', async () => {
    const rows = [row(2, { testCode: 'CBC', testName: 'CBC', price: 400 })];
    const { tests: plans } = await previewImport(T, ['admin'], rows);
    tests[0].rangeVersion += 1;
    expect(await commitImport(T, 'admin', ['admin'], rows, [confirm(plans[0])])).toMatchObject({ saved: 0 });
    const add = [row(2, { testCode: 'FER', testName: 'Ferritin', price: 10 })];
    const { tests: p2 } = await previewImport(T, ['admin'], add);
    expect(await commitImport(T, 'admin', ['admin'], add, [confirm(p2[0])])).toMatchObject({ saved: 1 });
    expect(await commitImport(T, 'admin', ['admin'], add, [confirm(p2[0])])).toMatchObject({ saved: 0, failed: 1 });
    expect(tests.filter((t) => t.testName === 'Ferritin')).toHaveLength(1);
  });

  it('is for the hospital admin only', async () => {
    for (const r of ['lab_technician', 'lab_supervisor', 'doctor']) {
      await expect(previewImport(T, [r], [row(2, { testName: 'x' })])).rejects.toMatchObject({ statusCode: 403 });
    }
  });
});

// #369: a result exactly on a "≤" or "≥" limit is normal; "<" and ">" exclude it.
describe('abnormal flag on one-sided limits', () => {
  it('includes the limit for ≤ / <= / ≥ / >= and excludes it for < / >', () => {
    expect(evaluateAbnormal('100', '≤100')).toBe(false);
    expect(evaluateAbnormal('100', '<=100')).toBe(false);
    expect(evaluateAbnormal('100.1', '≤100')).toBe(true);
    expect(evaluateAbnormal('100', '<100')).toBe(true);
    expect(evaluateAbnormal('99.9', '<100')).toBe(false);
    expect(evaluateAbnormal('40', '≥40')).toBe(false);
    expect(evaluateAbnormal('40', '>=40')).toBe(false);
    expect(evaluateAbnormal('39.9', '≥40')).toBe(true);
    expect(evaluateAbnormal('40', '>40')).toBe(true);
    expect(evaluateAbnormal('0.03', '< 0.04')).toBe(false);
  });

  it('a range keeps both ends inside it', () => {
    expect(evaluateAbnormal('13', '13-17')).toBe(false);
    expect(evaluateAbnormal('17', '13-17')).toBe(false);
    expect(evaluateAbnormal('17.1', '13-17')).toBe(true);
  });
});
