import { z } from 'zod';
import { DOCTOR_SPECIALTIES } from '../users/users.validation';

export const addSpecialityDataSchema = z.object({
  params: z.object({
    visitId: z.string().uuid(),
  }),
  body: z.object({
    speciality: z.enum(DOCTOR_SPECIALTIES),
    data: z.record(z.string(), z.any()),
  }),
});