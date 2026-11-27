import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import type { AddMedicoLegalInput } from './medico-legal.validation';

const toDate = (v?: string) => (v ? new Date(v) : null);

export const medicalAdd = async (tenantId: string, userId: string, input: AddMedicoLegalInput) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new AppError('tenant not found', 404);

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError('user not found', 404);

  const medicoLegal = await prisma.medicoLegalRecord.create({
    data: {
      tenantId,
      patientId: input.patientId,
      admissionId: input.admissionId,
      visitId: input.visitId ?? null,
      isMlc: input.isMlc,
      mlcSerialNumber: input.mlcSerialNumber ?? null,
      policeStation: input.policeStation ?? null,
      investigatingOfficer: input.investigatingOfficer ?? null,
      policeIntimationAt: toDate(input.policeIntimationAt),
      ioArrivalAt: toDate(input.ioArrivalAt),
      receiptAckNo: input.receiptAckNo ?? null,
      items: input.items ?? [],
      createdBy: userId,
      injuries: {
        create: (input.injuries ?? []).map((inj) => ({
          bodySite: inj.bodySite,
          nature: inj.nature ?? null,
          lengthCm: inj.length ?? null,
          widthCm: inj.width ?? null,
        })),
      },
    },
    include: { injuries: true },
  });

  return medicoLegal;
};

export const medicalGet = async (tenantId: string, admissionId: string) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new AppError('tenant not found', 404);

  const admission = await prisma.admission.findUnique({ where: { id: admissionId } });
  if (!admission) throw new AppError('admission not found', 404);

  return await prisma.medicoLegalRecord.findMany({
    where: { tenantId, admissionId },
    orderBy: { createdAt: 'desc' },
    include: { injuries: true },
  });
};
