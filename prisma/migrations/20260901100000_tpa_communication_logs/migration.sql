-- Make the TPA communication log writable for the claims that actually exist.
--
-- `tpa_communication_logs` has been in the schema since the insurance module
-- was built and has never held a row, because nothing in the codebase writes
-- one. Building the write path exposed three reasons it would have stayed
-- empty even after it was built:
--
-- 1. `tpa_id` was NOT NULL, but a claim reaches its TPA through
--    `insurance_policies.tpa_id`, which is nullable — and on the live data
--    EVERY policy has it null and there are no `tpa_providers` at all. Staff
--    worked around the gap by naming insurers "Pending TPA Assignment" and
--    "TPA  1". A required tpa_id would therefore have excluded 100% of real
--    claims and shipped the feature dead a second time. It is now optional:
--    recorded when the policy names a TPA, absent when the hospital deals with
--    the insurer directly.
--
-- 2. There was no way to attach a log to a pre-authorization, even though a
--    pre-auth IS the TPA conversation — request, approval, denial, query hold.
--    `pre_auth_id` fixes that; a log now hangs off a claim, a pre-auth, or
--    neither (a general enquiry).
--
-- 3. Nothing distinguished an entry the system recorded from one a person
--    typed. An audit trail that cannot tell those apart invites reading
--    machine-written rows as somebody's account of a phone call, so
--    `is_system` marks the automatic ones.
--
-- Safe to replay, and safe on data: the table is empty, every change is a
-- widening, and existing inserts that supply tpa_id keep working.

ALTER TABLE "tpa_communication_logs" ALTER COLUMN "tpa_id" DROP NOT NULL;

ALTER TABLE "tpa_communication_logs" ADD COLUMN IF NOT EXISTS "pre_auth_id" TEXT;

ALTER TABLE "tpa_communication_logs" ADD COLUMN IF NOT EXISTS "is_system" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
    ALTER TABLE "tpa_communication_logs"
        ADD CONSTRAINT "tpa_communication_logs_pre_auth_id_fkey"
        FOREIGN KEY ("pre_auth_id") REFERENCES "pre_authorization_requests" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- The log is read newest-first for one hospital, and filtered to one claim or
-- one pre-auth from their detail pages.
CREATE INDEX IF NOT EXISTS "tpa_communication_logs_tenant_id_created_at_idx"
    ON "tpa_communication_logs" ("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "tpa_communication_logs_claim_id_idx"
    ON "tpa_communication_logs" ("claim_id");

CREATE INDEX IF NOT EXISTS "tpa_communication_logs_pre_auth_id_idx"
    ON "tpa_communication_logs" ("pre_auth_id");
