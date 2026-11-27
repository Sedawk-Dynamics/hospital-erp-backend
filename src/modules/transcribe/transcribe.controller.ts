import { Response, NextFunction } from "express";
import { AppError } from "../../shared/appError";
import { AuthenticatedRequest } from "../../shared/types";
import * as transcribeService from './transcribe.service';
import { sendResponse } from "../../shared/apiResponse";

export const transcribe=async(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{
    try {
        if(!req.file)throw new AppError('No audio file uploaded',400);
        if(!req.user?.tenantId)throw new AppError('Unauthenticated',401);
        const result=await transcribeService.transcribeUpload(req.file, req.user.tenantId as string);
        sendResponse({ res, data: result, message: 'Transcribed' });
    } catch (error) {
        next(error)
    }
}

















































































































