/**
 * System roles and their permission mappings.
 * Used by both the seed script and tenant creation service
 * to bootstrap RBAC for every tenant.
 */

export const SYSTEM_ROLE_NAMES = [
  'super_admin', 'admin', 'doctor', 'patient', 'nurse', 'nurse_admin',
  'front_desk', 'lab_technician', 'lab_supervisor', 'radiologist', 'pharmacist',
  'pharmacy_technician', 'pharmacy_admin', 'inventory_manager',
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
      { module: 'lab_orders', action: 'read' }, { module: 'lab_orders', action: 'approve' },
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
      { module: 'progress_notes', action: 'read' }, { module: 'progress_notes', action: 'create' }, { module: 'progress_notes', action: 'update' },
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

    radiologist: [
      { module: 'imaging', action: 'read' }, { module: 'imaging', action: 'create' }, { module: 'imaging', action: 'update' }, { module: 'imaging', action: 'approve' },
      { module: 'patients', action: 'read' },
    ],

    pharmacist: [
      { module: 'pharmacy', action: 'read' }, { module: 'pharmacy', action: 'create' }, { module: 'pharmacy', action: 'update' }, { module: 'pharmacy', action: 'approve' },
      { module: 'prescriptions', action: 'read' }, { module: 'prescriptions', action: 'update' },
      { module: 'inventory', action: 'read' }, { module: 'patients', action: 'read' },
    ],

    pharmacy_technician: [
      { module: 'pharmacy', action: 'read' }, { module: 'pharmacy', action: 'create' }, { module: 'pharmacy', action: 'update' },
      { module: 'prescriptions', action: 'read' }, { module: 'inventory', action: 'read' }, { module: 'patients', action: 'read' },
    ],

    pharmacy_admin: [
      { module: 'pharmacy', action: 'read' }, { module: 'pharmacy', action: 'create' }, { module: 'pharmacy', action: 'update' }, { module: 'pharmacy', action: 'delete' }, { module: 'pharmacy', action: 'approve' },
      { module: 'prescriptions', action: 'read' }, { module: 'prescriptions', action: 'update' },
      { module: 'inventory', action: 'read' }, { module: 'inventory', action: 'create' }, { module: 'inventory', action: 'update' },
      { module: 'patients', action: 'read' }, { module: 'reports', action: 'read' },
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
      { module: 'insurance', action: 'read' }, { module: 'insurance', action: 'create' }, { module: 'insurance', action: 'update' }, { module: 'insurance', action: 'approve' },
      { module: 'billing', action: 'read' }, { module: 'patients', action: 'read' }, { module: 'admissions', action: 'read' },
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
