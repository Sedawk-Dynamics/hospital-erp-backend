-- Test Report 3, C16: "Nurse and Nurse Admin should also have ward-to-ward
-- transfer authority (currently only Front Desk can transfer)."
--
-- POST /clinical/transfers was gated on `admissions:create`, which also grants
-- admitting a patient, opening a reservation, and raising or cancelling an IP
-- request. Granting that to nursing to let them move a patient between wards
-- would have handed them the admission counter as well.
--
-- The transfer now has its own permission. Placement (ward_to_ward,
-- bed_to_bed) is what nursing gets; doctor_to_doctor reassigns clinical
-- responsibility and is refused for placement-only roles in the service.
--
-- IMPORTANT: this must also grant the roles that could already transfer
-- (admin, doctor, front_desk) or the route they use every day would start
-- returning 403.

INSERT INTO "permissions" ("id", "module", "action", "description")
SELECT gen_random_uuid(), 'patient_transfers', v.action, v.descr
FROM (VALUES
  ('create', 'Move an admitted patient (ward/bed) or hand over the consultant'),
  ('approve', 'Approve a requested patient transfer')
) AS v(action, descr)
WHERE NOT EXISTS (
  SELECT 1 FROM "permissions" p
   WHERE p."module" = 'patient_transfers' AND p."action" = v.action
);

-- admin and super_admin hold every module by construction; the rest are named.
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT gen_random_uuid(), r."id", p."id"
FROM "roles" r
JOIN "permissions" p
  ON p."module" = 'patient_transfers'
 AND p."action" IN ('create', 'approve')
WHERE r."name" IN ('admin', 'super_admin', 'doctor', 'front_desk', 'nurse', 'nurse_admin')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
