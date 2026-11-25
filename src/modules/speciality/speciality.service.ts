import { AppError } from '../../shared/appError';
import { prisma } from '../../config/database';

export const specialityDataAdd = async (visitId: string, tenantId: string, input: any) => {
  const visit = await prisma.visit.findFirst({
    where: { id: visitId, tenantId },
    select: { id: true, patientId: true, doctorId: true },
  });
  if (!visit) throw AppError.notFound('visit not found');

  return prisma.consultationSpecialtyData.upsert({
    where: { visitId_speciality: { visitId, speciality: input.speciality } },
    update: { data: input.data },
    create: {
      tenantId,
      visitId,
      patientId: visit.patientId,
      doctorId: visit.doctorId,
      speciality: input.speciality,
      data: input.data,
    },
  });
};

export const specialityDataFetch = async (visitId: string, tenantId: string) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new AppError('tenant not found', 404);

    const visit = await prisma.visit.findUnique({ where: { id: visitId } });
    if (!visit) throw new AppError('visit not found', 404);

    return await prisma.consultationSpecialtyData.findFirst({ where: { tenantId, visitId }, select: { data: true } });
}
