-- Hold the GSTR-2B statement the hospital downloads from the portal.
--
-- 2B is the government's record of what the hospital's SUPPLIERS have declared,
-- and a hospital may only claim input credit that appears in it. Nothing in
-- this system can produce that figure — a purchase register says what we
-- believe we bought, 2B says what the supplier admitted to selling, and the gap
-- between the two is credit at risk. So the statement is imported.
--
-- Two tables rather than one. The import is the statement: which period, which
-- GSTIN it was generated for, when it was downloaded and by whom — the
-- provenance an auditor asks for. The documents are its rows.
--
-- ONE statement per period, replaced on re-import. The portal reissues 2B for a
-- period as suppliers file late, and the latest download is the only one that
-- counts; keeping every version would leave the reconciliation asking which
-- copy it should believe.
--
-- `match_key` is the invoice number with punctuation stripped and uppercased.
-- Suppliers write the same invoice as "SUP/001", "SUP-001" and "sup 001", and
-- matching on the raw string leaves a hospital chasing credit it already has.
-- Stored rather than computed at read time so the index can be used.

CREATE TABLE IF NOT EXISTS "gstr2b_imports" (
  "id"            TEXT NOT NULL,
  "tenant_id"     TEXT NOT NULL,
  "return_period" VARCHAR(6) NOT NULL,
  "gstin"         VARCHAR(15),
  "generated_at"  TIMESTAMP(3),
  "version"       VARCHAR(20),
  "file_name"     VARCHAR(255),
  "imported_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "imported_by"   TEXT,
  "invoice_count" INTEGER NOT NULL DEFAULT 0,
  "tax_total"     DECIMAL(14,2) NOT NULL DEFAULT 0,

  CONSTRAINT "gstr2b_imports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "gstr2b_imports_tenant_id_return_period_key"
  ON "gstr2b_imports" ("tenant_id", "return_period");

CREATE INDEX IF NOT EXISTS "gstr2b_imports_tenant_id_imported_at_idx"
  ON "gstr2b_imports" ("tenant_id", "imported_at");

CREATE TABLE IF NOT EXISTS "gstr2b_documents" (
  "id"                 TEXT NOT NULL,
  "import_id"          TEXT NOT NULL,
  "tenant_id"          TEXT NOT NULL,
  "return_period"      VARCHAR(6) NOT NULL,
  "supplier_gstin"     VARCHAR(15) NOT NULL,
  "supplier_name"      VARCHAR(255),
  "document_type"      VARCHAR(12) NOT NULL,
  "document_number"    VARCHAR(60) NOT NULL,
  "match_key"          VARCHAR(60) NOT NULL,
  "document_date"      TIMESTAMP(3),
  "document_value"     DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxable_value"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  "igst_amount"        DECIMAL(14,2) NOT NULL DEFAULT 0,
  "cgst_amount"        DECIMAL(14,2) NOT NULL DEFAULT 0,
  "sgst_amount"        DECIMAL(14,2) NOT NULL DEFAULT 0,
  "cess_amount"        DECIMAL(14,2) NOT NULL DEFAULT 0,
  "tax_amount"         DECIMAL(14,2) NOT NULL DEFAULT 0,
  "place_of_supply"    VARCHAR(2),
  "itc_available"      BOOLEAN NOT NULL DEFAULT true,
  "itc_blocked_reason" VARCHAR(255),
  "supplier_filed_on"  TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gstr2b_documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gstr2b_documents_tenant_id_return_period_idx"
  ON "gstr2b_documents" ("tenant_id", "return_period");

-- The reconciliation's own lookup: supplier plus normalised invoice number.
CREATE INDEX IF NOT EXISTS "gstr2b_documents_tenant_id_supplier_gstin_match_key_idx"
  ON "gstr2b_documents" ("tenant_id", "supplier_gstin", "match_key");

DO $$ BEGIN
  ALTER TABLE "gstr2b_imports"
    ADD CONSTRAINT "gstr2b_imports_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SET NULL: the statement outlives the account that downloaded it.
DO $$ BEGIN
  ALTER TABLE "gstr2b_imports"
    ADD CONSTRAINT "gstr2b_imports_imported_by_fkey"
    FOREIGN KEY ("imported_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CASCADE: a row has no meaning without the statement it came out of, and
-- re-importing a period deletes the old statement to replace it.
DO $$ BEGIN
  ALTER TABLE "gstr2b_documents"
    ADD CONSTRAINT "gstr2b_documents_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "gstr2b_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
