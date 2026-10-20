import { z } from 'zod';

const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(values).optional());

const optionalNumber = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
  z.number().min(0).optional(),
);

export const addIntoxicationExamSchema = z.object({
  body: z.object({
    patientId: z.string().min(1),
    admissionId: z.string().min(1),
    visitId: z.string().optional(),
    alcoholSmell: optionalEnum(['strong', 'mild', 'absent']),
    speech: optionalEnum(['slurred', 'incoherent', 'normal']),
    pupilsConjunctiva: optionalEnum(['dilated_sluggish', 'pinpoint', 'normal']),
    gaitBalance: optionalEnum(['staggering', 'unable_to_stand', 'steady']),
    rombergSign: optionalEnum(['positive', 'negative']),
    fingerToNose: optionalEnum(['inaccurate', 'past_pointing', 'normal']),

    recordedBac: optionalNumber,

    opinion: optionalEnum([
      'consumed_under_influence',
      'consumed_not_under_influence',
      'no_evidence',
    ]),

    examinerName: z.string().trim().optional(),
    examinerNmcNo: z.string().trim().optional(),
    examinedAt: z.string().optional(), // datetime-local string → Date in service

    witnessName: z.string().trim().optional(),
    witnessBuckleNo: z.string().trim().optional(),
    witnessPoliceStation: z.string().trim().optional(),
  }),
});

export const listIntoxicationExamSchema = z.object({
  query: z.object({
    admissionId: z.string().min(1),
  }),
});

export type AddIntoxicationExamInput = z.infer<typeof addIntoxicationExamSchema>['body'];
export type ListIntoxicationExamQuery = z.infer<typeof listIntoxicationExamSchema>['query'];
