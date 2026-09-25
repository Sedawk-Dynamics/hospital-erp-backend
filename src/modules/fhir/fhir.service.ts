import { prisma } from "../../config/database";
import { AppError } from "../../shared/appError";
import { VITAL_LOINC_MAP, VITAL_UCUM_MAP } from "../loinc/vital.loinc.map";

export const detailsPatient=async(id:string)=>{
    const patient=await prisma.patient.findUnique({where:{id}});
    if(!patient)throw new AppError("patient not found",404);

    return {
    resourceType: "Patient",
    id: patient.id,
    identifier: [
      { system: "https://trms/mrn", value: patient.mrn },
      ...(patient.abhaNumber ? [{ system: "https://healthid.abdm.gov.in", value: patient.abhaNumber }] : []),
    ],
    name: [{
      text: [patient.firstName, patient.lastName].filter(Boolean).join(" "),
      family: patient.lastName ?? undefined,
      given: [patient.firstName],
    }],
    gender: patient.gender ?? "unknown",
    birthDate: patient.dateOfBirth ? patient.dateOfBirth.toISOString().slice(0, 10) : undefined,
  };
}

export const patientConditionDetails=async(patientId:string)=>{
  const patient=await prisma.patient.findUnique({where:{id:patientId}});
  if(!patient)throw new AppError("patient not found",404);

  const diagnosis=await prisma.diagnosis.findMany({where:{patientId}});
  if(!diagnosis)throw new AppError("diagnosis not found",404);

  return diagnosis.map((diagnosis) => ({
    resourceType: "Condition",
    id: diagnosis.id,
    subject: { reference: `Patient/${patient.id}` },
    code: {
      coding: [
        { system: "http://hl7.org/fhir/sid/icd-10", code: diagnosis.icdCode },
        ...(diagnosis.snomedCode
          ? [{ system: "http://snomed.info/sct", code: diagnosis.snomedCode }]
          : []),
      ],
      text: diagnosis.diagnosisName,
    },
  }));
}

export const patientObservationsDetails = async (patientId: string) => {
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) throw new AppError("patient not found", 404);

  const vitals = await prisma.vital.findMany({
    where: { patientId },
    orderBy: { recordedAt: "desc" },
  });

  const labResults = await prisma.labResult.findMany({
    where: { patientId },
    include: {
      labOrderItem: {
        include: {
          test: { select: { loincCode: true, loincDisplayName: true } },
        },
      },
    },
    orderBy: { enteredAt: "desc" },
  });

  const observations = [];


  for (const r of labResults) {
    if (r.value === null || r.value === undefined) continue;

    const loinc = r.labOrderItem?.test?.loincCode ?? null;
    const numeric = Number(r.value);
    const isNumeric = r.value.trim() !== "" && !Number.isNaN(numeric);

    observations.push({
      resourceType: "Observation",
      id: `lab-${r.id}`,
      status: r.verifiedAt ? "final" : "preliminary",
      category: [{
        coding: [{
          system: "http://terminology.hl7.org/CodeSystem/observation-category",
          code: "laboratory",
        }],
      }],
      code: {
        coding: loinc ? [{ system: "http://loinc.org", code: loinc }] : [],
        text: r.parameterName,
      },
      subject: { reference: `Patient/${patient.id}` },
      effectiveDateTime: r.enteredAt.toISOString(),
      ...(isNumeric
        ? { valueQuantity: { value: numeric, unit: r.unit ?? undefined } }
        : { valueString: r.value }),
      ...(r.normalRange ? { referenceRange: [{ text: r.normalRange }] } : {}),
      ...(r.isAbnormal
        ? {
            interpretation: [{
              coding: [{
                system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                code: "A",
                display: "Abnormal",
              }],
            }],
          }
        : {}),
    });
  }

  for (const row of vitals) {
    for (const key of Object.keys(VITAL_LOINC_MAP) as (keyof typeof VITAL_LOINC_MAP)[]) {
      const raw = row[key];
      if (raw === null || raw === undefined) continue;

      observations.push({
        resourceType: "Observation",
        id: `${row.id}-${key}`,
        status: "final",
        code: {
          coding: [{ system: "http://loinc.org", code: VITAL_LOINC_MAP[key] }],
        },
        subject: { reference: `Patient/${patient.id}` },
        effectiveDateTime: row.recordedAt.toISOString(),
        valueQuantity: {
          value: Number(raw),
          unit: VITAL_UCUM_MAP[key],
          system: "http://unitsofmeasure.org",
          code: VITAL_UCUM_MAP[key],
        },
      });
    }
  }

  return observations;
};


export const patientDiagnosisReport = async (patientId: string) => {
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) throw new AppError("patient not found", 404);


  const items = await prisma.labOrderItem.findMany({
    where: { labOrder: { patientId } },
    include: {
      test: { select: { testName: true, loincCode: true } },
      labResults: { select: { id: true, verifiedAt: true, enteredAt: true } },
      labOrder: { select: { createdAt: true } },
    },
    orderBy: { labOrder: { createdAt: "desc" } },
  });

  return items.map((item) => {
    const results = item.labResults;
    const status =
      results.length === 0
        ? "registered"
        : results.every((r) => r.verifiedAt)
          ? "final"
          : "preliminary";

    const effective =
      results.reduce<Date | null>(
        (max, r) => (!max || r.enteredAt > max ? r.enteredAt : max),
        null,
      ) ?? item.labOrder.createdAt;

    return {
      resourceType: "DiagnosticReport",
      id: item.id,
      status,
      category: [{
        coding: [{
          system: "http://terminology.hl7.org/CodeSystem/v2-0074",
          code: "LAB",
        }],
      }],
      code: {
        coding: item.test.loincCode
          ? [{ system: "http://loinc.org", code: item.test.loincCode }]
          : [],
        text: item.test.testName,
      },
      subject: { reference: `Patient/${patient.id}` },
      effectiveDateTime: effective.toISOString(),
      result: results.map((r) => ({ reference: `Observation/lab-${r.id}` })),
    };
  });
};


export const fhirDataMeta=()=>{
  return {
  "resourceType": "CapabilityStatement",
  "status": "active",
  "fhirVersion": "4.0.1",
  "format": ["json"],
  "rest": [{
    "mode": "server",
    "resource": [
      { "type": "Patient",          "interaction": [{ "code": "read" }] },
      { "type": "Condition",        "interaction": [{ "code": "search-type" }] },
      { "type": "Observation",      "interaction": [{ "code": "search-type" }] },
      { "type": "DiagnosticReport", "interaction": [{ "code": "search-type" }] }
    ]
  }]
}
}