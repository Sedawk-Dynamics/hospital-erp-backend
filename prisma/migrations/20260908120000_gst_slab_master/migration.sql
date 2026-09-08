-- The list of GST rates the law recognises, with the dates each was legal.
--
-- Until now nothing in the system knew which rates exist. A determination could
-- resolve to 10%, or 12%, or any other number somebody had typed onto a master
-- years ago, and it went onto an invoice and into a return unchallenged. This
-- database holds pharmacy lines billed at 10% and at 12% — neither of which is
-- a slab a hospital may charge today.
--
-- PLATFORM data, with no tenant column. A slab is not a hospital's opinion; it
-- is what Parliament has enacted, identical for everyone on the platform.
--
-- Date-ranged rather than a flat list, because the answer changed on 22
-- September 2025: the 56th GST Council meeting retired 12% and 28% and brought
-- in 40%. A bill raised in June 2025 at 12% was correct and must stay correct;
-- the same rate on a bill raised today is not. One boolean cannot say both, so
-- each slab carries the window it was legal in and the check is made AS AT the
-- bill's own date. `effective_to` NULL means "still in force".

CREATE TABLE IF NOT EXISTS "gst_slabs" (
  "id"             TEXT         NOT NULL,
  "rate_percent"   DECIMAL(5,2) NOT NULL,
  "label"          VARCHAR(40)  NOT NULL,
  "effective_from" DATE         NOT NULL,
  "effective_to"   DATE,
  "note"           VARCHAR(255),
  "is_active"      BOOLEAN      NOT NULL DEFAULT true,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gst_slabs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "gst_slabs_rate_percent_effective_from_key"
  ON "gst_slabs" ("rate_percent", "effective_from");

CREATE INDEX IF NOT EXISTS "gst_slabs_effective_from_effective_to_idx"
  ON "gst_slabs" ("effective_from", "effective_to");

-- The two windows, seeded here so a fresh database and an upgraded one agree.
-- Rates are the ones the GST report names: 0 / 5 / 12 / 18 / 28 before GST 2.0,
-- and 0 / 5 / 18 / 40 from 22 September 2025. Inserted only when the table is
-- empty, so a platform that has since edited its own list is left alone.
INSERT INTO "gst_slabs" ("id", "rate_percent", "label", "effective_from", "effective_to", "note")
SELECT * FROM (VALUES
  (gen_random_uuid()::text,  0.00, 'Nil',  DATE '2017-07-01', DATE '2025-09-21', 'Pre-GST 2.0 slab'),
  (gen_random_uuid()::text,  5.00, '5%',   DATE '2017-07-01', DATE '2025-09-21', 'Pre-GST 2.0 slab'),
  (gen_random_uuid()::text, 12.00, '12%',  DATE '2017-07-01', DATE '2025-09-21', 'Retired by the 56th GST Council, effective 22 Sep 2025'),
  (gen_random_uuid()::text, 18.00, '18%',  DATE '2017-07-01', DATE '2025-09-21', 'Pre-GST 2.0 slab'),
  (gen_random_uuid()::text, 28.00, '28%',  DATE '2017-07-01', DATE '2025-09-21', 'Retired by the 56th GST Council, effective 22 Sep 2025'),
  (gen_random_uuid()::text,  0.00, 'Nil',  DATE '2025-09-22', NULL, 'GST 2.0'),
  (gen_random_uuid()::text,  5.00, '5%',   DATE '2025-09-22', NULL, 'GST 2.0 — most medicines and medical devices'),
  (gen_random_uuid()::text, 18.00, '18%',  DATE '2025-09-22', NULL, 'GST 2.0 — nutraceuticals, cosmetic procedures, most non-medical services'),
  (gen_random_uuid()::text, 40.00, '40%',  DATE '2025-09-22', NULL, 'GST 2.0 — luxury and sin goods; not used by a hospital')
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM "gst_slabs");
