-- The tax master for SERVICES, which this system has never had.
--
-- `hsn_gst_rates` has classified GOODS since the pharmacy work landed, and it
-- works: scan an HSN at stock inward and the right GST fills itself in. There
-- was never an equivalent for services, and a hospital sells far more services
-- than goods — consultation, surgery, nursing, diagnostics, accommodation.
--
-- The consequence is visible in the live data. Every service rate in the system
-- today is either hard-coded to zero in the source or typed by hand at the
-- counter, and the typing shows: registration fees recorded at 10%, procedures
-- at 2%, "other" at 2%, and the same X-Ray priced at 0%, 5% and 10% on three
-- different tariff rows. None of those are rates that exist in law.
--
-- Same shape and same rules as hsn_gst_rates deliberately, so there is one way
-- to think about both: platform reference data with no tenant_id, matched by
-- LONGEST PREFIX so 999312 (medical and dental services) beats its heading 9993
-- (human health services).
--
-- `treatment` carries more weight here than on the goods side. Almost every
-- healthcare SAC is EXEMPT under Notification 12/2017-Central Tax (Rate) rather
-- than nil-rated or taxable-at-zero, and exempt turnover is reported on its own
-- return line — as well as being the numerator of the Rule 42 input-credit
-- reversal the hospital computes monthly. Recording these as "0%" would lose
-- the one number that calculation needs.
--
-- Creates nothing that existing code reads, so it cannot change any bill.
-- IF NOT EXISTS throughout: the table is created by `prisma db push` on deploy,
-- so this file is the written record and must be safe to replay.

CREATE TABLE IF NOT EXISTS "sac_codes" (
    "id"          TEXT NOT NULL,
    "sac_code"    VARCHAR(20) NOT NULL,
    "description" VARCHAR(255),
    "gst_rate"    DECIMAL(5,2) NOT NULL,
    "treatment"   VARCHAR(20),
    "category"    VARCHAR(60),
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sac_codes_pkey" PRIMARY KEY ("id")
);

-- One row per code, so a longest-prefix match can never find two answers.
CREATE UNIQUE INDEX IF NOT EXISTS "sac_codes_sac_code_key" ON "sac_codes" ("sac_code");

-- Every read filters on it.
CREATE INDEX IF NOT EXISTS "sac_codes_is_active_idx" ON "sac_codes" ("is_active");
