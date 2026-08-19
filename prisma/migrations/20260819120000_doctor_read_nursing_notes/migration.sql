-- Test Report 3, C2: "Doctor cannot see notes entered by the nurse in the same
-- patient encounter."
--
-- The consultation page has a Nursing Notes panel and NursingNote.visitId has
-- always been filterable, but GET /progress-notes/nursing is gated by
-- requirePermission('nursing_notes', 'read') -- and that middleware resolves
-- against this table, not the seed file. No tenant's `doctor` role ever had a
-- nursing_notes row, so the request 403'd and the panel rendered empty. From
-- the doctor's chair that is indistinguishable from the notes not existing.
--
-- READ ONLY on purpose. Nursing notes are nursing's record; a doctor's own
-- observations belong in progress_notes, which they already own outright.

-- The permission itself is seeded for the nurse roles, but a tenant created
-- before nursing_notes existed could be missing the row entirely.
INSERT INTO "permissions" ("id", "module", "action", "description")
SELECT gen_random_uuid(), 'nursing_notes', 'read', 'View nursing notes'
WHERE NOT EXISTS (
  SELECT 1 FROM "permissions" WHERE "module" = 'nursing_notes' AND "action" = 'read'
);

-- Grant it to every tenant's doctor role. ON CONFLICT keeps this re-runnable
-- and a no-op for any tenant that somehow already has it.
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."name" = 'doctor'
  AND p."module" = 'nursing_notes'
  AND p."action" = 'read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
