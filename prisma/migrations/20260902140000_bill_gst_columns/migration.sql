-- Give a bill line somewhere to record the tax it actually carried.
--
-- `bill_items` has had `tax_percent` and `tax_amount` since the beginning, and
-- between them they answer one question: how much. Every other question a GST
-- return asks is unanswerable from those two numbers.
--
--   * WHAT KIND of supply was it? A zero on a consultation line is an exempt
--     healthcare service; a zero on an ORS line is nil-rated goods. GSTR-1
--     table 8 and GSTR-3B 3.1(c)/(e) report those separately, and a percentage
--     cannot tell them apart.
--   * UNDER WHICH CODE? GSTR-1 table 12 is an HSN/SAC summary. Nothing on a
--     bill line records a code today.
--   * SPLIT HOW? CGST, SGST and IGST are three separate columns on the return
--     and three separate ledgers at the department. The pharmacy receipt is the
--     only place in the system they appear at all, and it derives them by
--     halving the total in the browser at print time and then throwing them
--     away.
--   * TAX ON WHAT VALUE? For a medicine at MRP the taxable value is the price
--     with the tax dug back out of it, and it is the figure the return wants —
--     not the price the patient paid.
--   * AND WHY THAT RATE? So the counter can answer a patient without reading
--     the source, and so an auditor can see which lines were classified by a
--     rule and which by a fallback.
--
-- `requires_tax_resolution` is the safety catch: a line that came out taxable
-- only because a category default filled a blank is a guessed rate, and a
-- guessed tax rate on a patient's bill is indefensible. The finalisation gate
-- reads this column.
--
-- The same rollup goes on `bills`, alongside the three facts that decide the
-- split. Those are SNAPSHOTS by design — the hospital's GSTIN may change, but
-- this bill was raised under the one recorded on it, and an old bill has to
-- stay explainable.
--
-- BACKFILL, and its limits. Historic rows are given a taxable value, a
-- treatment and a CGST/SGST split derived from the tax they already carry.
-- NO MONEY MOVES: taxable_value + tax_amount reproduces total_amount exactly,
-- and cgst + sgst reproduces tax_amount exactly. This is describing what those
-- bills already say, not restating them — old bills are never re-rated, which
-- is the hospital's own instruction. Every historic line is treated as
-- intra-state because there was no place of supply to say otherwise, and that
-- is what those bills were in fact.
--
-- Every column is nullable or defaulted, so the additive step is safe on its
-- own and every statement is guarded: safe to replay.

ALTER TABLE "bill_items"
  ADD COLUMN IF NOT EXISTS "hsn_sac_code"            VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "gst_treatment"           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "tax_inclusive"           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "taxable_value"           DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cgst_rate"               DECIMAL(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cgst_amount"             DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sgst_rate"               DECIMAL(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sgst_amount"             DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "igst_rate"               DECIMAL(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "igst_amount"             DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cess_amount"             DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rate_source"             VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "tax_reason"              VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "requires_tax_resolution" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "bills"
  ADD COLUMN IF NOT EXISTS "taxable_value"              DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cgst_amount"                DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sgst_amount"                DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "igst_amount"                DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cess_amount"                DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "round_off"                  DECIMAL(6,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "supplier_gstin"             VARCHAR(15),
  ADD COLUMN IF NOT EXISTS "supplier_state_code"        VARCHAR(2),
  ADD COLUMN IF NOT EXISTS "recipient_gstin"            VARCHAR(15),
  ADD COLUMN IF NOT EXISTS "place_of_supply_state_code" VARCHAR(2),
  ADD COLUMN IF NOT EXISTS "is_inter_state"             BOOLEAN NOT NULL DEFAULT false;

-- GSTR-1 table 12 groups by code across a whole period.
CREATE INDEX IF NOT EXISTS "bill_items_hsn_sac_code_idx" ON "bill_items" ("hsn_sac_code");
-- Finding the lines that are holding a bill back from being finalised.
CREATE INDEX IF NOT EXISTS "bill_items_requires_tax_resolution_idx"
  ON "bill_items" ("requires_tax_resolution");

-- ── Describe the history, without restating it ────────────────────────────
-- Guarded on gst_treatment being null so a replay is a no-op.

UPDATE "bill_items"
   SET "taxable_value" = ROUND("total_amount" - "tax_amount", 2),
       "gst_treatment" = CASE WHEN "tax_percent" > 0 THEN 'taxable' ELSE 'exempt' END,
       -- Everything billed before there was a place of supply was intra-state,
       -- because the patient was standing in the hospital.
       "cgst_rate"   = ROUND("tax_percent" / 2, 2),
       "sgst_rate"   = ROUND("tax_percent" / 2, 2),
       "cgst_amount" = ROUND("tax_amount" / 2, 2),
       "sgst_amount" = ROUND("tax_amount" - ROUND("tax_amount" / 2, 2), 2),
       "rate_source" = 'legacy'
 WHERE "gst_treatment" IS NULL;

UPDATE "bills" b
   SET "taxable_value" = COALESCE(t.taxable, 0),
       "cgst_amount"   = COALESCE(t.cgst, 0),
       "sgst_amount"   = COALESCE(t.sgst, 0)
  FROM (
        SELECT "bill_id",
               SUM("taxable_value") AS taxable,
               SUM("cgst_amount")   AS cgst,
               SUM("sgst_amount")   AS sgst
          FROM "bill_items"
         GROUP BY "bill_id"
       ) t
 WHERE t."bill_id" = b."id"
   AND b."taxable_value" = 0;
