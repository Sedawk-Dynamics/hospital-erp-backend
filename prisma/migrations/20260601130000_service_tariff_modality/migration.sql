-- Imaging service catalog (2026-06-01).
-- Adds a modality column to service_tariffs so imaging (category='radiology')
-- tariffs carry the ImagingType they run on. This lets the doctor's imaging
-- order dialog search the tariff catalog and route a picked study (e.g.
-- "MRI Brain with contrast") to the correct modality + price — mirroring how
-- the lab test catalog feeds the lab order search.

ALTER TABLE "service_tariffs"
  ADD COLUMN IF NOT EXISTS "modality" "ImagingType";

-- Backfill modality on the per-modality base-price rows, whose service_code is
-- already the imaging type value (e.g. 'ct_scan').
UPDATE "service_tariffs"
SET "modality" = "service_code"::"ImagingType"
WHERE "category" = 'radiology'
  AND "modality" IS NULL
  AND "service_code" IN ('xray', 'mri', 'ct_scan', 'ultrasound', 'ecg', 'echo', 'other');
