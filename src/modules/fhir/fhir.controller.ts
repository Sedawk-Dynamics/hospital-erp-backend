import { Request,Response,NextFunction } from "express";
import { detailsPatient,patientConditionDetails,patientObservationsDetails,patientDiagnosisReport,fhirDataMeta,practitionerData,encounterData,organizationData,reportOP} from "./fhir.service";

export const patientDetails=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const patientId=req.params.id as string;
        const results = await detailsPatient(patientId);
        res.json(results );
    } catch (error) {
        next(error)
    }
}

export const patientCondition=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const patientId=req.query.patient as string;
        const results = await patientConditionDetails(patientId);
        res.json(results );
    } catch (error) {
        next(error)
    }
}

export const patientObservations=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const patientId=req.query.patient as string;
        const results = await patientObservationsDetails(patientId);
        res.json(results );
    } catch (error) {
        next(error)
    }
}


export const patientDiagnosticReport=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const patientId=req.query.patient as string;
        const results = await patientDiagnosisReport(patientId);
        res.json( results );
    } catch (error) {
        next(error)
    }
}


export const fhirMetaData=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const results = await fhirDataMeta();
        res.json(results );
    } catch (error) {
        next(error)
    }
}

export const fhirPractitionerData=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const practitionerId=req.params.id as string;
        const results = await practitionerData(practitionerId);
        res.json(results );
    } catch (error) {
        next(error)
    }
}

export const fhirOrganizationData=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const organizationId=req.params.id as string;
        const results = await organizationData(organizationId);
        res.json(results );
    } catch (error) {
        next(error)
    }
}

export const fhirEncounterData=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const encounterId=req.params.id as string;
        const results = await encounterData(encounterId);
        res.json(results );
    } catch (error) {
        next(error)
    }
}

export const fhirOpReport=async(req:Request,res:Response,next:NextFunction)=>{
    try {
        const visitId=req.query.visitId as string;
        const results = await reportOP(visitId);
        res.json(results);
    } catch (error) {
        next(error)
    }
}
