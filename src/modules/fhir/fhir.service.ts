import { prisma } from "../../config/database";
import { AppError } from "../../shared/appError";
import { approveRefund } from "../billing/billing.service";
import { VITAL_LOINC_MAP, VITAL_UCUM_MAP } from "../loinc/vital.loinc.map";
import { buildBundle } from "./fhir.util";

export const detailsPatient=async(id:string)=>{
    const patient=await prisma.patient.findUnique({where:{id}});
    if(!patient)throw new AppError("patient not found",404);

    return {
    resourceType: "Patient",
    id: patient.id,
    identifier: [
      { system: "https://cenaps/mrn", value: patient.mrn },
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

  return buildBundle(diagnosis.map((diagnosis) => ({
    resourceType: "Condition",
    id: diagnosis.id,
    subject: { reference: `Patient/${patient.id}` },
    encounter: { reference: `Encounter/${diagnosis.visitId}` },
    ...(diagnosis.diagnosedBy
      ? { recorder: { reference: `Practitioner/${diagnosis.diagnosedBy}` } }
      : {}),
    code: {
      coding: [
        { system: "http://hl7.org/fhir/sid/icd-10", code: diagnosis.icdCode },
        ...(diagnosis.snomedCode
          ? [{ system: "http://snomed.info/sct", code: diagnosis.snomedCode }]
          : []),
      ],
      text: diagnosis.diagnosisName,
    },
  })));
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
          test: { select: { loincCode: true, loincDisplayName: true,parameters:true } },
        },
      },
      labOrder: { select: { visitId: true } },
    },
    orderBy: { enteredAt: "desc" },
  });

  const units = await prisma.labUnit.findMany({ select: { symbol: true, ucumCode: true } });
  const ucumBySymbol = new Map(units.map((u) => [u.symbol, u.ucumCode]));
  const observations = [];


  for (const r of labResults) {
    if (r.value === null || r.value === undefined) continue;

    const params = (r.labOrderItem?.test?.parameters as
      | { name?: string; loincCode?: string | null; loincDisplayName?: string | null }[]
      | null) ?? [];
    const param = params.find(
      (p) => p?.name?.trim().toLowerCase() === r.parameterName.trim().toLowerCase(),
    );
    const loinc = param?.loincCode ?? r.labOrderItem?.test?.loincCode ?? null;
    const loincDisplay = param?.loincCode
      ? param?.loincDisplayName ?? null
      : r.labOrderItem?.test?.loincDisplayName ?? null;

    const ucum = r.unit ? ucumBySymbol.get(r.unit) ?? null : null;
    const numeric = Number(r.value);
    const isNumeric = r.value.trim() !== "" && !Number.isNaN(numeric);

    observations.push({
      resourceType: "Observation",
      id: `lab-${r.id}`,
      status: r.verifiedAt ? "final" : "preliminary",
      ...(r.labOrder?.visitId
        ? { encounter: { reference: `Encounter/${r.labOrder.visitId}` } }
        : {}),
      category: [{
        coding: [{
          system: "http://terminology.hl7.org/CodeSystem/observation-category",
          code: "laboratory",
        }],
      }],
      code: {
        coding: loinc
          ? [{
              system: "http://loinc.org",
              code: loinc,
              ...(loincDisplay ? { display: loincDisplay } : {}),
            }]
          : [],
        text: r.parameterName,
      },
      subject: { reference: `Patient/${patient.id}` },
      effectiveDateTime: r.enteredAt.toISOString(),
      ...(isNumeric
        ? {
            valueQuantity: {
              value: numeric,
              unit: r.unit ?? undefined,
              ...(ucum
                ? { system: "http://unitsofmeasure.org", code: ucum }
                : {}),
            },
          }
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
        ...(row.visitId
          ? { encounter: { reference: `Encounter/${row.visitId}` } }
          : {}),
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

  return buildBundle(observations);
};


export const patientDiagnosisReport = async (patientId: string) => {
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient) throw new AppError("patient not found", 404);


  const items = await prisma.labOrderItem.findMany({
    where: { labOrder: { patientId } },
    include: {
      test: { select: { testName: true, loincCode: true } },
      labResults: { select: { id: true, verifiedAt: true, enteredAt: true } },
      labOrder: { select: { createdAt: true, visitId: true, tenantId: true } },
    },
    orderBy: { labOrder: { createdAt: "desc" } },
  });

  return buildBundle(items.map((item) => {
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
      ...(item.labOrder.visitId
        ? { encounter: { reference: `Encounter/${item.labOrder.visitId}` } }
        : {}),
      ...(item.labOrder.tenantId
        ? { performer: [{ reference: `Organization/${item.labOrder.tenantId}` }] }
        : {}),
      effectiveDateTime: effective.toISOString(),
      result: results.map((r) => ({ reference: `Observation/lab-${r.id}` })),
    };
  }));
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


export const practitionerData=async(practitionerId:string)=>{
  const user=await prisma.user.findUnique({where:{id:practitionerId},
  include:{doctorProfile:true}});

  if(!user)throw new AppError("practitioner not found",404);

  const { doctorProfile } = user;
  const firstName = user.firstName ?? "";
  const lastName = user.lastName ?? "";

  return {
    resourceType: "Practitioner",
    id: user.id,
    identifier: [
      user.hprId
        ? { system: "https://hpr.abdm.gov.in", value: user.hprId }
        : { system: "https://cenaps/license", value: doctorProfile?.licenseNumber },
    ],
    name: [
      {
        text: user.firstName + " " + user.lastName,
        family: user.lastName,
        given: [user.firstName],
        prefix: ["Dr"]
      }
    ],
    telecom: [
      { system: "phone", value: user.phone },
      { system: "email", value: user.email }
    ],
    qualification: [
      { code: { text: doctorProfile?.qualifications } }  // e.g. "MBBS, MD"
    ]
  };
}

export const organizationData=async(organizationId:string)=>{
  const tenant=await prisma.tenant.findUnique({where
    :{id:organizationId}
  })

  if(!tenant)throw new AppError("organization not found",404)

  return {
  resourceType: "Organization",
  id: tenant.id,
  // Prefer the ABDM HFR ID; fall back to the internal license number.
  identifier: [
    tenant.hfrId
      ? { system: "https://facility.abdm.gov.in", value: tenant.hfrId }
      : { system: "https://cenaps/license", value: tenant.licenseNumber },
  ],
  name: tenant.name,
  telecom: [
    { system: "phone", value: tenant.phone },
    { system: "email", value: tenant.email },
    { system: "url",   value: tenant.website }
  ],
  address: [
    {
      text: tenant.address,
      city: tenant.city,
      state: tenant.state,
      country: tenant.country
    }
  ]
}
}

export const encounterData = async (encounterId: string) => {
  const visit = await prisma.visit.findUnique({
    where: { id: encounterId },
    include: { doctor: { select: { userId: true } } },
  });
  if (!visit) throw new AppError("encounter not found", 404);

  const cls = visit.visitType === "ip"
    ? { code: "IMP", display: "inpatient encounter" }
    : { code: "AMB", display: "ambulatory" };

  // status → FHIR encounter status
  const statusMap: Record<string, string> = {
    active: "in-progress",
    completed: "finished",
    discharged: "finished",
    transferred: "in-progress",
  };

  return {
    resourceType: "Encounter",
    id: visit.id,
    status: statusMap[visit.status] ?? "unknown",
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: cls.code,
      display: cls.display,
    },
    subject: { reference: `Patient/${visit.patientId}` },
    participant: visit.doctor?.userId
      ? [{ individual: { reference: `Practitioner/${visit.doctor.userId}` } }]
      : [],
    period: { start: visit.visitDate.toISOString() },
    reasonCode: visit.chiefComplaint ? [{ text: visit.chiefComplaint }] : [],
    serviceProvider: { reference: `Organization/${visit.tenantId}` },
  };
};



