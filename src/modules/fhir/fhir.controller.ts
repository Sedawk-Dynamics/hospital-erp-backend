import { Request,Response,NextFunction } from "express";
import { detailsPatient,patientConditionDetails,patientObservationsDetails,patientDiagnosisReport,fhirDataMeta} from "./fhir.service";

export const patientDetails=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const patientId=req.params.id as string;
        const results = await detailsPatient(patientId);
        res.json({ data: results });
    } catch (error) {
        next(error)
    }
}

export const patientCondition=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const patientId=req.query.patient as string;
        const results = await patientConditionDetails(patientId);
        res.json({ data: results });
    } catch (error) {
        next(error)
    }
}

export const patientObservations=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const patientId=req.query.patient as string;
        const results = await patientObservationsDetails(patientId);
        res.json({ data: results });
    } catch (error) {
        next(error)
    }
}


export const patientDiagnosticReport=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const patientId=req.query.patient as string;
        const results = await patientDiagnosisReport(patientId);
        res.json({ data: results });
    } catch (error) {
        next(error)
    }
}


export const fhirMetaData=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const results = await fhirDataMeta();
        res.json({ data: results });
    } catch (error) {
        next(error)
    }
}