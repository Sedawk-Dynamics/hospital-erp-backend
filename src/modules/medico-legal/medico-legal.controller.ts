import { AuthenticatedRequest } from "../../shared/types"
import { Response,NextFunction } from "express"
import * as medicoLegalService from './medico-legal.service';
import { sendResponse } from "../../shared/apiResponse";

export const addMedical=async(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{
    try {
        const tenantId=req.user!.tenantId as string;
        const userId=req.user!.userId as string;
        const data=await medicoLegalService.medicalAdd(tenantId,userId,req.body);
        sendResponse({ res, statusCode: 201, message: 'Medico-legal record added successfully', data });
    } catch (error) {
        next(error)
    }
}

export const getMedical = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const admissionId = req.query.admissionId as string;
    const data = await medicoLegalService.medicalGet(tenantId, admissionId);
    sendResponse({ res, message: 'Medico-legal records fetched successfully', data });
  } catch (error) {
    next(error);
  }
};
