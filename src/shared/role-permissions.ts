/**
 * System roles and their permission mappings.
 * Used by both the seed script and tenant creation service
 * to bootstrap RBAC for every tenant.
 */

// Pharmacy has exactly TWO roles: `pharmacist` (operational counter — dispense,
// patient returns) and `pharmacy_admin` (full management — formulary, batches,
// recalls, purchase, reports, inventory). The legacy `pharmacy_technician` was
// folded into `pharmacist` (see backfill-pharmacy-roles.ts).
export const SYSTEM_ROLE_NAMES = [
  'super_admin', 'admin', 'doctor', 'patient', 'nurse', 'nurse_admin',
  'front_desk', 'lab_technician', 'lab_supervisor', 'radiology_admin', 'radiologist', 'pharmacist',
  'pharmacy_admin', 'inventory_manager',
  'billing_admin', 'cashier', 'insurance_staff', 'blood_bank_staff', 'hr_staff',
] as const;

export const PERMISSION_MODULES = [
  'auth', 'tenants', 'users', 'roles', 'departments', 'floors', 'wards', 'beds',
  'patients', 'appointments', 'visits', 'admissions', 'vitals', 'diagnoses',
  'progress_notes', 'nursing_notes', 'prescriptions', 'lab_orders', 'lab_reports',
  'imaging', 'pharmacy', 'inventory', 'billing', 'payments', 'insurance',
  'blood_bank', 'hr', 'notifications', 'tickets', 'reports', 'audit_logs', 'compliance',
  'forms', 'nurse_assignments', 'duty_rosters',
] as const;

export const PERMISSION_ACTIONS = ['create', 'read', 'update', 'delete', 'export', 'approve'] as const;

interface PermissionDef {
  module: string;
  action: string;
}

export function getRolePermissions(): Record<string, PermissionDef[]> {
  const allPermissions: PermissionDef[] = [];
  for (const mod of PERMISSION_MODULES) {
    for (const action of PERMISSION_ACTIONS) {
      allPermissions.push({ module: mod, action });
    }
  }

  return {
    super_admin: allPermissions,

    admin: [
      { module: 'users', action: 'create' }, { module: 'users', action: 'read' }, { module: 'users', action: 'update' }, { module: 'users', action: 'delete' }, { module: 'users', action: 'export' },
      { module: 'roles', action: 'create' }, { module: 'roles', action: 'read' }, { module: 'roles', action: 'update' }, { module: 'roles', action: 'delete' },
      { module: 'departments', action: 'create' }, { module: 'departments', action: 'read' }, { module: 'departments', action: 'update' }, { module: 'departments', action: 'delete' },
      { module: 'floors', action: 'create' }, { module: 'floors', action: 'read' }, { module: 'floors', action: 'update' }, { module: 'floors', action: 'delete' },
      { module: 'wards', action: 'create' }, { module: 'wards', action: 'read' }, { module: 'wards', action: 'update' }, { module: 'wards', action: 'delete' },
      { module: 'beds', action: 'create' }, { module: 'beds', action: 'read' }, { module: 'beds', action: 'update' }, { module: 'beds', action: 'delete' },
      { module: 'patients', action: 'create' }, { module: 'patients', action: 'read' }, { module: 'patients', action: 'update' }, { module: 'patients', action: 'export' },
      { module: 'appointments', action: 'create' }, { module: 'appointments', action: 'read' }, { module: 'appointments', action: 'update' }, { module: 'appointments', action: 'delete' }, { module: 'appointments', action: 'export' },
      { module: 'visits', action: 'read' }, { module: 'visits', action: 'update' },
      { module: 'admissions', action: 'read' }, { module: 'admissions', action: 'update' }, { module: 'admissions', action: 'approve' },
      { module: 'vitals', action: 'read' },
      { module: 'diagnoses', action: 'read' },
      { module: 'progress_notes', action: 'read' },
      { module: 'nursing_notes', action: 'read' },
      { module: 'prescriptions', action: 'read' },
      // Hospital admin manages the lab test catalog end-to-end (clone from
      // platform templates, edit parameters, archive). Lab supervisor keeps
      // the same `update` perm too, but the service-layer guard restricts
      // supervisors to the /price endpoint so they cannot mutate parameters.
      { module: 'lab_orders', action: 'read' }, { module: 'lab_orders', action: 'create' },
      { module: 'lab_orders', action: 'update' }, { module: 'lab_orders', action: 'delete' },
      { module: 'lab_orders', action: 'approve' },
      { module: 'lab_reports', action: 'read' }, { module: 'lab_reports', action: 'approve' }, { module: 'lab_reports', action: 'export' },
      { module: 'imaging', action: 'read' }, { module: 'imaging', action: 'approve' },
      { module: 'pharmacy', action: 'read' }, { module: 'pharmacy', action: 'update' }, { module: 'pharmacy', action: 'approve' },
      { module: 'inventory', action: 'create' }, { module: 'inventory', action: 'read' }, { module: 'inventory', action: 'update' }, { module: 'inventory', action: 'delete' }, { module: 'inventory', action: 'approve' }, { module: 'inventory', action: 'export' },
      { module: 'forms', action: 'create' }, { module: 'forms', action: 'read' }, { module: 'forms', action: 'update' }, { module: 'forms', action: 'approve' }, { module: 'forms', action: 'export' },
      { module: 'billing', action: 'create' }, { module: 'billing', action: 'read' }, { module: 'billing', action: 'update' }, { module: 'billing', action: 'delete' }, { module: 'billing', action: 'approve' }, { module: 'billing', action: 'export' },
      { module: 'payments', action: 'create' }, { module: 'payments', action: 'read' }, { module: 'payments', action: 'update' }, { module: 'payments', action: 'approve' },
      { module: 'insurance', action: 'create' }, { module: 'insurance', action: 'read' }, { module: 'insurance', action: 'update' }, { module: 'insurance', action: 'approve' }, { module: 'insurance', action: 'export' },
      { module: 'blood_bank', action: 'read' }, { module: 'blood_bank', action: 'update' }, { module: 'blood_bank', action: 'approve' },
      { module: 'hr', action: 'create' }, { module: 'hr', action: 'read' }, { module: 'hr', action: 'update' }, { module: 'hr', action: 'approve' }, { module: 'hr', action: 'export' },
      { module: 'notifications', action: 'create' }, { module: 'notifications', action: 'read' }, { module: 'notifications', action: 'update' }, { module: 'notifications', action: 'delete' },
      { module: 'tickets', action: 'create' }, { module: 'tickets', action: 'read' }, { module: 'tickets', action: 'update' }, { module: 'tickets', action: 'approve' },
      { module: 'compliance', action: 'create' }, { module: 'compliance', action: 'read' }, { module: 'compliance', action: 'update' }, { module: 'compliance', action: 'approve' },
      { module: 'reports', action: 'create' }, { module: 'reports', action: 'read' }, { module: 'reports', action: 'export' },
      { module: 'audit_logs', action: 'read' }, { module: 'audit_logs', action: 'export' },
    ],

    doctor: [
      { module: 'patients', action: 'read' }, { module: 'patients', action: 'create' }, { module: 'patients', action: 'update' },
      { module: 'appointments', action: 'read' }, { module: 'appointments', action: 'create' }, { module: 'appointments', action: 'update' },
      { module: 'visits', action: 'read' }, { module: 'visits', action: 'create' }, { module: 'visits', action: 'update' },
      { module: 'admissions', action: 'read' }, { module: 'admissions', action: 'create' }, { module: 'admissions', action: 'update' },
      // Vitals are owned by the nursing team. Doctors can read but never create
      // or correct — corrections are append-only and limited to nursing roles.
      { module: 'vitals', action: 'read' },
      { module: 'diagnoses', action: 'read' }, { module: 'diagnoses', action: 'create' }, { module: 'diagnoses', action: 'update' }, { module: 'diagnoses', action: 'delete' },
      { module: 'progress_notes', action: 'read' }, { module: 'progress_notes', action: 'create' }, { module: 'progress_notes', action: 'update' }, { module: 'progress_notes', action: 'approve' },
      { module: 'prescriptions', action: 'read' }, { module: 'prescriptions', action: 'create' }, { module: 'prescriptions', action: 'update' },
      { module: 'lab_orders', action: 'read' }, { module: 'lab_orders', action: 'create' }, { module: 'lab_reports', action: 'read' },
      { module: 'imaging', action: 'read' }, { module: 'imaging', action: 'create' },
      { module: 'billing', action: 'read' }, { module: 'payments', action: 'read' },
      { module: 'forms', action: 'read' }, { module: 'forms', action: 'create' }, { module: 'forms', action: 'approve' },
    ],

    patient: [
      { module: 'patients', action: 'read' }, { module: 'appointments', action: 'read' }, { module: 'appointments', action: 'create' },
      { module: 'billing', action: 'read' }, { module: 'payments', action: 'read' },
      { module: 'lab_reports', action: 'read' }, { module: 'imaging', action: 'read' }, { module: 'prescriptions', action: 'read' },
      { module: 'forms', action: 'read' }, { module: 'forms', action: 'create' },
    ],

    nurse: [
      { module: 'patients', action: 'read' }, { module: 'patients', action: 'update' },
      { module: 'appointments', action: 'read' }, { module: 'appointments', action: 'update' },
      { module: 'visits', action: 'read' }, { module: 'visits', action: 'update' },
      { module: 'admissions', action: 'read' }, { module: 'admissions', action: 'update' },
      { module: 'vitals', action: 'read' }, { module: 'vitals', action: 'create' }, { module: 'vitals', action: 'update' },
      { module: 'diagnoses', action: 'read' },
      { module: 'nursing_notes', action: 'read' }, { module: 'nursing_notes', action: 'create' }, { module: 'nursing_notes', action: 'update' },
      { module: 'progress_notes', action: 'read' },
      { module: 'prescriptions', action: 'read' }, { module: 'prescriptions', action: 'update' },
      { module: 'lab_orders', action: 'read' }, { module: 'lab_reports', action: 'read' },
      { module: 'imaging', action: 'read' },
      { module: 'nurse_assignments', action: 'read' },
      // Read-only on the duty roster so the nurse dashboard can detect "what
      // shift am I on right now" from /hr/rosters/active and render rostered
      // hours instead of the hardcoded clock fallback.
      { module: 'duty_rosters', action: 'read' },
      { module: 'forms', action: 'read' }, { module: 'forms', action: 'create' }, { module: 'forms', action: 'approve' },
    ],

    // Single nursing-management role. Owns nurse-to-doctor assignment,
    // ward/floor management, shift planning, and shift handover. Read-only
    // on clinical data — vitals/notes/prescriptions are written by `nurse`.
    nurse_admin: [
      // Clinical read-through (no writes — vitals are nurse-owned)
      { module: 'patients', action: 'read' },
      { module: 'appointments', action: 'read' },
      { module: 'visits', action: 'read' },
      { module: 'admissions', action: 'read' },
      { module: 'vitals', action: 'read' },
      { module: 'diagnoses', action: 'read' },
      { module: 'nursing_notes', action: 'read' },
      { module: 'progress_notes', action: 'read' },
      { module: 'prescriptions', action: 'read' },
      { module: 'lab_orders', action: 'read' }, { module: 'lab_reports', action: 'read' },
      { module: 'imaging', action: 'read' },
      // Nurse-to-doctor / nurse-to-patient assignment lifecycle
      { module: 'nurse_assignments', action: 'create' }, { module: 'nurse_assignments', action: 'read' },
      { module: 'nurse_assignments', action: 'update' }, { module: 'nurse_assignments', action: 'delete' },
      { module: 'nurse_assignments', action: 'approve' },
      // Shift planning (full lifecycle)
      { module: 'duty_rosters', action: 'create' }, { module: 'duty_rosters', action: 'read' },
      { module: 'duty_rosters', action: 'update' }, { module: 'duty_rosters', action: 'delete' },
      { module: 'duty_rosters', action: 'approve' }, { module: 'duty_rosters', action: 'export' },
      // Ward / floor / bed management
      { module: 'departments', action: 'read' },
      { module: 'floors', action: 'create' }, { module: 'floors', action: 'read' },
      { module: 'floors', action: 'update' }, { module: 'floors', action: 'delete' },
      { module: 'wards', action: 'create' }, { module: 'wards', action: 'read' },
      { module: 'wards', action: 'update' }, { module: 'wards', action: 'delete' },
      { module: 'beds', action: 'create' }, { module: 'beds', action: 'read' },
      { module: 'beds', action: 'update' }, { module: 'beds', action: 'delete' },
      // Manage nursing staff records
      { module: 'users', action: 'read' },
      { module: 'hr', action: 'read' }, { module: 'hr', action: 'approve' }, { module: 'hr', action: 'export' },
      // Compliance / audit / reporting
      { module: 'compliance', action: 'read' }, { module: 'compliance', action: 'create' },
      { module: 'compliance', action: 'update' }, { module: 'compliance', action: 'approve' },
      { module: 'forms', action: 'read' }, { module: 'forms', action: 'approve' },
      { module: 'audit_logs', action: 'read' },
      { module: 'reports', action: 'read' }, { module: 'reports', action: 'create' }, { module: 'reports', action: 'export' },
    ],

    front_desk: [
      { module: 'patients', action: 'read' }, { module: 'patients', action: 'create' }, { module: 'patients', action: 'update' },
      { module: 'appointments', action: 'read' }, { module: 'appointments', action: 'create' }, { module: 'appointments', action: 'update' },
      // Front desk owns the admission counter per the SOW: take the
      // request, allocate ward/bed, generate the admission slip. They
      // need read-through on infrastructure and write on visits/admissions.
      { module: 'visits', action: 'read' }, { module: 'visits', action: 'create' }, { module: 'visits', action: 'update' },
      { module: 'admissions', action: 'read' }, { module: 'admissions', action: 'create' }, { module: 'admissions', action: 'update' },
      { module: 'floors', action: 'read' },
      { module: 'wards', action: 'read' },
      { module: 'beds', action: 'read' },
      { module: 'billing', action: 'read' }, { module: 'billing', action: 'create' },
      { module: 'payments', action: 'read' }, { module: 'payments', action: 'create' },
      { module: 'departments', action: 'read' },
      { module: 'forms', action: 'read' }, { module: 'forms', action: 'create' }, { module: 'forms', action: 'approve' },
    ],

    lab_technician: [
      { module: 'lab_orders', action: 'read' }, { module: 'lab_orders', action: 'update' },
      { module: 'lab_reports', action: 'read' }, { module: 'lab_reports', action: 'create' }, { module: 'lab_reports', action: 'update' },
      { module: 'patients', action: 'read' },
    ],

    lab_supervisor: [
      { module: 'lab_orders', action: 'read' }, { module: 'lab_orders', action: 'create' }, { module: 'lab_orders', action: 'update' }, { module: 'lab_orders', action: 'approve' },
      { module: 'lab_reports', action: 'read' }, { module: 'lab_reports', action: 'create' }, { module: 'lab_reports', action: 'update' }, { module: 'lab_reports', action: 'approve' },
      { module: 'patients', action: 'read' },
    ],

    // Radiologist (clinical role): receives orders that the radiology_admin
    // has already payment-verified, schedules slots, performs the study,
    // drafts the report, marks it complete (status=finalized). Cannot
    // publish — admin re-approves the finalized report and only then
    // is it visible to the patient. So `imaging:approve` lives on
    // radiology_admin/admin, NOT on radiologist (2026-05-27 flow change).
    radiologist: [
      { module: 'imaging', action: 'read' }, { module: 'imaging', action: 'create' },
      { module: 'imaging', action: 'update' },
      { module: 'patients', action: 'read' },
      // Read-through on linked modules so the radiologist UI can show the
      // ordering doctor, ward, visit context without separate fetch errors.
      { module: 'visits', action: 'read' },
      { module: 'appointments', action: 'read' },
      { module: 'lab_reports', action: 'read' },
      { module: 'reports', action: 'read' },
    ],

    // Radiology Admin (operational role): owns the whole radiology surface —
    // modality catalog, tariffs, scheduling, vendor purchases, billing
    // reconciliation, team workload, analytics. Mirrors the lab_supervisor
    // posture inside the radiology module. Does NOT replace the radiologist
    // (clinical sign-off stays with them).
    radiology_admin: [
      { module: 'imaging', action: 'create' }, { module: 'imaging', action: 'read' },
      { module: 'imaging', action: 'update' }, { module: 'imaging', action: 'delete' },
      { module: 'imaging', action: 'approve' }, { module: 'imaging', action: 'export' },
      { module: 'patients', action: 'read' },
      { module: 'visits', action: 'read' },
      { module: 'appointments', action: 'read' },
      { module: 'lab_orders', action: 'read' }, { module: 'lab_reports', action: 'read' },
      // Radiology-side billing review + inventory of contrast media / film.
      // billing create/update/delete let the admin manage imaging modalities
      // (service tariffs) in Settings.
      { module: 'billing', action: 'read' }, { module: 'billing', action: 'create' },
      { module: 'billing', action: 'update' }, { module: 'billing', action: 'delete' },
      { module: 'payments', action: 'read' },
      { module: 'inventory', action: 'read' }, { module: 'inventory', action: 'create' },
      { module: 'inventory', action: 'update' }, { module: 'inventory', action: 'approve' },
      { module: 'inventory', action: 'export' },
      { module: 'users', action: 'read' },
      { module: 'hr', action: 'read' },
      { module: 'audit_logs', action: 'read' },
      { module: 'reports', action: 'read' }, { module: 'reports', action: 'create' }, { module: 'reports', action: 'export' },
      { module: 'notifications', action: 'read' },
    ],

    // Operational counter: dispense (pharmacy:create), patient returns, and read
    // formulary/batches/prescriptions. NO approve (verify/recall/process-return/
    // flag-expired) and NO delete — those are pharmacy_admin only. Master/stock
    // management (formulary, categories, batches) is further blocked by the
    // assertPharmacyAdmin service guard even though create/update are granted
    // (create/update are needed for dispense + patient returns).
    pharmacist: [
      { module: 'pharmacy', action: 'read' }, { module: 'pharmacy', action: 'create' }, { module: 'pharmacy', action: 'update' },
      { module: 'prescriptions', action: 'read' }, { module: 'prescriptions', action: 'update' },
      { module: 'inventory', action: 'read' }, { module: 'patients', action: 'read' },
    ],

    // Full pharmacy management + the inventory module (suppliers, purchase
    // orders, stock, transfers, reports).
    pharmacy_admin: [
      { module: 'pharmacy', action: 'read' }, { module: 'pharmacy', action: 'create' }, { module: 'pharmacy', action: 'update' }, { module: 'pharmacy', action: 'delete' }, { module: 'pharmacy', action: 'approve' }, { module: 'pharmacy', action: 'export' },
      { module: 'prescriptions', action: 'read' }, { module: 'prescriptions', action: 'update' },
      { module: 'inventory', action: 'read' }, { module: 'inventory', action: 'create' }, { module: 'inventory', action: 'update' }, { module: 'inventory', action: 'delete' }, { module: 'inventory', action: 'approve' }, { module: 'inventory', action: 'export' },
      { module: 'patients', action: 'read' }, { module: 'reports', action: 'read' }, { module: 'reports', action: 'export' },
    ],

    inventory_manager: [
      { module: 'inventory', action: 'read' }, { module: 'inventory', action: 'create' }, { module: 'inventory', action: 'update' },
      { module: 'inventory', action: 'delete' }, { module: 'inventory', action: 'approve' }, { module: 'inventory', action: 'export' },
      { module: 'reports', action: 'read' },
    ],

    billing_admin: [
      { module: 'billing', action: 'read' }, { module: 'billing', action: 'create' }, { module: 'billing', action: 'update' }, { module: 'billing', action: 'delete' }, { module: 'billing', action: 'approve' }, { module: 'billing', action: 'export' },
      { module: 'payments', action: 'read' }, { module: 'payments', action: 'create' }, { module: 'payments', action: 'update' }, { module: 'payments', action: 'approve' },
      { module: 'patients', action: 'read' }, { module: 'insurance', action: 'read' }, { module: 'reports', action: 'read' },
    ],

    cashier: [
      { module: 'billing', action: 'read' }, { module: 'billing', action: 'create' }, { module: 'billing', action: 'update' },
      { module: 'payments', action: 'read' }, { module: 'payments', action: 'create' }, { module: 'patients', action: 'read' },
    ],

    insurance_staff: [
      { module: 'insurance', action: 'read' }, { module: 'insurance', action: 'create' }, { module: 'insurance', action: 'update' }, { module: 'insurance', action: 'approve' }, { module: 'insurance', action: 'export' },
      { module: 'billing', action: 'read' }, { module: 'billing', action: 'update' },
      { module: 'patients', action: 'read' }, { module: 'admissions', action: 'read' },
    ],

    blood_bank_staff: [
      { module: 'blood_bank', action: 'read' }, { module: 'blood_bank', action: 'create' }, { module: 'blood_bank', action: 'update' }, { module: 'blood_bank', action: 'approve' },
      { module: 'patients', action: 'read' },
    ],

    hr_staff: [
      { module: 'hr', action: 'read' }, { module: 'hr', action: 'create' }, { module: 'hr', action: 'update' }, { module: 'hr', action: 'approve' }, { module: 'hr', action: 'export' },
      { module: 'users', action: 'read' }, { module: 'departments', action: 'read' }, { module: 'reports', action: 'read' },
    ],
  };
}
