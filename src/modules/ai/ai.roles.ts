// ============================================================================
// Role profiles for the platform-wide support chatbot (Use Case 3).
//
// The support assistant is ROLE-AWARE: it knows which role the signed-in user
// holds and tailors every answer to that role's portal, modules, workflows and
// permissions. This file is the single source of truth for "who is asking":
//   - normalizeRole()  — collapses the many DB role slugs (incl. every doctor
//                        specialization) into the canonical role set below.
//   - ROLE_PROFILES    — a human-readable description of each role used to build
//                        the LLM system prompt and to power role-specific quick
//                        actions/help.
//
// Keep this aligned with the frontend `config/role-modules.ts` mapping and the
// backend RBAC permission matrix (see ROLES.md).
// ============================================================================

export type CanonicalRole =
  | 'super_admin'
  | 'admin'
  | 'doctor'
  | 'nurse'
  | 'nurse_admin'
  | 'front_desk'
  | 'billing_admin'
  | 'cashier'
  | 'pharmacist'
  | 'pharmacy_admin'
  | 'lab_technician'
  | 'lab_supervisor'
  | 'radiologist'
  | 'radiology_admin'
  | 'inventory_manager'
  | 'insurance_staff'
  | 'hr_staff'
  | 'blood_bank_staff'
  | 'patient';

// Every doctor specialization collapses to the single `doctor` portal/role.
const DOCTOR_SPECIALIZATIONS = new Set([
  'doctor',
  'general_physician',
  'ent',
  'diabetologist',
  'obstetrics_gynaecologist',
  'cardiologist',
  'dermatologist',
  'neurologist',
  'ophthalmologist',
  'orthopedic',
  'pediatrician',
  'psychiatrist',
  'pulmonologist',
  'surgeon',
  'urologist',
  'opt',
  'physiotherapist',
]);

/**
 * Normalize a raw role slug (as stored on the user/JWT) into the canonical role
 * used by the knowledge base and profiles. Mirrors the frontend normalization:
 * lowercase, collapse whitespace/hyphens to underscores, then fold synonyms.
 */
export function normalizeRole(slug: string): string {
  const n = (slug || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (DOCTOR_SPECIALIZATIONS.has(n)) return 'doctor';
  // A pathologist signs/verifies lab reports — same surface as a lab supervisor.
  if (n === 'pathologist') return 'lab_supervisor';
  return n;
}

/** Normalize + dedupe a list of role slugs. */
export function normalizeRoles(slugs: string[] = []): string[] {
  return [...new Set(slugs.map(normalizeRole))].filter(Boolean);
}

// Authority order (highest → lowest). Used to pick a single "primary" role when
// a user holds several, so the assistant can lead with the most capable hat.
const ROLE_PRIORITY: string[] = [
  'super_admin',
  'admin',
  'doctor',
  'nurse_admin',
  'pharmacy_admin',
  'lab_supervisor',
  'radiology_admin',
  'billing_admin',
  'inventory_manager',
  'insurance_staff',
  'hr_staff',
  'nurse',
  'pharmacist',
  'radiologist',
  'blood_bank_staff',
  'lab_technician',
  'pharmacy_technician',
  'front_desk',
  'cashier',
  'patient',
];

/** Pick the highest-authority canonical role from a user's role list. */
export function primaryRole(roles: string[]): string {
  const norm = normalizeRoles(roles);
  for (const r of ROLE_PRIORITY) if (norm.includes(r)) return r;
  return norm[0] ?? 'admin';
}

export interface RoleProfile {
  /** Canonical role slug. */
  slug: string;
  /** Human label, e.g. "Doctor". */
  label: string;
  /** Portal name shown in the app header, e.g. "Doctor Portal". */
  portal: string;
  /** Modules this role lands in (app sidebar module switcher). */
  modules: string[];
  /** One-sentence "who is this" summary. */
  summary: string;
  /** Bullet list of what this role can DO in the product. */
  canDo: string[];
  /** Things this role explicitly cannot do (helps the bot say "no, ask X"). */
  cannotDo: string[];
  /** Example questions this role is likely to ask the assistant. */
  sampleQuestions: string[];
}

/**
 * The canonical role profiles. `admin`/`super_admin` are treated as
 * all-access; every operational role is scoped to its department.
 */
export const ROLE_PROFILES: Record<string, RoleProfile> = {
  super_admin: {
    slug: 'super_admin',
    label: 'Super Admin',
    portal: 'Super Admin Portal',
    modules: ['Super Admin panel (all hospitals)'],
    summary:
      'The SaaS platform owner. Manages every hospital (tenant), subscriptions, feature toggles, global catalogs (drug master, ICD, lab templates) and AI settings. Bypasses permission checks.',
    canDo: [
      'Create/activate/deactivate hospitals and manage their subscriptions & commissions',
      'Toggle plan features per hospital and review demo requests',
      'Manage the shared Drug Master, ICD-10 catalog, Lab test templates and Lab units',
      'Configure the AI/LLM provider, model and per-feature switches (AI Settings)',
      'Build platform-wide dynamic form templates and view platform reports',
      'Handle platform support tickets from hospitals',
    ],
    cannotDo: [
      'Nothing is blocked at the platform level — but day-to-day clinical data entry lives inside each hospital, not the super-admin panel',
    ],
    sampleQuestions: [
      'How do I onboard a new hospital?',
      'How do I change the AI model or turn a feature off?',
      'How do I add an ICD code to the shared catalog?',
      'How do I import drugs into the Drug Master?',
    ],
  },
  admin: {
    slug: 'admin',
    label: 'Hospital Admin',
    portal: 'Admin Portal',
    modules: ['Hospital', 'Laboratory', 'Radiology', 'Pharmacy', 'Inventory', 'OT', 'Insurance', 'HR', 'and all other hospital modules'],
    summary:
      'The hospital administrator / management head. Broad control across every module in their own hospital, but read-only on direct clinical data entry (vitals, notes, prescriptions) and cannot manage tenants.',
    canDo: [
      'Manage users, roles, departments, floors, wards and beds',
      'Register and manage patients, appointments and admissions oversight',
      'Full control of billing, payments, insurance, inventory and HR/payroll',
      'View (oversight) clinical data — visits, vitals, diagnoses, notes, prescriptions, lab & imaging results',
      'Approve lab/imaging reports, pharmacy actions, blood bank and compliance items',
      'Configure hospital settings (info, services/tariffs, rooms, forms, doctor schedules) and view all reports & audit logs',
    ],
    cannotDo: [
      'Write clinical data directly (vitals, progress/nursing notes, prescriptions, diagnoses) — that is done by clinical staff',
      'Manage other hospitals or platform-level settings (that is the super-admin)',
      'Delete patient medical records or audit logs',
    ],
    sampleQuestions: [
      'How do I create a new user and assign a role?',
      'How do I set up floors, wards and beds?',
      'How many patients registered this month?',
      'What is today\'s total revenue?',
      'How do I configure services and tariffs?',
    ],
  },
  doctor: {
    slug: 'doctor',
    label: 'Doctor',
    portal: 'Doctor Portal',
    modules: ['Doctor'],
    summary:
      'A physician/surgeon/specialist. Runs OPD & IPD consultations, diagnoses, prescriptions, orders labs & imaging, writes progress and discharge summaries.',
    canDo: [
      'See OPD appointments and open a consultation; record diagnosis (with ICD code)',
      'Write prescriptions on the Prescription Pad (CDSS interaction/allergy safety check before signing)',
      'Order lab tests and imaging/radiology from the consultation',
      'Admit patients (raise an admission request) and manage IP patients from IP Home',
      'Write SOAP progress notes and generate/sign/publish discharge summaries (with AI narrative draft)',
      'Use the patient AI Assistant to reason over one patient\'s record and analyse blood reports',
      'View lab & imaging results, latest vitals (read-only) and their schedule/leaves',
    ],
    cannotDo: [
      'Record vitals (nurse-only — doctors see them read-only)',
      'Dispense drugs, run billing, or do admin/HR/inventory tasks',
    ],
    sampleQuestions: [
      'How do I write a prescription?',
      'How do I order a lab test or imaging?',
      'How do I generate a discharge summary?',
      'How do I use the patient AI assistant?',
      'How many patients are currently admitted?',
    ],
  },
  nurse: {
    slug: 'nurse',
    label: 'Nurse',
    portal: 'Nurse Portal',
    modules: ['Nurse'],
    summary:
      'A registered/ward/ICU nurse providing bedside care. Records vitals, does clinical charting, administers medication via eMAR, fills patient forms and hands over shifts.',
    canDo: [
      'Record and update vitals (BP, temperature, pulse, SpO2, etc.)',
      'Do clinical charting — observations (AVPU/mobility), devices/lines with checks, procedures, intake/output',
      'Administer medication on the eMAR (given / given-late / held / PRN) against the auto-generated schedule',
      'Fill dynamic patient forms (admission, pain, fall-risk, wound care, etc.)',
      'Manage assigned IP patients, view doctor orders and acknowledge them',
      'Do shift handover (incoming/outgoing per-nurse feed) and see their own schedule',
    ],
    cannotDo: [
      'Create patients, write prescriptions, create lab/imaging orders, or approve anything',
      'Assign nurses to beds or plan rosters (that is the Nurse Admin)',
    ],
    sampleQuestions: [
      'How do I record vitals for a patient?',
      'How do I give a medication on the eMAR?',
      'How do I do a shift handover?',
      'Where do I fill the admission assessment form?',
    ],
  },
  nurse_admin: {
    slug: 'nurse_admin',
    label: 'Nurse Admin',
    portal: 'Nurse Admin Portal',
    modules: ['Nursing Admin', 'Ward'],
    summary:
      'The nursing administrator who owns the whole nursing function — nurse↔doctor mapping, per-shift bed assignments, handover, roster planning, ward/floor setup, staffing and compliance. Read-only on clinical data.',
    canDo: [
      'Map nurses to doctors so a nurse handles that doctor\'s patients',
      'Assign a nurse to every occupied IPD bed for each shift',
      'Bulk-transfer current-shift assignments to the next shift (handover)',
      'Plan, publish and approve weekly duty rosters',
      'Create/edit floors, wards and beds and track occupancy',
      'View ward-wide doctor orders with acknowledgement status; staffing heatmap & CSV export; configure eMAR time-slots/frequencies',
    ],
    cannotDo: [
      'Record vitals, nursing notes or give medication (that is the bedside Nurse)',
      'Write prescriptions or clinical notes',
    ],
    sampleQuestions: [
      'How do I assign nurses to beds for this shift?',
      'How do I map a nurse to a doctor?',
      'How do I publish the weekly roster?',
      'How do I add a new ward or bed?',
    ],
  },
  front_desk: {
    slug: 'front_desk',
    label: 'Front Desk',
    portal: 'Front Desk Portal',
    modules: ['Hospital'],
    summary:
      'Reception. Registers patients, books & checks in appointments, handles walk-ins and takes counter payments.',
    canDo: [
      'Register new patients (MRN auto-generated) and look them up by name/MRN/phone',
      'Book appointments, check doctor availability and check patients in',
      'Handle walk-ins from the Walk In screen',
      'Create bills and take counter payments; help start an IP reservation/admission',
    ],
    cannotDo: [
      'Clinical documentation, prescriptions, lab/imaging orders',
      'Approvals, refunds, discounts or admin functions',
    ],
    sampleQuestions: [
      'How do I register a new patient?',
      'How do I book an appointment?',
      'How do I check a patient in?',
      'How many appointments are booked today?',
    ],
  },
  billing_admin: {
    slug: 'billing_admin',
    label: 'Billing Admin',
    portal: 'Billing Portal',
    modules: ['Hospital'],
    summary:
      'The billing/accounts manager. Full financial control — creates/finalizes/exports bills, processes and approves payments, refunds and discounts, and settles credit.',
    canDo: [
      'Create, edit, finalize, delete and export bills',
      'Process, update and approve payments; approve refunds and apply discounts',
      'Work the Billing, Transactions and Credit Settlement screens (insurance/corporate/patient)',
      'View billing & financial reports and revenue',
    ],
    cannotDo: [
      'Clinical operations, pharmacy, inventory or HR',
    ],
    sampleQuestions: [
      'How do I create and finalize a bill?',
      'How do I approve a refund?',
      'How do I settle a credit/insurance bill?',
      'What is today\'s total revenue?',
    ],
  },
  cashier: {
    slug: 'cashier',
    label: 'Cashier',
    portal: 'Cashier Portal',
    modules: ['Hospital'],
    summary:
      'The billing-counter cashier. Collects payments and prints receipts.',
    canDo: [
      'Create and update bills',
      'Accept and record payments (cash / card / UPI) and print receipts',
      'Look up patients for billing',
    ],
    cannotDo: [
      'Approve refunds, finalize bills, apply discounts, delete bills or export data',
    ],
    sampleQuestions: [
      'How do I take a payment at the counter?',
      'How do I print a receipt?',
      'How do I look up a patient\'s bill?',
    ],
  },
  pharmacist: {
    slug: 'pharmacist',
    label: 'Pharmacist',
    portal: 'Pharmacist Portal',
    modules: ['Pharmacy'],
    summary:
      'The counter pharmacist. Verifies prescriptions and dispenses medication (POS-style billing), and handles patient returns.',
    canDo: [
      'Work the Prescription Queue and dispense against a prescription (POS billing screen)',
      'Verify prescriptions and check interactions; place pre-pack holds',
      'Process patient drug returns (links to the original sale, creates a refund)',
      'View pharmacy stock levels (read-only)',
    ],
    cannotDo: [
      'Full inventory/supplier/PO management, ward stock, statutory reports or discount policy (that is the Pharmacy Admin)',
    ],
    sampleQuestions: [
      'How do I dispense a prescription?',
      'How do I process a drug return?',
      'How do I put an item on pre-pack hold?',
    ],
  },
  pharmacy_admin: {
    slug: 'pharmacy_admin',
    label: 'Pharmacy Admin',
    portal: 'Pharmacy Admin Portal',
    modules: ['Pharmacy', 'Inventory'],
    summary:
      'The chief pharmacist / pharmacy manager. Everything the pharmacist can do, plus full drug inventory, batches, ward stock, statutory reports, discount policy and pharmacy financials.',
    canDo: [
      'Manage the drug formulary, batches and expiry; import from the Drug Master catalog',
      'Manage ward stock, stock ledger, pharmacy transactions and discount policy',
      'File statutory/NDPS reports and view detailed pharmacy analytics',
      'Approve drug returns and recalls (Recall / Lift / Affected-Patients on the Batches page)',
    ],
    cannotDo: [
      'Clinical documentation or non-pharmacy admin functions',
    ],
    sampleQuestions: [
      'How do I add stock / receive a drug batch?',
      'How do I recall a drug batch?',
      'Where are the statutory (NDPS) reports?',
      'How do I import a drug from the Drug Master?',
    ],
  },
  lab_technician: {
    slug: 'lab_technician',
    label: 'Lab Technician',
    portal: 'Lab Technician Portal',
    modules: ['Laboratory'],
    summary:
      'The lab bench worker. Accepts orders, collects samples, enters results or uploads reports, and marks tests done. Cannot approve/sign/publish.',
    canDo: [
      'Accept lab orders and progress the sample lifecycle (collected → processing)',
      'Enter result values (range-aware) or upload the report file per test',
      'Use "Upload + Mark Done" per test; the report then goes to review',
      'See Home (orders/status/result entry) only — no verify/sign/publish buttons',
    ],
    cannotDo: [
      'Create lab orders (doctors do that) or approve/verify/publish reports (supervisor only)',
      'See lab Reports/Billing/Settings surfaces (supervisor-only)',
    ],
    sampleQuestions: [
      'How do I accept a lab order?',
      'How do I enter results and mark a test done?',
      'How do I upload a lab report file?',
    ],
  },
  lab_supervisor: {
    slug: 'lab_supervisor',
    label: 'Lab Supervisor',
    portal: 'Lab Supervisor Portal',
    modules: ['Laboratory'],
    summary:
      'The senior pathologist / lab manager. Everything a technician can do, plus review, verify, sign and publish reports, manage the test catalog/analytics/billing, and issue corrections.',
    canDo: [
      'Review submitted results and Approve & Publish reports to patient + doctor',
      'Sign branded reports (QR verification) and issue corrections after finalize',
      'Manage the test catalog (clone from super-admin templates; edit price/TAT), units, outsourcing and technicians',
      'View lab dashboard, analytics (TAT/SLA breach) and lab billing',
    ],
    cannotDo: [
      'Create the original doctor order (still doctor-driven)',
    ],
    sampleQuestions: [
      'How do I approve and publish a lab report?',
      'How do I issue a correction after a report is finalized?',
      'How do I add a test to our catalog?',
    ],
  },
  radiologist: {
    slug: 'radiologist',
    label: 'Radiologist',
    portal: 'Radiologist Portal',
    modules: ['Radiology'],
    summary:
      'The imaging specialist. Works the worklist, performs studies, uploads result files (PDF/JPG/DICOM), and signs/finalizes reports. Requires admin payment-verification before a request appears.',
    canDo: [
      'Work the Worklist / Home of payment-verified imaging requests',
      'Upload result files (PDF, JPG, PNG, DICOM, MP4) — attachment-based reporting',
      'Finalize/sign the report (gated on having attachments); view via the Radiology Viewer (DICOM/PACS/OHIF)',
    ],
    cannotDo: [
      'Verify payment or approve for the patient (that is the Radiology Admin two-stage gate)',
      'See radiology Dashboard/Reports/Billing/Settings (admin-only)',
    ],
    sampleQuestions: [
      'How do I upload an imaging result?',
      'How do I finalize an imaging report?',
      'Why is a request not in my worklist yet?',
    ],
  },
  radiology_admin: {
    slug: 'radiology_admin',
    label: 'Radiology Admin',
    portal: 'Radiology Admin Portal',
    modules: ['Radiology'],
    summary:
      'The radiology manager. Verifies payment before a request reaches the radiologist, approves published reports before they reach the patient, and owns analytics/billing/inventory/modality tariffs.',
    canDo: [
      'Verify payment on imaging requests (Stage 1 gate) and approve reports for the patient (Stage 2 gate)',
      'Close no-shows / cancellations with a reason, and reopen/reschedule from the Closed tab',
      'Manage per-modality pricing, inventory, vendor purchases; view dashboard, reports & billing',
    ],
    cannotDo: [
      'Interpret/sign the clinical report (that is the radiologist)',
    ],
    sampleQuestions: [
      'How do I verify payment on an imaging request?',
      'How do I approve a report for the patient?',
      'How do I close a no-show request?',
      'How do I set per-modality prices?',
    ],
  },
  inventory_manager: {
    slug: 'inventory_manager',
    label: 'Inventory Manager',
    portal: 'Inventory Portal',
    modules: ['Inventory', 'Pharmacy (read)', 'Laboratory (read)', 'OT (read)'],
    summary:
      'The stores / procurement manager. Full control of general (non-drug) inventory — suppliers, items, stock in/out, transfers, purchase orders and reports.',
    canDo: [
      'Manage suppliers/vendors and inventory items (Storage list)',
      'Receive stock (bulk inward with batch/expiry for medicines), issue stock-out and stock transfers',
      'Create, approve and receive purchase orders; monitor low-stock alerts',
      'View inventory reports (stock balance, expiry/waste, reorder, dept consumption, detailed) and audit logs',
    ],
    cannotDo: [
      'Clinical operations or HR/finance functions',
    ],
    sampleQuestions: [
      'How do I add a new stock item?',
      'How do I create a purchase order?',
      'How do I record stock going out to a department?',
      'Where do I see low-stock alerts?',
    ],
  },
  insurance_staff: {
    slug: 'insurance_staff',
    label: 'Insurance Staff',
    portal: 'Insurance Portal',
    modules: ['Insurance & TPA', 'Hospital'],
    summary:
      'The insurance desk officer. Manages insurers/TPAs, policies, pre-authorizations and claims (create, submit, approve, reject).',
    canDo: [
      'Manage insurer and TPA records and view TPA logs',
      'Create and verify insurance policies',
      'Handle pre-authorization requests and create/submit/approve/reject claims',
      'View bills and admission details for claim linkage (read-only)',
    ],
    cannotDo: [
      'Clinical operations; write billing (only reads it for claims)',
    ],
    sampleQuestions: [
      'How do I submit a claim?',
      'How do I raise a pre-authorization?',
      'How do I add an insurer or TPA?',
    ],
  },
  hr_staff: {
    slug: 'hr_staff',
    label: 'HR Staff',
    portal: 'HR Portal',
    modules: ['HR & Payroll'],
    summary:
      'Human resources. Manages staff profiles & licenses, attendance, leaves, duty rosters and payroll.',
    canDo: [
      'Create/manage staff profiles and professional licenses',
      'Record attendance and process/approve leave requests',
      'Create and publish duty rosters',
      'Generate, approve and export payroll and salary slips; view HR reports',
    ],
    cannotDo: [
      'Clinical, billing or inventory operations',
    ],
    sampleQuestions: [
      'How do I add a staff member?',
      'How do I run payroll?',
      'How do I approve a leave request?',
      'How do I record attendance?',
    ],
  },
  blood_bank_staff: {
    slug: 'blood_bank_staff',
    label: 'Blood Bank Staff',
    portal: 'Blood Bank Portal',
    modules: ['Hospital (Blood Bank)'],
    summary:
      'Blood bank technician/officer. Manages donors, donations & screening, blood-unit inventory, cross-matching and transfusions.',
    canDo: [
      'Register donors and record donations with screening',
      'Track blood-unit inventory (whole blood, packed cells, plasma, platelets)',
      'Perform and record cross-match tests; process transfusion requests and completions',
    ],
    cannotDo: [
      'Non-blood-bank clinical or admin functions',
    ],
    sampleQuestions: [
      'How do I register a blood donor?',
      'How do I record a donation?',
      'How do I process a transfusion request?',
    ],
  },
  patient: {
    slug: 'patient',
    label: 'Patient',
    portal: 'Patient Portal',
    modules: ['Patient Portal'],
    summary:
      'A patient using the self-service portal. Views their own records and books appointments — no access to other patients or hospital operations.',
    canDo: [
      'View their profile, medical history and current medications',
      'Book appointments and see appointment history & follow-ups',
      'View their own lab reports, imaging reports, prescriptions, consultation & discharge summaries',
      'View their bills and pay online (Razorpay), and manage documents/settings',
    ],
    cannotDo: [
      'See anyone else\'s data or any clinical/admin/aggregate hospital numbers',
    ],
    sampleQuestions: [
      'How do I book an appointment?',
      'Where can I see my lab reports?',
      'How do I pay my bill online?',
      'Where are my prescriptions?',
    ],
  },
};

/** Fallback profile for an unrecognised role (treated like a general staff user). */
export const DEFAULT_ROLE_PROFILE: RoleProfile = {
  slug: 'staff',
  label: 'Staff',
  portal: 'Hospital Portal',
  modules: ['Hospital'],
  summary: 'A hospital staff member.',
  canDo: ['Use the modules your administrator has granted you'],
  cannotDo: [],
  sampleQuestions: ['How do I use this module?'],
};

export function getRoleProfile(role: string): RoleProfile {
  return ROLE_PROFILES[normalizeRole(role)] ?? DEFAULT_ROLE_PROFILE;
}

// The screen each role lands on after login — used so the assistant's steps
// start from THIS role's home, making answers visibly role-specific.
export const ROLE_LANDING: Record<string, string> = {
  super_admin: 'the Super Admin panel',
  admin: 'the Hospital module → Home',
  doctor: 'Doctor → Home',
  nurse: 'Nurse → Dashboard',
  nurse_admin: 'Nursing Admin → Dashboard',
  front_desk: 'Hospital → Home',
  billing_admin: 'Hospital → Hospital Billing',
  cashier: 'Hospital → Billing → Cash Counter',
  pharmacist: 'Pharmacy → Billing',
  pharmacy_admin: 'Pharmacy → Billing',
  lab_technician: 'Laboratory → Home',
  lab_supervisor: 'Laboratory → Home',
  radiologist: 'Radiology → Worklist',
  radiology_admin: 'Radiology → Dashboard',
  inventory_manager: 'Inventory → Storage',
  insurance_staff: 'Insurance → Dashboard',
  hr_staff: 'HR → Dashboard',
  blood_bank_staff: 'Hospital → Blood Bank',
  patient: 'the Patient Portal',
};

export function roleLanding(role: string): string {
  return ROLE_LANDING[normalizeRole(role)] ?? 'your portal home';
}

/** "A and B" / "A, B and C" — for naming which roles perform an out-of-scope task. */
export function labelsProse(labels: string[]): string {
  const u = [...new Set(labels)].filter(Boolean);
  if (u.length <= 1) return u[0] ?? 'another role';
  if (u.length === 2) return `${u[0]} and ${u[1]}`;
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`;
}

/**
 * Build a compact "who is asking" block for the LLM system prompt from the
 * caller's roles. Leads with the primary (highest-authority) role and lists any
 * additional hats so the assistant tailors navigation/wording to this user.
 */
export function describeCaller(roles: string[]): string {
  const norm = normalizeRoles(roles);
  if (!norm.length) return 'The user is a hospital staff member (role unknown).';

  const primary = primaryRole(norm);
  const profile = getRoleProfile(primary);
  const others = norm.filter((r) => r !== primary).map((r) => getRoleProfile(r).label);

  const lines = [
    `The signed-in user's role is: ${profile.label} (${profile.portal}).`,
    others.length ? `They also hold: ${others.join(', ')}.` : '',
    `Who they are: ${profile.summary}`,
    `Modules they work in: ${profile.modules.join(', ')}.`,
    `Their landing screen after login: ${roleLanding(primary)}.`,
    `They CAN: ${profile.canDo.join('; ')}.`,
    profile.cannotDo.length ? `They CANNOT: ${profile.cannotDo.join('; ')}.` : '',
    'Tailor every answer to THIS role: reference their portal and modules, use the exact screen/menu names, and give step-by-step navigation STARTING from their landing screen above. If they ask how to do something outside their permissions, say plainly that their role cannot do it and name the role that can.',
  ];
  return lines.filter(Boolean).join('\n');
}
