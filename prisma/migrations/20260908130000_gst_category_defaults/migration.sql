-- The category fallback the rate-resolution chain has always had a branch for
-- and never had data for.
--
-- `determineTax` step 7 reads `masters.categoryDefault`. The resolver that
-- builds the masters bundle passed the literal `null` for it on every call, for
-- every tenant, so that branch has been unreachable from any live billing path
-- since it was written — and the proof is in the data: `rate_source` on
-- bill_items is legacy, room_rule or no_rule, and never once category_default.
--
-- What it is for, in the GST report's own words: "Used when an item has not
-- been mapped to a code yet, so nothing is ever billed at a guessed rate." The
-- Changes document adds the safety rule that makes it usable — a fallback
-- cannot silently override an approved item-level classification, and an
-- unmapped TAXABLE item cannot be finalised without authorised resolution. The
-- engine already honours both: the default sits BELOW the item master and the
-- code masters in the chain, and anything it makes taxable is flagged
-- `requiresResolution`, which the finalisation gate refuses.
--
-- PLATFORM data with no tenant column, like the HSN and SAC masters beside it:
-- "consultation is exempt" is not a hospital's opinion.

CREATE TABLE IF NOT EXISTS "gst_category_defaults" (
  "id"           TEXT         NOT NULL,
  -- One of the engine's SupplyKind values: medicine, consumable, room,
  -- procedure, consultation, lab, imaging, nursing, registration, other.
  "supply_kind"  VARCHAR(20)  NOT NULL,
  "rate_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  -- 'taxable' | 'exempt' | 'nil_rated' | 'non_gst' | 'zero_rated'.
  "treatment"    VARCHAR(20)  NOT NULL DEFAULT 'exempt',
  "description"  VARCHAR(255),
  "is_active"    BOOLEAN      NOT NULL DEFAULT true,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gst_category_defaults_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "gst_category_defaults_supply_kind_key"
  ON "gst_category_defaults" ("supply_kind");

-- Seeded from the master rate table in section 3.1 of the GST report. Every one
-- of these is the legally correct default for a clinical establishment, which
-- is why they are exempt: healthcare is exempt in India and tax is the
-- exception. Only inserted when the table is empty, so a platform that has
-- since edited its own list is left alone.
INSERT INTO "gst_category_defaults" ("id", "supply_kind", "rate_percent", "treatment", "description")
SELECT * FROM (VALUES
  (gen_random_uuid()::text, 'consultation',  0.00, 'exempt',  'Doctor consultation / OPD visit — healthcare service'),
  (gen_random_uuid()::text, 'lab',           0.00, 'exempt',  'Laboratory and diagnostic services'),
  (gen_random_uuid()::text, 'imaging',       0.00, 'exempt',  'Diagnostic imaging — X-ray, CT, MRI, ECG'),
  (gen_random_uuid()::text, 'procedure',     0.00, 'exempt',  'Therapeutic procedures and surgery'),
  (gen_random_uuid()::text, 'nursing',       0.00, 'exempt',  'Nursing and inpatient treatment charges'),
  (gen_random_uuid()::text, 'room',          0.00, 'exempt',  'Accommodation — the room rule decides the rate'),
  (gen_random_uuid()::text, 'registration',  0.00, 'exempt',  'Registration fee — the hospital setting decides the rate'),
  -- Goods are the one place a default of exempt would be wrong: a medicine
  -- with no HSN is an unfinished setup, not an exempt supply. 5% is the slab
  -- almost every finished medicine carries, and the engine flags anything this
  -- branch makes taxable so it cannot be finalised unresolved.
  (gen_random_uuid()::text, 'medicine',      5.00, 'taxable', 'Medicines with no HSN mapped yet — flagged for resolution'),
  (gen_random_uuid()::text, 'consumable',    5.00, 'taxable', 'Consumables with no HSN mapped yet — flagged for resolution'),
  (gen_random_uuid()::text, 'other',         0.00, 'exempt',  'Anything not otherwise classified')
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM "gst_category_defaults");
