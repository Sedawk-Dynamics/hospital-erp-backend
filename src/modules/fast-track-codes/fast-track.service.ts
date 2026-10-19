import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import type { AddFastTrackCodeInput } from './fast-track.validation';

export const codesAdd = async (
  tenantId: string,
  userId: string,
  input: AddFastTrackCodeInput,
) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new AppError('tenant not found', 404);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('user not found', 404);

  const fastTrackCode = await prisma.fastTrackCode.create({
    data: {
      tenantId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      visitId: input.visitId ?? null,
      code: input.code,
      details: input.details,
      activatedBy: userId,
    },
  });

  return fastTrackCode;
};


export const codesFetch=async(tenantId:string,admissionId:string)=>{
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new AppError('tenant not found', 404);

  const admission=await prisma.admission.findUnique({where:{id:admissionId}});
  if(!admission)throw new AppError('admission not found',404);

  return await prisma.fastTrackCode.findMany({
  where: { tenantId, admissionId },
  orderBy: { createdAt: 'desc' },
});
}