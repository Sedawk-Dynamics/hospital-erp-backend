import { z } from 'zod';

export const createLocationSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Location name is required').max(120),
    type: z.enum(['main_vault', 'sub_store']).optional(),
    wardId: z.string().uuid().optional(),
  }),
});

export const receiveConsignmentSchema = z.object({
  body: z.object({
    drugFormularyId: z.string().uuid('Invalid drug ID'),
    quantity: z.number().int().positive('Quantity must be positive'),
    ndpsLicenseNumber: z.string().min(1, "The vendor's NDPS licence number is required").max(120),
    form3cNumber: z.string().min(1, 'The Form 3C consignment-note number is required').max(120),
    transportDetails: z.string().max(500).optional(),
    grossWeight: z.string().max(60).optional(),
    supplierId: z.string().uuid().optional(),
    batchNumber: z.string().max(100).optional(),
    expiryDate: z.string().optional(),
    notes: z.string().max(1000).optional(),
  }),
});


export const consumptionSchema = z.object({
  body: z.object({
    drugFormularyId: z.string().uuid('Invalid drug ID'),
    fromLocationId: z.string().uuid('Invalid sub-store location'),
    quantity: z.number().int().positive('Quantity must be positive'),
    patientId: z.string().uuid('Invalid patient'),
    doctorRegNo: z.string().min(1, "The prescriber's registration number is required").max(60),
    bedNumber: z.string().min(1, 'The bed number is required').max(40),
    diagnosis: z.string().min(1, 'A medical justification (diagnosis) is required'),
    notes: z.string().max(1000).optional(),
  }),
});

export const disposalSchema = z.object({
  body: z.object({
    drugFormularyId: z.string().uuid('Invalid drug ID'),
    locationId: z.string().uuid('Invalid location'),
    quantity: z.number().int().positive('Quantity must be positive'),
    reasonCode: z.enum(['breakage', 'contamination', 'expiry', 'other']),
    referenceNumber: z.string().min(1, 'A police-complaint / destruction reference is required').max(120),
    coSignById: z.string().uuid('The medical director co-sign is required'),
    attachmentUrl: z.string().max(500).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

export const patientResidualQuerySchema = z.object({
  query: z.object({
    status: z.enum(['quarantined', 'destroyed', 'fully_administered', 'all']).optional(),
    patientId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

export const destroyPatientResidualSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid patient residual id') }),
  body: z.object({
    disposalMethod: z.string().trim().min(1, 'Destruction method is required').max(160),
    referenceNumber: z.string().trim().min(1, 'Destruction memo/reference is required').max(120),
    witnessedById: z.string().uuid('Select an authorised witness'),
    witnessPassword: z.string().min(1, 'Witness password is required').max(200),
    attachmentUrl: z.string().max(500).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

export const dailyCloseSchema = z.object({
  body: z.object({ date: z.string().optional() }),
});

export const verifyDailySchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid daily-account id') }),
  body: z.object({ physicalCount: z.number().int().nonnegative('Physical count must be ≥ 0') }),
});

export const stockQuerySchema = z.object({
  query: z.object({ drugFormularyId: z.string().uuid().optional() }),
});

export const registerQuerySchema = z.object({
  query: z.object({
    formType: z.enum(['3C', '3E', '3H', 'transfer', 'disposal', 'all']).optional(),
    drugFormularyId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});
