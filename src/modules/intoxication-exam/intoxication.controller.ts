import { AuthenticatedRequest } from "../../shared/types";
import { Response,NextFunction } from "express";
import { sendResponse } from "../../shared/apiResponse";
import * as intoxicationExamService from './intoxication.service';

export const addExamination=async(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{
    try {
        const tenantId=req.user!.tenantId as string;
        const userId=req.user!.userId as string;
        const data=await intoxicationExamService.examinationAdd(tenantId,userId,req.body);
        sendResponse({ res, statusCode: 201, message: 'Intoxication Exam record added successfully', data });
    } catch (error) {
        next(error);
    }
}


export const fetchExaminations=async(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{
    try {
        const admissionId=req.query.admissionId as string;
        const tenantId=req.user!.tenantId as string;
        const data=await intoxicationExamService.examinationFetch(tenantId,admissionId);
        sendResponse({res,statusCode:200,message:"Intoxication Exam record fetched successfully",data})
    } catch (error) {
        next(error);
    }
}


