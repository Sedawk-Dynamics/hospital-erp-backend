-- G12: IP ward→pharmacy flow support.
--  * admissions.billing_category — cash | package | insurance | corporate
--    (null = cash). Lets the pharmacist see whether to collect payment.
--  * prescriptions.pharmacy_status — ordered | preparing | ready | collected
--    fulfilment lifecycle, independent of the clinical dispensing status.
ALTER TABLE "admissions" ADD COLUMN IF NOT EXISTS "billing_category" VARCHAR(20);
ALTER TABLE "prescriptions" ADD COLUMN IF NOT EXISTS "pharmacy_status" VARCHAR(20);
