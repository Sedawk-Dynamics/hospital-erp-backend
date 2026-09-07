-- Give a bill the document identity the law asks for.
--
-- A GST invoice series must be unique and CONSECUTIVE for a financial year,
-- per registered person, per document type. None of the five series this system
-- already has satisfies that. They all reset daily — BILL-20260902-0001 starts
-- again tomorrow — and they are all shared across tenants, because bill_number
-- is globally unique and the generators take their maximum across every
-- hospital. Neither property is what a return needs.
--
-- So the invoice number becomes its own thing, and bill_number stays exactly
-- what it is: the internal reference staff already know and search by.
--
-- The counter row IS the sequence. `last_number` is incremented under a row
-- lock at allotment, which is what keeps the series gap-free when two counters
-- finalise in the same instant — a MAX() over existing rows cannot, because two
-- readers see the same maximum.
--
-- Allotted at FINALISE and never at draft. A draft that is abandoned would
-- otherwise burn a number and leave a hole, and a hole in an invoice series is
-- the first thing an auditor asks about.
--
-- gst_frozen_at records the moment the document was issued. After it the tax
-- figures on the bill are read-only and a correction goes through a credit
-- note — which is the law's answer, not a limitation of this system.
--
-- The unique index on invoice_number lands on a brand-new all-NULL column and
-- Postgres treats NULLs as distinct, so it cannot collide on existing rows.
-- Everything is nullable or defaulted and every statement is guarded: no
-- existing bill changes, and this is safe to replay.

CREATE TABLE IF NOT EXISTS "gst_document_series" (
    "id"             TEXT NOT NULL,
    "tenant_id"      TEXT NOT NULL,
    "document_type"  VARCHAR(30) NOT NULL,
    "financial_year" VARCHAR(7) NOT NULL,
    "prefix"         VARCHAR(24) NOT NULL,
    "last_number"    INTEGER NOT NULL DEFAULT 0,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gst_document_series_pkey" PRIMARY KEY ("id")
);

-- One counter per hospital, per document type, per year — exactly the scope the
-- law puts on a series.
--
-- The name is Prisma's own convention for a compound unique, and it has to be:
-- a database built by `db push` gets that name, and one upgraded by this file
-- would otherwise get a different one for the same index. Postgres infers the
-- conflict target of an upsert from the COLUMNS, so both work — but the two
-- databases then differ, and the next schema diff wants to rename it.
--
-- The rename comes FIRST, before the create. The other way round, the create
-- makes the correctly-named index, the rename then finds it already there and
-- skips, and the database is left carrying BOTH — two unique indexes over the
-- same three columns.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'gst_document_series_tenant_type_fy_key')
     AND NOT EXISTS (
       SELECT 1 FROM pg_class
        WHERE relname = 'gst_document_series_tenant_id_document_type_financial_year_key'
     )
  THEN
    ALTER INDEX "gst_document_series_tenant_type_fy_key"
      RENAME TO "gst_document_series_tenant_id_document_type_financial_year_key";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "gst_document_series_tenant_id_document_type_financial_year_key"
  ON "gst_document_series" ("tenant_id", "document_type", "financial_year");

DO $$ BEGIN
  ALTER TABLE "gst_document_series"
    ADD CONSTRAINT "gst_document_series_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "bills"
  ADD COLUMN IF NOT EXISTS "gst_document_type" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "invoice_number"    VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "financial_year"    VARCHAR(7),
  ADD COLUMN IF NOT EXISTS "gst_frozen_at"     TIMESTAMP(3);

-- A number may only ever belong to one document.
CREATE UNIQUE INDEX IF NOT EXISTS "bills_invoice_number_key"
  ON "bills" ("invoice_number");
