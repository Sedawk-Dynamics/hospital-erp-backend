import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as patientPortalService from './patient-portal.service';

export const getRegistrationFees=async(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{
  try {
    const tenantId=req.user!.tenantId as string;
    const userId=req.user!.userId as string
    const result=await patientPortalService.registrationFees(tenantId,userId);
    sendResponse({res,message:"Bill Id generated for the registration fees",data:result})
  } catch (error) {
    next(error)
  }
}