import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../../src/config/database';
import {
  createHospitalForm,
  updateHospitalForm,
  publishHospitalForm,
  discardHospitalFormDraft,
  listHospitalForms,
  getHospitalForm,
  createSubmission,
  deriveHospitalFormStatus,
} from '../../../../src/modules/forms/forms.service';

// Gap 304 — a form's draft and its published (nurse-visible) version are
// separate. QA found the opposite: a schema edit to a published form went
// straight to nurses as "version 2" with no draft retained. These tests drive
// the whole lifecycle against a small in-memory table so the service's real
// read/write paths are exercised end to end.

const TENANT = 'tenant-1';
const ADMIN = ['admin'];
const NURSE = ['nurse'];
const ADMIN_ID = 'admin-user';
const NURSE_ID = 'nurse-user';

const field = (key: string, label: string) => ({
  id: key, key, label, type: 'text', required: false, width: 'full',
});
const V1 = { fields: [field('pulse', 'Pulse')], version: 1 };
const V2 = { fields: [field('pulse', 'Pulse'), field('bp', 'Blood pressure')], version: 1 };

type Row = Record<string, unknown>;
let rows: Row[];
let submissions: Row[];

function store(v: unknown) {
  // Prisma writes DbNull as SQL NULL; JSON round-trip mimics jsonb storage.
  if (v === Prisma.DbNull) return null;
  if (v && typeof v === 'object' && !(v instanceof Date)) return JSON.parse(JSON.stringify(v));
  return v;
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (cond === null) return row[k] == null;
    if (cond && typeof cond === 'object' && 'not' in (cond as Row)) return row[k] != null;
    return row[k] === cond;
  });
}

function pick(row: Row, select?: Record<string, boolean>) {
  if (!select) return { ...row, _count: { submissions: submissions.filter((s) => s.formId === row.id).length } };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

function installFakeTable() {
  rows = [];
  submissions = [];
  let seq = 0;
  vi.mocked(prisma.hospitalForm.create).mockImplementation((async ({ data }: { data: Row }) => {
    const row: Row = {
      id: `form-${++seq}`,
      draftSchema: null,
      archivedAt: null,
      publishedAt: null,
      publishedById: null,
      ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, store(v)])),
    };
    rows.push(row);
    return { ...row };
  }) as never);
  vi.mocked(prisma.hospitalForm.update).mockImplementation((async ({ where, data }: { where: Row; data: Row }) => {
    const row = rows.find((r) => r.id === where.id)!;
    for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = store(v);
    return { ...row };
  }) as never);
  vi.mocked(prisma.hospitalForm.findFirst).mockImplementation((async (
    { where, select }: { where: Row; select?: Record<string, boolean> },
  ) => {
    const row = rows.find((r) => matches(r, where));
    return row ? pick(row, select) : null;
  }) as never);
  vi.mocked(prisma.hospitalForm.findMany).mockImplementation((async ({ where }: { where: Row }) =>
    rows.filter((r) => matches(r, where)).map((r) => pick(r))) as never);
  vi.mocked(prisma.hospitalForm.count).mockImplementation((async ({ where }: { where: Row }) =>
    rows.filter((r) => matches(r, where)).length) as never);
  vi.mocked(prisma.hospitalFormSubmission.create).mockImplementation((async ({ data }: { data: Row }) => {
    const sub = { id: `sub-${submissions.length + 1}`, ...data };
    submissions.push(sub);
    return sub;
  }) as never);
  vi.mocked(prisma.hospitalFormSubmission.aggregate).mockImplementation((async ({ where }: { where: Row }) => {
    const versions = submissions.filter((s) => s.formId === where.formId).map((s) => s.formVersion as number);
    return { _max: { formVersion: versions.length ? Math.max(...versions) : null } };
  }) as never);
  vi.mocked(prisma.patient.findFirst).mockResolvedValue({ id: 'pat-1' } as never);
  vi.mocked(prisma.admission.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.visit.findFirst).mockResolvedValue(null as never);
}

const listQuery = { status: 'active', page: 1, limit: 50 } as never;

async function nurseView(id: string) {
  return getHospitalForm(TENANT, id, NURSE);
}

async function newDraft() {
  return createHospitalForm(TENANT, ADMIN_ID, ADMIN, {
    name: 'Vitals', category: 'other', schema: V1, isPublished: false,
  } as never);
}

const fieldKeys = (schema: unknown) => (schema as { fields: { key: string }[] }).fields.map((f) => f.key);

describe('gap 304: hospital form draft vs published', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFakeTable();
  });

  it('a new form is a Draft that nurses are not offered', async () => {
    const form = await newDraft();
    expect(form.status).toBe('draft');
    expect(form.statusLabel).toBe('Draft');
    expect(form.publishedVersion).toBeNull();

    const nurseList = await listHospitalForms(TENANT, listQuery, NURSE);
    expect(nurseList.items).toHaveLength(0);
    await expect(nurseView(form.id)).rejects.toThrow(/not found/i);
    await expect(
      createSubmission(TENANT, NURSE_ID, form.id, { patientId: 'pat-1', data: {} } as never),
    ).rejects.toThrow(/draft/i);
  });

  it('editing a never-published form edits the draft, not a version', async () => {
    const form = await newDraft();
    const edited = await updateHospitalForm(TENANT, ADMIN, form.id, { schema: V2 } as never, ADMIN_ID);
    expect(edited.status).toBe('draft');
    expect(edited.isPublished).toBe(false);
    expect(fieldKeys(edited.schema)).toEqual(['pulse', 'bp']);
  });

  it('publishing creates v1, records who and when, and nurses then see it', async () => {
    const form = await newDraft();
    const pub = await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, form.id);
    expect(pub.status).toBe('published');
    expect(pub.publishedVersion).toBe(1);
    expect(pub.publishedById).toBe(ADMIN_ID);
    expect(pub.publishedAt).toBeInstanceOf(Date);

    const seen = await nurseView(form.id);
    expect(seen.version).toBe(1);
    expect(fieldKeys(seen.schema)).toEqual(['pulse']);
  });

  it('editing a published form keeps nurses on the published version and flags unpublished changes', async () => {
    const form = await newDraft();
    await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, form.id);

    const edited = await updateHospitalForm(TENANT, ADMIN, form.id, { schema: V2 } as never, ADMIN_ID);
    // The QA failure: this used to return version 2 with the edit live.
    expect(edited.version).toBe(1);
    expect(edited.status).toBe('published_with_changes');
    expect(edited.statusLabel).toBe('Published · unpublished changes');
    expect(edited.hasUnpublishedChanges).toBe(true);
    expect(fieldKeys(edited.schema)).toEqual(['pulse']);
    expect(fieldKeys(edited.draftSchema)).toEqual(['pulse', 'bp']);

    // Nurses: still v1, and the draft is not in the payload at all.
    const seen = await nurseView(form.id);
    expect(seen.version).toBe(1);
    expect(fieldKeys(seen.schema)).toEqual(['pulse']);
    expect(seen).not.toHaveProperty('draftSchema');
    const nurseList = await listHospitalForms(TENANT, listQuery, NURSE);
    expect(nurseList.items).toHaveLength(1);
    expect(nurseList.items[0]).not.toHaveProperty('draftSchema');
    expect(fieldKeys(nurseList.items[0].schema)).toEqual(['pulse']);

    // A submission snapshots the published version, not the draft.
    const sub = await createSubmission(TENANT, NURSE_ID, form.id, {
      patientId: 'pat-1', data: { pulse: '72', bp: '120/80' },
    } as never);
    expect(sub.formVersion).toBe(1);
    expect(fieldKeys(sub.formSnapshot)).toEqual(['pulse']);
    expect(sub.data).toEqual({ pulse: '72' });
  });

  it('republishing makes the draft v2 for nurses and clears the draft', async () => {
    const form = await newDraft();
    await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, form.id);
    await updateHospitalForm(TENANT, ADMIN, form.id, { schema: V2 } as never, ADMIN_ID);

    const pub = await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, form.id);
    expect(pub.version).toBe(2);
    expect(pub.status).toBe('published');
    expect(pub.draftSchema).toBeNull();

    const seen = await nurseView(form.id);
    expect(seen.version).toBe(2);
    expect(fieldKeys(seen.schema)).toEqual(['pulse', 'bp']);

    const sub = await createSubmission(TENANT, NURSE_ID, form.id, {
      patientId: 'pat-1', data: { pulse: '72', bp: '120/80' },
    } as never);
    expect(sub.formVersion).toBe(2);
  });

  it('publishing with nothing pending is a no-op, not a new version', async () => {
    const form = await newDraft();
    await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, form.id);
    const again = await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, form.id);
    expect(again.version).toBe(1);
    expect(again.status).toBe('published');
  });

  it('saving the published schema back unchanged leaves no draft behind', async () => {
    const form = await newDraft();
    await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, form.id);
    await updateHospitalForm(TENANT, ADMIN, form.id, { schema: V2 } as never, ADMIN_ID);
    const back = await updateHospitalForm(TENANT, ADMIN, form.id, { schema: V1 } as never, ADMIN_ID);
    expect(back.status).toBe('published');
    expect(back.draftSchema).toBeNull();
  });

  it('discarding the draft returns the builder to the published schema', async () => {
    const form = await newDraft();
    await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, form.id);
    await updateHospitalForm(TENANT, ADMIN, form.id, { schema: V2 } as never, ADMIN_ID);
    const discarded = await discardHospitalFormDraft(TENANT, ADMIN, form.id);
    expect(discarded.status).toBe('published');
    expect(discarded.draftSchema).toBeNull();
    expect(fieldKeys(discarded.schema)).toEqual(['pulse']);
    await expect(discardHospitalFormDraft(TENANT, ADMIN, (await newDraft()).id)).rejects.toThrow(/never been published/i);
  });

  it('a published form cannot be silently turned back into a draft', async () => {
    const form = await newDraft();
    await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, form.id);
    await expect(
      updateHospitalForm(TENANT, ADMIN, form.id, { isPublished: false } as never, ADMIN_ID),
    ).rejects.toThrow(/cannot be turned back into a draft/i);
  });

  it('the forms list and the builder report the same status for the same form', async () => {
    const draft = await newDraft();
    const live = await newDraft();
    await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, live.id);
    const changed = await newDraft();
    await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, changed.id);
    await updateHospitalForm(TENANT, ADMIN, changed.id, { schema: V2 } as never, ADMIN_ID);

    const list = await listHospitalForms(TENANT, listQuery, ADMIN);
    for (const id of [draft.id, live.id, changed.id]) {
      const inList = list.items.find((f) => f.id === id)!;
      const inBuilder = await getHospitalForm(TENANT, id, ADMIN);
      expect(inList.status).toBe(inBuilder.status);
      expect(inList.statusLabel).toBe(inBuilder.statusLabel);
      expect(inList.publishedVersion).toBe(inBuilder.publishedVersion);
    }
    const byId = Object.fromEntries(list.items.map((f) => [f.id, f.status]));
    expect(byId[draft.id]).toBe('draft');
    expect(byId[live.id]).toBe('published');
    expect(byId[changed.id]).toBe('published_with_changes');
  });

  it('a first publish never reuses a version number submissions already carry', async () => {
    // Legacy: a form that was live at v3, then unpublished, then re-published.
    const form = await newDraft();
    rows[0].version = 3;
    submissions.push({ id: 'old', formId: form.id, formVersion: 3 });
    const pub = await publishHospitalForm(TENANT, ADMIN_ID, ADMIN, form.id);
    expect(pub.version).toBe(4);
  });

  it('existing published forms with no draft read as Published', () => {
    expect(deriveHospitalFormStatus({ isPublished: true, version: 5, draftSchema: null })).toBe('published');
    expect(deriveHospitalFormStatus({ isPublished: true, version: 5, draftSchema: null, archivedAt: new Date() })).toBe('archived');
  });
});
