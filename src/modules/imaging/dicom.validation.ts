import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

export const createStudySchema = z.object({
  body: z.object({
    imagingRequestId: z.string().uuid().optional(),
    imagingResultId: z.string().uuid().optional(),
    patientId: z.string().uuid('Invalid patient ID'),
    studyInstanceUid: z.string().min(1).max(255),
    accessionNumber: z.string().max(64).optional(),
    studyDate: z.string().optional(),
    studyDescription: z.string().max(255).optional(),
    modality: z.string().max(20).optional(),
    patientName: z.string().max(255).optional(),
    patientDicomId: z.string().max(64).optional(),
    referringPhysician: z.string().max(255).optional(),
    viewerUrl: z.string().url().optional(),
  }),
});

export const addInstanceSchema = z.object({
  body: z.object({
    seriesInstanceUid: z.string().min(1).max(255).optional(),
    seriesDescription: z.string().max(255).optional(),
    seriesNumber: z.number().int().nonnegative().optional(),
    seriesModality: z.string().max(20).optional(),
    bodyPart: z.string().max(100).optional(),

    sopInstanceUid: z.string().min(1).max(255),
    sopClassUid: z.string().max(255).optional(),
    instanceNumber: z.number().int().nonnegative().optional(),
    fileUrl: z.string().min(1),
    fileSizeBytes: z.number().int().nonnegative().optional(),
    mimeType: z.string().max(100).default('application/dicom'),
    rows: z.number().int().positive().optional(),
    columns: z.number().int().positive().optional(),
  }),
  params: z.object({
    id: z.string().uuid(),
  }),
});

export const getStudiesQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    imagingRequestId: z.string().uuid().optional(),
    modality: z.string().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const studyIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

export const worklistQuerySchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    modality: z.string().optional(),
    status: z.enum(['requested', 'scheduled', 'in_progress', 'completed', 'reported', 'cancelled']).optional(),
  }),
});

export type CreateStudyInput = z.infer<typeof createStudySchema>['body'];
export type AddInstanceInput = z.infer<typeof addInstanceSchema>['body'];
export type GetStudiesQuery = z.infer<typeof getStudiesQuerySchema>['query'];
export type WorklistQuery = z.infer<typeof worklistQuerySchema>['query'];
