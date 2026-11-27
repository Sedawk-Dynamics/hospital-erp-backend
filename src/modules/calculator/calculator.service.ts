import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { CreateCalculatorInput, UpdateCalculatorInput } from './calculator.validation';
import { AppError } from '../../shared/appError';

export const createCalculator = async (
  tenantId: string,
  userId: string,
  input: CreateCalculatorInput,
) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new AppError('Tenant not found', 404);

  const calculator = await prisma.calculator.create({
    data: {
      ...input,
      tenantId,
      createdById: userId,
      variables: input.variables as Prisma.InputJsonValue,
      bands: input.bands as Prisma.InputJsonValue,
    },
  });

  return calculator;
};



export const fetchCalculators=async(tenantId:string,userId:string,query?:{scope?:string,speciality?:string,search?:string})=>{
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new AppError('Tenant not found', 404);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);

    const calculators = await prisma.calculator.findMany({
      where: {
        tenantId,
        OR: [{ createdById: userId }, { scope: 'shared' }],
      },
      orderBy: { createdAt: 'desc' },
    });
    return calculators;
}

export const updateCalculator=async(tenantId:string,userId:string,id:string,data:UpdateCalculatorInput)=>{
const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new AppError('Tenant not found', 404);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);

    const calculator=await prisma.calculator.findUnique({where:{id}});
    if(!calculator || calculator.tenantId !== tenantId)throw new AppError('calculator not found',404);

    if(calculator.createdById !== userId)throw new AppError('Not allowed to edit this calculator',403);

    const updateCalculator=await prisma.calculator.update({where:{id},
    data:data})

    return updateCalculator;
}