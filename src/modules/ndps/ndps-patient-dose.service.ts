import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { taxResolverFor, type TaxResolver } from '../gst/gst-resolver.service';
import { getControlledDrugSettings } from '../hospital-settings/hospital-settings.service';
import { assertWitnessIdentity } from '../pharmacy/controlled-dispense';
import { postConsumptionCharge } from './ndps.service';

export type ResidualDisposition = 'none' | 'destroyed' | 'quarantined';

export interface PatientDoseInput {
  drugBatchId: string;
  ndpsLocationId: string;
  labelledQuantity: number;
  administeredQuantity: number;
  quantityUnit: string;
  containerQuantity?: number;
  disposition?: ResidualDisposition;
  disposalMethod?: string;
  quarantineLocation?: string;
  witnessedById?: string;
  witnessPassword?: string;
  emergencyUse?: boolean;
  emergencyReason?: string;
  notes?: string;
}

type ScheduleForDose = NonNullable<Awaited<ReturnType<typeof loadDoseSchedule>>>;

export interface PreparedPatientDose {
  schedule: ScheduleForDose;
  input: PatientDoseInput;
  labelledQuantity: Prisma.Decimal;
  administeredQuantity: Prisma.Decimal;
  residualQuantity: Prisma.Decimal;
  disposition: ResidualDisposition;
  status: 'fully_administered' | 'destroyed' | 'quarantined';
  stockSource: 'dispensing_record' | 'ward_stock' | 'drug_batch';
  dispensingRecordId: string | null;
  witnessedAt: Date | null;
  doctorRegNo: string;
  bedNumber: string;
  diagnosis: string;
  resolver: TaxResolver | null;
}

const fourDp = (value: number, label: string) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw AppError.badRequest(`${label} must be greater than zero.`);
  }
  const scaled = Math.round(value * 10_000);
  if (Math.abs(value * 10_000 - scaled) > 0.000001) {
    throw AppError.badRequest(`${label} can have at most four decimal places.`);
  }
  return scaled;
};

export function reconcilePatientDoseQuantities(
  labelledQuantity: number,
  administeredQuantity: number,
  requestedDisposition?: ResidualDisposition,
) {
  const labelledScaled = fourDp(labelledQuantity, 'Labelled quantity');
  const administeredScaled = fourDp(administeredQuantity, 'Administered quantity');
  if (administeredScaled > labelledScaled) {
    throw AppError.badRequest('Administered quantity cannot exceed the labelled quantity.');
  }
  const residualScaled = labelledScaled - administeredScaled;
  const disposition: ResidualDisposition = residualScaled === 0
    ? 'none'
    : requestedDisposition ?? 'quarantined';
  if (residualScaled === 0 && requestedDisposition && requestedDisposition !== 'none') {
    throw AppError.badRequest('A fully administered container has no residual to destroy or quarantine.');
  }
  if (residualScaled > 0 && disposition === 'none') {
    throw AppError.badRequest('Choose immediate witnessed destruction or sealed quarantine for the residual.');
  }
  return {
    labelledQuantity: new Prisma.Decimal((labelledScaled / 10_000).toFixed(4)),
    administeredQuantity: new Prisma.Decimal((administeredScaled / 10_000).toFixed(4)),
    residualQuantity: new Prisma.Decimal((residualScaled / 10_000).toFixed(4)),
    disposition,
    status: (residualScaled === 0
      ? 'fully_administered'
      : disposition === 'destroyed' ? 'destroyed' : 'quarantined') as
      'fully_administered' | 'destroyed' | 'quarantined',
  };
}

function isNdpsDrug(drug: {
  isNarcotic: boolean;
  vaultControlled: boolean;
  controlledClass: string | null;
}) {
  return drug.isNarcotic || drug.vaultControlled || drug.controlledClass?.toLowerCase() === 'narcotic';
}

type DoseDb = typeof prisma | Prisma.TransactionClient;

async function loadDoseSchedule(tenantId: string, scheduleId: string, db: DoseDb = prisma) {
  return db.emarSchedule.findFirst({
    where: { id: scheduleId, tenantId },
    include: {
      prescriptionItem: {
        include: {
          drug: {
            select: {
              id: true,
              drugName: true,
              strength: true,
              price: true,
              taxPercent: true,
              hsnCode: true,
              isNarcotic: true,
              vaultControlled: true,
              controlledClass: true,
            },
          },
        },
      },
      prescription: {
        include: {
          doctor: { select: { id: true, licenseNumber: true } },
          visit: {
            select: {
              diagnoses: {
                orderBy: [{ diagnosisType: 'asc' }, { diagnosedAt: 'desc' }],
                take: 1,
                select: { diagnosisName: true },
              },
            },
          },
        },
      },
      admission: {
        select: {
          id: true,
          wardId: true,
          admissionType: true,
          admissionReason: true,
          bed: { select: { bedNumber: true } },
        },
      },
      ndpsPatientDose: true,
    },
  });
}

export async function getPatientDoseContext(tenantId: string, scheduleId: string) {
  const schedule = await loadDoseSchedule(tenantId, scheduleId);
  if (!schedule) throw AppError.notFound('Schedule row not found');

  const drug = schedule.prescriptionItem.drug;
  if (!drug || !isNdpsDrug(drug)) {
    return { isNdps: false, existingDose: schedule.ndpsPatientDose };
  }

  const [locations, batches, dispensing] = await Promise.all([
    prisma.ndpsLocation.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      include: {
        balances: {
          where: { tenantId, drugFormularyId: drug.id },
          select: { quantity: true },
        },
      },
    }),
    prisma.drugBatch.findMany({
      where: {
        tenantId,
        drugId: drug.id,
        isExpired: false,
        isRecalled: false,
        OR: [
          { quantityInStock: { gt: 0 } },
          ...(schedule.drugBatchId ? [{ id: schedule.drugBatchId }] : []),
        ],
      },
      orderBy: [{ expiryDate: 'asc' }, { batchNumber: 'asc' }],
      select: { id: true, batchNumber: true, expiryDate: true, quantityInStock: true },
    }),
    prisma.dispensingRecord.findFirst({
          where: {
            tenantId,
            patientId: schedule.patientId,
            prescriptionItemId: schedule.prescriptionItemId,
            cancelledAt: null,
            ...(schedule.dispensingRecordId ? { id: schedule.dispensingRecordId } : {}),
          },
          orderBy: { dispensedAt: 'desc' },
          select: { id: true, drugBatchId: true, quantityDispensed: true, billId: true },
        }),
  ]);

  return {
    isNdps: true,
    drug: {
      id: drug.id,
      name: drug.drugName,
      strength: drug.strength,
    },
    linkedBatchId: dispensing?.drugBatchId ?? schedule.drugBatchId,
    dispensingRecordId: dispensing?.id ?? null,
    requiresEmergencyReason: !dispensing,
    clinicalDetails: {
      doctorRegistration: schedule.prescription.doctor.licenseNumber,
      bedNumber: schedule.admission?.bed?.bedNumber ??
        (schedule.admission?.admissionType === 'emergency' ? 'EMERGENCY' : null),
      diagnosis: schedule.prescription.visit.diagnoses[0]?.diagnosisName ??
        schedule.admission?.admissionReason ?? null,
    },
    batches,
    locations: locations.map((location) => ({
      id: location.id,
      name: location.name,
      type: location.type,
      wardId: location.wardId,
      availableContainers: location.balances[0]?.quantity ?? 0,
      preferred: Boolean(schedule.admission?.wardId && location.wardId === schedule.admission.wardId),
    })),
    existingDose: schedule.ndpsPatientDose,
  };
}

export async function getPrescriptionItemDoseContext(tenantId: string, prescriptionItemId: string) {
  const item = await prisma.prescriptionItem.findFirst({
    where: { id: prescriptionItemId, prescription: { tenantId } },
    include: {
      drug: {
        select: {
          id: true, drugName: true, strength: true, isNarcotic: true,
          vaultControlled: true, controlledClass: true,
        },
      },
      prescription: {
        include: {
          doctor: { select: { licenseNumber: true } },
          visit: {
            select: {
              diagnoses: {
                orderBy: [{ diagnosisType: 'asc' }, { diagnosedAt: 'desc' }],
                take: 1,
                select: { diagnosisName: true },
              },
              admission: {
                select: {
                  id: true, wardId: true, admissionType: true, admissionReason: true,
                  bed: { select: { bedNumber: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!item) throw AppError.notFound('Prescription item not found');
  const drug = item.drug;
  if (!drug || !isNdpsDrug(drug)) return { isNdps: false, existingDose: null };

  const admission = item.prescription.visit.admission;
  const [locations, batches, dispensing] = await Promise.all([
    prisma.ndpsLocation.findMany({
      where: { tenantId, isActive: true },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
      include: {
        balances: {
          where: { tenantId, drugFormularyId: drug.id },
          select: { quantity: true },
        },
      },
    }),
    prisma.drugBatch.findMany({
      where: { tenantId, drugId: drug.id, isExpired: false, isRecalled: false, quantityInStock: { gt: 0 } },
      orderBy: [{ expiryDate: 'asc' }, { batchNumber: 'asc' }],
      select: { id: true, batchNumber: true, expiryDate: true, quantityInStock: true },
    }),
    prisma.dispensingRecord.findFirst({
      where: {
        tenantId,
        patientId: item.prescription.patientId,
        prescriptionItemId: item.id,
        cancelledAt: null,
      },
      orderBy: { dispensedAt: 'desc' },
      select: { id: true, drugBatchId: true, quantityDispensed: true, billId: true },
    }),
  ]);

  // A linked batch may have zero current shelf stock because pharmacy already
  // issued it to this patient. Keep it selectable even though the general batch
  // query correctly shows only available stock.
  if (dispensing && !batches.some((batch) => batch.id === dispensing.drugBatchId)) {
    const issuedBatch = await prisma.drugBatch.findFirst({
      where: { id: dispensing.drugBatchId, tenantId, drugId: drug.id },
      select: { id: true, batchNumber: true, expiryDate: true, quantityInStock: true },
    });
    if (issuedBatch) batches.unshift(issuedBatch);
  }

  return {
    isNdps: true,
    drug: { id: drug.id, name: drug.drugName, strength: drug.strength },
    linkedBatchId: dispensing?.drugBatchId ?? null,
    dispensingRecordId: dispensing?.id ?? null,
    requiresEmergencyReason: !dispensing,
    clinicalDetails: {
      doctorRegistration: item.prescription.doctor.licenseNumber,
      bedNumber: admission?.bed?.bedNumber ?? (admission?.admissionType === 'emergency' ? 'EMERGENCY' : null),
      diagnosis: item.prescription.visit.diagnoses[0]?.diagnosisName ?? admission?.admissionReason ?? null,
    },
    batches,
    locations: locations.map((location) => ({
      id: location.id,
      name: location.name,
      type: location.type,
      wardId: location.wardId,
      availableContainers: location.balances[0]?.quantity ?? 0,
      preferred: Boolean(admission?.wardId && location.wardId === admission.wardId),
    })),
    existingDose: null,
  };
}

export async function preparePatientDose(
  tenantId: string,
  userId: string,
  scheduleId: string,
  input: PatientDoseInput | undefined,
  db: DoseDb = prisma,
): Promise<PreparedPatientDose | null> {
  const schedule = await loadDoseSchedule(tenantId, scheduleId, db);
  if (!schedule) throw AppError.notFound('Schedule row not found');
  const drug = schedule.prescriptionItem.drug;
  if (!drug || !isNdpsDrug(drug)) return null;
  if (!input) {
    throw AppError.badRequest(
      'This is an NDPS/controlled narcotic. Record the labelled quantity, administered quantity and residual disposition before confirming the dose.',
    );
  }
  if (schedule.ndpsPatientDose) {
    throw AppError.conflict('This NDPS dose has already been reconciled.');
  }

  const reconciliation = reconcilePatientDoseQuantities(
    input.labelledQuantity,
    input.administeredQuantity,
    input.disposition,
  );
  const { disposition } = reconciliation;

  const containerQuantity = input.containerQuantity ?? 1;
  if (!Number.isInteger(containerQuantity) || containerQuantity <= 0) {
    throw AppError.badRequest('Container quantity must be a positive whole number.');
  }
  if (!input.quantityUnit?.trim() || input.quantityUnit.trim().length > 20) {
    throw AppError.badRequest('A valid content unit (for example mg, mcg or mL) is required.');
  }

  const [batch, location, dispensing, wardStock] = await Promise.all([
    db.drugBatch.findFirst({
      where: { id: input.drugBatchId, tenantId, drugId: drug.id },
      select: {
        id: true,
        batchNumber: true,
        expiryDate: true,
        quantityInStock: true,
        isExpired: true,
        isRecalled: true,
      },
    }),
    db.ndpsLocation.findFirst({
      where: { id: input.ndpsLocationId, tenantId, isActive: true },
      select: { id: true, name: true, wardId: true },
    }),
    db.dispensingRecord.findFirst({
          where: {
            tenantId,
            patientId: schedule.patientId,
            prescriptionItemId: schedule.prescriptionItemId,
            drugBatchId: input.drugBatchId,
            cancelledAt: null,
            ...(schedule.dispensingRecordId ? { id: schedule.dispensingRecordId } : {}),
          },
          orderBy: { dispensedAt: 'desc' },
          select: { id: true, billId: true },
        }),
    schedule.admission?.wardId
      ? db.wardStock.findFirst({
          where: {
            tenantId,
            wardId: schedule.admission.wardId,
            drugId: drug.id,
            drugBatchId: input.drugBatchId,
            quantityInStock: { gte: containerQuantity },
          },
          select: { id: true },
        })
      : null,
  ]);

  if (!batch) throw AppError.badRequest('The selected batch does not belong to this prescribed drug.');
  if (batch.isExpired || batch.expiryDate < new Date()) throw AppError.badRequest('The selected batch has expired.');
  if (batch.isRecalled) throw AppError.badRequest('The selected batch has been recalled and cannot be administered.');
  if (!location) throw AppError.notFound('NDPS custody location not found.');

  let stockSource: PreparedPatientDose['stockSource'];
  if (dispensing) {
    stockSource = 'dispensing_record';
  } else {
    if (!input.emergencyUse || !input.emergencyReason?.trim()) {
      throw AppError.badRequest(
        'No patient-specific pharmacy issue is linked to this dose. Mark it as emergency stock use and enter the clinical reason, or complete pharmacy issue first.',
      );
    }
    stockSource = wardStock ? 'ward_stock' : 'drug_batch';
    if (stockSource === 'drug_batch' && batch.quantityInStock < containerQuantity) {
      throw AppError.badRequest(`Only ${batch.quantityInStock} container(s) remain in the selected batch.`);
    }
  }

  const balance = await db.ndpsStockBalance.findFirst({
    where: { tenantId, drugFormularyId: drug.id, locationId: location.id },
    select: { quantity: true },
  });
  if ((balance?.quantity ?? 0) < containerQuantity) {
    throw AppError.badRequest(
      `Only ${balance?.quantity ?? 0} container(s) are recorded at ${location.name}; ${containerQuantity} required.`,
    );
  }

  let witnessedAt: Date | null = null;
  if (disposition === 'destroyed') {
    if (!input.disposalMethod?.trim()) {
      throw AppError.badRequest('Record the approved residual destruction method.');
    }
    if (!input.witnessedById || input.witnessedById === userId) {
      throw AppError.badRequest('Immediate residual destruction requires a different authorised witness.');
    }
    const settings = await getControlledDrugSettings(tenantId);
    await assertWitnessIdentity(tenantId, input.witnessedById, input.witnessPassword, settings.witnessRoles);
    witnessedAt = new Date();
  }
  if (disposition === 'quarantined' && !input.quarantineLocation?.trim()) {
    throw AppError.badRequest('Record where the sealed residual is quarantined.');
  }

  const doctorRegNo = schedule.prescription.doctor.licenseNumber?.trim();
  if (!doctorRegNo) {
    throw AppError.badRequest("The prescribing doctor's registration number must be completed before recording NDPS administration.");
  }
  const bedNumber = schedule.admission?.bed?.bedNumber?.trim() ||
    (schedule.admission?.admissionType === 'emergency' ? 'EMERGENCY' : 'UNASSIGNED');
  const diagnosis = schedule.prescription.visit.diagnoses[0]?.diagnosisName?.trim() ||
    schedule.admission?.admissionReason?.trim() || input.emergencyReason?.trim();
  if (!diagnosis) {
    throw AppError.badRequest('A diagnosis or clinical justification is required for Form 3E.');
  }

  return {
    schedule,
    input: { ...input, containerQuantity },
    labelledQuantity: reconciliation.labelledQuantity,
    administeredQuantity: reconciliation.administeredQuantity,
    residualQuantity: reconciliation.residualQuantity,
    disposition,
    status: reconciliation.status,
    stockSource,
    dispensingRecordId: dispensing?.id ?? null,
    witnessedAt,
    doctorRegNo,
    bedNumber,
    diagnosis,
    resolver: stockSource === 'dispensing_record' ? null : await taxResolverFor(tenantId),
  };
}

async function consumePhysicalContainer(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  prepared: PreparedPatientDose,
) {
  const { schedule, input, stockSource } = prepared;
  const drug = schedule.prescriptionItem.drug!;
  const containers = input.containerQuantity ?? 1;

  const balance = await tx.ndpsStockBalance.updateMany({
    where: {
      tenantId,
      drugFormularyId: drug.id,
      locationId: input.ndpsLocationId,
      quantity: { gte: containers },
    },
    data: { quantity: { decrement: containers } },
  });
  if (balance.count !== 1) throw AppError.conflict('NDPS location stock changed. Refresh and try again.');

  if (stockSource === 'ward_stock') {
    const ward = await tx.wardStock.updateMany({
      where: {
        tenantId,
        wardId: schedule.admission!.wardId!,
        drugBatchId: input.drugBatchId,
        quantityInStock: { gte: containers },
      },
      data: { quantityInStock: { decrement: containers } },
    });
    if (ward.count !== 1) throw AppError.conflict('Ward emergency stock changed. Refresh and try again.');
  } else if (stockSource === 'drug_batch') {
    const batch = await tx.drugBatch.updateMany({
      where: { id: input.drugBatchId, tenantId, quantityInStock: { gte: containers } },
      data: { quantityInStock: { decrement: containers } },
    });
    if (batch.count !== 1) throw AppError.conflict('Batch stock changed. Refresh and try again.');
  }

  return { containers, drug, userId };
}

export async function recordPreparedPatientDose(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
  administeredAt: Date,
  prepared: PreparedPatientDose,
) {
  const duplicate = await tx.ndpsPatientDose.findUnique({
    where: { emarScheduleId: prepared.schedule.id },
    select: { id: true },
  });
  if (duplicate) throw AppError.conflict('This NDPS dose has already been reconciled.');

  const { containers, drug } = await consumePhysicalContainer(tx, tenantId, userId, prepared);
  const patientDoseId = randomUUID();
  const administrationTransactionId = randomUUID();
  const disposalTransactionId = prepared.disposition === 'destroyed' ? randomUUID() : null;
  const batch = await tx.drugBatch.findUnique({
    where: { id: prepared.input.drugBatchId },
    select: { batchNumber: true, expiryDate: true },
  });

  await tx.ndpsTransaction.create({
    data: {
      id: administrationTransactionId,
      tenantId,
      drugFormularyId: drug.id,
      drugBatchId: prepared.input.drugBatchId,
      entryType: 'dispense',
      quantity: containers,
      fromLocationId: prepared.input.ndpsLocationId,
      patientId: prepared.schedule.patientId,
      doctorRegNo: prepared.doctorRegNo,
      bedNumber: prepared.bedNumber,
      diagnosis: prepared.diagnosis,
      patientDoseId,
      emarScheduleId: prepared.schedule.id,
      dispensingRecordId: prepared.dispensingRecordId,
      labelledQuantity: prepared.labelledQuantity,
      administeredQuantity: prepared.administeredQuantity,
      residualQuantity: prepared.residualQuantity,
      quantityUnit: prepared.input.quantityUnit.trim(),
      residualDisposition: prepared.disposition,
      stockSource: prepared.stockSource,
      batchNumber: batch?.batchNumber ?? null,
      expiryDate: batch?.expiryDate ?? null,
      recordedById: userId,
      notes: prepared.input.notes ?? null,
      occurredAt: administeredAt,
    },
  });

  if (disposalTransactionId) {
    await tx.ndpsTransaction.create({
      data: {
        id: disposalTransactionId,
        tenantId,
        drugFormularyId: drug.id,
        drugBatchId: prepared.input.drugBatchId,
        entryType: 'disposal',
        quantity: 0,
        fromLocationId: prepared.input.ndpsLocationId,
        patientId: prepared.schedule.patientId,
        reasonCode: 'patient_residual',
        referenceNumber: `EMAR-${prepared.schedule.id.slice(0, 8).toUpperCase()}`,
        coSignById: prepared.input.witnessedById!,
        patientDoseId,
        emarScheduleId: prepared.schedule.id,
        dispensingRecordId: prepared.dispensingRecordId,
        labelledQuantity: prepared.labelledQuantity,
        administeredQuantity: prepared.administeredQuantity,
        residualQuantity: prepared.residualQuantity,
        quantityUnit: prepared.input.quantityUnit.trim(),
        residualDisposition: 'destroyed',
        stockSource: 'residual_only',
        batchNumber: batch?.batchNumber ?? null,
        expiryDate: batch?.expiryDate ?? null,
        recordedById: userId,
        notes: [prepared.input.disposalMethod, prepared.input.notes].filter(Boolean).join(' — ') || null,
        occurredAt: administeredAt,
      },
    });
  }

  let billing: { billId: string; billNumber: string; charged: number } | null = null;
  if (prepared.resolver) {
    billing = await postConsumptionCharge(
      tx,
      tenantId,
      userId,
      {
        patientId: prepared.schedule.patientId,
        drugName: drug.drugName,
        unitPrice: Number(drug.price ?? 0),
        taxPercent: Number(drug.taxPercent ?? 0),
        hsnCode: drug.hsnCode,
        quantity: containers,
        bedNumber: prepared.bedNumber,
        ndpsTxnId: administrationTransactionId,
      },
      prepared.resolver,
    );
  }

  if (prepared.stockSource === 'ward_stock') {
    await tx.wardStockLedger.create({
      data: {
        tenantId,
        wardId: prepared.schedule.admission!.wardId!,
        drugId: drug.id,
        drugBatchId: prepared.input.drugBatchId,
        movementType: 'dispensed',
        quantity: containers,
        patientId: prepared.schedule.patientId,
        admissionId: prepared.schedule.admissionId,
        billId: billing?.billId ?? null,
        performedBy: userId,
        reason: `Emergency NDPS administration; eMAR ${prepared.schedule.id}`,
      },
    });
  }

  const patientDose = await tx.ndpsPatientDose.create({
    data: {
      id: patientDoseId,
      tenantId,
      emarScheduleId: prepared.schedule.id,
      prescriptionItemId: prepared.schedule.prescriptionItemId,
      patientId: prepared.schedule.patientId,
      admissionId: prepared.schedule.admissionId,
      drugFormularyId: drug.id,
      drugBatchId: prepared.input.drugBatchId,
      dispensingRecordId: prepared.dispensingRecordId,
      ndpsLocationId: prepared.input.ndpsLocationId,
      administrationTransactionId,
      disposalTransactionId,
      labelledQuantity: prepared.labelledQuantity,
      administeredQuantity: prepared.administeredQuantity,
      residualQuantity: prepared.residualQuantity,
      quantityUnit: prepared.input.quantityUnit.trim(),
      containerQuantity: containers,
      status: prepared.status,
      disposition: prepared.disposition,
      stockSource: prepared.stockSource,
      emergencyUse: Boolean(prepared.input.emergencyUse),
      emergencyReason: prepared.input.emergencyReason?.trim() || null,
      administeredById: userId,
      administeredAt,
      witnessedById: prepared.input.witnessedById ?? null,
      witnessedAt: prepared.witnessedAt,
      disposalMethod: prepared.input.disposalMethod?.trim() || null,
      quarantineLocation: prepared.input.quarantineLocation?.trim() || null,
      quarantinedAt: prepared.disposition === 'quarantined' ? administeredAt : null,
      destroyedAt: prepared.disposition === 'destroyed' ? administeredAt : null,
      billId: billing?.billId ?? null,
      notes: prepared.input.notes ?? null,
    },
  });

  return { patientDose, billing };
}

export function patientDoseAuditMetadata(prepared: PreparedPatientDose | null) {
  if (!prepared) return undefined;
  return {
    ndps: {
      batchId: prepared.input.drugBatchId,
      locationId: prepared.input.ndpsLocationId,
      labelledQuantity: prepared.labelledQuantity.toString(),
      administeredQuantity: prepared.administeredQuantity.toString(),
      residualQuantity: prepared.residualQuantity.toString(),
      quantityUnit: prepared.input.quantityUnit,
      disposition: prepared.disposition,
      stockSource: prepared.stockSource,
      emergencyUse: Boolean(prepared.input.emergencyUse),
    },
  };
}

const NDPS_ADMIN_ROLES = new Set(['super_admin', 'admin', 'pharmacy_admin']);

export async function listPatientResiduals(
  tenantId: string,
  query: { status?: 'quarantined' | 'destroyed' | 'fully_administered' | 'all'; patientId?: string; fromDate?: string; toDate?: string },
) {
  const where: Prisma.NdpsPatientDoseWhereInput = { tenantId };
  if (!query.status || query.status === 'quarantined') where.status = 'quarantined';
  else if (query.status !== 'all') where.status = query.status;
  if (query.patientId) where.patientId = query.patientId;
  if (query.fromDate || query.toDate) {
    where.administeredAt = {};
    if (query.fromDate) where.administeredAt.gte = new Date(query.fromDate);
    if (query.toDate) where.administeredAt.lte = new Date(query.toDate);
  }

  const doses = await prisma.ndpsPatientDose.findMany({
    where,
    orderBy: [{ status: 'desc' }, { administeredAt: 'desc' }],
    take: 1000,
    include: {
      schedule: {
        select: {
          id: true,
          status: true,
          dosage: true,
          patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
        },
      },
    },
  });
  const drugIds = [...new Set(doses.map((dose) => dose.drugFormularyId))];
  const batchIds = [...new Set(doses.map((dose) => dose.drugBatchId))];
  const locationIds = [...new Set(doses.map((dose) => dose.ndpsLocationId))];
  const userIds = [...new Set(doses.flatMap((dose) => [dose.administeredById, dose.witnessedById].filter(Boolean)))] as string[];
  const [drugs, batches, locations, users] = await Promise.all([
    prisma.drugFormulary.findMany({
      where: { tenantId, id: { in: drugIds } },
      select: { id: true, drugName: true, strength: true },
    }),
    prisma.drugBatch.findMany({
      where: { tenantId, id: { in: batchIds } },
      select: { id: true, batchNumber: true, expiryDate: true },
    }),
    prisma.ndpsLocation.findMany({
      where: { tenantId, id: { in: locationIds } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { tenantId, id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]));
  const drugById = byId(drugs);
  const batchById = byId(batches);
  const locationById = byId(locations);
  const userById = byId(users);
  const userName = (id: string | null) => {
    const user = id ? userById.get(id) : null;
    return user ? `${user.firstName} ${user.lastName ?? ''}`.trim() : null;
  };

  return {
    items: doses.map((dose) => {
      const drug = drugById.get(dose.drugFormularyId);
      const batch = batchById.get(dose.drugBatchId);
      const patient = dose.schedule.patient;
      return {
        id: dose.id,
        emarScheduleId: dose.emarScheduleId,
        patient: { id: patient.id, mrn: patient.mrn, name: `${patient.firstName} ${patient.lastName ?? ''}`.trim() },
        drug: { id: dose.drugFormularyId, name: drug?.drugName ?? '-', strength: drug?.strength ?? null },
        batch: { id: dose.drugBatchId, number: batch?.batchNumber ?? '-', expiryDate: batch?.expiryDate ?? null },
        location: { id: dose.ndpsLocationId, name: locationById.get(dose.ndpsLocationId)?.name ?? '-' },
        labelledQuantity: dose.labelledQuantity,
        administeredQuantity: dose.administeredQuantity,
        residualQuantity: dose.residualQuantity,
        quantityUnit: dose.quantityUnit,
        containerQuantity: dose.containerQuantity,
        status: dose.status,
        disposition: dose.disposition,
        quarantineLocation: dose.quarantineLocation,
        quarantinedAt: dose.quarantinedAt,
        disposalMethod: dose.disposalMethod,
        destroyedAt: dose.destroyedAt,
        administeredAt: dose.administeredAt,
        administeredBy: userName(dose.administeredById),
        witnessedBy: userName(dose.witnessedById),
        emergencyUse: dose.emergencyUse,
        emergencyReason: dose.emergencyReason,
        notes: dose.notes,
      };
    }),
    total: doses.length,
  };
}

export async function destroyQuarantinedResidual(
  tenantId: string,
  userId: string,
  roles: string[],
  patientDoseId: string,
  data: {
    disposalMethod: string;
    referenceNumber: string;
    witnessedById: string;
    witnessPassword: string;
    attachmentUrl?: string;
    notes?: string;
  },
) {
  if (!roles.some((role) => NDPS_ADMIN_ROLES.has(role))) {
    throw AppError.forbidden('You do not have permission to complete NDPS residual destruction.');
  }
  if (data.witnessedById === userId) {
    throw AppError.badRequest('The witness must be a different person from the person recording destruction.');
  }
  const settings = await getControlledDrugSettings(tenantId);
  await assertWitnessIdentity(tenantId, data.witnessedById, data.witnessPassword, settings.witnessRoles);

  const dose = await prisma.ndpsPatientDose.findFirst({
    where: { id: patientDoseId, tenantId },
    include: { schedule: { select: { id: true, status: true } } },
  });
  if (!dose) throw AppError.notFound('Patient residual record not found.');
  if (dose.status !== 'quarantined' || dose.disposition !== 'quarantined') {
    throw AppError.conflict('Only a pending quarantined residual can be destroyed.');
  }
  if (Number(dose.residualQuantity) <= 0) {
    throw AppError.conflict('This record has no residual quantity to destroy.');
  }

  const destroyedAt = new Date();
  const disposalTransactionId = randomUUID();
  return prisma.$transaction(async (tx) => {
    const changed = await tx.ndpsPatientDose.updateMany({
      where: { id: patientDoseId, tenantId, status: 'quarantined', disposalTransactionId: null },
      data: {
        status: 'destroyed',
        disposition: 'destroyed',
        disposalTransactionId,
        disposalMethod: data.disposalMethod.trim(),
        witnessedById: data.witnessedById,
        witnessedAt: destroyedAt,
        destroyedAt,
        notes: data.notes ?? dose.notes,
      },
    });
    if (changed.count !== 1) {
      throw AppError.conflict('This residual was already actioned. Refresh the worklist.');
    }

    const batch = await tx.drugBatch.findUnique({
      where: { id: dose.drugBatchId },
      select: { batchNumber: true, expiryDate: true },
    });
    await tx.ndpsTransaction.create({
      data: {
        id: disposalTransactionId,
        tenantId,
        drugFormularyId: dose.drugFormularyId,
        drugBatchId: dose.drugBatchId,
        entryType: 'disposal',
        // The container left available stock when it was opened. Destroying its
        // contents must never subtract a second physical container.
        quantity: 0,
        fromLocationId: dose.ndpsLocationId,
        patientId: dose.patientId,
        reasonCode: 'patient_residual',
        referenceNumber: data.referenceNumber.trim(),
        attachmentUrl: data.attachmentUrl ?? null,
        coSignById: data.witnessedById,
        patientDoseId: dose.id,
        emarScheduleId: dose.emarScheduleId,
        dispensingRecordId: dose.dispensingRecordId,
        labelledQuantity: dose.labelledQuantity,
        administeredQuantity: dose.administeredQuantity,
        residualQuantity: dose.residualQuantity,
        quantityUnit: dose.quantityUnit,
        residualDisposition: 'destroyed',
        stockSource: 'residual_only',
        batchNumber: batch?.batchNumber ?? null,
        expiryDate: batch?.expiryDate ?? null,
        recordedById: userId,
        notes: [data.disposalMethod, data.notes].filter(Boolean).join(' — ') || null,
        occurredAt: destroyedAt,
      },
    });
    await tx.emarAuditLog.create({
      data: {
        tenantId,
        scheduleId: dose.emarScheduleId,
        action: 'status',
        fromStatus: dose.schedule.status,
        toStatus: dose.schedule.status,
        performedById: userId,
        notes: data.notes,
        metadata: {
          ndpsResidualDestruction: {
            patientDoseId: dose.id,
            residualQuantity: dose.residualQuantity.toString(),
            quantityUnit: dose.quantityUnit,
            method: data.disposalMethod,
            referenceNumber: data.referenceNumber,
            witnessedById: data.witnessedById,
          },
        },
      },
    });
    return tx.ndpsPatientDose.findUniqueOrThrow({ where: { id: dose.id } });
  });
}
