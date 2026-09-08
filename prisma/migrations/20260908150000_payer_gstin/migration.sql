-- Give an insurer and a TPA a tax identity, so a B2B invoice can exist.
--
-- Section 4.7: "The system does not capture an insurer's or TPA's GSTIN today,
-- so a B2B invoice cannot currently be raised." That is still true — `insurers`
-- and `tpa_providers` carry only id, tenant_id, name, contact_person, phone,
-- email, address, is_active, created_at.
--
-- The consequence runs wider than one missing field. Everything downstream of a
-- registered recipient is built and unreachable: `recipientGstin` on `bills`
-- has twenty read sites and no write site, `isInterState` is never set true,
-- report A-4 (the B2B register) is structurally always empty, GSTR-1 Table 4
-- can never be filled, and acceptance scenario 21 — billing a TPA registered in
-- another state, which must produce IGST — cannot be performed at all.
--
-- `state_code` is stored rather than derived on every read, but it is DERIVED
-- from the GSTIN when one is set: the first two digits of a GSTIN are the state,
-- so the two cannot be allowed to drift apart. Same rule the hospital's own GST
-- profile follows.
--
-- Also `suppliers.state_code`, for the same reason on the purchase side: telling
-- an intra-state purchase from an inter-state one is what decides whether the
-- input credit sits in CGST+SGST or in IGST, and B-1 has no way to say today.

ALTER TABLE "insurers"      ADD COLUMN IF NOT EXISTS "gstin"      VARCHAR(15);
ALTER TABLE "insurers"      ADD COLUMN IF NOT EXISTS "state_code" VARCHAR(2);
ALTER TABLE "tpa_providers" ADD COLUMN IF NOT EXISTS "gstin"      VARCHAR(15);
ALTER TABLE "tpa_providers" ADD COLUMN IF NOT EXISTS "state_code" VARCHAR(2);
ALTER TABLE "suppliers"     ADD COLUMN IF NOT EXISTS "state_code" VARCHAR(2);

-- Backfill the supplier state from the GSTIN already on file. The first two
-- characters of a GSTIN are the state code, and every supplier that has one is
-- therefore already telling us its state.
UPDATE "suppliers"
   SET "state_code" = substring("gst_number" from 1 for 2)
 WHERE "state_code" IS NULL
   AND "gst_number" IS NOT NULL
   AND "gst_number" ~ '^[0-9]{2}';

CREATE INDEX IF NOT EXISTS "insurers_gstin_idx"      ON "insurers" ("gstin");
CREATE INDEX IF NOT EXISTS "tpa_providers_gstin_idx" ON "tpa_providers" ("gstin");
