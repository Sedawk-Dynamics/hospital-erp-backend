import { sendResponse } from '../../shared/apiResponse';
import { AuthenticatedRequest } from '../../shared/types';
import { Response,NextFunction } from "express"
import * as fastTrackService from './fast-track.service';

export const addCodes=async(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{
    try {
        const tenantId=req.user!.tenantId as string;
        const userId=req.user!.userId as string;  
        const data=await fastTrackService.codesAdd(tenantId,userId,req.body);
        sendResponse({
              res,
              message: 'Fast Track code added successfully',
              data
            });
        return 
    } catch (error) {
        next(error)
    }
}


export const getCodes=async(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{
    try {
        const tenantId=req.user!.tenantId as string;
        const admissionId=req.query.admissionId as string;
        const data=await fastTrackService.codesFetch(tenantId,admissionId);
        sendResponse({ res, message: 'Fast Track codes fetched successfully', data });
    } catch (error) {
        next(error)
    }
}