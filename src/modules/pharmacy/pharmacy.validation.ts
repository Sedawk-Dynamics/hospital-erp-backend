import { z } from 'zod';
import { paginationSchema } from '../../shared/pagination';

// ============================================================
// Audit trail (read)
// ============================================================

export const getAuditTrailQuerySchema = z.object({
  query: paginationSchema.extend({
    action: z.enum(['create', 'read', 'update', 'delete']).optional(),
    entityType: z.string().max(100).optional(),
    userId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    search: z.string().max(200).optional(),
  }),
});

// ============================================================
// Formulary
// ============================================================

export const createFormularySchema = z.object({
  body: z.object({
    drugName: z.string().min(1, 'Drug name is required').max(255),
    genericName: z.string().max(255).optional(),
    manufacturer: z.string().max(255).optional(),
    dosageForm: z
      .enum(['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other'])
      .optional(),
    strength: z.string().max(100).optional(),
    unitOfMeasurement: z.string().max(20).optional(),
    price: z.number().nonnegative('Price must be non-negative').optional(),
    packSize: z.number().int().positive().optional(),
    looseUnitLabel: z.string().max(40).optional(),
    taxPercent: z.number().min(0).max(100).optional(),
    minStock: z.number().int().nonnegative().optional(),
    // Product Resolution Engine / compliance identity.
    gtin: z.string().max(20).optional(),
    casePackGtin: z.string().max(20).optional(),
    unitsPerCase: z.number().int().positive().optional(),
    hsnCode: z.string().max(20).optional(),
    manufacturerCode: z.string().max(100).optional(),
    indications: z.string().optional(),
    contraindications: z.string().optional(),
    // Vital/life-saving — bypasses the IP cash-patient credit-clearance gate.
    isLifeSaving: z.boolean().optional(),
    isNarcotic: z.boolean().optional(),
    isReimbursable: z.boolean().optional(),
    isActive: z.boolean().default(true),
    // G1: set true to create even when a high-confidence near-duplicate exists
    // (the user reviewed the suggestions and chose "create anyway").
    force: z.boolean().optional(),
  }),
});

// G1: live duplicate look-up for the inward / add-drug dialog.
export const findFormularyMatchesSchema = z.object({
  query: z.object({
    name: z.string().min(1, 'A drug name is required').max(255),
    genericName: z.string().max(255).optional(),
    manufacturer: z.string().max(255).optional(),
    strength: z.string().max(100).optional(),
    dosageForm: z.string().max(40).optional(),
    excludeId: z.string().uuid().optional(),
  }),
});

// G1: merge a duplicate formulary row (sourceId) into the canonical one (:id).
export const mergeFormularySchema = z.object({
  body: z.object({
    sourceId: z.string().uuid('Invalid source drug ID'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid formulary item ID'),
  }),
});

export const updateFormularySchema = z.object({
  body: z.object({
    drugName: z.string().min(1).max(255).optional(),
    genericName: z.string().max(255).optional().nullable(),
    manufacturer: z.string().max(255).optional().nullable(),
    dosageForm: z
      .enum(['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other'])
      .optional()
      .nullable(),
    strength: z.string().max(100).optional().nullable(),
    unitOfMeasurement: z.string().max(20).optional().nullable(),
    price: z.number().nonnegative().optional().nullable(),
    packSize: z.number().int().positive().optional().nullable(),
    looseUnitLabel: z.string().max(40).optional().nullable(),
    taxPercent: z.number().min(0).max(100).optional().nullable(),
    minStock: z.number().int().nonnegative().optional().nullable(),
    gtin: z.string().max(20).optional().nullable(),
    casePackGtin: z.string().max(20).optional().nullable(),
    unitsPerCase: z.number().int().positive().optional().nullable(),
    hsnCode: z.string().max(20).optional().nullable(),
    manufacturerCode: z.string().max(100).optional().nullable(),
    indications: z.string().optional().nullable(),
    contraindications: z.string().optional().nullable(),
    isLifeSaving: z.boolean().optional(),
    isNarcotic: z.boolean().optional(),
    isReimbursable: z.boolean().optional(),
    isActive: z.boolean().optional(),
    isRecalled: z.boolean().optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid formulary item ID'),
  }),
});

export const formularyIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid formulary item ID'),
  }),
});

// Import a drug from the platform DrugMaster catalog into this tenant's
// formulary. Optional overrides let the hospital set its own selling price /
// category at import time.
export const importFormularySchema = z.object({
  body: z.object({
    drugMasterId: z.string().uuid('Invalid drug catalog ID'),
    price: z.number().nonnegative('Price must be non-negative').optional(),
  }),
});

// Tenant-facing catalog browse (platform DrugMaster + imported flag).
export const getCatalogQuerySchema = z.object({
  query: paginationSchema.extend({
    dosageForm: z
      .enum(['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other'])
      .optional(),
    schedule: z.string().max(10).optional(),
    imported: z.enum(['yes', 'no']).optional(),
  }),
});

// Bulk import many catalog drugs into the tenant formulary at once.
export const importFormularyBulkSchema = z.object({
  body: z.object({
    drugMasterIds: z
      .array(z.string().uuid('Invalid drug catalog ID'))
      .min(1, 'Select at least one drug')
      .max(1000, 'Import at most 1000 drugs at a time'),
  }),
});

export const getFormularyQuerySchema = z.object({
  query: paginationSchema.extend({
    dosageForm: z
      .enum(['tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other'])
      .optional(),
    isActive: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    // Filter to NDPS narcotic drugs only (drives the NDPS drug pickers).
    isNarcotic: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    // Filter by live stock derived from available batches.
    stockStatus: z.enum(['in', 'out']).optional(),
  }),
});

// ============================================================
// Batches
// ============================================================

export const createBatchSchema = z.object({
  body: z.object({
    drugId: z.string().uuid('Invalid drug ID'),
    batchNumber: z.string().min(1, 'Batch number is required').max(100),
    manufacturingDate: z.string().optional(),
    expiryDate: z.string().min(1, 'Expiry date is required'),
    supplierId: z.string().uuid('Invalid supplier ID').optional(),
    // G2 purchase-side discount structure — captured as distinct fields.
    mrp: z.number().nonnegative('MRP must be non-negative').optional(),
    purchasePrice: z.number().nonnegative('Purchase price must be non-negative').optional(),
    purchaseDiscountPercent: z.number().min(0).max(100).optional(),
    gstPercent: z.number().min(0).max(100).optional(),
    sellingPrice: z.number().nonnegative('Selling price must be non-negative').optional(),
    quantityReceived: z.number().int().positive('Quantity received must be positive'),
    // Free units received on top of the paid quantity (count toward stock).
    freeQuantity: z.number().int().nonnegative().optional(),
    // GRN invoice traceability (design-doc manual GRN Steps 1/8/9).
    invoiceNumber: z.string().max(100).optional(),
    invoiceDate: z.string().optional(),
    // Barcode-driven traceability (spec Section 2): a scanned pack barcode. When
    // barcode is omitted an internal Code-128 is minted from the batch id.
    barcode: z.string().max(64).optional(),
    // GS1 DataMatrix serial (AI 21) read from the 2D scan, kept for traceability.
    serialNumber: z.string().max(80).optional(),
    // Manual GRN Step 6: when a batch with this number already exists, set this
    // to fold the received quantity into the existing batch (Increase Quantity)
    // instead of erroring.
    addToExisting: z.boolean().optional(),
  }),
});

// OP pre-packing — Stock Hold / Pre-Packed (spec OP Step 1).
export const prePackHoldSchema = z.object({
  body: z.object({
    patientId: z.string().uuid('Invalid patient ID').optional(),
    prescriptionId: z.string().uuid('Invalid prescription ID').optional(),
    notes: z.string().max(1000).optional(),
    items: z
      .array(z.object({ drugBatchId: z.string().uuid('Invalid drug batch ID'), quantity: z.number().int().positive() }))
      .min(1, 'Add at least one item to pre-pack'),
  }),
});

export const collectHoldSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid hold id') }),
  body: z.object({
    billDiscountPercent: z.number().min(0).max(100).optional(),
    billDiscountAmount: z.number().nonnegative().optional(),
    payments: z
      .array(z.object({
        method: z.enum(['cash', 'credit_card', 'debit_card', 'upi', 'net_banking', 'insurance', 'advance', 'cheque', 'other']),
        amount: z.number().nonnegative(),
        reference: z.string().max(120).optional(),
      }))
      .optional(),
  }),
});

export const holdsQuerySchema = z.object({
  query: z.object({
    status: z.enum(['held', 'collected', 'released']).optional(),
    patientId: z.string().uuid().optional(),
  }),
});

// Barcode scan resolve (POS / dispensing) + automated compliance pre-check.
export const scanQuerySchema = z.object({
  query: z.object({ code: z.string().min(1, 'A barcode is required').max(256) }),
});

export const complianceCheckSchema = z.object({
  body: z.object({
    prescriptionId: z.string().uuid().optional(),
    items: z
      .array(z.object({ drugBatchId: z.string().uuid('Invalid drug batch ID') }))
      .min(1, 'At least one item is required'),
  }),
});

export const updateBatchSchema = z.object({
  body: z.object({
    batchNumber: z.string().min(1).max(100).optional(),
    manufacturingDate: z.string().optional().nullable(),
    expiryDate: z.string().optional(),
    supplierId: z.string().uuid('Invalid supplier ID').optional().nullable(),
    mrp: z.number().nonnegative().optional().nullable(),
    purchasePrice: z.number().nonnegative().optional().nullable(),
    purchaseDiscountPercent: z.number().min(0).max(100).optional().nullable(),
    gstPercent: z.number().min(0).max(100).optional().nullable(),
    sellingPrice: z.number().nonnegative().optional().nullable(),
    invoiceNumber: z.string().max(100).optional().nullable(),
    invoiceDate: z.string().optional().nullable(),
    quantityInStock: z.number().int().nonnegative('Stock quantity must be non-negative').optional(),
    isExpired: z.boolean().optional(),
    isRecalled: z.boolean().optional(),
    recallReason: z.string().optional().nullable(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

export const batchIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

// G4: deliberate stock-count correction (always reason-stamped + audited).
export const adjustBatchSchema = z.object({
  body: z
    .object({
      newQuantity: z.number().int().nonnegative().optional(),
      physicalCount: z.number().int().nonnegative().optional(),
      reason: z.string().min(1, 'A reason is required').max(500),
    })
    .refine((b) => b.newQuantity != null || b.physicalCount != null, {
      message: 'Provide the corrected quantity (newQuantity or physicalCount)',
      path: ['newQuantity'],
    }),
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

// G4: physical stock-take reconciliation — staff enter a counted quantity per
// batch; the system flags the variance vs the system count and applies each
// non-zero delta as an audited correction. `countedQuantity` is the physically
// counted on-hand; a session-level reason is required (per-line note optional).
export const stockTakeReconcileSchema = z.object({
  body: z.object({
    reason: z.string().min(1, 'A stock-take reason / reference is required').max(500),
    lines: z
      .array(
        z.object({
          batchId: z.string().uuid('Invalid batch ID'),
          countedQuantity: z.number().int().nonnegative('Counted quantity cannot be negative'),
          reason: z.string().max(500).optional(),
        }),
      )
      .min(1, 'Count at least one batch')
      .max(500, 'At most 500 batches per stock-take'),
  }),
});

// G4: stock discrepancy report — manual corrections in a date window.
export const getStockAdjustmentsQuerySchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    drugId: z.string().uuid().optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  }),
});

export const getBatchesQuerySchema = z.object({
  query: paginationSchema.extend({
    drugId: z.string().uuid().optional(),
    isExpired: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    // Filter to recalled (or explicitly not-recalled) batches — powers the
    // "Recalled" view on the batches page (recall management lives there now).
    isRecalled: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
    // Convenience filter for the POS picker: only batches that are not
    // expired, not recalled, and have stock > 0. Trumps `isExpired`.
    availableOnly: z
      .string()
      .transform((val) => val === 'true')
      .optional(),
  }),
});

export const getExpiringBatchesQuerySchema = z.object({
  query: paginationSchema.extend({
    days: z.coerce.number().int().positive().default(30),
  }),
});

// ============================================================
// G1 — Bulk stock inward (CSV / OCR / manual multi-row)
// ============================================================

// One incoming distributor-invoice line as far as duplicate detection cares —
// the identity fields the matching engine scores against, plus the Product
// Resolution Engine inputs (GTIN off the invoice/scan + the supplier the line
// came from, which drives the learned distributor mapping).
const inwardMatchLineSchema = z.object({
  drugName: z.string().min(1, 'Name is required').max(255),
  genericName: z.string().max(255).optional().nullable(),
  manufacturer: z.string().max(255).optional().nullable(),
  strength: z.string().max(100).optional().nullable(),
  dosageForm: z.string().max(40).optional().nullable(),
  gtin: z.string().max(20).optional().nullable(),
  // A line can be a medicine (default — matched against the formulary) or any
  // other stock item (matched against inventory_items). `category` is the item
  // category when kind=item.
  kind: z.enum(['drug', 'item']).optional(),
  category: z.enum(['drug', 'consumable', 'surgical_supply', 'equipment', 'other']).optional().nullable(),
});

// Step 1: score every incoming line against the formulary (no writes). An
// optional header supplierId is recorded on each received batch.
export const matchInwardSchema = z.object({
  body: z.object({
    supplierId: z.string().uuid('Invalid supplier ID').optional(),
    lines: z
      .array(inwardMatchLineSchema)
      .min(1, 'At least one line is required')
      .max(200, 'At most 200 lines at a time'),
  }),
});

// Step 2: a reviewed line — the user's map-or-create decision plus the batch /
// stock-in details to post. `quantityReceived` is the TOTAL units received
// (paid + free), matching createBatch; `freeQuantity` records the free portion.
const commitInwardLineSchema = inwardMatchLineSchema
  .extend({
    action: z.enum(['map', 'create']),
    // Required when action === 'map' — the existing formulary row (medicine) or
    // inventory item (other stock) to add the incoming stock to.
    targetFormularyId: z.string().uuid('Invalid target drug ID').optional(),
    targetInventoryItemId: z.string().uuid('Invalid target item ID').optional(),
    // Set on a 'create' line that the user seeded from the DrugMaster catalog —
    // the new formulary row links back to the catalog drug for identity/pricing.
    drugMasterId: z.string().uuid('Invalid drug catalog ID').optional(),
    // The raw distributor line text (defaults to drugName) — stored verbatim as
    // the learned mapping key so future imports of this exact name auto-resolve.
    externalName: z.string().max(255).optional(),
    // Product-definition fields carried onto a newly-created product (medicine or
    // item) — full "New Item" parity so one flow defines AND receives stock.
    packSize: z.number().int().positive().optional(),
    looseUnitLabel: z.string().max(40).optional(),
    hsnCode: z.string().max(20).optional(),
    manufacturerCode: z.string().max(100).optional(),
    minStock: z.number().int().nonnegative().optional(),
    description: z.string().max(2000).optional(),
    barcode: z.string().max(64).optional(),
    // Batch / stock-in (mirrors createBatchSchema). Batch + expiry are required
    // only when actually receiving stock for a medicine (qty > 0); see refine.
    batchNumber: z.string().max(100).optional(),
    manufacturingDate: z.string().optional(),
    expiryDate: z.string().optional(),
    // Optional: omit / 0 to just register the product without receiving stock
    // (the old "New Item" behaviour); > 0 also posts a batch / stock-in.
    quantityReceived: z.number().int().nonnegative().optional(),
    freeQuantity: z.number().int().nonnegative().optional(),
    mrp: z.number().nonnegative().optional(),
    purchasePrice: z.number().nonnegative().optional(),
    purchaseDiscountPercent: z.number().min(0).max(100).optional(),
    gstPercent: z.number().min(0).max(100).optional(),
    sellingPrice: z.number().nonnegative().optional(),
    // Per-line overrides for the header values.
    supplierId: z.string().uuid('Invalid supplier ID').optional(),
    invoiceNumber: z.string().max(100).optional(),
    invoiceDate: z.string().optional(),
    // Fold into an existing batch of the same number instead of erroring.
    addToExisting: z.boolean().optional(),
  })
  .refine(
    (l) =>
      l.action === 'create' ||
      (l.kind === 'item' ? !!l.targetInventoryItemId : !!l.targetFormularyId),
    {
      message: 'A mapped line needs a target (existing drug or item)',
      path: ['targetFormularyId'],
    },
  )
  .refine(
    // Batch + expiry are required only when actually receiving stock for a
    // medicine. Registering a medicine (qty 0/absent) or any item needs neither.
    (l) => l.kind === 'item' || !((l.quantityReceived ?? 0) > 0) || (!!l.batchNumber && !!l.expiryDate),
    {
      message: 'Batch number and expiry date are required when receiving a medicine',
      path: ['batchNumber'],
    },
  );

// Resolve a barcode/GS1 scan taken at stock entry into a draft inward line.
export const inwardScanQuerySchema = z.object({
  query: z.object({
    code: z.string().min(1, 'No barcode provided').max(512),
  }),
});

// Remember an unknown barcode against a chosen drug (stock-entry fallback).
export const attachBarcodeSchema = z.object({
  body: z.object({
    gtin: z.string().min(1, 'No barcode provided').max(64),
    drugId: z.string().uuid('Invalid drug ID'),
  }),
});

export const commitInwardSchema = z.object({
  body: z.object({
    // Header values applied to every line unless the line overrides them (G10).
    supplierId: z.string().uuid('Invalid supplier ID').optional(),
    invoiceNumber: z.string().max(100).optional(),
    invoiceDate: z.string().optional(),
    // G2 purchase-side TOTAL-BILL discount — the distributor's whole-invoice
    // discount applied on top of any per-line purchaseDiscountPercent. Percent
    // and/or a flat amount; both fold into each line's net purchase value.
    invoiceDiscountPercent: z.number().min(0).max(100).optional(),
    invoiceDiscountAmount: z.number().nonnegative().optional(),
    addToExisting: z.boolean().optional(),
    lines: z
      .array(commitInwardLineSchema)
      .min(1, 'At least one line is required')
      .max(200, 'At most 200 lines at a time'),
  }),
});

// ============================================================
// Dispensing
// ============================================================

export const createDispenseSchema = z.object({
  body: z.object({
    prescriptionId: z.string().uuid('Invalid prescription ID'),
    prescriptionItemId: z.string().uuid('Invalid prescription item ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    drugBatchId: z.string().uuid('Invalid drug batch ID'),
    quantityDispensed: z.number().int().positive('Quantity dispensed must be positive'),
    notes: z.string().max(1000).optional(),
  }),
});

// Counter billing / POS sale — bills a whole cart in one invoice. Supports
// partial-of-prescription, loose (sub-unit) sales, walk-in/OTC (no prescription)
// and free-typed quantities. prescriptionId is optional (walk-in => omitted).
export const createPharmacySaleSchema = z.object({
  body: z.object({
    // Optional — omit for a walk-in / OTC counter sale (no patient selected).
    patientId: z.string().uuid('Invalid patient ID').optional(),
    prescriptionId: z.string().uuid('Invalid prescription ID').optional(),
    items: z
      .array(
        z.object({
          drugBatchId: z.string().uuid('Invalid drug batch ID'),
          prescriptionItemId: z.string().uuid('Invalid prescription item ID').optional(),
          // Quantity is in the chosen unit: packs (default) or loose sub-units.
          quantity: z.number().positive('Quantity must be positive'),
          saleUnit: z.enum(['pack', 'loose']).default('pack'),
          discountPercent: z.number().min(0).max(100).optional(),
          // Optional per-base-unit price override (e.g. negotiated price).
          unitPrice: z.number().nonnegative().optional(),
          // §4.4: mark this line non-returnable on the bill (no patient return).
          nonReturnable: z.boolean().optional(),
        }),
      )
      .min(1, 'At least one item is required'),
    // G2 sale-side: a bill-level discount applied on top of any per-item
    // discounts (both can be used together). Percent and flat amount both
    // supported; the flat amount is added to the percent-derived discount.
    billDiscountPercent: z.number().min(0).max(100).optional(),
    billDiscountAmount: z.number().nonnegative().optional(),
    // TTO (To Take Out) — flags this as discharge / take-home medication.
    isTto: z.boolean().optional(),
    // Single-mode tender (back-compat). Prefer `payments[]` for split tenders.
    paymentMethod: z
      .enum(['cash', 'credit_card', 'debit_card', 'upi', 'net_banking', 'cheque', 'other'])
      .optional(),
    amountPaid: z.number().nonnegative().optional(),
    // G7: split payment — multiple tenders (cash + UPI + card…) in one bill.
    // When present this takes precedence over paymentMethod/amountPaid.
    payments: z
      .array(
        z.object({
          method: z.enum([
            'cash',
            'credit_card',
            'debit_card',
            'upi',
            'net_banking',
            'insurance',
            // G7: deduct from an admitted IP patient's prepaid advance.
            'advance',
            'cheque',
            'other',
          ]),
          amount: z.number().positive('Tender amount must be positive'),
          reference: z.string().max(120).optional(),
        }),
      )
      .max(8, 'At most 8 tenders per bill')
      .optional(),
    notes: z.string().max(1000).optional(),
  }),
});

export const saleIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid bill ID'),
  }),
});

// List of pharmacy counter-sale bills (PH- invoices) for the Transactions page.
export const getPharmacySalesQuerySchema = z.object({
  query: paginationSchema.extend({
    status: z.enum(['paid', 'partially_paid', 'pending', 'cancelled']).optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

// Void a pharmacy counter sale — restores stock, reverses the counter payment.
export const cancelSaleSchema = z.object({
  body: z.object({
    reason: z.string().min(1, 'Cancellation reason is required').max(500),
  }),
  params: z.object({
    id: z.string().uuid('Invalid bill ID'),
  }),
});

export const dispenseIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid dispensing record ID'),
  }),
});

// G16: mint a temporary emergency (Golden Hour) patient to dispense against.
export const createEmergencyPatientSchema = z.object({
  body: z.object({
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    phone: z.string().max(20).optional(),
    gender: z.enum(['male', 'female', 'other']).optional(),
    notes: z.string().max(500).optional(),
  }),
});

// G16: merge a temp emergency patient's pharmacy history into a permanent MRN.
export const mergeEmergencyPatientSchema = z.object({
  body: z.object({
    targetPatientId: z.string().uuid('Invalid target patient ID'),
  }),
  params: z.object({
    id: z.string().uuid('Invalid emergency patient ID'),
  }),
});

// G12: advance an IP prescription through the ward→pharmacy fulfilment lifecycle.
export const setPharmacyStatusSchema = z.object({
  body: z.object({
    status: z.enum(['ordered', 'preparing', 'ready', 'collected']),
  }),
  params: z.object({
    id: z.string().uuid('Invalid prescription ID'),
  }),
});

export const getDispenseQuerySchema = z.object({
  query: paginationSchema.extend({
    patientId: z.string().uuid().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

// ============================================================
// Returns
// ============================================================

export const createReturnSchema = z.object({
  body: z
    .object({
      returnType: z.enum(['patient_return', 'vendor_return', 'counter_return']),
      // Optional when dispensingRecordId is given — the batch is taken from the
      // original sale line in that case.
      drugBatchId: z.string().uuid('Invalid drug batch ID').optional(),
      // counter_return: the medicine being returned (formulary item). The batch
      // and expiry below are optional — a walk-in return need not name a batch.
      drugId: z.string().uuid('Invalid drug ID').optional(),
      batchNumber: z.string().max(100).optional(),
      expiryDate: z.coerce.date().optional(),
      saleUnit: z.enum(['pack', 'loose']).optional(),
      // Anchor a patient return to the original sale line so the refund is
      // computed from what was billed and bounded by what was dispensed.
      dispensingRecordId: z.string().uuid('Invalid dispensing record ID').optional(),
      patientId: z.string().uuid('Invalid patient ID').optional(),
      supplierId: z.string().uuid('Invalid supplier ID').optional(),
      quantity: z.number().int().positive('Quantity must be positive'),
      reason: z.string().max(1000).optional(),
      // Money actually handed back to the customer on a patient return. When
      // given it overrides the auto-computed billed price and is what gets
      // refunded against the original bill. Returns now apply immediately (no
      // separate approve step).
      refundAmount: z.number().nonnegative().optional(),
      // G5: supplier credit note for vendor (expired/damaged) returns.
      creditNoteNumber: z.string().max(80).optional(),
      creditAmount: z.number().nonnegative().optional(),
    })
    .refine(
      (b) =>
        b.returnType === 'counter_return'
          ? !!b.drugId
          : !!b.drugBatchId || !!b.dispensingRecordId,
      {
        message:
          'A counter return needs a medicine (drugId); other returns need a drugBatchId or dispensingRecordId',
        path: ['drugId'],
      },
    ),
});

// SOW-literal vendor-return endpoint (POST /pharmacy/vendor-returns): returnType
// is implied, supplier required. The controller injects returnType.
export const createVendorReturnSchema = z.object({
  body: z.object({
    drugBatchId: z.string().uuid('Invalid drug batch ID'),
    supplierId: z.string().uuid('Supplier is required for vendor returns'),
    quantity: z.number().int().positive('Quantity must be positive'),
    reason: z.string().max(1000).optional(),
    // G5: supplier credit note for the returned (expired/damaged) stock.
    creditNoteNumber: z.string().max(80).optional(),
    creditAmount: z.number().nonnegative().optional(),
  }),
});

export const returnIdParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid return ID'),
  }),
});

export const getReturnsQuerySchema = z.object({
  query: paginationSchema.extend({
    returnType: z.enum(['patient_return', 'vendor_return', 'counter_return']).optional(),
    status: z.enum(['pending', 'processed', 'rejected']).optional(),
  }),
});

// Returnable counter-sale lines for the patient-return picker. G3: a return can
// be looked up either by patient or by presenting the physical bill (billNumber).
export const returnableQuerySchema = z.object({
  query: z
    .object({
      patientId: z.string().uuid('A valid patient ID is required').optional(),
      billNumber: z.string().min(1).max(50).optional(),
    })
    .refine((q) => !!q.patientId || !!q.billNumber, {
      message: 'Provide a patientId or a billNumber',
      path: ['patientId'],
    }),
});

export const processReturnSchema = z.object({
  body: z.object({
    status: z.enum(['processed', 'rejected']),
    // G14: cash refund vs credit to the patient's advance. Omit to auto-detect
    // from the patient's IP billing category (package/insurance → advance).
    refundMode: z.enum(['cash', 'advance']).optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid return ID'),
  }),
});

// ============================================================
// Recall Management
// ============================================================

export const recallBatchSchema = z.object({
  body: z.object({
    recallReason: z.string().min(1, 'Recall reason is required').max(1000),
  }),
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

export const unrecallBatchSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

export const recallDrugSchema = z.object({
  body: z.object({
    recallReason: z.string().min(1, 'Recall reason is required').max(1000),
  }),
  params: z.object({
    id: z.string().uuid('Invalid drug ID'),
  }),
});

export const getRecalledItemsQuerySchema = z.object({
  query: paginationSchema.extend({
    type: z.enum(['batch', 'drug', 'all']).default('all'),
  }),
});

export const recallAffectedPatientsParamSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid batch ID'),
  }),
});

// ============================================================
// GST
// ============================================================

export const getGstReportQuerySchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    gstRate: z.coerce.number().min(0).max(100).optional(),
  }),
});

// ============================================================
// G15 — Mandatory reports
// ============================================================

export const dailyTransactionQuerySchema = z.object({
  query: z.object({ date: z.string().optional() }),
});

export const purchaseReportQuerySchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    supplierId: z.string().uuid().optional(),
  }),
});

export const vendorWiseQuerySchema = z.object({
  query: z.object({ supplierId: z.string().uuid().optional() }),
});

export const creditNotesQuerySchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    supplierId: z.string().uuid().optional(),
  }),
});

// ============================================================
// G13 — Ward stock
// ============================================================
export const wardStockTransferSchema = z.object({
  body: z.object({
    wardId: z.string().uuid('Invalid ward ID'),
    drugBatchId: z.string().uuid('Invalid drug batch ID'),
    quantity: z.number().int().positive('Quantity must be positive'),
  }),
});

export const wardStockDispenseSchema = z.object({
  body: z.object({
    wardId: z.string().uuid('Invalid ward ID'),
    drugBatchId: z.string().uuid('Invalid drug batch ID'),
    patientId: z.string().uuid('Invalid patient ID'),
    quantity: z.number().int().positive('Quantity must be positive'),
    admissionId: z.string().uuid().optional(),
    reason: z.string().max(500).optional(),
    // Clearance given for an over-deposit cash IP patient (IP credit gate).
    override: z.boolean().optional(),
  }),
});

// G13: return excess / near-expiry ward stock back to the central pharmacy.
export const wardStockReturnSchema = z.object({
  body: z.object({
    wardId: z.string().uuid('Invalid ward ID'),
    drugBatchId: z.string().uuid('Invalid drug batch ID'),
    quantity: z.number().int().positive('Quantity must be positive'),
    reason: z.string().max(500).optional(),
  }),
});

// G13: correct a ward's on-hand count (breakage / miscount) to a verified value.
export const wardStockAdjustSchema = z.object({
  body: z.object({
    wardId: z.string().uuid('Invalid ward ID'),
    drugBatchId: z.string().uuid('Invalid drug batch ID'),
    newQuantity: z.number().int().nonnegative('Corrected quantity cannot be negative'),
    reason: z.string().min(1, 'A reason is required').max(500),
  }),
});

// IP credit & clearance check — live deposit-vs-bill picture for a patient.
export const creditStatusQuerySchema = z.object({
  query: z.object({ patientId: z.string().uuid('A patient ID is required') }),
});

export const wardStockQuerySchema = z.object({
  query: z.object({ wardId: z.string().uuid('A ward ID is required') }),
});

export const wardLedgerQuerySchema = z.object({
  query: z.object({
    wardId: z.string().uuid('A ward ID is required'),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
  }),
});

// G17: narcotic / controlled-drug register for a DI audit.
export const narcoticRegisterQuerySchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    dispensedBy: z.string().uuid().optional(),
    schedule: z.string().max(10).optional(),
  }),
});

// ============================================================
// G9 — Draft purchase orders for drugs
// ============================================================

export const getDrugPurchaseOrdersQuerySchema = z.object({
  query: z.object({
    status: z.enum(['draft', 'sent', 'received', 'cancelled']).optional(),
  }),
});

export const drugPurchaseOrderIdParamSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid purchase order ID') }),
});

export const updateDrugPurchaseOrderSchema = z.object({
  body: z.object({
    supplierId: z.string().uuid('Invalid supplier ID').nullable().optional(),
    notes: z.string().max(1000).optional(),
    items: z
      .array(
        z.object({
          drugId: z.string().uuid('Invalid drug ID'),
          quantityOrdered: z.number().int().positive('Quantity must be positive'),
        }),
      )
      .max(500, 'At most 500 lines per order')
      .optional(),
  }),
  params: z.object({ id: z.string().uuid('Invalid purchase order ID') }),
});

export const setDrugPurchaseOrderStatusSchema = z.object({
  body: z.object({ status: z.enum(['sent', 'received', 'cancelled']) }),
  params: z.object({ id: z.string().uuid('Invalid purchase order ID') }),
});

// ============================================================
// Stock ledger (batch-wise movement register)
// ============================================================

export const getStockLedgerQuerySchema = z.object({
  query: z.object({
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    drugId: z.string().uuid().optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  }),
});

// ============================================================
// Type exports
// ============================================================

export type CreateFormularyInput = z.infer<typeof createFormularySchema>['body'];
export type UpdateFormularyInput = z.infer<typeof updateFormularySchema>['body'];
export type ImportFormularyInput = z.infer<typeof importFormularySchema>['body'];
export type ImportFormularyBulkInput = z.infer<typeof importFormularyBulkSchema>['body'];
export type GetFormularyQuery = z.infer<typeof getFormularyQuerySchema>['query'];
export type CreateBatchInput = z.infer<typeof createBatchSchema>['body'];
export type InwardMatchInput = z.infer<typeof matchInwardSchema>['body'];
export type CommitInwardInput = z.infer<typeof commitInwardSchema>['body'];
export type StockTakeReconcileInput = z.infer<typeof stockTakeReconcileSchema>['body'];
export type UpdateBatchInput = z.infer<typeof updateBatchSchema>['body'];
export type GetBatchesQuery = z.infer<typeof getBatchesQuerySchema>['query'];
export type GetExpiringBatchesQuery = z.infer<typeof getExpiringBatchesQuerySchema>['query'];
export type CreateDispenseInput = z.infer<typeof createDispenseSchema>['body'];
export type CreatePharmacySaleInput = z.infer<typeof createPharmacySaleSchema>['body'];
export type GetPharmacySalesQuery = z.infer<typeof getPharmacySalesQuerySchema>['query'];
export type CancelSaleInput = z.infer<typeof cancelSaleSchema>['body'];
export type GetDispenseQuery = z.infer<typeof getDispenseQuerySchema>['query'];
export type CreateReturnInput = z.infer<typeof createReturnSchema>['body'];
export type GetReturnsQuery = z.infer<typeof getReturnsQuerySchema>['query'];
export type ProcessReturnInput = z.infer<typeof processReturnSchema>['body'];
export type RecallBatchInput = z.infer<typeof recallBatchSchema>['body'];
export type RecallDrugInput = z.infer<typeof recallDrugSchema>['body'];
export type GetRecalledItemsQuery = z.infer<typeof getRecalledItemsQuerySchema>['query'];
export type GetGstReportQuery = z.infer<typeof getGstReportQuerySchema>['query'];
export type GetStockLedgerQuery = z.infer<typeof getStockLedgerQuerySchema>['query'];
