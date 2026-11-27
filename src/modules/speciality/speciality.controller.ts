import { AuthenticatedRequest } from "../../shared/types";
import { NextFunction,Response } from "express";
import * as specialityService from './speciality.service';
import { sendResponse } from "../../shared/apiResponse";

export const addSpecialityData=async(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{
    try {
        const visitId=req.params.visitId as string;
        const tenantId=req.user!.tenantId as string;
        const data=await specialityService.specialityDataAdd(visitId,tenantId,req.body);
        sendResponse({res,message:"Speciality Data added successfully",data});
    } catch (error) {
        next(error)
    }
}

export const getSpecialityData=async(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{
    try {
        const visitId=req.params.visitId as string;
        const tenantId=req.user?.tenantId as string;
        const data=await specialityService.specialityDataFetch(visitId,tenantId);
        sendResponse({res,message:"Speciality Data fetched successfully",data});
    } catch (error) {
        next(error)
    }
}


