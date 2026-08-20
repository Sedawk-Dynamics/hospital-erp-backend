import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../../../src/config/database';
import {
  createProgressNote,
  updateProgressNote,
  signProgressNote,
  deleteProgressNote,
  getProgressNoteById,
  createNursingNote,
  updateNursingNote,
  deleteNursingNote,
  getNursingNoteById,
  listConsultationsAwaitingSignature,
} from '../../../../src/modules/progress-notes/progress-notes.service';

const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================
// Progress Notes
// ============================================================

describe('Progress Notes Service', () => {
  describe('createProgressNote', () => {
    it('should create a progress note when visit and doctor profile exist', async () => {
      const input = {
        visitId: 'visit-1',
        patientId: 'pat-1',
        noteType: 'soap',
        content: 'Patient is stable.',
      };

      vi.mocked(prisma.visit.findFirst).mockResolvedValueOnce({ id: 'visit-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce({ id: 'doc-1' } as any);
      vi.mocked(prisma.progressNote.create).mockResolvedValueOnce({
        id: 'note-1',
        doctorId: 'doc-1',
        status: 'draft',
        ...input,
      } as any);

      const result = await createProgressNote(TENANT_ID, USER_ID, input as any);

      expect(result.id).toBe('note-1');
      expect(prisma.progressNote.create).toHaveBeenCalledOnce();
    });

    it('should throw notFound when visit does not exist', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValueOnce(null);

      await expect(
        createProgressNote(TENANT_ID, USER_ID, {
          visitId: 'bad-visit',
          patientId: 'pat-1',
          noteType: 'soap',
          content: 'x',
        } as any),
      ).rejects.toThrow('Visit not found');
    });

    it('should throw badRequest when user has no doctor profile', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValueOnce({ id: 'visit-1' } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce(null);

      await expect(
        createProgressNote(TENANT_ID, USER_ID, {
          visitId: 'visit-1',
          patientId: 'pat-1',
          noteType: 'soap',
          content: 'x',
        } as any),
      ).rejects.toThrow('No doctor profile found for the current user');
    });
  });

  describe('updateProgressNote', () => {
    it('should update a draft progress note', async () => {
      const existing = { id: 'note-1', status: 'active', doctorId: 'doc-1', content: 'old', pins: [] };
      vi.mocked(prisma.progressNote.findFirst).mockResolvedValueOnce(existing as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce({ id: 'doc-1' } as any);
      // $transaction callback mode: invoke the callback directly with the `tx` client.
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (cb: any) => cb(prisma));
      vi.mocked(prisma.progressNoteAmendment.createMany).mockResolvedValueOnce({ count: 1 } as any);
      vi.mocked(prisma.progressNote.update).mockResolvedValueOnce({
        ...existing,
        content: 'new content',
      } as any);

      const result = await updateProgressNote(TENANT_ID, USER_ID, 'note-1', { content: 'new content' } as any);

      expect(result!.content).toBe('new content');
    });

    it('should throw badRequest when updating a finalized note', async () => {
      vi.mocked(prisma.progressNote.findFirst).mockResolvedValueOnce({
        id: 'note-1',
        status: 'finalized',
        pins: [],
      } as any);

      await expect(
        updateProgressNote(TENANT_ID, USER_ID, 'note-1', { content: 'x' } as any),
      ).rejects.toThrow('Cannot update a finalized progress note');
    });

    it('should throw notFound when note does not exist', async () => {
      vi.mocked(prisma.progressNote.findFirst).mockResolvedValueOnce(null);

      await expect(
        updateProgressNote(TENANT_ID, USER_ID, 'bad-id', { content: 'x' } as any),
      ).rejects.toThrow('Progress note not found');
    });

    it('should throw forbidden when a different doctor tries to edit', async () => {
      vi.mocked(prisma.progressNote.findFirst).mockResolvedValueOnce({
        id: 'note-1',
        status: 'active',
        doctorId: 'doc-other',
        pins: [],
      } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce({ id: 'doc-1' } as any);

      await expect(
        updateProgressNote(TENANT_ID, USER_ID, 'note-1', { content: 'x' } as any),
      ).rejects.toThrow('Only the assigned doctor can edit this progress note');
    });
  });

  describe('signProgressNote', () => {
    it('should finalize a draft progress note', async () => {
      vi.mocked(prisma.progressNote.findFirst).mockResolvedValueOnce({
        id: 'note-1',
        status: 'active',
        doctorId: 'doc-1',
      } as any);
      vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce({ id: 'doc-1' } as any);
      vi.mocked(prisma.progressNote.update).mockResolvedValueOnce({
        id: 'note-1',
        status: 'finalized',
      } as any);

      const result = await signProgressNote(TENANT_ID, 'note-1', USER_ID);

      expect(result.status).toBe('finalized');
    });

    it('should throw badRequest when signing an already finalized note', async () => {
      vi.mocked(prisma.progressNote.findFirst).mockResolvedValueOnce({
        id: 'note-1',
        status: 'finalized',
      } as any);

      await expect(
        signProgressNote(TENANT_ID, 'note-1', USER_ID),
      ).rejects.toThrow('Progress note is already finalized');
    });
  });

  // ============================================================
  // Nursing Notes
  // ============================================================

  describe('createNursingNote', () => {
    it('should create a nursing note when visit exists', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValueOnce({ id: 'visit-1' } as any);
      vi.mocked(prisma.nursingNote.create).mockResolvedValueOnce({
        id: 'nn-1',
        nurseId: USER_ID,
        content: 'Vitals stable',
      } as any);

      const result = await createNursingNote(TENANT_ID, USER_ID, {
        visitId: 'visit-1',
        patientId: 'pat-1',
        noteType: 'assessment',
        content: 'Vitals stable',
      } as any);

      expect(result.id).toBe('nn-1');
    });

    it('should throw notFound when visit does not exist', async () => {
      vi.mocked(prisma.visit.findFirst).mockResolvedValueOnce(null);

      await expect(
        createNursingNote(TENANT_ID, USER_ID, {
          visitId: 'bad',
          patientId: 'pat-1',
          noteType: 'assessment',
          content: 'x',
        } as any),
      ).rejects.toThrow('Visit not found');
    });
  });

  describe('updateNursingNote', () => {
    it('should update an existing nursing note', async () => {
      vi.mocked(prisma.nursingNote.findFirst).mockResolvedValueOnce({
        id: 'nn-1',
        content: 'old',
      } as any);
      vi.mocked(prisma.nursingNote.update).mockResolvedValueOnce({
        id: 'nn-1',
        content: 'updated',
      } as any);

      const result = await updateNursingNote(TENANT_ID, 'nn-1', { content: 'updated' } as any);

      expect(result.content).toBe('updated');
    });

    it('should throw notFound when nursing note does not exist', async () => {
      vi.mocked(prisma.nursingNote.findFirst).mockResolvedValueOnce(null);

      await expect(
        updateNursingNote(TENANT_ID, 'bad-id', { content: 'x' } as any),
      ).rejects.toThrow('Nursing note not found');
    });
  });
});

// ============================================================
// Consultations awaiting signature (Test Report 3 / A7)
// ============================================================

describe('listConsultationsAwaitingSignature', () => {
  it('scopes the query to the calling doctor and to pinned OP notes', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce({ id: 'doc-1' } as any);
    vi.mocked(prisma.progressNote.findMany).mockResolvedValueOnce([] as any);

    await listConsultationsAwaitingSignature(TENANT_ID, USER_ID);

    const where = vi.mocked(prisma.progressNote.findMany).mock.calls[0]![0]!.where as any;
    expect(where.doctorId).toBe('doc-1');
    // A pinned section is the only thing there is to publish.
    expect(where.pins).toEqual({ some: {} });
    // OP only — IP rounds belong to the discharge summary, not this list.
    expect(where.admissionId).toBeNull();
    expect(where.visit).toMatchObject({ tenantId: TENANT_ID, visitType: 'op' });
  });

  it('still offers a note the 24h cron archived, which can be signed', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce({ id: 'doc-1' } as any);
    vi.mocked(prisma.progressNote.findMany).mockResolvedValueOnce([] as any);

    await listConsultationsAwaitingSignature(TENANT_ID, USER_ID);

    // Excluding archived would make a consultation permanently unpublishable
    // a day after it happened.
    const where = vi.mocked(prisma.progressNote.findMany).mock.calls[0]![0]!.where as any;
    expect(where.status.in).toContain('active');
    expect(where.status.in).toContain('archived');
    expect(where.status.in).not.toContain('finalized');
  });

  it('returns nothing for a user who is not a doctor here', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce(null as any);

    const rows = await listConsultationsAwaitingSignature(TENANT_ID, 'not-a-doctor');

    expect(rows).toEqual([]);
    // Must not fall through to an unscoped query that would expose the
    // whole tenant's unsigned notes.
    expect(prisma.progressNote.findMany).not.toHaveBeenCalled();
  });

  it('carries the appointmentId the dashboard needs to deep-link', async () => {
    vi.mocked(prisma.doctorProfile.findFirst).mockResolvedValueOnce({ id: 'doc-1' } as any);
    vi.mocked(prisma.progressNote.findMany).mockResolvedValueOnce([] as any);

    await listConsultationsAwaitingSignature(TENANT_ID, USER_ID);

    const include = vi.mocked(prisma.progressNote.findMany).mock.calls[0]![0]!.include as any;
    expect(include.visit.select.appointmentId).toBe(true);
  });
});
