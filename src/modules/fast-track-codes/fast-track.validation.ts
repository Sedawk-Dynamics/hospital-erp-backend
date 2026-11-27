import z from'zod';

export const addFastTrackCodeSchema = z.object({
  body: z.object({
    patientId: z.string().min(1),
    admissionId: z.string().min(1),
    visitId: z.string().optional(),
    code: z.enum(['code_red_trauma', 'code_stemi', 'code_stroke', 'code_sepsis', 'red', 'orange', 'yellow', 'green', 'black']),
    details: z.record(z.string(), z.any()),
  }),
});

export const listFastTrackCodesSchema = z.object({
  query: z.object({
    admissionId: z.string().min(1),
  }),
});

export type AddFastTrackCodeInput = z.infer<typeof addFastTrackCodeSchema>['body'];
export type ListFastTrackCodesQuery = z.infer<typeof listFastTrackCodesSchema>['query'];
