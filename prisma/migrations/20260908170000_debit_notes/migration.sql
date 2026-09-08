-- Tell a debit note from a credit note.
--
-- The review document (#9) says report A-6 is called "Credit and Debit Note
-- Register" but is only credit notes, and asks for both types shown separately.
-- It is worse than a reporting gap: the system cannot RAISE a debit note at
-- all, so the one case that needs one has nowhere to go.
--
-- The case is real and the code already names it. When a concession granted
-- after an invoice was issued is later REDUCED, money goes back ON to an issued
-- invoice — and that is a debit note under section 34, not a credit note.
-- `creditPostSupplyConcession` detects it, refuses to invent the wrong
-- document, and logs for an accountant to raise by hand.
--
-- Same table, because a debit note IS the same document with the sign the other
-- way up: same series shape, same link to the original invoice, same line-level
-- reversal, same 30 November time limit. Splitting them into two tables would
-- duplicate every one of those rules.
--
-- Defaults to 'credit', so every note already issued keeps its meaning.

ALTER TABLE "credit_notes"
  ADD COLUMN IF NOT EXISTS "note_type" VARCHAR(8) NOT NULL DEFAULT 'credit';

CREATE INDEX IF NOT EXISTS "credit_notes_tenant_note_type_idx"
  ON "credit_notes" ("tenant_id", "note_type");
