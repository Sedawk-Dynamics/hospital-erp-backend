import { prisma } from '../../config/database';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import type {
  RegisterDonorInput,
  UpdateDonorInput,
  ListDonorsQuery,
  RecordDonationInput,
  UpdateDonationInput,
  ListDonationsQuery,
  ScreenDonationInput,
  ListInventoryQuery,
  AddBloodUnitInput,
  UpdateBloodUnitInput,
  DiscardBloodUnitInput,
  RequestCrossMatchInput,
  ListCrossMatchesQuery,
  CompleteCrossMatchInput,
  RequestTransfusionInput,
  ListTransfusionsQuery,
  CompleteTransfusionInput,
  ReportReactionInput,
} from './blood-bank.validation';

// ============================================================
// DONORS
// ============================================================

export async function registerDonor(tenantId: string, data: RegisterDonorInput) {
  const donor = await prisma.bloodDonor.create({
    data: {
      tenantId,
      firstName: data.firstName,
      lastName: data.lastName,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
      gender: data.gender as any,
      bloodGroup: data.bloodGroup,
      phone: data.phone,
      email: data.email || undefined,
      address: data.address,
      healthStatus: data.healthStatus,
      isEligible: data.isEligible ?? true,
    },
  });
  return donor;
}

export async function getDonors(tenantId: string, query: ListDonorsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.search) {
    const search = query.search.trim();
    where.OR = [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  if (query.bloodGroup) {
    where.bloodGroup = query.bloodGroup;
  }

  if (query.isEligible !== undefined) {
    where.isEligible = query.isEligible;
  }

  const orderBy: any = {};
  if (query.sortBy) {
    orderBy[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [donors, total] = await Promise.all([
    prisma.bloodDonor.findMany({ where, skip, take, orderBy }),
    prisma.bloodDonor.count({ where }),
  ]);

  return { donors, total, page, limit };
}

export async function getDonorById(tenantId: string, id: string) {
  const donor = await prisma.bloodDonor.findFirst({
    where: { id, tenantId },
    include: {
      bloodDonations: { orderBy: { donationDate: 'desc' }, take: 20 },
    },
  });

  if (!donor) {
    throw AppError.notFound('Blood donor not found');
  }

  return donor;
}

export async function updateDonor(tenantId: string, id: string, data: UpdateDonorInput) {
  const existing = await prisma.bloodDonor.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Blood donor not found');
  }

  const updateData: any = {};
  if (data.firstName !== undefined) updateData.firstName = data.firstName;
  if (data.lastName !== undefined) updateData.lastName = data.lastName;
  if (data.dateOfBirth !== undefined)
    updateData.dateOfBirth = data.dateOfBirth ? new Date(data.dateOfBirth) : null;
  if (data.gender !== undefined) updateData.gender = data.gender;
  if (data.bloodGroup !== undefined) updateData.bloodGroup = data.bloodGroup;
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.email !== undefined) updateData.email = data.email || null;
  if (data.address !== undefined) updateData.address = data.address;
  if (data.healthStatus !== undefined) updateData.healthStatus = data.healthStatus;
  if (data.isEligible !== undefined) updateData.isEligible = data.isEligible;

  const donor = await prisma.bloodDonor.update({
    where: { id },
    data: updateData,
  });

  return donor;
}

export async function getDonorHistory(tenantId: string, donorId: string) {
  const donor = await prisma.bloodDonor.findFirst({
    where: { id: donorId, tenantId },
  });

  if (!donor) {
    throw AppError.notFound('Blood donor not found');
  }

  const donations = await prisma.bloodDonation.findMany({
    where: { donorId, tenantId },
    orderBy: { donationDate: 'desc' },
  });

  return { donor, donations };
}

// ============================================================
// DONATIONS
// ============================================================

export async function recordDonation(tenantId: string, data: RecordDonationInput) {
  // Verify donor exists and belongs to tenant
  const donor = await prisma.bloodDonor.findFirst({
    where: { id: data.donorId, tenantId },
  });

  if (!donor) {
    throw AppError.notFound('Blood donor not found');
  }

  if (!donor.isEligible) {
    throw AppError.badRequest('Donor is currently not eligible for donation');
  }

  // Check for duplicate bag number
  if (data.bagNumber) {
    const existingBag = await prisma.bloodDonation.findUnique({
      where: { bagNumber: data.bagNumber },
    });
    if (existingBag) {
      throw AppError.conflict('A donation with this bag number already exists');
    }
  }

  const donation = await prisma.bloodDonation.create({
    data: {
      tenantId,
      donorId: data.donorId,
      donationDate: new Date(data.donationDate),
      donationType: data.donationType as any,
      volumeMl: data.volumeMl,
      bagNumber: data.bagNumber,
      notes: data.notes,
      collectedBy: data.collectedBy,
    },
  });

  // Update donor's last donation date
  await prisma.bloodDonor.update({
    where: { id: data.donorId },
    data: { lastDonationDate: new Date(data.donationDate) },
  });

  return donation;
}

export async function getDonations(tenantId: string, query: ListDonationsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.donorId) {
    where.donorId = query.donorId;
  }

  if (query.screeningResult) {
    where.screeningResult = query.screeningResult;
  }

  if (query.fromDate) {
    where.donationDate = { ...where.donationDate, gte: new Date(query.fromDate) };
  }

  if (query.toDate) {
    where.donationDate = { ...where.donationDate, lte: new Date(query.toDate) };
  }

  const orderBy: any = {};
  if (query.sortBy) {
    orderBy[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.donationDate = 'desc';
  }

  const [donations, total] = await Promise.all([
    prisma.bloodDonation.findMany({
      where,
      skip,
      take,
      orderBy,
      include: { donor: { select: { id: true, firstName: true, lastName: true, bloodGroup: true } } },
    }),
    prisma.bloodDonation.count({ where }),
  ]);

  return { donations, total, page, limit };
}

export async function getDonationById(tenantId: string, id: string) {
  const donation = await prisma.bloodDonation.findFirst({
    where: { id, tenantId },
    include: {
      donor: true,
      bloodInventory: true,
    },
  });

  if (!donation) {
    throw AppError.notFound('Blood donation not found');
  }

  return donation;
}

export async function updateDonation(tenantId: string, id: string, data: UpdateDonationInput) {
  const existing = await prisma.bloodDonation.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Blood donation not found');
  }

  const updateData: any = {};
  if (data.donationDate !== undefined) updateData.donationDate = new Date(data.donationDate);
  if (data.donationType !== undefined) updateData.donationType = data.donationType;
  if (data.volumeMl !== undefined) updateData.volumeMl = data.volumeMl;
  if (data.bagNumber !== undefined) updateData.bagNumber = data.bagNumber;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const donation = await prisma.bloodDonation.update({
    where: { id },
    data: updateData,
  });

  return donation;
}

export async function screenDonation(
  tenantId: string,
  id: string,
  userId: string,
  data: ScreenDonationInput,
) {
  const existing = await prisma.bloodDonation.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Blood donation not found');
  }

  if (existing.screeningResult !== 'pending') {
    throw AppError.badRequest('Donation has already been screened');
  }

  const donation = await prisma.bloodDonation.update({
    where: { id },
    data: {
      screeningResult: data.screeningResult as any,
      notes: data.notes ?? existing.notes,
      collectedBy: userId,
    },
  });

  return donation;
}

// ============================================================
// BLOOD INVENTORY
// ============================================================

export async function getBloodInventory(tenantId: string, query: ListInventoryQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.bloodGroup) {
    where.bloodGroup = query.bloodGroup;
  }

  if (query.componentType) {
    where.componentType = query.componentType;
  }

  if (query.status) {
    where.status = query.status;
  }

  if (query.storageLocation) {
    where.storageLocation = { contains: query.storageLocation, mode: 'insensitive' };
  }

  const orderBy: any = {};
  if (query.sortBy) {
    orderBy[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [items, total] = await Promise.all([
    prisma.bloodInventory.findMany({ where, skip, take, orderBy }),
    prisma.bloodInventory.count({ where }),
  ]);

  return { items, total, page, limit };
}

export async function getBloodInventoryByGroup(tenantId: string) {
  const inventory = await prisma.bloodInventory.groupBy({
    by: ['bloodGroup', 'componentType', 'status'],
    where: { tenantId },
    _count: { id: true },
    _sum: { volumeMl: true },
  });

  return inventory;
}

export async function addBloodUnit(tenantId: string, data: AddBloodUnitInput) {
  // Check for duplicate bag number
  if (data.bagNumber) {
    const existingBag = await prisma.bloodInventory.findUnique({
      where: { bagNumber: data.bagNumber },
    });
    if (existingBag) {
      throw AppError.conflict('A blood unit with this bag number already exists');
    }
  }

  // Verify donation exists if provided
  if (data.donationId) {
    const donation = await prisma.bloodDonation.findFirst({
      where: { id: data.donationId, tenantId },
    });
    if (!donation) {
      throw AppError.notFound('Blood donation not found');
    }
  }

  const unit = await prisma.bloodInventory.create({
    data: {
      tenantId,
      donationId: data.donationId,
      componentType: data.componentType as any,
      bloodGroup: data.bloodGroup,
      bagNumber: data.bagNumber,
      volumeMl: data.volumeMl,
      collectionDate: new Date(data.collectionDate),
      expiryDate: new Date(data.expiryDate),
      storageLocation: data.storageLocation,
    },
  });

  return unit;
}

export async function updateBloodUnit(tenantId: string, id: string, data: UpdateBloodUnitInput) {
  const existing = await prisma.bloodInventory.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Blood unit not found');
  }

  const updateData: any = {};
  if (data.componentType !== undefined) updateData.componentType = data.componentType;
  if (data.bloodGroup !== undefined) updateData.bloodGroup = data.bloodGroup;
  if (data.volumeMl !== undefined) updateData.volumeMl = data.volumeMl;
  if (data.expiryDate !== undefined) updateData.expiryDate = new Date(data.expiryDate);
  if (data.status !== undefined) updateData.status = data.status;
  if (data.storageLocation !== undefined) updateData.storageLocation = data.storageLocation;

  const unit = await prisma.bloodInventory.update({
    where: { id },
    data: updateData,
  });

  return unit;
}

export async function discardBloodUnit(tenantId: string, id: string, _data: DiscardBloodUnitInput) {
  const existing = await prisma.bloodInventory.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Blood unit not found');
  }

  if (existing.status === 'discarded') {
    throw AppError.badRequest('Blood unit is already discarded');
  }

  if (existing.status === 'issued') {
    throw AppError.badRequest('Cannot discard a blood unit that has been issued');
  }

  const unit = await prisma.bloodInventory.update({
    where: { id },
    data: { status: 'discarded' },
  });

  return unit;
}

export async function getExpiringUnits(tenantId: string, days: number) {
  const now = new Date();
  const expiryThreshold = new Date();
  expiryThreshold.setDate(now.getDate() + days);

  const units = await prisma.bloodInventory.findMany({
    where: {
      tenantId,
      status: 'available',
      expiryDate: {
        gte: now,
        lte: expiryThreshold,
      },
    },
    orderBy: { expiryDate: 'asc' },
  });

  return units;
}

// ============================================================
// CROSS-MATCH
// ============================================================

export async function requestCrossMatch(tenantId: string, data: RequestCrossMatchInput) {
  // Verify patient exists
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify blood inventory unit exists and is available
  const unit = await prisma.bloodInventory.findFirst({
    where: { id: data.bloodInventoryId, tenantId },
  });
  if (!unit) {
    throw AppError.notFound('Blood inventory unit not found');
  }
  if (unit.status !== 'available' && unit.status !== 'reserved') {
    throw AppError.badRequest('Blood unit is not available for cross-matching');
  }

  const crossMatch = await prisma.crossMatchTest.create({
    data: {
      tenantId,
      patientId: data.patientId,
      bloodInventoryId: data.bloodInventoryId,
      notes: data.notes,
    },
  });

  // Reserve the unit
  await prisma.bloodInventory.update({
    where: { id: data.bloodInventoryId },
    data: { status: 'reserved' },
  });

  return crossMatch;
}

export async function getCrossMatches(tenantId: string, query: ListCrossMatchesQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if (query.result) {
    where.result = query.result;
  }

  const orderBy: any = {};
  if (query.sortBy) {
    orderBy[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [crossMatches, total] = await Promise.all([
    prisma.crossMatchTest.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        bloodInventory: { select: { id: true, bloodGroup: true, componentType: true, bagNumber: true } },
      },
    }),
    prisma.crossMatchTest.count({ where }),
  ]);

  return { crossMatches, total, page, limit };
}

export async function getCrossMatchById(tenantId: string, id: string) {
  const crossMatch = await prisma.crossMatchTest.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, bloodGroup: true } },
      bloodInventory: true,
    },
  });

  if (!crossMatch) {
    throw AppError.notFound('Cross-match test not found');
  }

  return crossMatch;
}

export async function completeCrossMatch(
  tenantId: string,
  id: string,
  userId: string,
  data: CompleteCrossMatchInput,
) {
  const existing = await prisma.crossMatchTest.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Cross-match test not found');
  }

  if (existing.result !== 'pending') {
    throw AppError.badRequest('Cross-match test has already been completed');
  }

  const crossMatch = await prisma.crossMatchTest.update({
    where: { id },
    data: {
      result: data.result as any,
      testedBy: userId,
      testedAt: new Date(),
      notes: data.notes ?? existing.notes,
    },
  });

  // If incompatible, release the reserved unit back to available
  if (data.result === 'incompatible') {
    await prisma.bloodInventory.update({
      where: { id: existing.bloodInventoryId },
      data: { status: 'available' },
    });
  }

  return crossMatch;
}

// ============================================================
// TRANSFUSIONS
// ============================================================

export async function requestTransfusion(tenantId: string, data: RequestTransfusionInput) {
  // Verify patient
  const patient = await prisma.patient.findFirst({
    where: { id: data.patientId, tenantId },
  });
  if (!patient) {
    throw AppError.notFound('Patient not found');
  }

  // Verify cross-match is compatible
  const crossMatch = await prisma.crossMatchTest.findFirst({
    where: { id: data.crossMatchId, tenantId },
  });
  if (!crossMatch) {
    throw AppError.notFound('Cross-match test not found');
  }
  if (crossMatch.result !== 'compatible') {
    throw AppError.badRequest('Cross-match test result is not compatible');
  }

  // Verify blood inventory unit
  const unit = await prisma.bloodInventory.findFirst({
    where: { id: data.bloodInventoryId, tenantId },
  });
  if (!unit) {
    throw AppError.notFound('Blood inventory unit not found');
  }
  if (unit.status !== 'reserved' && unit.status !== 'available') {
    throw AppError.badRequest('Blood unit is not available for transfusion');
  }

  const transfusion = await prisma.transfusion.create({
    data: {
      tenantId,
      patientId: data.patientId,
      visitId: data.visitId,
      bloodInventoryId: data.bloodInventoryId,
      crossMatchId: data.crossMatchId,
      transfusionDate: new Date(data.transfusionDate),
      volumeMl: data.volumeMl,
      orderedBy: data.orderedBy,
      administeredBy: data.administeredBy,
      notes: data.notes,
    },
  });

  // Mark blood unit as issued
  await prisma.bloodInventory.update({
    where: { id: data.bloodInventoryId },
    data: { status: 'issued' },
  });

  return transfusion;
}

export async function getTransfusions(tenantId: string, query: ListTransfusionsQuery) {
  const { skip, take, page, limit } = getPaginationParams(query);

  const where: any = { tenantId };

  if (query.patientId) {
    where.patientId = query.patientId;
  }

  if (query.fromDate) {
    where.transfusionDate = { ...where.transfusionDate, gte: new Date(query.fromDate) };
  }

  if (query.toDate) {
    where.transfusionDate = { ...where.transfusionDate, lte: new Date(query.toDate) };
  }

  const orderBy: any = {};
  if (query.sortBy) {
    orderBy[query.sortBy] = query.sortOrder || 'desc';
  } else {
    orderBy.createdAt = 'desc';
  }

  const [transfusions, total] = await Promise.all([
    prisma.transfusion.findMany({
      where,
      skip,
      take,
      orderBy,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        bloodInventory: { select: { id: true, bloodGroup: true, componentType: true, bagNumber: true } },
      },
    }),
    prisma.transfusion.count({ where }),
  ]);

  return { transfusions, total, page, limit };
}

export async function getTransfusionById(tenantId: string, id: string) {
  const transfusion = await prisma.transfusion.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, firstName: true, lastName: true, bloodGroup: true } },
      bloodInventory: true,
      crossMatch: true,
    },
  });

  if (!transfusion) {
    throw AppError.notFound('Transfusion not found');
  }

  return transfusion;
}

export async function startTransfusion(tenantId: string, id: string) {
  const existing = await prisma.transfusion.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Transfusion not found');
  }

  // Transfusion model does not have a status field.
  // We use the presence of transfusionDate to track if it has been acknowledged.
  // Just return the record as confirmation.
  return existing;
}

export async function completeTransfusion(
  tenantId: string,
  id: string,
  data: CompleteTransfusionInput,
) {
  const existing = await prisma.transfusion.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Transfusion not found');
  }

  const updateData: any = {};
  if (data.notes !== undefined) updateData.notes = data.notes;

  const transfusion = await prisma.transfusion.update({
    where: { id },
    data: updateData,
  });

  return transfusion;
}

export async function reportReaction(tenantId: string, id: string, data: ReportReactionInput) {
  const existing = await prisma.transfusion.findFirst({
    where: { id, tenantId },
  });

  if (!existing) {
    throw AppError.notFound('Transfusion not found');
  }

  const transfusion = await prisma.transfusion.update({
    where: { id },
    data: {
      adverseReaction: true,
      reactionDetails: data.reactionDetails,
    },
  });

  return transfusion;
}
