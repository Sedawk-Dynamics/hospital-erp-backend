import { z } from 'zod';

// Number fields arrive from the frontend as strings; '' → undefined, else number.
const optionalNumber = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
  z.number().min(0).optional(),
);

const injurySchema = z.object({
  bodySite: z.string().trim().min(1, 'Body site is required'),
  nature: z.string().trim().optional(),
  length: optionalNumber,
  width: optionalNumber,
});

export const addMedicoLegalSchema = z.object({
  body: z.object({
    patientId: z.string().min(1),
    admissionId: z.string().min(1),
    visitId: z.string().optional(),
    isMlc: z.boolean(),
    mlcSerialNumber: z.string().trim().optional(),
    policeStation: z.string().trim().optional(),
    investigatingOfficer: z.string().trim().optional(),
    policeIntimationAt: z.string().optional(),
    ioArrivalAt: z.string().optional(),
    receiptAckNo: z.string().trim().optional(),
    items: z.array(z.string()).default([]),
    injuries: z.array(injurySchema).default([]),
  }),
});

export const listMedicoLegalSchema = z.object({
  query: z.object({
    admissionId: z.string().min(1),
  }),
});

export type AddMedicoLegalInput = z.infer<typeof addMedicoLegalSchema>['body'];
export type ListMedicoLegalQuery = z.infer<typeof listMedicoLegalSchema>['query'];
