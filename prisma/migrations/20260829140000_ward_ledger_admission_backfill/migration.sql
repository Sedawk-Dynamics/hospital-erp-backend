-- Point historic ward doses at the stay they were given during.
--
-- dispenseFromWard scoped the BILL to the patient's open admission but wrote
-- the ledger row with only the admission the caller had named — which is
-- nothing, on every path where the nurse dispenses from the ward screen. So a
-- per-stay medicine consumption report read zero for ward-issued medicine,
-- which is most of the medicine an inpatient receives.
--
-- The service now writes the same admission the bill got. This carries the rows
-- already written over to it, taking the stay from the bill the dose was
-- charged to — the same answer the code would have reached.
--
-- Idempotent: only fills rows that are still null, so it may be re-run.
UPDATE "ward_stock_ledger" l
   SET "admission_id" = b."admission_id"
  FROM "bills" b
 WHERE l."bill_id" = b."id"
   AND l."movement_type" = 'dispensed'
   AND l."admission_id" IS NULL
   AND b."admission_id" IS NOT NULL;
