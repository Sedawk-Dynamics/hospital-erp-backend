# Nurse Assignments & Vital Corrections

Backend design notes for the nurse-hierarchy feature.

## NurseAssignment model

One row per (admission, shift) covering the IPD nurse-to-bed assignment. OPD admissions are explicitly rejected at the service layer.

| Field | Notes |
|-------|-------|
| `admissionId` | FK to `Admission`; must be `status=admitted` at create time. |
| `nurseId` | FK to `User`. |
| `wardId`, `bedId` | Defaults copied from the admission when not specified. |
| `shiftDate` + `shiftType` | Key for partial uniqueness (see below). |
| `assignedById` | Actor creating the row. For `nurse_incharge`-driven assignment this is always the in-charge user; for bulk handovers it is the caller (in-charge or system). |
| `status` | `active` (default), `ended`, `handed_over`, `cancelled`. |
| `handedOverToId` / `handedOverAt` / `handoverNoteId` | Populated when a new row is created from this row via handover. The previous row transitions to `handed_over`. |

### Partial unique index

Prisma cannot express partial uniques declaratively, so the migration SQL must include (see `prisma/sql/nurse_assignment_partial_unique.sql`):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_nurse_assignment_active
  ON nurse_assignments (admission_id, shift_date, shift_type)
  WHERE status = 'active';
```

This enforces "at most one active assignment per admission per shift" without blocking historic rows.

## Vital correction flow

Core constants live in `clinical.service.ts`:

- `VITAL_SELF_CORRECTION_WINDOW_MS = 15 * 60 * 1000` (15 min).
- `VITAL_SELF_CORRECT_ROLES = {'nurse', 'nurse_incharge'}` — these roles can silently fix their own entries within the grace window.

Decision matrix for `POST /clinical/vitals/:id/correct`:

| Caller role | Grace window? | Same user as `recordedBy`? | Result |
|-------------|---------------|-----------------------------|--------|
| nurse / nurse_incharge | yes | yes | in-place update (mode `self-correct-silent`) |
| nurse / nurse_incharge | no | any | new Vital row with `supersedesVitalId`, `isCorrection=true` (mode `audited-correction`) |
| nurse / nurse_incharge | yes | no | audited-correction (cross-nurse) |
| doctor | any | any | audited-correction — doctors never silent-edit |
| anyone else with `vitals:update` | any | any | audited-correction |

Additional guard: you cannot correct a row that has already been superseded — the service returns 400 and asks the caller to correct the newest row in the chain. This keeps the supersede chain linear.

## Order acknowledgements

The existing `POST /clinical/orders/acknowledge` endpoint records an ack by creating a `NursingNote` with `metadata = { kind: 'order_acknowledgment', orderType, orderId }`. This avoids a schema change.

`GET /clinical/orders/acknowledgements?scope=mine|ward|all&wardId=&status=&orderType=` aggregates lab + imaging orders and joins the ack metadata in-process. `scope=mine` filters admissions via the caller's active NurseAssignments; `scope=ward` requires `wardId` and filters through current admissions.

## Duty rosters

Routes remain under `/hr/rosters*` but are gated on `duty_rosters:*` permissions so `nurse_admin` can operate them without full HR access. The overlap check was relaxed from "one roster per staff per date" to "one per staff per shiftType per date", enabling split shifts.

`POST /hr/rosters/bulk` performs a best-effort loop with per-entry error reporting (no single-transaction rollback — intentional so partial failures don't invalidate the whole plan).

`PATCH /hr/rosters/:id/publish` sets `status = published` and stamps `approvedBy` + `approvedAt`. Only `scheduled` rows can be published.
