-- One value per parameter per test, enforced by the database.
--
-- Re-entering a value used to append a second LabResult instead of replacing
-- the first, so a corrected figure printed twice on the report with neither
-- marked. The entry path was fixed to delete-then-insert, and no duplicate has
-- been created since — but the rows from before that fix are still sitting on
-- their reports, which is why QA reported the bug as still present. Code alone
-- also cannot stop it: several paths write results (manual entry, OCR
-- extraction, backfill) and only one of them was doing the dedup.
--
-- Step 1 keeps the most recently entered row in each duplicate group and drops
-- the rest — the newest value is the corrected one, which is what the
-- technician meant to leave behind.
DELETE FROM "lab_results" a
USING "lab_results" b
WHERE a."lab_order_item_id" = b."lab_order_item_id"
  AND LOWER(a."parameter_name") = LOWER(b."parameter_name")
  AND (
    a."entered_at" < b."entered_at"
    -- Same instant: fall back to id so exactly one row survives either way.
    OR (a."entered_at" = b."entered_at" AND a."id" < b."id")
  );

-- Step 2 makes it impossible to reintroduce, whichever path writes.
--
-- LOWER() so "Hb" and "HB" collide: the manual path matched the parameter name
-- exactly while the OCR path compared case-insensitively, so the two disagreed
-- about whether a parameter was already present.
CREATE UNIQUE INDEX IF NOT EXISTS "lab_results_item_parameter_unique"
  ON "lab_results" ("lab_order_item_id", LOWER("parameter_name"));
