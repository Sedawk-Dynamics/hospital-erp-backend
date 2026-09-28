import express from "express";
import { patientDetails,patientCondition,patientObservations,patientDiagnosticReport,fhirMetaData,fhirPractitionerData,fhirOrganizationData,fhirEncounterData } from "./fhir.controller";

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

