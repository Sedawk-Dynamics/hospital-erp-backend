import { prisma } from "../../config/database"
import { AddIntoxicationExamInput } from "./intoxication.validation"
import { AppError } from "../../shared/appError";

const toDate = (v?: string) => (v ? new Date(v) : null);

export const examinationAdd=async(tenantId:string,userId:string,input:AddIntoxicationExamInput)=>{
     const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new AppError('tenant not found', 404);

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new AppError('user not found', 404);

      const intoxicationExamData = await prisma.intoxicationExam.create({
        data: {
          tenantId,
          patientId: input.patientId,
          admissionId: input.admissionId,
          visitId: input.visitId ?? null,
          alcoholSmell: input.alcoholSmell ?? null,
          speech: input.speech ?? null,
          pupilsConjunctiva: input.pupilsConjunctiva ?? null,
          gaitBalance: input.gaitBalance ?? null,
          rombergSign: input.rombergSign ?? null,
          fingerToNose: input.fingerToNose ?? null,
          recordedBac: input.recordedBac ?? null,
          opinion: input.opinion ?? null,
          examinerName: input.examinerName ?? null,
          examinerNmcNo: input.examinerNmcNo ?? null,
          examinedAt: toDate(input.examinedAt),
          witnessName: input.witnessName ?? null,
          witnessBuckleNo: input.witnessBuckleNo ?? null,
          witnessPoliceStation: input.witnessPoliceStation ?? null,
          createdBy: userId,
        },
      });

      return intoxicationExamData;
}


export const examinationFetch=async(tenantId:string,admissionId:string)=>{
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new AppError('tenant not found', 404);
    
      const admission = await prisma.admission.findUnique({ where: { id: admissionId } });
      if (!admission) throw new AppError('admission not found', 404);
    
      return await prisma.intoxicationExam.findMany({
        where: { tenantId, admissionId },
        orderBy: { createdAt: 'desc' },
      });
}

