// Role-aware knowledge base for the platform-wide support chatbot (Use Case 3).
//
// Each curated "how-to" doc is tagged with the roles it is most relevant to.
// retrieveDocs() scores by keyword overlap AND boosts docs that match the
// signed-in user's role, so a nurse and a doctor asking the same words get
// answers grounded in their own workflow. Docs are handed to the LLM as
// grounding context so answers stay accurate to THIS product. Extend freely.
//
// role tags use the CANONICAL role slugs from ai.roles.ts. '*' = every role.

import { normalizeRole } from './ai.roles';

export interface HowToDoc {
  title: string;
  /** Canonical role slugs this doc is most relevant to, or ['*'] for everyone. */
  roles: string[];
  keywords: string[];
  body: string;
}

export const HOW_TO_DOCS: HowToDoc[] = [
  // ---------------------------------------------------------------------------
  // Universal — login, navigation, the assistant itself
  // ---------------------------------------------------------------------------
  {
    title: 'Log in, select hospital and module',
    roles: ['*'],
    keywords: ['login', 'log in', 'sign in', 'select clinic', 'select hospital', 'switch clinic', 'change module', 'select module', 'navigation', 'portal'],
    body: 'Log in with your email and password. If you belong to more than one hospital you pick one on Select Hospital. Most roles are then taken straight to their portal; multi-module roles pick a module on Select Module. Use the header switchers to change hospital or module at any time. The left sidebar lists the pages for your active module.',
  },
  {
    title: 'Using the Support Assistant',
    roles: ['*'],
    keywords: ['assistant', 'chatbot', 'support', 'help bot', 'ai help', 'how to use assistant'],
    body: 'The floating Support Assistant (bottom-right) answers two kinds of questions for YOUR role: (1) how-to / navigation ("how do I book an appointment?") and (2) read-only numbers about your own hospital ("how many patients this month?"). It is read-only — it explains and reports, it never changes data — and everything it reports is scoped to your hospital only.',
  },
  {
    title: 'Reset password / forgot password',
    roles: ['*'],
    keywords: ['forgot password', 'reset password', 'change password', 'cannot log in'],
    body: 'On the login screen use "Forgot password" to receive a reset link by email. To change a password while signed in, open My Account / profile settings. An admin can also reset a user\'s password from User Management.',
  },
  {
    title: 'Edit my profile / account settings',
    roles: ['*'],
    keywords: ['my account', 'profile', 'account settings', 'update profile', 'my profile'],
    body: 'Open My Account (top-right menu) to update your name, phone, avatar and password, and to enable two-factor authentication (TOTP). Clinical/role permissions are managed by your administrator, not here.',
  },

  // ---------------------------------------------------------------------------
  // Front desk / reception — patients & appointments
  // ---------------------------------------------------------------------------
  {
    title: 'Register a new patient',
    roles: ['front_desk', 'admin', 'doctor', 'cashier', 'billing_admin'],
    keywords: ['add patient', 'register patient', 'new patient', 'patient registration', 'create patient', 'mrn'],
    body: 'Open the Hospital module → Home (or Walk In). Click "Register Patient" / "Add New Patient", fill name, age/date of birth, gender, phone and address, then Save. An MRN (medical record number) is assigned automatically. You can then book an appointment or start a bill for that patient.',
  },
  {
    title: 'Look up / search a patient',
    roles: ['front_desk', 'cashier', 'billing_admin', 'nurse', 'doctor', 'pharmacist', 'admin'],
    keywords: ['find patient', 'search patient', 'lookup patient', 'patient search', 'mrn search'],
    body: 'Use the patient search box (by name, MRN or phone) on the Hospital Home / patient list. Click a result to open the patient. Most modules also have a patient picker when you start an action (billing, dispensing, orders).',
  },
  {
    title: 'Book an appointment',
    roles: ['front_desk', 'admin', 'doctor', 'patient'],
    keywords: ['book appointment', 'schedule appointment', 'new appointment', 'opd booking', 'appointment', 'slot'],
    body: 'Go to Appointments / Hospital Home. Click "New Appointment", search the patient (or register a walk-in first), pick the doctor, then a date and available time slot, and confirm. The appointment appears on the OP list where it can be checked in.',
  },
  {
    title: 'Check a patient in (appointment status)',
    roles: ['front_desk', 'nurse', 'admin'],
    keywords: ['check in', 'checkin', 'check-in', 'appointment status', 'waiting', 'confirm appointment', 'arrived'],
    body: 'On the OP appointment list, use the row status/actions to move an appointment through its stages: confirmed → checked-in → waiting → in-consultation → completed. Front desk confirms and checks in; the doctor picks it up from there.',
  },
  {
    title: 'Handle a walk-in patient',
    roles: ['front_desk', 'admin'],
    keywords: ['walk in', 'walkin', 'walk-in', 'quick registration'],
    body: 'Hospital module → Walk In. Register the patient quickly and create the appointment/visit in one flow, then take any counter payment. Useful for unscheduled OPD patients.',
  },

  // ---------------------------------------------------------------------------
  // Doctor — clinical
  // ---------------------------------------------------------------------------
  {
    title: 'Start / open an OPD consultation',
    roles: ['doctor'],
    keywords: ['consultation', 'start consultation', 'open consultation', 'see patient', 'opd', 'examine'],
    body: 'Doctor module → Home shows your OP appointments. Click a checked-in patient to open the consultation. From there you record diagnosis, write prescriptions, order labs/imaging and write progress notes. Latest vitals (recorded by nursing) show read-only at the top.',
  },
  {
    title: 'Record a diagnosis with ICD code',
    roles: ['doctor'],
    keywords: ['diagnosis', 'icd', 'diagnosis code', 'icd code', 'record diagnosis'],
    body: 'In the consultation Diagnosis section, type the condition — the field autocompletes from the ICD-10 catalog. Pick the matching code to attach it. Doctors can add/edit/remove diagnoses; super-admins manage the shared ICD catalog and hospitals can add custom codes.',
  },
  {
    title: 'Write a prescription (Prescription Pad)',
    roles: ['doctor'],
    keywords: ['prescription', 'prescribe', 'medicine', 'drug', 'prescription pad', 'rx', 'medication order'],
    body: 'In the consultation open the Prescription Pad: search the drug (formulary/Drug Master, with free-text fallback), set dosage, frequency, duration and route, then add it. The CDSS safety panel flags interactions and allergies before you sign. Sign to finalize; you can print or cancel. IP prescriptions auto-generate the nurse eMAR schedule.',
  },
  {
    title: 'Order a lab test',
    roles: ['doctor'],
    keywords: ['lab test', 'order lab', 'laboratory', 'blood test', 'investigation', 'lab order'],
    body: 'In the consultation click "Order Lab", search the test catalog, add the tests and submit. The order flows to the Laboratory module for the technician to accept, collect the sample and enter results.',
  },
  {
    title: 'Order imaging / radiology',
    roles: ['doctor'],
    keywords: ['imaging', 'radiology', 'x-ray', 'ct', 'mri', 'scan', 'order imaging', 'ultrasound'],
    body: 'In the consultation click "Order Imaging", choose the modality and body part, add the clinical indication, and submit. Radiology Admin verifies payment first, then the radiologist performs and reports it; you see the published result in the orders panel / patient record.',
  },
  {
    title: 'Admit a patient (IP admission)',
    roles: ['doctor', 'front_desk', 'admin', 'nurse_admin'],
    keywords: ['admit patient', 'admission', 'inpatient', 'ip admission', 'reserve bed', 'admit'],
    body: 'From the consultation the doctor raises an Admission Request. Front-desk/admin (or Nurse Admin) opens IP Home → Reservation and assigns a floor → ward → bed, then confirms. The patient then appears under In-Patient and on the shared IP workspace.',
  },
  {
    title: 'Manage IP (admitted) patients',
    roles: ['doctor', 'nurse'],
    keywords: ['ip home', 'inpatient list', 'admitted patients', 'ward round', 'ip workspace', 'progress'],
    body: 'Doctor module → IP Home lists your admitted patients. Open one to reach the IP workspace (Overview, eMAR, Rx, Vitals, Charting, Progress, Orders, Patient). Write progress notes, add orders, and start a discharge when ready.',
  },
  {
    title: 'Write a progress note (SOAP)',
    roles: ['doctor', 'nurse'],
    keywords: ['progress note', 'soap note', 'clinical note', 'daily note', 'ward note'],
    body: 'Doctor module → Progress Notes (or the Progress tab in the IP workspace). Write in SOAP format; vitals can carry forward, pinned problems auto-fill, and AI smart suggestions can draft text. Notes support amendments and show on the IP timeline. Nurses can view doctor notes read-only.',
  },
  {
    title: 'Generate a discharge summary',
    roles: ['doctor'],
    keywords: ['discharge summary', 'discharge', 'discharge document', 'mrd', 'discharge patient'],
    body: 'Doctor module → Discharge Summary. Select the admission; the summary auto-fills from admission data (diagnoses, procedures, labs, medications). Edit the sections, optionally use "Generate with AI" to draft the narrative (hospital course / instructions / follow-up), then Sign and Publish. Published summaries appear in the patient portal.',
  },
  {
    title: 'Use the patient AI Assistant (doctor)',
    roles: ['doctor'],
    keywords: ['patient ai', 'ai assistant', 'ai chatbot doctor', 'patient analysis', 'cdss ai', 'blood report ai'],
    body: 'Doctor module → AI Assistant, or the AI button on the consultation top bar. Pick a patient and ask e.g. "summarise this patient\'s history" or "analyse the latest blood report" (returns a 0–100 score). It reasons over that one patient\'s record only; it does not interpret radiology images. This is separate from the read-only Support Assistant.',
  },
  {
    title: 'View CDSS alerts',
    roles: ['doctor'],
    keywords: ['cdss', 'clinical decision', 'alerts', 'drug interaction', 'allergy alert', 'safety'],
    body: 'The CDSS (Clinical Decision Support) safety checks run automatically in the Prescription Pad (interactions, allergies, duplicates). Doctor module → CDSS Alerts shows the rule-based alerts for your patients. CDSS is rule-based, not the LLM.',
  },
  {
    title: 'My schedule and leaves (doctor)',
    roles: ['doctor'],
    keywords: ['schedule', 'my leaves', 'doctor schedule', 'availability', 'time off', 'roster'],
    body: 'Doctor module → Schedule & Leaves shows your consulting slots and lets you apply for leave. Admin configures doctor schedules under Hospital → Settings → Doctor Schedules.',
  },

  // ---------------------------------------------------------------------------
  // Nurse — bedside
  // ---------------------------------------------------------------------------
  {
    title: 'Record vitals',
    roles: ['nurse'],
    keywords: ['vitals', 'blood pressure', 'temperature', 'record vitals', 'spo2', 'pulse', 'vital signs'],
    body: 'Vitals are nurse-only. Nurse module → Patient Vitals (or the Vitals tab in the IP workspace / a checked-in OPD appointment). Enter BP, temperature, pulse, SpO2, respiratory rate, etc. and save. Doctors then see the latest vitals read-only in the consultation and prescription pad.',
  },
  {
    title: 'Clinical charting (observations, devices, procedures, I/O)',
    roles: ['nurse'],
    keywords: ['charting', 'clinical charting', 'observation', 'device', 'line', 'intake output', 'io', 'procedure', 'wound'],
    body: 'Nurse module → Clinical Charting for an admitted patient. Record structured observations (AVPU / condition / mobility), devices & lines with their checks, procedures (which can auto-link a device), and intake/output totals. This replaces free-text notes with structured capture.',
  },
  {
    title: 'Administer medication on the eMAR',
    roles: ['nurse'],
    keywords: ['emar', 'medication administration', 'give medicine', 'mar', 'administer', 'due meds', 'prn'],
    body: 'Nurse module → eMAR. The schedule is auto-generated from the doctor\'s IP prescriptions. For each due dose mark it Given, Given-late (delay is tracked), Held (with reason) or record a PRN dose (respecting the minimum interval). Nurse Admin configures the time-slots and frequencies in eMAR Settings.',
  },
  {
    title: 'Fill a patient form',
    roles: ['nurse'],
    keywords: ['patient form', 'nursing form', 'assessment form', 'admission form', 'fall risk', 'pain score', 'fill form'],
    body: 'Nurse module → Patient Forms → pick the patient. Fill the dynamic forms your hospital has enabled (admission assessment, pain, fall-risk, wound care, etc.). Forms are built by the admin from super-admin templates; submissions are retained even if a form is later retired.',
  },
  {
    title: 'Shift handover (nurse)',
    roles: ['nurse'],
    keywords: ['handover', 'shift handover', 'hand over', 'sbar', 'shift change', 'incoming outgoing'],
    body: 'Nurse module → Shift Handover shows your incoming/outgoing feed ("from Nurse X / to Nurse Y") for the current shift\'s patients. Add handover notes and hand your assignments to the next nurse. Bulk shift transfer is done by the Nurse Admin on the handover screen.',
  },
  {
    title: 'View my assigned patients and orders (nurse)',
    roles: ['nurse'],
    keywords: ['my patients', 'assigned patients', 'ip patients', 'orders', 'acknowledge order', 'ward orders'],
    body: 'Nurse module → IP Patients shows the beds/patients assigned to you this shift (assignments are set by the Nurse Admin). Orders & Ward lists doctor orders for your patients so you can acknowledge them. My Schedule shows your rostered shifts.',
  },

  // ---------------------------------------------------------------------------
  // Nurse admin
  // ---------------------------------------------------------------------------
  {
    title: 'Assign nurses to beds (per shift)',
    roles: ['nurse_admin'],
    keywords: ['assign nurse', 'patient assignment', 'bed assignment', 'nurse assignment', 'allocate nurse'],
    body: 'Nursing Admin → Patient Assignments. For the selected shift, assign a nurse to each occupied IPD bed (OPD needs no assignment). The assigned nurse then sees those patients on their IP Patients screen. Use the searchable nurse picker to scale to large staff lists.',
  },
  {
    title: 'Map a nurse to a doctor',
    roles: ['nurse_admin'],
    keywords: ['nurse doctor', 'nurse to doctor', 'map nurse', 'nurse doctor mapping'],
    body: 'Nursing Admin → Nurse ↔ Doctor. Map a nurse to one or many doctors so that nurse handles patients under those doctors. This drives which patients flow to which nurse.',
  },
  {
    title: 'Bulk shift handover (nurse admin)',
    roles: ['nurse_admin'],
    keywords: ['bulk handover', 'shift transfer', 'handover all', 'next shift'],
    body: 'Nursing Admin → Shift Handover. Bulk-transfer the current shift\'s assignments to the next-shift nurses atomically, so nobody is left unassigned at shift change.',
  },
  {
    title: 'Plan and publish the duty roster',
    roles: ['nurse_admin', 'hr_staff'],
    keywords: ['roster', 'duty roster', 'shift plan', 'publish roster', 'schedule nurses'],
    body: 'Nursing Admin → Roster Planning (nurses) or HR → Duty Rosters (all staff). Build the weekly roster grid, set each person\'s shift, then publish and approve it. The roster is the source of truth for shift detection used by the nurse dashboard and handover.',
  },
  {
    title: 'Set up floors, wards and beds',
    roles: ['nurse_admin', 'admin'],
    keywords: ['ward', 'bed', 'floor', 'add ward', 'add bed', 'room', 'ward setup', 'bed availability'],
    body: 'Nursing Admin → Ward (or Hospital → Settings → Rooms for admin). Structure is Hospital → Floor (level + name) → Ward → Bed. Add floors, then wards, then beds; each bed tracks its status (available/occupied). Bed availability shows on Hospital IP Home.',
  },
  {
    title: 'Staffing overview and coverage',
    roles: ['nurse_admin'],
    keywords: ['staffing', 'coverage', 'heatmap', 'staffing report', 'nurse coverage'],
    body: 'Nursing Admin → Staffing gives a hospital-wide staffing view with a coverage heatmap and CSV export, so you can spot shifts/wards that are short.',
  },

  // ---------------------------------------------------------------------------
  // Pharmacy
  // ---------------------------------------------------------------------------
  {
    title: 'Dispense a prescription',
    roles: ['pharmacist', 'pharmacy_admin'],
    keywords: ['dispense', 'dispensing', 'prescription queue', 'pharmacy billing', 'sell medicine', 'pos'],
    body: 'Pharmacy module → Billing (POS) or Prescription Queue. Pick the prescription/patient, add the drugs (batch is chosen by expiry), set quantities, apply any discount, and take payment to dispense. The stock ledger and batch quantities update automatically.',
  },
  {
    title: 'Process a drug return',
    roles: ['pharmacist', 'pharmacy_admin'],
    keywords: ['drug return', 'return medicine', 'refund medicine', 'counter return', 'return'],
    body: 'Pharmacy module → Returns. A patient return links to the original sale line and, on approval, creates a refund and restocks. A counter return (walk-in, no patient) just takes the medicine + quantity. Returnable items come from GET returnable sales.',
  },
  {
    title: 'Pre-pack holds',
    roles: ['pharmacist', 'pharmacy_admin'],
    keywords: ['pre-pack', 'prepack', 'hold', 'reserve medicine'],
    body: 'Pharmacy module → Pre-Pack Holds. Reserve/prepare medicines ahead of collection; release them when the patient arrives.',
  },
  {
    title: 'Add / receive drug stock (batches)',
    roles: ['pharmacy_admin', 'inventory_manager'],
    keywords: ['add stock', 'drug stock', 'batch', 'stock inward', 'receive stock', 'expiry', 'inward'],
    body: 'Inventory module → Storage → Add Stock. "New Item" defines a drug/item; Bulk Stock Inward receives quantities with batch number, expiry and pack size (a strip can sell as loose units). You can OCR a supplier invoice to auto-fill (if enabled). Medicines expand inline to their batch workspace.',
  },
  {
    title: 'Recall a drug batch',
    roles: ['pharmacy_admin'],
    keywords: ['recall', 'drug recall', 'affected patients', 'lift recall', 'batch recall'],
    body: 'Pharmacy/Inventory → Batches. Use the "Recall Drug" header button or a row\'s Recall action; filter with the Recalled chip. You can Lift a recall and see Affected Patients (who received the recalled batch).',
  },
  {
    title: 'Pharmacy statutory / NDPS reports',
    roles: ['pharmacy_admin'],
    keywords: ['statutory report', 'ndps', 'narcotics', 'schedule drug', 'compliance report pharmacy'],
    body: 'Pharmacy module → Statutory Reports for regulatory filings, and Inventory → Narcotics (NDPS) for controlled-substance registers. Pharmacy Admin also has Reports (detailed analytics), Ward Stock, Stock Ledger and Discount Policy.',
  },

  // ---------------------------------------------------------------------------
  // Laboratory
  // ---------------------------------------------------------------------------
  {
    title: 'Accept a lab order and collect the sample',
    roles: ['lab_technician', 'lab_supervisor'],
    keywords: ['accept order', 'lab order', 'collect sample', 'sample', 'sample collection', 'lab home'],
    body: 'Laboratory module → Home lists incoming orders. Accept an order, then move the sample through its lifecycle (collected → processing). Doctors create the orders; the lab does not create them.',
  },
  {
    title: 'Enter results and mark a test done',
    roles: ['lab_technician', 'lab_supervisor'],
    keywords: ['enter results', 'lab result', 'result entry', 'mark done', 'upload report', 'add details'],
    body: 'Open the order in the Laboratory module. For each test either "Add Details" (enter values against reference ranges) or "Upload File" (attach the report), then "Upload + Mark Done". When the last test is done the report goes to review status for a supervisor to publish. The uploaded file becomes the report.',
  },
  {
    title: 'Approve and publish a lab report',
    roles: ['lab_supervisor'],
    keywords: ['approve report', 'publish report', 'verify lab', 'sign report', 'release report'],
    body: 'Laboratory module → open the order → Report panel. A supervisor reviews the technician\'s results and clicks "Approve & Publish", which signs and releases the report to the patient portal and the ordering doctor. Technicians cannot publish.',
  },
  {
    title: 'Correct a published lab report',
    roles: ['lab_supervisor'],
    keywords: ['correct report', 'amend report', 'lab correction', 'edit after publish', 'reissue'],
    body: 'Once a report is finalized it is edit-locked. To change it, a supervisor uses the correction flow (issues a corrected version). While still draft/review, a test can be reopened with the per-test Edit button.',
  },
  {
    title: 'Manage the lab test catalog',
    roles: ['lab_supervisor'],
    keywords: ['test catalog', 'add test', 'lab test', 'template', 'import test', 'price tat', 'units'],
    body: 'Laboratory module → Settings. Clone tests from the super-admin Lab Test Templates into your catalog (one or all); a supervisor can then edit price/TAT. Manage units (unit groups/aliases), outsourcing and technicians here too.',
  },

  // ---------------------------------------------------------------------------
  // Radiology
  // ---------------------------------------------------------------------------
  {
    title: 'Work the radiology worklist and upload a result',
    roles: ['radiologist'],
    keywords: ['worklist', 'imaging result', 'upload imaging', 'radiology result', 'perform scan', 'attachment'],
    body: 'Radiology module → Home/Worklist shows payment-verified requests. Open one, perform the study, and upload the result file(s) — PDF, JPG, PNG, DICOM or MP4. Reporting is attachment-based; a draft is created when you open Upload.',
  },
  {
    title: 'Finalize / sign an imaging report',
    roles: ['radiologist'],
    keywords: ['finalize imaging', 'sign report radiology', 'publish imaging', 'complete study'],
    body: 'After uploading, click Finalize/Sign (gated on having at least one attachment). Radiology Admin must then approve it before the patient sees it. View studies in the Radiology Viewer (DICOM/PDF/image/ECG/video; OHIF/PACS if configured).',
  },
  {
    title: 'Verify payment on an imaging request',
    roles: ['radiology_admin'],
    keywords: ['verify payment', 'payment verify', 'imaging payment', 'approve request radiology'],
    body: 'Radiology module (admin surface). Stage 1: verify payment on a new imaging request — only then does it reach the radiologist\'s worklist. Stage 2: after the radiologist finalizes, approve the report so it reaches the patient. Payment-mode badges show on the request.',
  },
  {
    title: 'Close a no-show / cancel an imaging request',
    roles: ['radiology_admin'],
    keywords: ['no show', 'no-show', 'close request', 'cancel imaging', 'reschedule imaging', 'reopen'],
    body: 'Radiology admin can Close a request that won\'t produce a file: no-show, or cancelled (refused / done elsewhere, etc.) with a reason and note. Reopen or Reschedule from the Closed / No-show tab. Set per-modality prices under Radiology → Settings.',
  },

  // ---------------------------------------------------------------------------
  // Billing / cashier / finance
  // ---------------------------------------------------------------------------
  {
    title: 'Create a bill',
    roles: ['billing_admin', 'cashier', 'front_desk', 'admin'],
    keywords: ['create bill', 'billing', 'new bill', 'invoice', 'add services', 'generate bill'],
    body: 'Hospital module → Hospital Billing. Open/create the bill for a patient, add services (from the tariff/services list), apply any discount, then save. Cashiers create and update bills; billing admins can also finalize, delete and export.',
  },
  {
    title: 'Take a payment / cash counter',
    roles: ['cashier', 'billing_admin', 'front_desk'],
    keywords: ['payment', 'collect payment', 'cash counter', 'pay', 'receipt', 'card', 'upi'],
    body: 'Hospital module → Billing → Cash Counter. Select the bill, choose the mode (cash/card/UPI), record the amount and confirm to generate a receipt. Pending bills are tracked under the Pending tab.',
  },
  {
    title: 'Refunds, discounts and approvals (billing admin)',
    roles: ['billing_admin', 'admin'],
    keywords: ['refund', 'discount', 'approve payment', 'void bill', 'cancel bill', 'finalize'],
    body: 'Billing Admin can approve refunds, apply discounts and finalize/delete bills from the Billing and Transactions screens. Cashiers cannot approve refunds or apply discounts. Transactions has Collection Summary, Credit, Cancelled, Draft, Receipt and Day End tabs.',
  },
  {
    title: 'Credit settlement (insurance/corporate/patient)',
    roles: ['billing_admin', 'admin', 'insurance_staff'],
    keywords: ['credit settlement', 'settle credit', 'corporate billing', 'insurance settlement', 'tpa settle'],
    body: 'Hospital module → Credit Settlement has three tabs — Insurance, Corporate and Patient/Provider. Reconcile and settle outstanding credit against the payer.',
  },
  {
    title: 'Collect IP advance and generate the final bill',
    roles: ['billing_admin', 'cashier', 'admin'],
    keywords: ['advance', 'ip advance', 'final bill', 'discharge bill', 'deposit'],
    body: 'On the IP patient, use "Collect Advance" to take a deposit during the stay, and "Generate Final Bill" at discharge to consolidate charges. Patients can also pay online (Razorpay) from the patient portal.',
  },

  // ---------------------------------------------------------------------------
  // Inventory
  // ---------------------------------------------------------------------------
  {
    title: 'Add an inventory item / stock',
    roles: ['inventory_manager', 'pharmacy_admin', 'admin'],
    keywords: ['inventory', 'add stock', 'stock', 'new item', 'stock inward', 'item', 'batch', 'storage'],
    body: 'Inventory module → Storage → Add Stock. "New Item" defines an item or medicine (category, barcode); Bulk Stock Inward receives quantities (batch/expiry for medicines). A storage row is a medicine (batch-tracked) or any other supply; medicines expand to their batches.',
  },
  {
    title: 'Create a purchase order',
    roles: ['inventory_manager', 'pharmacy_admin', 'admin'],
    keywords: ['purchase order', 'po', 'order stock', 'procure', 'buy stock', 'supplier order'],
    body: 'Inventory module → Purchase Orders → New. Pick the vendor, add items and quantities, submit for approval, then receive against the PO when stock arrives (which creates the inward). Drug POs have their own screen (Drug Orders).',
  },
  {
    title: 'Manage suppliers / vendors',
    roles: ['inventory_manager', 'pharmacy_admin', 'admin'],
    keywords: ['supplier', 'vendor', 'add supplier', 'vendor management'],
    body: 'Inventory module → Vendors. Add and manage supplier records (contact, GST, terms) used on purchase orders.',
  },
  {
    title: 'Stock out / stock transfer',
    roles: ['inventory_manager', 'pharmacy_admin'],
    keywords: ['stock out', 'issue stock', 'stock transfer', 'move stock', 'department stock', 'consume'],
    body: 'Inventory module → Stock Out issues stock to a department/consumption; Stock Transfer moves stock between locations. Both update the ledger. Reports include Stock Balance, Expiry/Waste, Reorder History, Dept Consumption and a consolidated Detailed analysis.',
  },
  {
    title: 'Low-stock alerts and reports',
    roles: ['inventory_manager', 'pharmacy_admin', 'admin'],
    keywords: ['low stock', 'reorder', 'stock alert', 'inventory report', 'expiry report', 'valuation'],
    body: 'Inventory module → Reports. Watch Stock Balance / reorder levels for low-stock, Expiry/Waste for near-expiry, and the Detailed report for valuation, movements and department consumption.',
  },

  // ---------------------------------------------------------------------------
  // Insurance
  // ---------------------------------------------------------------------------
  {
    title: 'Submit an insurance claim',
    roles: ['insurance_staff', 'admin'],
    keywords: ['claim', 'insurance claim', 'submit claim', 'file claim', 'approve claim', 'reject claim'],
    body: 'Insurance module → Claims → New. Link the patient/admission and bill, attach documents, and submit to the insurer/TPA. Track status; approve or reject as responses come in. TPA Logs record the exchange.',
  },
  {
    title: 'Raise a pre-authorization',
    roles: ['insurance_staff', 'admin'],
    keywords: ['pre-auth', 'preauthorization', 'pre authorization', 'authorization', 'cashless'],
    body: 'Insurance module → Pre-Authorization. Create a pre-auth request for a planned admission/procedure against the patient\'s policy and submit it to the TPA for cashless approval.',
  },
  {
    title: 'Manage insurers, TPAs and policies',
    roles: ['insurance_staff', 'admin'],
    keywords: ['insurer', 'tpa', 'policy', 'add insurer', 'add policy', 'verify policy'],
    body: 'Insurance module → Insurers / TPA Providers to maintain payer records, and Policies to create and verify patient insurance policies used on claims and pre-auths.',
  },

  // ---------------------------------------------------------------------------
  // HR
  // ---------------------------------------------------------------------------
  {
    title: 'Add / manage a staff member',
    roles: ['hr_staff', 'admin'],
    keywords: ['staff', 'add staff', 'employee', 'staff profile', 'hr', 'license'],
    body: 'HR module → Staff → Add. Create the staff profile (department, designation, contact) and record professional Licenses under HR → Licenses (with expiry tracking). Note: creating a login user with a role is done in User Management by an admin.',
  },
  {
    title: 'Record attendance',
    roles: ['hr_staff', 'admin'],
    keywords: ['attendance', 'clock in', 'mark attendance', 'timesheet'],
    body: 'HR module → Attendance. Record and track staff attendance for the period; attendance feeds payroll.',
  },
  {
    title: 'Process leave requests',
    roles: ['hr_staff', 'admin'],
    keywords: ['leave', 'leave request', 'approve leave', 'time off', 'holiday'],
    body: 'HR module → Leaves. Review staff leave requests and approve or reject them. Approved leave shows on rosters/schedules.',
  },
  {
    title: 'Run payroll',
    roles: ['hr_staff', 'admin'],
    keywords: ['payroll', 'salary', 'pay slip', 'salary slip', 'run payroll', 'process salary'],
    body: 'HR module → Payroll. Generate payroll for the period (using attendance/leave), approve it, generate salary slips and export. HR reports summarise staffing and payroll.',
  },

  // ---------------------------------------------------------------------------
  // Blood bank
  // ---------------------------------------------------------------------------
  {
    title: 'Register a blood donor and record a donation',
    roles: ['blood_bank_staff', 'admin'],
    keywords: ['blood donor', 'donation', 'donor', 'blood bank', 'screening', 'collect blood'],
    body: 'Hospital module → Blood Bank. Register the donor, record the donation with screening results, and add the resulting unit (whole blood / packed cells / plasma / platelets) to inventory.',
  },
  {
    title: 'Cross-match and process a transfusion',
    roles: ['blood_bank_staff', 'admin'],
    keywords: ['cross match', 'crossmatch', 'transfusion', 'blood request', 'issue blood', 'compatibility'],
    body: 'Blood Bank. For a transfusion request, perform and record the cross-match against the patient, issue the compatible unit, and record the transfusion completion. Inventory decrements automatically.',
  },

  // ---------------------------------------------------------------------------
  // Admin (hospital)
  // ---------------------------------------------------------------------------
  {
    title: 'Create a user and assign a role',
    roles: ['admin'],
    keywords: ['create user', 'add user', 'assign role', 'new user', 'user management', 'staff login'],
    body: 'Hospital → Settings → Users (User Management). Create the user (email + temporary password), then assign one or more roles — permissions are additive across roles. Only admin/super-admin can create users and assign roles.',
  },
  {
    title: 'Configure services and tariffs',
    roles: ['admin', 'billing_admin'],
    keywords: ['services', 'tariff', 'price list', 'service master', 'charges', 'rate'],
    body: 'Hospital → Settings → Services. Define the billable services and their prices; these populate the item picker when creating bills.',
  },
  {
    title: 'Hospital settings (info, rooms, forms, schedules, bank, insurance)',
    roles: ['admin'],
    keywords: ['settings', 'hospital info', 'rooms', 'forms', 'doctor schedules', 'bank account', 'configure hospital'],
    body: 'Hospital → Settings groups: Hospital Info, Services, Rooms (floors/wards/beds), Forms (build dynamic forms from templates), Doctor Schedules, Bank Account and Insurance. Admin also has Reports, Dashboard and Audit Logs in the Hospital module.',
  },
  {
    title: 'Build a dynamic form',
    roles: ['admin'],
    keywords: ['form', 'dynamic form', 'build form', 'form builder', 'clone form', 'nursing form'],
    body: 'Hospital → Settings → Forms. Clone a super-admin form template or build your own; publish it so nurses can fill it under Patient Forms. Submissions are tenant-isolated and retained even if the form is later retired.',
  },
  {
    title: 'View reports and audit logs',
    roles: ['admin', 'nurse_admin'],
    keywords: ['reports', 'audit log', 'audit', 'analytics', 'export report'],
    body: 'Hospital module → Reports (7 categories) and Dashboard (stat cards). Audit Logs (read/export) record who changed what. Most modules also carry their own Reports surface.',
  },

  // ---------------------------------------------------------------------------
  // Super admin (platform)
  // ---------------------------------------------------------------------------
  {
    title: 'Onboard / manage a hospital (super-admin)',
    roles: ['super_admin'],
    keywords: ['onboard hospital', 'add hospital', 'tenant', 'subscription', 'activate hospital', 'new clinic'],
    body: 'Super Admin → Hospitals → add a hospital (tenant), set its subscription/plan and features, and activate it. Manage subscriptions, commissions and demo requests from the Super Admin panel.',
  },
  {
    title: 'Configure AI / LLM provider (super-admin)',
    roles: ['super_admin'],
    keywords: ['configure ai', 'llm settings', 'ai settings', 'gemini', 'openai', 'ai provider', 'ai model', 'disable ai'],
    body: 'Super Admin → AI Settings. Choose the provider (Gemini or OpenAI) and model per hospital or platform-default, set temperature/fallbacks, and toggle each AI feature (patient chatbot, blood report, support chatbot, discharge, radiology, progress-note suggestions, invoice OCR). API keys are set on the server via environment variables.',
  },
  {
    title: 'Manage the ICD catalog / Drug Master / Lab templates (super-admin)',
    roles: ['super_admin'],
    keywords: ['icd', 'drug master', 'lab template', 'lab units', 'catalog', 'form template', 'platform catalog'],
    body: 'Super Admin panel: ICD Codes (shared ICD-10 catalog + custom), Drug Master (~254K Indian drugs → hospitals import into their formulary), Lab Templates & Lab Units (hospitals clone into their catalog), and Form Templates. These are platform-wide and inherited by every hospital.',
  },

  // ---------------------------------------------------------------------------
  // Patient portal
  // ---------------------------------------------------------------------------
  {
    title: 'Patient portal — book an appointment',
    roles: ['patient'],
    keywords: ['book appointment', 'patient portal', 'appointment', 'see doctor', 'follow up'],
    body: 'Patient Portal → Book Appointment. Choose the doctor/date/slot and confirm; see your upcoming and past appointments under Appointments and Follow-ups.',
  },
  {
    title: 'Patient portal — view reports, prescriptions and pay bills',
    roles: ['patient'],
    keywords: ['my reports', 'lab reports', 'imaging reports', 'prescriptions', 'pay bill', 'bills', 'medications', 'discharge summary'],
    body: 'Patient Portal: Lab Reports and Imaging Reports show your published results; Prescriptions and Current Medications show your medicines; Consultation & Discharge Summaries show your visit documents; Billing lets you view and pay bills online (Razorpay). You only ever see your own data.',
  },
];

const STOP = new Set([
  'how', 'do', 'i', 'a', 'an', 'the', 'to', 'in', 'on', 'of', 'for', 'is', 'are',
  'can', 'my', 'me', 'we', 'this', 'that', 'and', 'or', 'with', 'add', 'new', 'get',
  'where', 'what', 'does', 'use', 'used', 'using', 'from',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Return the top-N docs most relevant to the question by keyword overlap,
 * BOOSTED for docs that match the signed-in user's role. Passing the user's
 * roles makes a nurse and a doctor asking the same words get their own
 * workflow's answer first. Docs are never hard-filtered by role, so a
 * cross-role "how does X do it?" still surfaces the right doc (the LLM, told
 * the caller's role, will explain who can actually do it).
 */
export function retrieveDocs(question: string, roles: string[] = [], n = 3): HowToDoc[] {
  const qTokens = new Set(tokenize(question));
  const ql = question.toLowerCase();
  const roleSet = new Set(roles.map((r) => normalizeRole(r)));

  const scored = HOW_TO_DOCS.map((doc) => {
    let score = 0;
    for (const kw of doc.keywords) {
      if (ql.includes(kw)) score += 5; // whole-phrase keyword hit
      for (const t of tokenize(kw)) if (qTokens.has(t)) score += 1;
    }
    for (const t of tokenize(doc.title)) if (qTokens.has(t)) score += 1;

    // Role affinity: strongly prefer docs written for THIS user's role.
    if (score > 0) {
      const universal = doc.roles.includes('*');
      const mine = doc.roles.some((r) => roleSet.has(r));
      if (mine) score += 4;
      else if (universal) score += 1;
      else if (roleSet.size) score -= 1; // a doc for a different role, deprioritised
    }
    return { doc, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, n).map((s) => s.doc);
}
