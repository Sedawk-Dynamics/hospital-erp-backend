-- Remove the OT Surgical Kits feature ("Issue Bulk, Reconcile Net").
-- Drops the kit-template master, kit-issue ledger, and their item tables.
-- Child tables are dropped before their parents; CASCADE clears any leftover
-- foreign-key references defensively.

DROP TABLE IF EXISTS "ot_kit_issue_items" CASCADE;
DROP TABLE IF EXISTS "ot_kit_issues" CASCADE;
DROP TABLE IF EXISTS "surgical_kit_template_items" CASCADE;
DROP TABLE IF EXISTS "surgical_kit_templates" CASCADE;
