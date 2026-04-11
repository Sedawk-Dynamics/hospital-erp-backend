/**
 * Seeds 40 System Forms — fixed, developer-defined forms with immutable triggers.
 *
 * Idempotent: upserts by slug id. Run with:
 *   npx tsx prisma/seed-system-forms.ts
 */
import { PrismaClient, FormCategory, FormTrigger } from '@prisma/client';

const prisma = new PrismaClient();

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

type RoleSetting = 'required' | 'optional' | 'view_only' | 'hidden';

interface FormField {
  id: string;
  type: string;
  label: string;
  placeholder?: string;
  helpText?: string;
  required: boolean;
  options?: { value: string; label: string }[];
  width: 'full' | 'half' | 'third';
}

interface SystemFormSeed {
  id: string;
  name: string;
  description: string;
  category: FormCategory;
  trigger: FormTrigger;
  sortOrder: number;
  /** Subscription module this form belongs to.
   *  Values match FeatureToggle.featureKey (appointments, billing, lab, pharmacy, inventory,
   *  imaging, ip_management, ot_management, blood_bank, insurance, hr, compliance, reports, multi_hospital). */
  module: string;
  /** Only these roles appear in the hospital admin's configure dialog. */
  applicableRoles: string[];
  /** Where this form appears in the workflow (human-readable) */
  appearsAt: string;
  /** Where submitted results are displayed (list of pages/views) */
  resultsVisibleAt: string[];
  defaultRoleSettings: Record<string, RoleSetting>;
  schema: { version: number; fields: FormField[] };
}

// ────────────────────────────────────────────────────────────────
// Helper to build simple fields quickly
// ────────────────────────────────────────────────────────────────

const sec = (id: string, label: string): FormField => ({
  id, type: 'section_header', label, required: false, width: 'full',
});

const txt = (id: string, label: string, opts: Partial<FormField> = {}): FormField => ({
  id, type: 'text', label, required: false, width: 'half', ...opts,
});

const area = (id: string, label: string, opts: Partial<FormField> = {}): FormField => ({
  id, type: 'textarea', label, required: false, width: 'full', ...opts,
});

const num = (id: string, label: string, opts: Partial<FormField> = {}): FormField => ({
  id, type: 'number', label, required: false, width: 'half', ...opts,
});

const sel = (id: string, label: string, options: string[], opts: Partial<FormField> = {}): FormField => ({
  id, type: 'select', label, required: false, width: 'half',
  options: options.map(o => ({ value: o.toLowerCase().replace(/\s+/g, '_'), label: o })),
  ...opts,
});

const radio = (id: string, label: string, options: string[], opts: Partial<FormField> = {}): FormField => ({
  id, type: 'radio', label, required: false, width: 'full',
  options: options.map(o => ({ value: o.toLowerCase().replace(/\s+/g, '_'), label: o })),
  ...opts,
});

const check = (id: string, label: string, opts: Partial<FormField> = {}): FormField => ({
  id, type: 'checkbox', label, required: false, width: 'full', ...opts,
});

const date = (id: string, label: string, opts: Partial<FormField> = {}): FormField => ({
  id, type: 'date', label, required: false, width: 'half', ...opts,
});

const time = (id: string, label: string, opts: Partial<FormField> = {}): FormField => ({
  id, type: 'time', label, required: false, width: 'half', ...opts,
});

const phone = (id: string, label: string, opts: Partial<FormField> = {}): FormField => ({
  id, type: 'phone', label, required: false, width: 'half', ...opts,
});

const email = (id: string, label: string, opts: Partial<FormField> = {}): FormField => ({
  id, type: 'email', label, required: false, width: 'half', ...opts,
});

const multiSel = (id: string, label: string, options: string[], opts: Partial<FormField> = {}): FormField => ({
  id, type: 'multi_select', label, required: false, width: 'full',
  options: options.map(o => ({ value: o.toLowerCase().replace(/\s+/g, '_'), label: o })),
  ...opts,
});

const sig = (id: string, label: string): FormField => ({
  id, type: 'signature', label, required: true, width: 'full',
});

// ────────────────────────────────────────────────────────────────
// Rating options reused across many forms
// ────────────────────────────────────────────────────────────────

const PAIN_SCALE = Array.from({ length: 11 }, (_, i) => ({ value: String(i), label: `${i}${i === 0 ? ' (None)' : i === 10 ? ' (Worst)' : ''}` }));

const RATING_5 = [
  { value: '5', label: 'Excellent' },
  { value: '4', label: 'Good' },
  { value: '3', label: 'Average' },
  { value: '2', label: 'Poor' },
  { value: '1', label: 'Very Poor' },
];

// ════════════════════════════════════════════════════════════════
//  ALL 40 SYSTEM FORMS
// ════════════════════════════════════════════════════════════════

const SYSTEM_FORMS: SystemFormSeed[] = [

  // ────────────────────────────────────────────────────────────
  //  APPOINTMENT BOOKING (4 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'patient_health_intake',
    name: 'Patient Health Intake',
    description: 'Pre-visit medical history, current symptoms, allergies, and lifestyle captured at booking time.',
    category: 'intake',
    trigger: 'appointment_booking',
    sortOrder: 1,
    module: 'appointments',
    applicableRoles: ['patient', 'front_desk', 'doctor', 'nurse'],
    appearsAt: 'Patient booking flow — after appointment is confirmed',
    resultsVisibleAt: ['Doctor consultation view (Forms tab)', 'Patient detail dialog (Front Desk)', 'Appointment detail page'],
    defaultRoleSettings: { patient: 'required', front_desk: 'optional', doctor: 'view_only', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_vitals', 'Body Measurements'),
      num('height_cm', 'Height (cm)', { placeholder: '170' }),
      num('weight_kg', 'Weight (kg)', { placeholder: '70' }),
      sec('sec_visit', 'Why are you visiting today?'),
      area('main_complaint', 'Main complaint / symptoms', { required: true, placeholder: 'Describe what brings you in today...' }),
      sel('symptom_duration', 'How long have you had these symptoms?', ['Less than 1 day', '1-3 days', '4-7 days', '1-2 weeks', '2-4 weeks', 'More than 1 month'], { required: true }),
      { id: 'pain_level', type: 'select', label: 'Pain level (0=none, 10=severe)', required: false, width: 'half' as const, options: PAIN_SCALE },
      sec('sec_history', 'Medical History'),
      multiSel('chronic_conditions', 'Chronic conditions (select all that apply)', ['Diabetes', 'High Blood Pressure', 'Asthma', 'Heart Disease', 'Kidney Disease', 'Liver Disease', 'Thyroid Disorder', 'Cancer', 'None']),
      area('previous_surgeries', 'Past surgeries or hospitalizations', { placeholder: 'e.g. Appendectomy in 2019' }),
      area('family_history', 'Family history of major illnesses', { placeholder: 'e.g. Father - diabetes; Mother - hypertension' }),
      sec('sec_allergies', 'Allergies & Medications'),
      radio('has_allergies', 'Do you have any known allergies?', ['Yes', 'No'], { required: true }),
      area('allergies_list', 'List your allergies (drugs, food, environmental)', { placeholder: 'e.g. Penicillin, peanuts, dust' }),
      area('current_medications', 'Current medications', { placeholder: 'Drug name + dose + frequency' }),
      sec('sec_lifestyle', 'Lifestyle'),
      radio('smoking', 'Smoking status', ['Never', 'Former smoker', 'Current smoker']),
      radio('alcohol', 'Alcohol consumption', ['None', 'Occasional', 'Moderate', 'Heavy']),
    ]},
  },

  {
    id: 'insurance_verification',
    name: 'Insurance & Payment Info',
    description: 'Insurance provider details, policy number, and payment method preferences.',
    category: 'registration',
    trigger: 'appointment_booking',
    sortOrder: 2,
    module: 'appointments',
    applicableRoles: ['patient', 'front_desk', 'insurance_staff', 'billing_admin'],
    appearsAt: 'Patient booking flow — after appointment is confirmed',
    resultsVisibleAt: ['Patient detail dialog (Front Desk)', 'Billing page', 'Appointment detail page'],
    defaultRoleSettings: { patient: 'required', front_desk: 'optional', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_insurance', 'Insurance Details'),
      radio('has_insurance', 'Do you have health insurance?', ['Yes', 'No'], { required: true }),
      txt('insurance_provider', 'Insurance Provider / Company', { width: 'full' }),
      txt('policy_number', 'Policy / Member ID'),
      txt('group_number', 'Group Number'),
      txt('policy_holder', 'Policy Holder Name'),
      sel('relationship', 'Relationship to Policy Holder', ['Self', 'Spouse', 'Child', 'Parent', 'Other']),
      date('policy_expiry', 'Policy Expiry Date'),
      sec('sec_payment', 'Payment Preference'),
      radio('payment_method', 'Preferred payment method', ['Insurance', 'Cash', 'Card', 'UPI']),
      txt('corporate_name', 'Corporate / Employer Name (if applicable)', { width: 'full' }),
    ]},
  },

  {
    id: 'general_consent',
    name: 'Consent for Treatment',
    description: 'General consent for medical examination, treatment, and data sharing as per regulations.',
    category: 'consent',
    trigger: 'appointment_booking',
    sortOrder: 3,
    module: 'appointments',
    applicableRoles: ['patient', 'front_desk', 'doctor', 'nurse'],
    appearsAt: 'Patient booking flow — after appointment is confirmed',
    resultsVisibleAt: ['Doctor consultation view (Forms tab)', 'Patient detail dialog (Front Desk)', 'Appointment detail page'],
    defaultRoleSettings: { patient: 'required', front_desk: 'optional', doctor: 'view_only', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_consent', 'Consent Acknowledgements'),
      check('ack_examination', 'I consent to medical examination and treatment by the attending physician.', { required: true }),
      check('ack_info_sharing', 'I consent to sharing my medical information with authorized hospital staff for treatment purposes.', { required: true }),
      check('ack_privacy', 'I have read and understood the hospital privacy policy.', { required: true }),
      check('ack_billing', 'I understand I am responsible for all charges not covered by insurance.', { required: true }),
      check('ack_emergency', 'In case of emergency, I authorize the hospital to perform necessary life-saving procedures.'),
      sec('sec_signature', 'Signature'),
      sig('patient_signature', 'Patient Signature (type full name)'),
      date('signed_date', 'Date', { required: true }),
    ]},
  },

  {
    id: 'demographics_verification',
    name: 'Demographics Verification',
    description: 'Front desk verifies and updates patient demographics, address, and emergency contact.',
    category: 'registration',
    trigger: 'appointment_booking',
    sortOrder: 4,
    module: 'appointments',
    applicableRoles: ['front_desk'],
    appearsAt: 'Patient booking flow — after appointment is confirmed',
    resultsVisibleAt: ['Patient detail dialog (Front Desk)', 'Appointment detail page'],
    defaultRoleSettings: { front_desk: 'required', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_verify', 'Patient Verification'),
      check('id_verified', 'Photo ID verified', { required: true }),
      check('address_confirmed', 'Address confirmed / updated'),
      check('phone_confirmed', 'Phone number confirmed'),
      check('email_confirmed', 'Email address confirmed'),
      sec('sec_emergency', 'Emergency Contact'),
      txt('emergency_name', 'Emergency Contact Name', { required: true }),
      phone('emergency_phone', 'Emergency Contact Phone', { required: true }),
      sel('emergency_relation', 'Relationship', ['Spouse', 'Parent', 'Child', 'Sibling', 'Friend', 'Other']),
      area('notes', 'Front Desk Notes'),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  PATIENT REGISTRATION (2 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'new_patient_registration',
    name: 'New Patient Registration',
    description: 'Complete registration form for new patients including personal, contact, and identification details.',
    category: 'registration',
    trigger: 'patient_registration',
    sortOrder: 1,
    module: 'appointments',
    applicableRoles: ['front_desk'],
    appearsAt: 'New patient registration at front desk',
    resultsVisibleAt: ['Patient detail dialog (Front Desk)'],
    defaultRoleSettings: { front_desk: 'required', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_personal', 'Personal Information'),
      txt('full_name', 'Full Name', { required: true, width: 'full' }),
      date('date_of_birth', 'Date of Birth', { required: true }),
      sel('gender', 'Gender', ['Male', 'Female', 'Other'], { required: true }),
      sel('blood_group', 'Blood Group', ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown']),
      sel('marital_status', 'Marital Status', ['Single', 'Married', 'Divorced', 'Widowed']),
      txt('occupation', 'Occupation'),
      txt('nationality', 'Nationality'),
      sec('sec_contact', 'Contact Details'),
      phone('phone', 'Mobile Number', { required: true }),
      phone('alt_phone', 'Alternate Phone'),
      email('email_addr', 'Email Address'),
      sec('sec_address', 'Address'),
      area('address', 'Full Address', { required: true }),
      txt('city', 'City', { required: true }),
      txt('state', 'State'),
      txt('pincode', 'PIN Code'),
      sec('sec_id', 'Identification'),
      sel('id_type', 'ID Proof Type', ['Aadhaar', 'PAN', 'Passport', 'Voter ID', 'Driving License']),
      txt('id_number', 'ID Number'),
    ]},
  },

  {
    id: 'emergency_contact',
    name: 'Emergency Contact Information',
    description: 'Emergency contacts and next of kin details for the patient record.',
    category: 'registration',
    trigger: 'patient_registration',
    sortOrder: 2,
    module: 'appointments',
    applicableRoles: ['patient', 'front_desk', 'doctor', 'nurse'],
    appearsAt: 'New patient registration at front desk',
    resultsVisibleAt: ['Patient detail dialog (Front Desk)', 'Doctor consultation view (Forms tab)'],
    defaultRoleSettings: { patient: 'required', front_desk: 'optional', doctor: 'view_only', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_primary', 'Primary Emergency Contact'),
      txt('contact1_name', 'Full Name', { required: true, width: 'full' }),
      phone('contact1_phone', 'Phone Number', { required: true }),
      sel('contact1_relation', 'Relationship', ['Spouse', 'Parent', 'Child', 'Sibling', 'Friend', 'Other'], { required: true }),
      txt('contact1_address', 'Address', { width: 'full' }),
      sec('sec_secondary', 'Secondary Emergency Contact'),
      txt('contact2_name', 'Full Name', { width: 'full' }),
      phone('contact2_phone', 'Phone Number'),
      sel('contact2_relation', 'Relationship', ['Spouse', 'Parent', 'Child', 'Sibling', 'Friend', 'Other']),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  VISIT CHECK-IN (4 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'chief_complaint',
    name: 'Chief Complaint & Symptoms',
    description: 'Primary reason for visit, symptom description, onset, and severity.',
    category: 'clinical',
    trigger: 'visit_check_in',
    sortOrder: 1,
    module: 'appointments',
    applicableRoles: ['patient', 'front_desk', 'doctor', 'nurse'],
    appearsAt: 'When patient checks in at front desk for their appointment',
    resultsVisibleAt: ['Doctor consultation view (Forms tab)', 'Patient detail dialog (Front Desk)'],
    defaultRoleSettings: { patient: 'optional', front_desk: 'required', doctor: 'view_only', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_complaint', 'Chief Complaint'),
      area('chief_complaint', 'What is the main reason for your visit today?', { required: true }),
      sel('symptom_onset', 'When did symptoms start?', ['Today', 'Yesterday', '2-3 days ago', '1 week ago', '2-4 weeks ago', 'More than a month ago'], { required: true }),
      sel('severity', 'How severe are your symptoms?', ['Mild', 'Moderate', 'Severe', 'Very Severe'], { required: true }),
      radio('getting_worse', 'Are symptoms getting worse?', ['Yes', 'No', 'Same']),
      sec('sec_associated', 'Associated Symptoms'),
      multiSel('associated_symptoms', 'Any other symptoms? (select all)', ['Fever', 'Headache', 'Nausea', 'Vomiting', 'Cough', 'Breathlessness', 'Fatigue', 'Dizziness', 'Body ache', 'Loss of appetite', 'None']),
      area('additional_details', 'Any additional details'),
    ]},
  },

  {
    id: 'current_medications',
    name: 'Current Medications List',
    description: 'List of all medications the patient is currently taking including dosage and frequency.',
    category: 'clinical',
    trigger: 'visit_check_in',
    sortOrder: 2,
    module: 'appointments',
    applicableRoles: ['patient', 'nurse', 'doctor', 'pharmacist'],
    appearsAt: 'When patient checks in at front desk for their appointment',
    resultsVisibleAt: ['Doctor consultation view (Forms tab)', 'Pharmacy module'],
    defaultRoleSettings: { patient: 'optional', nurse: 'optional', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_meds', 'Current Medications'),
      radio('taking_meds', 'Are you currently taking any medications?', ['Yes', 'No'], { required: true }),
      area('medications_list', 'List all medications (name, dose, frequency)', { placeholder: 'e.g. Metformin 500mg - twice daily' }),
      radio('taking_supplements', 'Are you taking any vitamins/supplements/herbal remedies?', ['Yes', 'No']),
      area('supplements_list', 'List supplements'),
      sec('sec_compliance', 'Medication Compliance'),
      radio('missed_doses', 'Have you missed any doses recently?', ['No', 'Yes, occasionally', 'Yes, frequently']),
      area('side_effects', 'Any side effects from current medications?'),
    ]},
  },

  {
    id: 'allergy_questionnaire',
    name: 'Allergy Questionnaire',
    description: 'Detailed allergy screening covering drug, food, environmental, and latex allergies.',
    category: 'intake',
    trigger: 'visit_check_in',
    sortOrder: 3,
    module: 'appointments',
    applicableRoles: ['patient', 'nurse', 'doctor', 'pharmacist'],
    appearsAt: 'When patient checks in at front desk for their appointment',
    resultsVisibleAt: ['Doctor consultation view (Forms tab)', 'Patient detail dialog (Front Desk)', 'Pharmacy module'],
    defaultRoleSettings: { patient: 'required', nurse: 'optional', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_drug', 'Drug Allergies'),
      radio('has_drug_allergy', 'Do you have any drug allergies?', ['Yes', 'No', 'Unknown'], { required: true }),
      area('drug_allergies', 'List drug allergies and reactions', { placeholder: 'e.g. Penicillin - rash; Sulfa - swelling' }),
      sec('sec_food', 'Food & Environmental'),
      radio('has_food_allergy', 'Any food allergies?', ['Yes', 'No']),
      area('food_allergies', 'List food allergies'),
      radio('has_env_allergy', 'Any environmental allergies (dust, pollen, etc.)?', ['Yes', 'No']),
      area('env_allergies', 'List environmental allergies'),
      sec('sec_other', 'Other'),
      radio('latex_allergy', 'Latex allergy?', ['Yes', 'No', 'Unknown']),
      radio('contrast_allergy', 'Allergy to contrast dye/iodine?', ['Yes', 'No', 'Unknown']),
      area('other_allergies', 'Any other allergies or sensitivities'),
    ]},
  },

  {
    id: 'infection_screening',
    name: 'Infection Screening',
    description: 'Screening questionnaire for infectious diseases, travel history, and exposure risks.',
    category: 'checklist',
    trigger: 'visit_check_in',
    sortOrder: 4,
    module: 'appointments',
    applicableRoles: ['nurse', 'front_desk', 'doctor'],
    appearsAt: 'When patient checks in at front desk for their appointment',
    resultsVisibleAt: ['Doctor consultation view (Forms tab)', 'Patient detail dialog (Front Desk)'],
    defaultRoleSettings: { nurse: 'required', front_desk: 'optional', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_symptoms', 'Symptom Screening'),
      check('fever', 'Fever (>38C / 100.4F) in last 14 days'),
      check('cough', 'New or worsening cough'),
      check('breathing_difficulty', 'Difficulty breathing'),
      check('sore_throat', 'Sore throat'),
      check('body_aches', 'Body aches / fatigue'),
      check('loss_taste_smell', 'Loss of taste or smell'),
      check('diarrhea', 'Diarrhea or vomiting'),
      sec('sec_exposure', 'Exposure & Travel'),
      radio('recent_travel', 'International travel in last 30 days?', ['Yes', 'No']),
      txt('travel_destination', 'If yes, where?', { width: 'full' }),
      radio('contact_with_infected', 'Contact with anyone diagnosed with infectious disease?', ['Yes', 'No', 'Unknown']),
      radio('isolation_required', 'Is isolation recommended?', ['Yes', 'No']),
      area('screening_notes', 'Additional screening notes'),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  PRE-CONSULTATION (4 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'vital_signs',
    name: 'Vital Signs Entry',
    description: 'Standard vital signs recorded by nurse before doctor consultation.',
    category: 'clinical',
    trigger: 'pre_consultation',
    sortOrder: 1,
    module: 'appointments',
    applicableRoles: ['nurse', 'doctor'],
    appearsAt: 'Before doctor consultation — nurse records vitals',
    resultsVisibleAt: ['Doctor consultation view (Forms tab)'],
    defaultRoleSettings: { nurse: 'required', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_vitals', 'Vital Signs'),
      num('temperature', 'Temperature (F)', { required: true, placeholder: '98.6' }),
      num('pulse', 'Pulse Rate (bpm)', { required: true, placeholder: '72' }),
      num('bp_systolic', 'BP Systolic (mmHg)', { required: true, placeholder: '120' }),
      num('bp_diastolic', 'BP Diastolic (mmHg)', { required: true, placeholder: '80' }),
      num('respiratory_rate', 'Respiratory Rate (/min)', { placeholder: '16' }),
      num('spo2', 'SpO2 (%)', { required: true, placeholder: '98' }),
      sec('sec_measurements', 'Measurements'),
      num('height_cm', 'Height (cm)', { placeholder: '170' }),
      num('weight_kg', 'Weight (kg)', { placeholder: '70' }),
      num('bmi', 'BMI (auto-calc if available)', { placeholder: '24.2' }),
      sec('sec_observations', 'Observations'),
      sel('general_appearance', 'General Appearance', ['Alert & Oriented', 'Drowsy', 'Lethargic', 'Distressed', 'Unconscious']),
      area('nurse_observations', 'Nurse Observations'),
    ]},
  },

  {
    id: 'pain_assessment',
    name: 'Pain Assessment Scale',
    description: 'Standardized pain assessment including location, type, intensity, and aggravating factors.',
    category: 'clinical',
    trigger: 'pre_consultation',
    sortOrder: 2,
    module: 'appointments',
    applicableRoles: ['nurse', 'doctor'],
    appearsAt: 'Before doctor consultation — nurse assesses pain',
    resultsVisibleAt: ['Doctor consultation view (Forms tab)'],
    defaultRoleSettings: { nurse: 'required', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_pain', 'Pain Assessment'),
      { id: 'pain_score', type: 'select', label: 'Pain Score (0-10)', required: true, width: 'half' as const, options: PAIN_SCALE },
      sel('pain_type', 'Type of Pain', ['Sharp', 'Dull', 'Burning', 'Throbbing', 'Cramping', 'Stabbing', 'Aching', 'Shooting'], { required: true }),
      txt('pain_location', 'Location of Pain', { required: true, width: 'full' }),
      radio('pain_onset', 'Onset', ['Sudden', 'Gradual']),
      sel('pain_duration', 'Duration', ['Constant', 'Intermittent', 'Only with movement', 'Only at rest']),
      sec('sec_factors', 'Factors'),
      area('aggravating_factors', 'What makes it worse?'),
      area('relieving_factors', 'What makes it better?'),
      radio('pain_affects_sleep', 'Does pain affect sleep?', ['Yes', 'No']),
      radio('pain_affects_activity', 'Does pain limit daily activities?', ['Yes', 'No']),
    ]},
  },

  {
    id: 'review_of_systems',
    name: 'Review of Systems (ROS)',
    description: 'Systematic body-system review to identify symptoms across all organ systems.',
    category: 'clinical',
    trigger: 'pre_consultation',
    sortOrder: 3,
    module: 'appointments',
    applicableRoles: ['nurse', 'doctor'],
    appearsAt: 'Before doctor consultation — systematic review',
    resultsVisibleAt: ['Doctor consultation view (Forms tab)'],
    defaultRoleSettings: { nurse: 'optional', doctor: 'optional', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_constitutional', 'Constitutional'),
      multiSel('constitutional', 'Any of the following?', ['Fever', 'Chills', 'Weight loss', 'Weight gain', 'Fatigue', 'Night sweats', 'None']),
      sec('sec_heent', 'Head / Eyes / Ears / Nose / Throat'),
      multiSel('heent', 'Any of the following?', ['Headache', 'Vision changes', 'Hearing loss', 'Tinnitus', 'Nasal congestion', 'Sore throat', 'None']),
      sec('sec_cardiovascular', 'Cardiovascular'),
      multiSel('cardiovascular', 'Any of the following?', ['Chest pain', 'Palpitations', 'Shortness of breath', 'Leg swelling', 'Dizziness', 'None']),
      sec('sec_respiratory', 'Respiratory'),
      multiSel('respiratory', 'Any of the following?', ['Cough', 'Wheezing', 'Blood in sputum', 'Difficulty breathing', 'None']),
      sec('sec_gi', 'Gastrointestinal'),
      multiSel('gi', 'Any of the following?', ['Nausea', 'Vomiting', 'Diarrhea', 'Constipation', 'Abdominal pain', 'Blood in stool', 'Heartburn', 'None']),
      sec('sec_musculoskeletal', 'Musculoskeletal'),
      multiSel('musculoskeletal', 'Any of the following?', ['Joint pain', 'Muscle pain', 'Stiffness', 'Swelling', 'Limited range of motion', 'None']),
      sec('sec_neurological', 'Neurological'),
      multiSel('neurological', 'Any of the following?', ['Numbness', 'Tingling', 'Weakness', 'Seizures', 'Memory problems', 'Balance issues', 'None']),
      area('ros_notes', 'Additional ROS notes'),
    ]},
  },

  {
    id: 'medical_history_update',
    name: 'Medical History Update',
    description: 'Periodic update to medical history, recent hospitalizations, and changes in health status.',
    category: 'clinical',
    trigger: 'pre_consultation',
    sortOrder: 4,
    module: 'appointments',
    applicableRoles: ['patient', 'nurse', 'doctor'],
    appearsAt: 'Before doctor consultation — patient/nurse updates history',
    resultsVisibleAt: ['Doctor consultation view (Forms tab)', 'Patient detail dialog (Front Desk)'],
    defaultRoleSettings: { patient: 'optional', nurse: 'optional', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_changes', 'Recent Health Changes'),
      radio('health_changes', 'Any changes in your health since last visit?', ['Yes', 'No'], { required: true }),
      area('changes_description', 'Describe changes'),
      radio('recent_hospitalization', 'Any hospitalization since last visit?', ['Yes', 'No']),
      area('hospitalization_details', 'If yes, provide details'),
      sec('sec_medications', 'Medication Changes'),
      radio('med_changes', 'Any changes to your medications?', ['Yes - new medication', 'Yes - stopped medication', 'Yes - dose change', 'No changes']),
      area('med_changes_details', 'Describe medication changes'),
      sec('sec_procedures', 'Recent Procedures'),
      radio('recent_procedures', 'Any procedures or surgeries since last visit?', ['Yes', 'No']),
      area('procedure_details', 'If yes, provide details'),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  ADMISSION (5 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'admission_consent',
    name: 'Admission Consent',
    description: 'Consent for inpatient admission including treatment authorization and hospital policies.',
    category: 'consent',
    trigger: 'admission',
    sortOrder: 1,
    module: 'ip_management',
    applicableRoles: ['patient', 'front_desk', 'doctor', 'nurse'],
    appearsAt: 'When patient is admitted to the hospital (IP admission)',
    resultsVisibleAt: ['Doctor IP home', 'Nurse charting', 'Patient detail dialog (Front Desk)'],
    defaultRoleSettings: { patient: 'required', front_desk: 'required', doctor: 'view_only', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_consent', 'Admission Consent'),
      check('ack_admission', 'I consent to admission and inpatient treatment as recommended by my physician.', { required: true }),
      check('ack_policies', 'I have been informed of hospital policies, visiting hours, and patient rights.', { required: true }),
      check('ack_billing', 'I understand and accept financial responsibility for charges not covered by insurance.', { required: true }),
      check('ack_privacy', 'I consent to the collection and use of my health information for treatment purposes.', { required: true }),
      check('ack_safety', 'I have been informed about safety procedures and emergency exits.'),
      sec('sec_signature', 'Authorization'),
      sig('patient_signature', 'Patient / Guardian Signature'),
      txt('relationship_to_patient', 'If signed by guardian, relationship to patient'),
      date('consent_date', 'Date', { required: true }),
    ]},
  },

  {
    id: 'fall_risk_assessment',
    name: 'Fall Risk Assessment',
    description: 'Standardized fall risk screening (Morse scale) for inpatient safety.',
    category: 'checklist',
    trigger: 'admission',
    sortOrder: 2,
    module: 'ip_management',
    applicableRoles: ['nurse', 'doctor'],
    appearsAt: 'When patient is admitted to the hospital (IP admission)',
    resultsVisibleAt: ['Doctor IP home', 'Nurse charting'],
    defaultRoleSettings: { nurse: 'required', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_history', 'Fall History'),
      radio('fall_history', 'History of falling (within 3 months)?', ['Yes (25 pts)', 'No (0 pts)'], { required: true }),
      radio('secondary_diagnosis', 'Secondary diagnosis (2+ medical diagnoses)?', ['Yes (15 pts)', 'No (0 pts)'], { required: true }),
      sec('sec_mobility', 'Mobility'),
      sel('ambulatory_aid', 'Ambulatory aid', ['None / Bed rest / Nurse assist (0 pts)', 'Crutches / Cane / Walker (15 pts)', 'Furniture for support (30 pts)'], { required: true, width: 'full' }),
      radio('iv_therapy', 'IV therapy / Heparin lock?', ['Yes (20 pts)', 'No (0 pts)'], { required: true }),
      sec('sec_gait', 'Gait & Mental Status'),
      sel('gait', 'Gait', ['Normal / Bed rest / Wheelchair (0 pts)', 'Weak (10 pts)', 'Impaired (20 pts)'], { required: true, width: 'full' }),
      sel('mental_status', 'Mental status', ['Oriented to own ability (0 pts)', 'Overestimates / Forgets limitations (15 pts)'], { required: true, width: 'full' }),
      sec('sec_score', 'Total Score'),
      num('total_score', 'Total Morse Score', { required: true, placeholder: '0-125' }),
      sel('risk_level', 'Risk Level', ['Low (0-24)', 'Moderate (25-44)', 'High (45+)'], { required: true }),
      area('interventions', 'Interventions applied'),
    ]},
  },

  {
    id: 'nutritional_screening',
    name: 'Nutritional Screening',
    description: 'Nutrition risk screening for inpatients to identify malnutrition risks.',
    category: 'clinical',
    trigger: 'admission',
    sortOrder: 3,
    module: 'ip_management',
    applicableRoles: ['nurse', 'doctor', 'dietitian'],
    appearsAt: 'When patient is admitted to the hospital (IP admission)',
    resultsVisibleAt: ['Doctor IP home', 'Nurse charting'],
    defaultRoleSettings: { nurse: 'required', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_screening', 'Nutritional Screening'),
      radio('unintended_weight_loss', 'Unintended weight loss in last 3 months?', ['No', 'Unsure', 'Yes, 1-5 kg', 'Yes, 6-10 kg', 'Yes, >10 kg'], { required: true }),
      radio('reduced_intake', 'Reduced food intake in last week?', ['No', 'Moderate decrease', 'Severe decrease'], { required: true }),
      radio('bmi_category', 'BMI category', ['Normal (18.5-25)', 'Underweight (<18.5)', 'Overweight (25-30)', 'Obese (>30)'], { required: true }),
      radio('disease_severity', 'Disease severity', ['Normal nutritional needs', 'Mild stress (e.g. minor surgery)', 'Moderate stress (e.g. major surgery)', 'Severe stress (e.g. ICU)'], { required: true }),
      sec('sec_diet', 'Dietary Information'),
      multiSel('dietary_restrictions', 'Dietary restrictions', ['Vegetarian', 'Vegan', 'Diabetic diet', 'Low sodium', 'Renal diet', 'Gluten free', 'Liquid diet', 'None']),
      radio('swallowing_difficulty', 'Any difficulty swallowing?', ['No', 'Mild', 'Severe']),
      sel('nutritional_risk', 'Overall Nutritional Risk', ['Low', 'Moderate', 'High'], { required: true }),
      area('dietitian_referral_notes', 'Notes / Dietitian referral needed?'),
    ]},
  },

  {
    id: 'patient_property_checklist',
    name: 'Patient Property Checklist',
    description: 'Inventory of patient belongings and valuables at admission.',
    category: 'checklist',
    trigger: 'admission',
    sortOrder: 4,
    module: 'ip_management',
    applicableRoles: ['nurse', 'front_desk'],
    appearsAt: 'When patient is admitted to the hospital (IP admission)',
    resultsVisibleAt: ['Nurse charting', 'Patient detail dialog (Front Desk)'],
    defaultRoleSettings: { nurse: 'required', front_desk: 'optional', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_valuables', 'Valuables'),
      check('has_cash', 'Cash / Wallet'),
      check('has_jewelry', 'Jewelry / Watch'),
      check('has_phone', 'Mobile Phone'),
      check('has_laptop', 'Laptop / Tablet'),
      check('has_documents', 'Important Documents'),
      area('valuables_list', 'List specific items and estimated value'),
      sec('sec_handling', 'Handling'),
      radio('valuables_handling', 'How are valuables handled?', ['Stored in hospital locker', 'Sent home with family', 'Kept with patient', 'No valuables'], { required: true }),
      txt('locker_number', 'Locker Number (if applicable)'),
      txt('received_by_family', 'Family member who received items (if applicable)', { width: 'full' }),
      sec('sec_clothing', 'Clothing & Personal Items'),
      area('personal_items', 'List clothing and personal items brought'),
      sec('sec_sign', 'Acknowledgement'),
      sig('patient_signature', 'Patient / Family Signature'),
      txt('nurse_name', 'Nurse Name', { required: true }),
    ]},
  },

  {
    id: 'advance_directive',
    name: 'Advance Directive / DNR',
    description: 'Advance healthcare directive and resuscitation preferences.',
    category: 'consent',
    trigger: 'admission',
    sortOrder: 5,
    module: 'ip_management',
    applicableRoles: ['patient', 'doctor', 'nurse'],
    appearsAt: 'When patient is admitted to the hospital (IP admission)',
    resultsVisibleAt: ['Doctor IP home', 'Nurse charting', 'Patient detail dialog (Front Desk)'],
    defaultRoleSettings: { patient: 'required', doctor: 'view_only', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_directive', 'Advance Directive'),
      radio('has_advance_directive', 'Do you have an advance healthcare directive?', ['Yes', 'No', 'I would like to create one'], { required: true }),
      radio('dnr_status', 'Resuscitation preference', ['Full Code (attempt all resuscitation)', 'DNR (Do Not Resuscitate)', 'Limited intervention', 'Comfort measures only'], { required: true }),
      sec('sec_proxy', 'Healthcare Proxy'),
      radio('has_healthcare_proxy', 'Do you have a designated healthcare proxy?', ['Yes', 'No']),
      txt('proxy_name', 'Proxy Name', { width: 'full' }),
      phone('proxy_phone', 'Proxy Phone'),
      sel('proxy_relationship', 'Relationship', ['Spouse', 'Parent', 'Child', 'Sibling', 'Friend', 'Attorney', 'Other']),
      sec('sec_wishes', 'Specific Wishes'),
      radio('organ_donation', 'Organ donation preference', ['Yes, I am a donor', 'No', 'Undecided']),
      area('additional_wishes', 'Any additional end-of-life wishes or instructions'),
      sec('sec_sign', 'Acknowledgement'),
      sig('patient_signature', 'Patient Signature'),
      date('directive_date', 'Date', { required: true }),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  PRE-OP (4 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'pre_op_assessment',
    name: 'Pre-Operative Assessment',
    description: 'Comprehensive pre-operative medical assessment by the surgeon.',
    category: 'clinical',
    trigger: 'pre_op',
    sortOrder: 1,
    module: 'ot_management',
    applicableRoles: ['doctor', 'nurse', 'ot_technician'],
    appearsAt: 'Before surgery — surgeon fills pre-operative assessment',
    resultsVisibleAt: ['OT module home', 'Doctor IP home'],
    defaultRoleSettings: { doctor: 'required', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_procedure', 'Procedure Details'),
      txt('procedure_name', 'Planned Procedure', { required: true, width: 'full' }),
      sel('urgency', 'Urgency', ['Elective', 'Urgent', 'Emergency'], { required: true }),
      sel('asa_class', 'ASA Classification', ['ASA I - Healthy', 'ASA II - Mild disease', 'ASA III - Severe disease', 'ASA IV - Life-threatening', 'ASA V - Moribund'], { required: true }),
      sec('sec_review', 'Pre-Op Review'),
      check('consent_obtained', 'Surgical consent obtained', { required: true }),
      check('labs_reviewed', 'Lab results reviewed'),
      check('imaging_reviewed', 'Imaging reviewed'),
      check('blood_arranged', 'Blood products arranged (if needed)'),
      check('npo_confirmed', 'NPO status confirmed', { required: true }),
      txt('npo_hours', 'Hours since last oral intake'),
      sec('sec_risk', 'Risk Factors'),
      multiSel('risk_factors', 'Risk factors', ['Diabetes', 'Hypertension', 'Cardiac disease', 'Respiratory disease', 'Obesity', 'Smoking', 'Previous anesthesia complications', 'DVT history', 'None']),
      area('surgical_plan', 'Surgical plan notes'),
      txt('estimated_duration', 'Estimated duration (minutes)', { width: 'half' }),
    ]},
  },

  {
    id: 'surgical_consent',
    name: 'Surgical Consent',
    description: 'Informed consent for surgical procedure including risks, alternatives, and authorization.',
    category: 'consent',
    trigger: 'pre_op',
    sortOrder: 2,
    module: 'ot_management',
    applicableRoles: ['patient', 'doctor', 'nurse'],
    appearsAt: 'Before surgery — patient signs surgical consent',
    resultsVisibleAt: ['OT module home', 'Doctor IP home', 'Patient detail dialog (Front Desk)'],
    defaultRoleSettings: { patient: 'required', doctor: 'required', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_verify', 'Patient Identification'),
      txt('patient_name', 'Full Name', { required: true }),
      date('dob', 'Date of Birth', { required: true }),
      sec('sec_procedure', 'Procedure Details'),
      txt('procedure_name', 'Name of Procedure', { required: true, width: 'full' }),
      txt('surgeon_name', 'Operating Surgeon', { required: true }),
      date('scheduled_date', 'Scheduled Date', { required: true }),
      sec('sec_acknowledge', 'Acknowledgements'),
      check('ack_explained', 'The procedure has been explained to me in language I understand.', { required: true }),
      check('ack_risks', 'I understand the risks including bleeding, infection, anesthesia complications, and in rare cases death.', { required: true }),
      check('ack_alternatives', 'I have been informed about alternative treatments and the option to refuse.', { required: true }),
      check('ack_questions', 'All my questions have been answered to my satisfaction.', { required: true }),
      sec('sec_anesthesia', 'Anesthesia'),
      radio('anesthesia_type', 'Anesthesia type discussed', ['General', 'Regional', 'Local', 'Sedation'], { required: true }),
      radio('blood_consent', 'Consent to blood transfusion if needed?', ['Yes', 'No'], { required: true }),
      sec('sec_signature', 'Signature'),
      sig('patient_signature', 'Patient Signature'),
      date('signed_date', 'Date', { required: true }),
      txt('witness_name', 'Witness Name'),
    ]},
  },

  {
    id: 'anesthesia_assessment',
    name: 'Anesthesia Assessment',
    description: 'Pre-anesthesia evaluation including airway assessment, previous anesthesia history.',
    category: 'clinical',
    trigger: 'pre_op',
    sortOrder: 3,
    module: 'ot_management',
    applicableRoles: ['doctor', 'nurse', 'ot_technician'],
    appearsAt: 'Before surgery — anesthesiologist fills assessment',
    resultsVisibleAt: ['OT module home', 'Doctor IP home'],
    defaultRoleSettings: { doctor: 'required', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_assessment', 'Anesthesia Assessment'),
      sel('planned_anesthesia', 'Planned Anesthesia Type', ['General', 'Spinal', 'Epidural', 'Regional block', 'Local', 'Sedation'], { required: true }),
      sel('mallampati_score', 'Mallampati Score', ['Class I', 'Class II', 'Class III', 'Class IV'], { required: true }),
      sel('mouth_opening', 'Mouth Opening', ['Normal (>3 cm)', 'Reduced (2-3 cm)', 'Limited (<2 cm)'], { required: true }),
      sel('neck_mobility', 'Neck Mobility', ['Normal', 'Reduced', 'Severely limited']),
      sec('sec_history', 'Anesthesia History'),
      radio('previous_anesthesia', 'Previous anesthesia experience', ['Yes - no complications', 'Yes - with complications', 'No previous anesthesia'], { required: true }),
      area('anesthesia_complications', 'If complications, describe'),
      radio('family_anesthesia_issues', 'Family history of anesthesia problems?', ['Yes', 'No', 'Unknown']),
      sec('sec_allergies', 'Allergies & Medications'),
      radio('latex_allergy', 'Latex allergy?', ['Yes', 'No']),
      area('current_meds', 'Current medications that may affect anesthesia'),
      radio('dentures', 'Dentures / loose teeth?', ['Yes', 'No']),
      sec('sec_plan', 'Anesthesia Plan'),
      area('anesthesia_plan', 'Anesthesia plan notes', { required: true }),
      txt('anesthesiologist', 'Anesthesiologist Name', { required: true, width: 'full' }),
    ]},
  },

  {
    id: 'pre_op_nursing_checklist',
    name: 'Pre-Op Nursing Checklist',
    description: 'Nursing verification checklist before patient enters operating theatre.',
    category: 'checklist',
    trigger: 'pre_op',
    sortOrder: 4,
    module: 'ot_management',
    applicableRoles: ['nurse', 'doctor', 'ot_technician'],
    appearsAt: 'Before surgery — nurse verifies readiness',
    resultsVisibleAt: ['OT module home', 'Nurse charting'],
    defaultRoleSettings: { nurse: 'required', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_identity', 'Identity & Documentation'),
      check('id_verified', 'Patient identity verified (wristband + verbal)', { required: true }),
      check('consent_signed', 'Surgical consent form signed and in chart', { required: true }),
      check('anesthesia_consent', 'Anesthesia consent signed'),
      check('site_marked', 'Surgical site marked (if applicable)', { required: true }),
      sec('sec_clinical', 'Clinical Readiness'),
      check('npo_verified', 'NPO status verified', { required: true }),
      check('vitals_recorded', 'Pre-op vitals recorded', { required: true }),
      check('allergies_flagged', 'Allergies flagged on chart and wristband', { required: true }),
      check('iv_access', 'IV access established'),
      check('blood_available', 'Blood products available (if ordered)'),
      check('labs_in_chart', 'Lab results in chart'),
      check('imaging_in_chart', 'Imaging results in chart'),
      sec('sec_preparation', 'Patient Preparation'),
      check('jewelry_removed', 'Jewelry and accessories removed'),
      check('prosthetics_removed', 'Dentures / hearing aids / glasses removed'),
      check('gown_on', 'Hospital gown on'),
      check('skin_prep_done', 'Skin preparation done (if applicable)'),
      check('pre_meds_given', 'Pre-medications administered (if ordered)'),
      sec('sec_handoff', 'OT Handoff'),
      txt('nurse_name', 'Preparing Nurse', { required: true }),
      time('handoff_time', 'Handoff Time', { required: true }),
      area('special_notes', 'Special notes for OT team'),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  POST-OP (2 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'post_op_assessment',
    name: 'Post-Operative Assessment',
    description: 'Surgeon post-operative assessment including findings, complications, and recovery plan.',
    category: 'clinical',
    trigger: 'post_op',
    sortOrder: 1,
    module: 'ot_management',
    applicableRoles: ['doctor', 'nurse'],
    appearsAt: 'After surgery — surgeon fills post-operative assessment',
    resultsVisibleAt: ['OT module home', 'Doctor IP home', 'Nurse charting'],
    defaultRoleSettings: { doctor: 'required', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_procedure', 'Procedure Summary'),
      txt('procedure_performed', 'Procedure Performed', { required: true, width: 'full' }),
      txt('duration_minutes', 'Actual Duration (minutes)', { required: true }),
      sel('anesthesia_used', 'Anesthesia Used', ['General', 'Spinal', 'Epidural', 'Regional', 'Local', 'Sedation'], { required: true }),
      sec('sec_findings', 'Operative Findings'),
      area('operative_findings', 'Intra-operative findings', { required: true }),
      radio('complications', 'Any intra-operative complications?', ['None', 'Minor', 'Major'], { required: true }),
      area('complications_detail', 'If complications, describe'),
      num('estimated_blood_loss', 'Estimated Blood Loss (ml)'),
      sec('sec_post_op', 'Post-Op Orders'),
      area('post_op_instructions', 'Post-operative instructions', { required: true }),
      sel('diet_order', 'Diet', ['NPO', 'Clear liquids', 'Soft diet', 'Regular diet']),
      sel('activity_level', 'Activity', ['Bed rest', 'Bed rest with bathroom privileges', 'Ambulate with assistance', 'Ambulate freely']),
      area('medications_ordered', 'Medications ordered'),
      area('follow_up_plan', 'Follow-up plan'),
    ]},
  },

  {
    id: 'recovery_room_checklist',
    name: 'Recovery Room Checklist',
    description: 'Post-anesthesia care unit (PACU) monitoring and discharge readiness checklist.',
    category: 'checklist',
    trigger: 'post_op',
    sortOrder: 2,
    module: 'ot_management',
    applicableRoles: ['nurse', 'doctor'],
    appearsAt: 'After surgery — nurse monitors recovery (PACU)',
    resultsVisibleAt: ['OT module home', 'Nurse charting', 'Doctor IP home'],
    defaultRoleSettings: { nurse: 'required', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_arrival', 'PACU Arrival'),
      time('arrival_time', 'Arrival Time', { required: true }),
      num('initial_aldrete', 'Initial Aldrete Score', { required: true, placeholder: '0-10' }),
      sec('sec_vitals', 'Recovery Vitals'),
      num('temp', 'Temperature (F)'),
      num('pulse', 'Pulse (bpm)', { required: true }),
      num('bp_systolic', 'BP Systolic', { required: true }),
      num('bp_diastolic', 'BP Diastolic', { required: true }),
      num('spo2', 'SpO2 (%)', { required: true }),
      num('rr', 'Respiratory Rate'),
      sec('sec_assessment', 'PACU Assessment'),
      { id: 'pain_score', type: 'select', label: 'Pain Score (0-10)', required: true, width: 'half' as const, options: PAIN_SCALE },
      sel('consciousness', 'Level of Consciousness', ['Fully awake', 'Arousable on calling', 'Not responding'], { required: true }),
      radio('nausea_vomiting', 'Nausea / Vomiting?', ['None', 'Mild nausea', 'Vomiting']),
      check('surgical_site_checked', 'Surgical site / dressing checked', { required: true }),
      check('drain_output_recorded', 'Drain output recorded (if applicable)'),
      sec('sec_discharge', 'Discharge Readiness'),
      num('discharge_aldrete', 'Discharge Aldrete Score', { required: true, placeholder: '0-10' }),
      check('discharge_criteria_met', 'Discharge criteria met', { required: true }),
      time('discharge_time', 'Discharge Time from PACU', { required: true }),
      txt('receiving_nurse', 'Receiving Nurse (ward)', { width: 'full' }),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  DISCHARGE (3 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'discharge_checklist',
    name: 'Discharge Summary Checklist',
    description: 'Checklist ensuring all discharge documentation is complete before patient leaves.',
    category: 'checklist',
    trigger: 'discharge',
    sortOrder: 1,
    module: 'ip_management',
    applicableRoles: ['doctor', 'nurse'],
    appearsAt: 'When patient is being discharged from the hospital',
    resultsVisibleAt: ['Doctor IP home', 'Nurse charting', 'Patient detail dialog (Front Desk)'],
    defaultRoleSettings: { doctor: 'required', nurse: 'required', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_documentation', 'Documentation'),
      check('summary_complete', 'Discharge summary completed', { required: true }),
      check('prescriptions_written', 'Discharge prescriptions written', { required: true }),
      check('instructions_given', 'Discharge instructions given to patient', { required: true }),
      check('follow_up_scheduled', 'Follow-up appointment scheduled'),
      check('referrals_made', 'Referrals made (if applicable)'),
      sec('sec_clinical', 'Clinical'),
      check('final_vitals', 'Final vital signs recorded', { required: true }),
      check('wound_care_explained', 'Wound care instructions explained (if applicable)'),
      check('medications_reconciled', 'Medication reconciliation done', { required: true }),
      check('diet_instructions', 'Diet instructions provided'),
      sec('sec_admin', 'Administrative'),
      check('billing_cleared', 'Billing / payment cleared'),
      check('property_returned', 'Patient property returned', { required: true }),
      check('transport_arranged', 'Transport arranged'),
      check('insurance_forms_complete', 'Insurance forms completed (if applicable)'),
      sec('sec_sign', 'Sign-off'),
      txt('discharging_doctor', 'Discharging Doctor', { required: true }),
      txt('discharging_nurse', 'Discharging Nurse', { required: true }),
      time('discharge_time', 'Discharge Time', { required: true }),
    ]},
  },

  {
    id: 'discharge_instructions',
    name: 'Discharge Instructions',
    description: 'Patient instructions for post-discharge care, medications, and warning signs.',
    category: 'clinical',
    trigger: 'discharge',
    sortOrder: 2,
    module: 'ip_management',
    applicableRoles: ['doctor', 'patient', 'nurse'],
    appearsAt: 'When patient is being discharged from the hospital',
    resultsVisibleAt: ['Patient portal (My Appointments)', 'Doctor IP home'],
    defaultRoleSettings: { doctor: 'required', patient: 'view_only', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_meds', 'Medications'),
      area('medications', 'Discharge medications (name, dose, frequency, duration)', { required: true }),
      area('medication_instructions', 'Special medication instructions'),
      sec('sec_activity', 'Activity & Diet'),
      area('activity_restrictions', 'Activity restrictions'),
      area('diet_instructions', 'Dietary recommendations'),
      sec('sec_care', 'Wound / Self Care'),
      area('wound_care', 'Wound care instructions (if applicable)'),
      area('self_care_instructions', 'Other self-care instructions'),
      sec('sec_warning', 'Warning Signs'),
      area('warning_signs', 'Seek immediate medical attention if you experience:', { required: true }),
      sec('sec_followup', 'Follow-Up'),
      txt('follow_up_doctor', 'Follow-up Doctor'),
      date('follow_up_date', 'Follow-up Date'),
      area('follow_up_instructions', 'Follow-up instructions'),
      txt('emergency_contact_number', 'Hospital Emergency Number', { width: 'full' }),
    ]},
  },

  {
    id: 'follow_up_care_plan',
    name: 'Follow-Up Care Plan',
    description: 'Structured follow-up plan including appointments, tests, and rehabilitation milestones.',
    category: 'clinical',
    trigger: 'discharge',
    sortOrder: 3,
    module: 'ip_management',
    applicableRoles: ['doctor', 'patient', 'nurse'],
    appearsAt: 'When patient is being discharged from the hospital',
    resultsVisibleAt: ['Patient portal (My Appointments)', 'Doctor IP home'],
    defaultRoleSettings: { doctor: 'required', patient: 'view_only', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_appointments', 'Follow-Up Appointments'),
      date('first_follow_up', 'First Follow-Up Date', { required: true }),
      txt('first_follow_up_doctor', 'Doctor', { required: true }),
      area('follow_up_schedule', 'Complete follow-up schedule'),
      sec('sec_tests', 'Pending Tests / Investigations'),
      area('pending_tests', 'Tests to be done before next visit'),
      area('test_instructions', 'Instructions for tests (fasting, prep, etc.)'),
      sec('sec_rehab', 'Rehabilitation'),
      radio('needs_rehab', 'Rehabilitation needed?', ['Yes - Physiotherapy', 'Yes - Occupational therapy', 'Yes - Speech therapy', 'No'], { required: true }),
      area('rehab_plan', 'Rehabilitation plan details'),
      sec('sec_goals', 'Recovery Goals'),
      area('short_term_goals', 'Short-term goals (1-2 weeks)'),
      area('long_term_goals', 'Long-term goals (1-3 months)'),
      area('doctor_notes', 'Doctor notes for follow-up team'),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  FEEDBACK (2 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'patient_satisfaction',
    name: 'Patient Satisfaction Survey',
    description: 'Post-visit satisfaction survey covering service quality, staff, and facilities.',
    category: 'feedback',
    trigger: 'feedback',
    sortOrder: 1,
    module: 'appointments',
    applicableRoles: ['patient'],
    appearsAt: 'After visit is completed — patient fills feedback',
    resultsVisibleAt: ['Hospital admin dashboard', 'Submissions tab'],
    defaultRoleSettings: { patient: 'required', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_overall', 'Overall Experience'),
      { id: 'overall_rating', type: 'radio', label: 'How would you rate your overall experience?', required: true, width: 'full' as const, options: RATING_5 },
      radio('would_recommend', 'Would you recommend us to friends or family?', ['Definitely', 'Probably', 'Maybe', 'Probably not', 'Definitely not'], { required: true }),
      sec('sec_specific', 'Specific Ratings'),
      sel('doctor_rating', 'Doctor / Consultation Quality', ['Excellent', 'Good', 'Average', 'Poor'], { required: true }),
      sel('staff_rating', 'Nursing & Front Desk Staff', ['Excellent', 'Good', 'Average', 'Poor']),
      sel('facility_rating', 'Cleanliness & Facility', ['Excellent', 'Good', 'Average', 'Poor']),
      sel('wait_time_rating', 'Waiting Time', ['Excellent', 'Good', 'Average', 'Poor']),
      sec('sec_feedback', 'Tell Us More'),
      area('positives', 'What did we do well?'),
      area('improvements', 'What could we improve?'),
      check('allow_followup', 'You may contact me to follow up on this feedback.'),
      phone('followup_phone', 'Best phone number to reach you'),
    ]},
  },

  {
    id: 'nps_survey',
    name: 'Net Promoter Score',
    description: 'Quick 2-question NPS survey for tracking hospital recommendation likelihood.',
    category: 'feedback',
    trigger: 'feedback',
    sortOrder: 2,
    module: 'appointments',
    applicableRoles: ['patient'],
    appearsAt: 'After visit is completed — patient fills NPS survey',
    resultsVisibleAt: ['Hospital admin dashboard', 'Submissions tab'],
    defaultRoleSettings: { patient: 'optional', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_nps', 'Net Promoter Score'),
      { id: 'nps_score', type: 'select', label: 'On a scale of 0-10, how likely are you to recommend us?', required: true, width: 'full' as const, options: Array.from({ length: 11 }, (_, i) => ({ value: String(i), label: `${i}${i <= 6 ? '' : i <= 8 ? ' (Passive)' : ' (Promoter)'}` })) },
      area('nps_reason', 'What is the primary reason for your score?', { required: true }),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  LAB (3 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'lab_order_form',
    name: 'Lab Order Request',
    description: 'Lab test order form with clinical indication, priority, and special instructions.',
    category: 'clinical',
    trigger: 'lab_order_created',
    sortOrder: 1,
    module: 'lab',
    applicableRoles: ['doctor', 'lab_technician', 'nurse'],
    appearsAt: 'When doctor creates a lab order',
    resultsVisibleAt: ['Laboratory module home', 'Doctor consultation view (Forms tab)'],
    defaultRoleSettings: { doctor: 'required', lab_technician: 'view_only', nurse: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_order', 'Lab Order'),
      area('tests_ordered', 'Tests Ordered', { required: true, placeholder: 'List all tests requested' }),
      area('clinical_indication', 'Clinical Indication / Reason', { required: true }),
      sel('priority', 'Priority', ['Routine', 'Urgent', 'STAT'], { required: true }),
      sec('sec_specimen', 'Specimen Details'),
      sel('specimen_type', 'Specimen Type', ['Blood', 'Urine', 'Stool', 'Swab', 'Sputum', 'CSF', 'Body fluid', 'Tissue', 'Other']),
      radio('fasting_required', 'Fasting required?', ['Yes', 'No']),
      area('special_instructions', 'Special collection instructions'),
      txt('ordering_doctor', 'Ordering Doctor', { required: true, width: 'full' }),
    ]},
  },

  {
    id: 'specimen_collection',
    name: 'Specimen Collection',
    description: 'Specimen collection verification including labeling, timing, and chain of custody.',
    category: 'checklist',
    trigger: 'lab_sample_collected',
    sortOrder: 1,
    module: 'lab',
    applicableRoles: ['lab_technician', 'doctor'],
    appearsAt: 'When lab technician collects a specimen',
    resultsVisibleAt: ['Laboratory module home', 'Doctor consultation view (Forms tab)'],
    defaultRoleSettings: { lab_technician: 'required', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_collection', 'Collection Details'),
      check('patient_id_verified', 'Patient identity verified (wristband + verbal)', { required: true }),
      check('label_verified', 'Specimen label matches order and patient', { required: true }),
      sel('specimen_type', 'Specimen Type', ['Blood - Venipuncture', 'Blood - Finger prick', 'Urine - Midstream', 'Urine - Catheter', 'Stool', 'Swab', 'Sputum', 'Other'], { required: true }),
      time('collection_time', 'Collection Time', { required: true }),
      txt('collected_by', 'Collected By', { required: true }),
      sec('sec_quality', 'Quality Checks'),
      check('correct_tube', 'Correct collection tube / container used', { required: true }),
      check('adequate_volume', 'Adequate specimen volume'),
      radio('hemolyzed', 'Specimen appears hemolyzed?', ['No', 'Slightly', 'Yes']),
      radio('lipemic', 'Specimen appears lipemic?', ['No', 'Yes']),
      area('collection_notes', 'Collection notes / issues'),
    ]},
  },

  {
    id: 'lab_quality_check',
    name: 'Lab Quality Check',
    description: 'Quality control verification before finalizing lab reports.',
    category: 'checklist',
    trigger: 'lab_qc_check',
    sortOrder: 1,
    module: 'lab',
    applicableRoles: ['lab_technician', 'lab_supervisor', 'doctor'],
    appearsAt: 'Before lab report is finalized — QC verification',
    resultsVisibleAt: ['Laboratory module home', 'Submissions tab'],
    defaultRoleSettings: { lab_technician: 'required', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_qc', 'Quality Control'),
      check('controls_run', 'Internal QC controls run and within range', { required: true }),
      check('calibration_valid', 'Instrument calibration valid'),
      check('results_reviewed', 'Results reviewed for critical values', { required: true }),
      check('delta_check', 'Delta check performed (compared with previous results)'),
      sec('sec_critical', 'Critical Values'),
      radio('critical_values_found', 'Any critical values detected?', ['No', 'Yes'], { required: true }),
      area('critical_values_list', 'If yes, list critical values and actions taken'),
      radio('doctor_notified', 'Ordering doctor notified of critical values?', ['Yes', 'No', 'N/A']),
      sec('sec_verification', 'Report Verification'),
      check('results_verified', 'All results verified and ready for release', { required: true }),
      txt('verified_by', 'Verified By', { required: true }),
      area('qc_notes', 'Additional QC notes'),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  NURSING (2 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'nursing_assessment',
    name: 'Nursing Assessment',
    description: 'Comprehensive nursing assessment for inpatient care planning.',
    category: 'clinical',
    trigger: 'nursing_note_added',
    sortOrder: 1,
    module: 'ip_management',
    applicableRoles: ['nurse', 'doctor'],
    appearsAt: 'When nurse adds a nursing note for an inpatient',
    resultsVisibleAt: ['Nurse charting', 'Doctor IP home'],
    defaultRoleSettings: { nurse: 'required', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_general', 'General Assessment'),
      sel('consciousness', 'Level of Consciousness', ['Alert', 'Drowsy', 'Confused', 'Unresponsive'], { required: true }),
      sel('orientation', 'Orientation', ['Oriented x3 (person, place, time)', 'Oriented x2', 'Oriented x1', 'Disoriented'], { required: true }),
      sel('mobility', 'Mobility Status', ['Independent', 'Needs assistance', 'Wheelchair', 'Bed-bound'], { required: true }),
      sec('sec_skin', 'Skin Assessment'),
      sel('skin_integrity', 'Skin Integrity', ['Intact', 'Redness', 'Bruising', 'Wound present', 'Pressure ulcer'], { required: true }),
      area('skin_notes', 'Skin assessment notes'),
      sec('sec_pain', 'Pain'),
      { id: 'pain_score', type: 'select', label: 'Current Pain Score (0-10)', required: true, width: 'half' as const, options: PAIN_SCALE },
      txt('pain_location', 'Pain Location'),
      sec('sec_functional', 'Functional Status'),
      sel('feeding', 'Feeding', ['Independent', 'Needs assistance', 'Tube feeding', 'NPO']),
      sel('continence', 'Continence', ['Continent', 'Incontinent - bladder', 'Incontinent - bowel', 'Catheterized']),
      sel('sleep', 'Sleep Pattern', ['Normal', 'Disturbed', 'Insomnia', 'Excessive']),
      area('nursing_plan', 'Nursing care plan notes', { required: true }),
    ]},
  },

  {
    id: 'wound_care_assessment',
    name: 'Wound Care Assessment',
    description: 'Wound assessment and dressing change documentation.',
    category: 'clinical',
    trigger: 'nursing_note_added',
    sortOrder: 2,
    module: 'ip_management',
    applicableRoles: ['nurse', 'doctor'],
    appearsAt: 'When nurse adds a nursing note for wound care',
    resultsVisibleAt: ['Nurse charting', 'Doctor IP home'],
    defaultRoleSettings: { nurse: 'required', doctor: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_wound', 'Wound Details'),
      txt('wound_location', 'Wound Location', { required: true, width: 'full' }),
      sel('wound_type', 'Wound Type', ['Surgical incision', 'Pressure ulcer', 'Traumatic', 'Burns', 'Diabetic ulcer', 'Venous ulcer', 'Other'], { required: true }),
      txt('wound_size', 'Size (L x W x D cm)', { required: true }),
      sec('sec_appearance', 'Wound Appearance'),
      sel('wound_bed', 'Wound Bed', ['Granulation (red)', 'Slough (yellow)', 'Necrotic (black)', 'Epithelializing (pink)', 'Mixed'], { required: true }),
      sel('exudate', 'Exudate', ['None', 'Minimal', 'Moderate', 'Heavy'], { required: true }),
      sel('exudate_type', 'Exudate Type', ['Serous (clear)', 'Sanguineous (bloody)', 'Purulent (pus)', 'Serosanguineous']),
      radio('odor', 'Odor?', ['None', 'Mild', 'Strong']),
      sel('surrounding_skin', 'Surrounding Skin', ['Normal', 'Red', 'Swollen', 'Macerated', 'Warm to touch']),
      sec('sec_treatment', 'Treatment'),
      area('dressing_applied', 'Dressing applied', { required: true }),
      area('treatment_notes', 'Treatment notes'),
      date('next_dressing_change', 'Next dressing change due'),
      txt('nurse_name', 'Nurse Name', { required: true }),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  SHIFT & OPERATIONS (4 forms)
  // ────────────────────────────────────────────────────────────

  {
    id: 'shift_handover_report',
    name: 'Shift Handover Report',
    description: 'Nurse shift handover with patient status, pending tasks, and critical information.',
    category: 'checklist',
    trigger: 'shift_handover',
    sortOrder: 1,
    module: 'ip_management',
    applicableRoles: ['nurse'],
    appearsAt: 'At nurse shift change — outgoing nurse fills handover',
    resultsVisibleAt: ['Nurse handover page', 'Submissions tab'],
    defaultRoleSettings: { nurse: 'required', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_shift', 'Shift Details'),
      sel('shift_type', 'Shift', ['Morning (6AM-2PM)', 'Afternoon (2PM-10PM)', 'Night (10PM-6AM)'], { required: true }),
      txt('outgoing_nurse', 'Outgoing Nurse', { required: true }),
      txt('incoming_nurse', 'Incoming Nurse', { required: true }),
      sec('sec_patients', 'Patient Summary'),
      num('total_patients', 'Total Patients in Ward', { required: true }),
      num('critical_patients', 'Critical / High Acuity Patients'),
      num('new_admissions', 'New Admissions This Shift'),
      num('discharges', 'Discharges This Shift'),
      sec('sec_critical', 'Critical Information'),
      area('critical_updates', 'Critical patient updates (status changes, deterioration, etc.)', { required: true }),
      area('pending_tasks', 'Pending tasks for next shift', { required: true }),
      area('pending_meds', 'Pending medications / treatments'),
      area('pending_labs', 'Pending lab results or investigations'),
      sec('sec_issues', 'Issues & Notes'),
      area('incidents', 'Any incidents or near-misses this shift'),
      area('equipment_issues', 'Equipment issues'),
      area('general_notes', 'General notes for incoming shift'),
    ]},
  },

  {
    id: 'medication_admin_record',
    name: 'Medication Administration Record',
    description: 'Record of medication administered including dose, route, time, and patient response.',
    category: 'clinical',
    trigger: 'medication_administered',
    sortOrder: 1,
    module: 'ip_management',
    applicableRoles: ['nurse', 'doctor', 'pharmacist'],
    appearsAt: 'When nurse administers medication to a patient',
    resultsVisibleAt: ['Nurse charting', 'Doctor IP home', 'Pharmacy module'],
    defaultRoleSettings: { nurse: 'required', doctor: 'view_only', pharmacist: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_medication', 'Medication Details'),
      txt('drug_name', 'Drug Name', { required: true, width: 'full' }),
      txt('dose', 'Dose', { required: true }),
      sel('route', 'Route', ['Oral', 'IV', 'IM', 'SC', 'Topical', 'Inhaled', 'Rectal', 'Sublingual', 'Other'], { required: true }),
      time('admin_time', 'Administration Time', { required: true }),
      sec('sec_verification', 'Verification (5 Rights)'),
      check('right_patient', 'Right Patient verified', { required: true }),
      check('right_drug', 'Right Drug verified', { required: true }),
      check('right_dose', 'Right Dose verified', { required: true }),
      check('right_route', 'Right Route verified', { required: true }),
      check('right_time', 'Right Time verified', { required: true }),
      sec('sec_response', 'Patient Response'),
      radio('adverse_reaction', 'Any adverse reaction?', ['None', 'Mild', 'Moderate', 'Severe']),
      area('reaction_details', 'If adverse reaction, describe'),
      area('admin_notes', 'Administration notes'),
      txt('administered_by', 'Administered By', { required: true, width: 'full' }),
    ]},
  },

  {
    id: 'incident_report',
    name: 'Incident Report',
    description: 'Report for any adverse events, near-misses, or safety incidents.',
    category: 'checklist',
    trigger: 'incident_reported',
    sortOrder: 1,
    module: 'compliance',
    applicableRoles: ['nurse', 'doctor'],
    appearsAt: 'When any staff reports an incident or adverse event',
    resultsVisibleAt: ['Submissions tab', 'Hospital admin dashboard'],
    defaultRoleSettings: { nurse: 'optional', doctor: 'optional', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_incident', 'Incident Details'),
      date('incident_date', 'Date of Incident', { required: true }),
      time('incident_time', 'Time of Incident', { required: true }),
      txt('incident_location', 'Location', { required: true, width: 'full' }),
      sel('incident_type', 'Type of Incident', ['Patient fall', 'Medication error', 'Equipment failure', 'Needle stick', 'Patient injury', 'Staff injury', 'Near miss', 'Security', 'Other'], { required: true }),
      sel('severity', 'Severity', ['No harm', 'Minor injury', 'Moderate injury', 'Severe injury', 'Death'], { required: true }),
      sec('sec_description', 'Description'),
      area('description', 'Detailed description of what happened', { required: true }),
      area('immediate_action', 'Immediate action taken', { required: true }),
      area('witnesses', 'Witnesses (names and roles)'),
      sec('sec_followup', 'Follow-Up'),
      radio('patient_notified', 'Patient / Family notified?', ['Yes', 'No', 'N/A']),
      radio('doctor_notified', 'Attending doctor notified?', ['Yes', 'No']),
      area('corrective_action', 'Corrective / preventive action recommended'),
      txt('reported_by', 'Reported By', { required: true, width: 'full' }),
    ]},
  },

  {
    id: 'daily_safety_checklist',
    name: 'Daily Safety Checklist',
    description: 'Daily ward safety and compliance checklist.',
    category: 'checklist',
    trigger: 'daily_safety_check',
    sortOrder: 1,
    module: 'compliance',
    applicableRoles: ['nurse'],
    appearsAt: 'Daily ward safety check — nurse fills at shift start',
    resultsVisibleAt: ['Submissions tab', 'Hospital admin dashboard'],
    defaultRoleSettings: { nurse: 'required', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_environment', 'Environment'),
      check('floors_clean', 'Floors clean and dry'),
      check('exits_clear', 'Emergency exits unobstructed'),
      check('lighting_ok', 'Adequate lighting in all areas'),
      check('waste_segregated', 'Bio-medical waste properly segregated'),
      check('sharps_containers', 'Sharps containers not overfull'),
      sec('sec_equipment', 'Equipment'),
      check('crash_cart_checked', 'Crash cart checked and sealed', { required: true }),
      check('suction_working', 'Suction equipment working'),
      check('oxygen_supply', 'Oxygen supply adequate'),
      check('monitors_functioning', 'Patient monitors functioning'),
      sec('sec_infection', 'Infection Control'),
      check('hand_hygiene_supplies', 'Hand hygiene supplies stocked', { required: true }),
      check('ppe_available', 'PPE available and accessible'),
      check('isolation_signs', 'Isolation signs posted (if applicable)'),
      sec('sec_medication', 'Medication Safety'),
      check('medication_fridge_temp', 'Medication fridge temperature logged', { required: true }),
      check('narcotics_count', 'Narcotics count matches record'),
      check('expired_meds_checked', 'No expired medications on ward'),
      sec('sec_sign', 'Sign-Off'),
      txt('completed_by', 'Completed By', { required: true }),
      time('completion_time', 'Time', { required: true }),
      area('issues_found', 'Issues found and actions taken'),
    ]},
  },

  // ────────────────────────────────────────────────────────────
  //  BLOOD BANK (1 form)
  // ────────────────────────────────────────────────────────────

  {
    id: 'blood_donation_form',
    name: 'Blood Donation Form',
    description: 'Donor screening questionnaire and consent for blood donation.',
    category: 'clinical',
    trigger: 'blood_donation_collected',
    sortOrder: 1,
    module: 'blood_bank',
    applicableRoles: ['nurse', 'doctor', 'lab_technician', 'blood_bank_staff'],
    appearsAt: 'When a blood donation is collected from a donor',
    resultsVisibleAt: ['Blood bank module', 'Laboratory module home'],
    defaultRoleSettings: { nurse: 'required', doctor: 'view_only', lab_technician: 'view_only', admin: 'view_only' },
    schema: { version: 1, fields: [
      sec('sec_donor', 'Donor Information'),
      txt('donor_name', 'Full Name', { required: true, width: 'full' }),
      date('dob', 'Date of Birth', { required: true }),
      sel('gender', 'Gender', ['Male', 'Female', 'Other'], { required: true }),
      num('weight_kg', 'Weight (kg)', { required: true }),
      num('hemoglobin', 'Hemoglobin (g/dL)', { required: true }),
      sel('blood_group', 'Blood Group', ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'], { required: true }),
      sec('sec_screening', 'Screening Questions'),
      radio('feeling_well', 'Are you feeling well today?', ['Yes', 'No'], { required: true }),
      radio('medications', 'Are you on any medications?', ['Yes', 'No']),
      radio('recent_surgery', 'Any surgery in last 6 months?', ['Yes', 'No']),
      radio('recent_tattoo', 'Any tattoo/piercing in last 12 months?', ['Yes', 'No']),
      radio('pregnant_nursing', 'Are you pregnant or nursing?', ['Yes', 'No', 'N/A']),
      radio('previous_donation', 'Previous blood donation?', ['Yes', 'No']),
      date('last_donation_date', 'If yes, date of last donation'),
      sec('sec_vitals', 'Pre-Donation Vitals'),
      num('bp_systolic', 'BP Systolic'),
      num('bp_diastolic', 'BP Diastolic'),
      num('pulse', 'Pulse'),
      num('temperature', 'Temperature (F)'),
      sec('sec_consent', 'Consent'),
      check('consent_given', 'Donor consents to blood collection and testing', { required: true }),
      txt('screened_by', 'Screened By', { required: true }),
    ]},
  },
];

// ════════════════════════════════════════════════════════════════
//  Seed Runner
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log('Seeding 40 System Forms...\n');

  let created = 0;
  let updated = 0;

  for (const form of SYSTEM_FORMS) {
    await prisma.systemForm.upsert({
      where: { id: form.id },
      create: {
        id: form.id,
        name: form.name,
        description: form.description,
        category: form.category,
        trigger: form.trigger,
        schema: form.schema as object,
        sortOrder: form.sortOrder,
        module: form.module,
        isActive: true,
        applicableRoles: form.applicableRoles,
        appearsAt: form.appearsAt,
        resultsVisibleAt: form.resultsVisibleAt,
        defaultRoleSettings: form.defaultRoleSettings as object,
      },
      update: {
        name: form.name,
        description: form.description,
        category: form.category,
        // trigger is FIXED — never update it
        schema: form.schema as object,
        sortOrder: form.sortOrder,
        module: form.module,
        applicableRoles: form.applicableRoles,
        appearsAt: form.appearsAt,
        resultsVisibleAt: form.resultsVisibleAt,
        defaultRoleSettings: form.defaultRoleSettings as object,
      },
    });

    const existing = await prisma.systemForm.findUnique({ where: { id: form.id } });
    if (existing) {
      updated++;
      console.log(`  Updated: ${form.id} (${form.trigger})`);
    } else {
      created++;
      console.log(`  Created: ${form.id} (${form.trigger})`);
    }
  }

  console.log(`\nDone. ${SYSTEM_FORMS.length} system forms seeded (${created} new, ${updated} updated).`);
}

main()
  .catch((e) => {
    console.error('\nSeed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
