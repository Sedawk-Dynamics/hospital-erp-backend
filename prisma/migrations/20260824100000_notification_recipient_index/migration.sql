-- The `notifications` table had NO index at all.
--
-- The bell polls every 30 seconds for every signed-in user, and each poll runs
-- an unread COUNT plus a paged list, both keyed on the recipient. Against a
-- table with no index that is a sequential scan per user per half-minute —
-- fine on dev data, expensive as soon as a hospital has real traffic.
--
-- Keyed on `user_id` rather than `(tenant_id, user_id)`: a notification names
-- exactly one user and the reads are scoped by the token's user, not by the
-- session tenant. They have to be — a patient's account lives on the platform
-- tenant while notifications about their care carry the hospital's tenant, so
-- a tenant-scoped read never matched and patients received nothing.
--
-- `is_read DESC, created_at DESC` matches how the list is actually read:
-- unread first, newest first.
CREATE INDEX IF NOT EXISTS "notifications_user_id_is_read_created_at_idx"
  ON "notifications" ("user_id", "is_read", "created_at" DESC);

-- Reference lookups (does an open alert already exist for this batch / claim?)
-- scan by reference rather than by recipient.
CREATE INDEX IF NOT EXISTS "notifications_tenant_id_reference_type_reference_id_idx"
  ON "notifications" ("tenant_id", "reference_type", "reference_id");
