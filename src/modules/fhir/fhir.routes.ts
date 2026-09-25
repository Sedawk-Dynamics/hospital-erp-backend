import express from "express";
import { patientDetails,patientCondition,patientObservations,patientDiagnosticReport,fhirMetaData } from "./fhir.controller";

export const fhirRoutes = express.Router();

fhirRoutes.get('/Patient/:id',patientDetails);
fhirRoutes.get('/Condition',patientCondition);
fhirRoutes.get('/Observation',patientObservations);
fhirRoutes.get('/DiagnosticReport',patientDiagnosticReport);
fhirRoutes.get('/metadata',fhirMetaData);
