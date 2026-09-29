import express from "express";
import { patientDetails,fhirDiagnosticReport,patientCondition,patientObservations,patientDiagnosticReport,fhirMetaData,fhirPractitionerData,fhirPrescriptionReport,fhirOrganizationData,fhirEncounterData,fhirOpReport,fhirIpReport} from "./fhir.controller";

export const fhirRoutes = express.Router();


// --- Patient and Conditions --- //
fhirRoutes.get('/Patient/:id',patientDetails);
fhirRoutes.get('/Condition',patientCondition);
fhirRoutes.get('/Observation',patientObservations);
fhirRoutes.get('/DiagnosticReport',patientDiagnosticReport);
fhirRoutes.get('/metadata', fhirMetaData);

// --- Practioner , Organization and Encounter --- //
fhirRoutes.get('/Practitioner/:id',fhirPractitionerData);
fhirRoutes.get('/Organization/:id',fhirOrganizationData);
fhirRoutes.get('/Encounter/:id',fhirEncounterData);

// --- final documents to be shared OP --- // 
fhirRoutes.get('/Composition/op-consultation',fhirOpReport);
// --- final documents to be shared IP --- // 
fhirRoutes.get('/Composition/ip-consultation',fhirIpReport);

// --- PRESCRIPTION, DIAGNOSTIC REPORT DATA --- //
fhirRoutes.get('/Composition/prescription',fhirPrescriptionReport);
fhirRoutes.get('/Composition/diagnostic-report',fhirDiagnosticReport);
