import 'dotenv/config';
import { PrismaClient, FormCategory, Prisma } from '@prisma/client';
import { formSchemaShape, type FormField } from '../modules/forms/forms.validation';

let prisma!: PrismaClient;

// ─────────────────────────────────────────────────────────────
// Seed a starter pack of patient-form templates owned by the
// platform super_admin. These are the templates a hospital admin
// can clone from the super-admin → Form Templates panel.
//
// Idempotent: matched by `name`; existing templates get their
// schema/description/category re-applied so re-running picks up
// edits made here.
// ─────────────────────────────────────────────────────────────

let fieldCounter = 0;
function fid(): string {
  fieldCounter += 1;
  return `f_${fieldCounter}`;
}

// Builders that fill in the parts the validator expects (id, width,
// required default, etc.) so each template literal stays readable.
const section = (label: string, key: string): FormField => ({
  id: fid(),
  type: 'section',
  key,
  label,
  required: false,
  width: 'full',
});

const divider = (key: string): FormField => ({
  id: fid(),
  type: 'divider',
  key,
  label: '—',
  required: false,
  width: 'full',
});

type TextOpts = {
  required?: boolean;
  width?: 'full' | 'half' | 'third';
  placeholder?: string;
  helpText?: string;
  maxLength?: number;
};
const text = (key: string, label: string, opts: TextOpts = {}): FormField => ({
  id: fid(),
  type: 'text',
  key,
  label,
  required: opts.required ?? false,
  width: opts.width ?? 'full',
  placeholder: opts.placeholder ?? null,
  helpText: opts.helpText ?? null,
  maxLength: opts.maxLength ?? null,
  defaultValue: null,
});

type TextareaOpts = TextOpts & { rows?: number };
const textarea = (key: string, label: string, opts: TextareaOpts = {}): FormField => ({
  id: fid(),
  type: 'textarea',
  key,
  label,
  required: opts.required ?? false,
  width: opts.width ?? 'full',
  placeholder: opts.placeholder ?? null,
  helpText: opts.helpText ?? null,
  rows: opts.rows ?? 3,
  maxLength: opts.maxLength ?? null,
  defaultValue: null,
});

type NumberOpts = {
  required?: boolean;
  width?: 'full' | 'half' | 'third';
  helpText?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
};
const num = (key: string, label: string, opts: NumberOpts = {}): FormField => ({
  id: fid(),
  type: 'number',
  key,
  label,
  required: opts.required ?? false,
  width: opts.width ?? 'half',
  helpText: opts.helpText ?? null,
  min: opts.min ?? null,
  max: opts.max ?? null,
  step: opts.step ?? null,
  unit: opts.unit ?? null,
  defaultValue: null,
  placeholder: null,
});

const date = (key: string, label: string, required = false, width: 'full' | 'half' | 'third' = 'half'): FormField => ({
  id: fid(),
  type: 'date',
  key,
  label,
  required,
  width,
  helpText: null,
  defaultValue: null,
});

const datetime = (key: string, label: string, required = false, width: 'full' | 'half' | 'third' = 'half'): FormField => ({
  id: fid(),
  type: 'datetime',
  key,
  label,
  required,
  width,
  helpText: null,
  defaultValue: null,
});

const opt = (value: string, label?: string) => ({ value, label: label ?? value });

type SelectOpts = {
  required?: boolean;
  width?: 'full' | 'half' | 'third';
  helpText?: string;
  placeholder?: string;
};
const select = (
  key: string,
  label: string,
  options: { value: string; label: string }[],
  opts: SelectOpts = {},
): FormField => ({
  id: fid(),
  type: 'select',
  key,
  label,
  required: opts.required ?? false,
  width: opts.width ?? 'half',
  helpText: opts.helpText ?? null,
  placeholder: opts.placeholder ?? null,
  options,
  defaultValue: null,
});

const radio = (
  key: string,
  label: string,
  options: { value: string; label: string }[],
  opts: SelectOpts = {},
): FormField => ({
  id: fid(),
  type: 'radio',
  key,
  label,
  required: opts.required ?? false,
  width: opts.width ?? 'full',
  helpText: opts.helpText ?? null,
  options,
  defaultValue: null,
});

const multi = (
  key: string,
  label: string,
  options: { value: string; label: string }[],
  opts: SelectOpts = {},
): FormField => ({
  id: fid(),
  type: 'multiselect',
  key,
  label,
  required: opts.required ?? false,
  width: opts.width ?? 'full',
  helpText: opts.helpText ?? null,
  placeholder: opts.placeholder ?? null,
  options,
  defaultValue: null,
});

const check = (
  key: string,
  label: string,
  width: 'full' | 'half' | 'third' = 'full',
): FormField => ({
  id: fid(),
  type: 'checkbox',
  key,
  label,
  required: false,
  width,
  helpText: null,
  defaultValue: null,
});

// ─────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────

type TemplateSeed = {
  name: string;
  description: string;
  category: FormCategory;
  fields: () => FormField[];
};

const TEMPLATES: TemplateSeed[] = [
  {
    name: 'Patient Admission Intake',
    description:
      'Captures the core demographics, presenting complaint, allergies, and prior history collected at the time of inpatient admission.',
    category: 'intake',
    fields: () => [
      section('Presenting Complaint', 's_complaint'),
      textarea('chief_complaint', 'Chief complaint', {
        required: true,
        rows: 3,
        placeholder: 'In the patient\'s own words',
      }),
      textarea('history_of_presenting_illness', 'History of presenting illness', { rows: 4 }),
      datetime('symptom_onset', 'Symptom onset', false, 'half'),
      select(
        'mode_of_arrival',
        'Mode of arrival',
        [opt('walk_in', 'Walk-in'), opt('ambulance', 'Ambulance'), opt('referral', 'Referral'), opt('transfer', 'Inter-hospital transfer')],
        { width: 'half' },
      ),

      section('Allergies', 's_allergies'),
      radio(
        'has_allergies',
        'Known allergies?',
        [opt('none', 'None known'), opt('drug', 'Drug allergy'), opt('food', 'Food allergy'), opt('other', 'Other')],
        { required: true },
      ),
      textarea('allergy_details', 'Allergy details (drug / food / reaction)', { rows: 2 }),

      section('Past History', 's_history'),
      multi(
        'comorbidities',
        'Known comorbidities',
        [
          opt('htn', 'Hypertension'),
          opt('dm', 'Diabetes Mellitus'),
          opt('cad', 'Coronary artery disease'),
          opt('ckd', 'Chronic kidney disease'),
          opt('copd', 'COPD / Asthma'),
          opt('cva', 'Stroke / TIA'),
          opt('ca', 'Cancer'),
          opt('thyroid', 'Thyroid disorder'),
          opt('liver', 'Chronic liver disease'),
          opt('none', 'None'),
        ],
      ),
      textarea('past_surgeries', 'Past surgeries / hospitalisations', { rows: 2 }),
      textarea('current_medications', 'Current medications', {
        rows: 3,
        helpText: 'List drug, dose, frequency. Include OTC and herbal supplements.',
      }),

      section('Social & Family', 's_social'),
      select(
        'smoking_status',
        'Smoking',
        [opt('never', 'Never'), opt('former', 'Former'), opt('current', 'Current')],
        { width: 'third' },
      ),
      select(
        'alcohol_use',
        'Alcohol',
        [opt('never', 'Never'), opt('occasional', 'Occasional'), opt('regular', 'Regular')],
        { width: 'third' },
      ),
      text('occupation', 'Occupation', { width: 'third' }),
      textarea('family_history', 'Relevant family history', { rows: 2 }),

      section('Admission Details', 's_admission'),
      text('admitting_diagnosis', 'Admitting diagnosis (provisional)', { required: true }),
      text('referring_doctor', 'Referring doctor', { width: 'half' }),
      text('emergency_contact_name', 'Emergency contact — name', { width: 'half' }),
      text('emergency_contact_phone', 'Emergency contact — phone', { width: 'half' }),
      select(
        'emergency_contact_relation',
        'Relationship',
        [opt('spouse', 'Spouse'), opt('parent', 'Parent'), opt('child', 'Child'), opt('sibling', 'Sibling'), opt('friend', 'Friend'), opt('other', 'Other')],
        { width: 'half' },
      ),
    ],
  },

  {
    name: 'Initial Nursing Assessment (Head-to-Toe)',
    description:
      'Structured head-to-toe assessment performed within the first shift after admission — covers neuro, cardio-respiratory, GI, skin and pain.',
    category: 'assessment',
    fields: () => [
      datetime('assessment_time', 'Assessment time', true, 'half'),
      select(
        'general_appearance',
        'General appearance',
        [opt('well', 'Well'), opt('mild_distress', 'Mild distress'), opt('moderate_distress', 'Moderate distress'), opt('severe_distress', 'Severe distress')],
        { width: 'half', required: true },
      ),

      section('Neurological', 's_neuro'),
      select(
        'level_of_consciousness',
        'Level of consciousness',
        [opt('alert', 'Alert'), opt('verbal', 'Responds to voice'), opt('pain', 'Responds to pain'), opt('unresponsive', 'Unresponsive')],
        { width: 'half', required: true },
      ),
      num('gcs_total', 'GCS total', { min: 3, max: 15, step: 1, width: 'half' }),
      select('orientation', 'Orientation', [opt('full', 'Oriented x3'), opt('partial', 'Partial'), opt('disoriented', 'Disoriented')], { width: 'half' }),
      select('pupils', 'Pupils', [opt('perrla', 'PERRLA'), opt('sluggish', 'Sluggish'), opt('fixed', 'Fixed / non-reactive'), opt('asymmetric', 'Asymmetric')], { width: 'half' }),

      section('Cardiovascular', 's_cv'),
      num('heart_rate', 'Heart rate', { min: 20, max: 250, unit: 'bpm', width: 'third' }),
      num('bp_systolic', 'BP systolic', { min: 40, max: 300, unit: 'mmHg', width: 'third' }),
      num('bp_diastolic', 'BP diastolic', { min: 20, max: 200, unit: 'mmHg', width: 'third' }),
      select('rhythm', 'Rhythm', [opt('regular', 'Regular'), opt('irregular', 'Irregular')], { width: 'half' }),
      select('peripheral_pulses', 'Peripheral pulses', [opt('strong', 'Strong'), opt('weak', 'Weak'), opt('absent', 'Absent')], { width: 'half' }),
      check('edema_present', 'Pedal / dependent edema present'),

      section('Respiratory', 's_resp'),
      num('respiratory_rate', 'Respiratory rate', { min: 5, max: 60, unit: '/min', width: 'third' }),
      num('spo2', 'SpO₂', { min: 0, max: 100, unit: '%', width: 'third' }),
      select(
        'oxygen_support',
        'Oxygen support',
        [opt('room_air', 'Room air'), opt('nasal_cannula', 'Nasal cannula'), opt('mask', 'Face mask'), opt('nrbm', 'NRBM'), opt('hfnc', 'HFNC'), opt('niv', 'NIV / BiPAP'), opt('vent', 'Mechanical ventilation')],
        { width: 'third' },
      ),
      multi('breath_sounds', 'Breath sounds', [
        opt('clear', 'Clear bilaterally'),
        opt('crackles', 'Crackles'),
        opt('wheeze', 'Wheeze'),
        opt('rhonchi', 'Rhonchi'),
        opt('diminished', 'Diminished'),
      ]),

      section('Gastrointestinal & GU', 's_gi'),
      select('bowel_sounds', 'Bowel sounds', [opt('present', 'Present'), opt('hyperactive', 'Hyperactive'), opt('hypoactive', 'Hypoactive'), opt('absent', 'Absent')], { width: 'half' }),
      select('abdomen', 'Abdomen', [opt('soft', 'Soft, non-tender'), opt('distended', 'Distended'), opt('tender', 'Tender'), opt('rigid', 'Rigid')], { width: 'half' }),
      select('last_bowel_movement', 'Last bowel movement', [opt('today', 'Today'), opt('1d', '1 day ago'), opt('2d', '2 days ago'), opt('3d_plus', '≥ 3 days ago'), opt('unknown', 'Unknown')], { width: 'half' }),
      select('urine_output', 'Urine output', [opt('adequate', 'Adequate'), opt('decreased', 'Decreased'), opt('anuric', 'Anuric'), opt('catheter', 'Indwelling catheter')], { width: 'half' }),

      section('Skin & Pain', 's_skin'),
      select(
        'skin_integrity',
        'Skin integrity',
        [opt('intact', 'Intact'), opt('dry', 'Dry'), opt('rash', 'Rash'), opt('wound', 'Open wound / ulcer')],
        { width: 'half' },
      ),
      num('pain_score', 'Pain score (0-10)', { min: 0, max: 10, step: 1, width: 'half' }),
      textarea('assessment_notes', 'Additional notes', { rows: 3 }),
    ],
  },

  {
    name: 'Pain Assessment',
    description:
      'PQRST-style pain reassessment used at admission, on shift change, and within 30 minutes after analgesic administration.',
    category: 'assessment',
    fields: () => [
      datetime('assessed_at', 'Assessed at', true, 'half'),
      select(
        'pain_scale_used',
        'Pain scale used',
        [opt('numeric', 'Numeric (0-10)'), opt('wong_baker', 'Wong-Baker faces'), opt('flacc', 'FLACC (paediatric)'), opt('cpot', 'CPOT (non-verbal adult)')],
        { width: 'half', required: true },
      ),
      num('pain_score', 'Current pain score', { min: 0, max: 10, step: 1, required: true, width: 'half' }),
      text('site', 'Site / location', { width: 'half' }),
      multi('character', 'Character', [
        opt('sharp', 'Sharp / stabbing'),
        opt('dull', 'Dull / aching'),
        opt('burning', 'Burning'),
        opt('throbbing', 'Throbbing'),
        opt('cramping', 'Cramping'),
        opt('colicky', 'Colicky'),
      ]),
      multi('aggravating_factors', 'Aggravating factors', [
        opt('movement', 'Movement'),
        opt('pressure', 'Pressure / palpation'),
        opt('food', 'Food intake'),
        opt('breathing', 'Deep breathing / cough'),
        opt('none', 'None identified'),
      ]),
      multi('relieving_factors', 'Relieving factors', [
        opt('rest', 'Rest'),
        opt('position', 'Position change'),
        opt('analgesic', 'Analgesic'),
        opt('heat_cold', 'Heat / cold'),
        opt('none', 'None'),
      ]),
      select(
        'radiation',
        'Radiation',
        [opt('none', 'None'), opt('limb', 'Down a limb'), opt('back', 'To back'), opt('chest', 'To chest'), opt('jaw', 'To jaw'), opt('other', 'Other')],
        { width: 'half' },
      ),
      select(
        'timing',
        'Timing',
        [opt('constant', 'Constant'), opt('intermittent', 'Intermittent'), opt('episodic', 'Episodic')],
        { width: 'half' },
      ),
      check('analgesic_given', 'Analgesic administered for this episode'),
      text('intervention', 'Intervention given (drug + dose)', { width: 'full' }),
      num('reassess_score', 'Reassessment score after intervention', { min: 0, max: 10, step: 1, width: 'half' }),
      datetime('reassessed_at', 'Reassessed at', false, 'half'),
      textarea('notes', 'Additional notes', { rows: 2 }),
    ],
  },

  {
    name: 'Fall Risk Assessment (Morse Scale)',
    description:
      'Morse Fall Scale screening — used on admission, daily, and after any fall. Total score guides the fall-precaution care plan.',
    category: 'screening',
    fields: () => [
      datetime('assessed_at', 'Assessed at', true, 'half'),
      radio(
        'history_of_falling',
        '1. History of falling within last 3 months',
        [opt('0', 'No (0)'), opt('25', 'Yes (25)')],
        { required: true },
      ),
      radio(
        'secondary_diagnosis',
        '2. Secondary diagnosis',
        [opt('0', 'No (0)'), opt('15', 'Yes (15)')],
        { required: true },
      ),
      radio(
        'ambulatory_aid',
        '3. Ambulatory aid',
        [
          opt('0', 'None / bed rest / nurse assist (0)'),
          opt('15', 'Crutches / cane / walker (15)'),
          opt('30', 'Furniture (30)'),
        ],
        { required: true },
      ),
      radio(
        'iv_therapy',
        '4. IV therapy / heparin lock',
        [opt('0', 'No (0)'), opt('20', 'Yes (20)')],
        { required: true },
      ),
      radio(
        'gait',
        '5. Gait / transferring',
        [
          opt('0', 'Normal / bed rest / wheelchair (0)'),
          opt('10', 'Weak (10)'),
          opt('20', 'Impaired (20)'),
        ],
        { required: true },
      ),
      radio(
        'mental_status',
        '6. Mental status',
        [opt('0', 'Oriented to own ability (0)'), opt('15', 'Forgets limitations (15)')],
        { required: true },
      ),
      num('total_score', 'Total Morse score', {
        min: 0,
        max: 125,
        step: 1,
        helpText: 'Sum of items 1-6. 0-24 low, 25-44 moderate, ≥45 high risk.',
        required: true,
        width: 'half',
      }),
      select(
        'risk_level',
        'Risk level',
        [opt('low', 'Low (0-24)'), opt('moderate', 'Moderate (25-44)'), opt('high', 'High (≥ 45)')],
        { required: true, width: 'half' },
      ),
      multi('precautions_in_place', 'Precautions in place', [
        opt('bed_low', 'Bed in lowest position'),
        opt('rails', 'Side rails up'),
        opt('call_bell', 'Call bell within reach'),
        opt('non_skid', 'Non-skid footwear'),
        opt('night_light', 'Night light on'),
        opt('signage', 'Fall-risk signage on door'),
        opt('assist', 'Assist with all transfers'),
      ]),
      textarea('notes', 'Notes', { rows: 2 }),
    ],
  },

  {
    name: 'Pressure Injury / Wound Assessment',
    description:
      'Per-wound assessment — site, stage, dimensions, exudate, surrounding skin and dressing plan. Repeat per shift for high-risk patients.',
    category: 'assessment',
    fields: () => [
      datetime('assessed_at', 'Assessed at', true, 'half'),
      select(
        'wound_type',
        'Wound type',
        [
          opt('pressure', 'Pressure injury'),
          opt('surgical', 'Surgical incision'),
          opt('traumatic', 'Traumatic'),
          opt('diabetic', 'Diabetic ulcer'),
          opt('venous', 'Venous ulcer'),
          opt('arterial', 'Arterial ulcer'),
          opt('burn', 'Burn'),
          opt('other', 'Other'),
        ],
        { required: true, width: 'half' },
      ),
      text('location', 'Anatomical location', { required: true, placeholder: 'e.g. Sacrum, Right heel, Left lateral malleolus', width: 'full' }),
      select(
        'stage',
        'Stage / depth',
        [
          opt('stage_1', 'Stage 1 — non-blanchable erythema'),
          opt('stage_2', 'Stage 2 — partial-thickness'),
          opt('stage_3', 'Stage 3 — full-thickness'),
          opt('stage_4', 'Stage 4 — full-thickness with bone/tendon'),
          opt('unstageable', 'Unstageable'),
          opt('dti', 'Deep tissue injury'),
          opt('na', 'Not applicable'),
        ],
        { width: 'half' },
      ),
      num('length_cm', 'Length', { min: 0, step: 0.1, unit: 'cm', width: 'third' }),
      num('width_cm', 'Width', { min: 0, step: 0.1, unit: 'cm', width: 'third' }),
      num('depth_cm', 'Depth', { min: 0, step: 0.1, unit: 'cm', width: 'third' }),
      multi(
        'wound_bed',
        'Wound bed',
        [
          opt('granulation', 'Granulation'),
          opt('slough', 'Slough'),
          opt('eschar', 'Eschar'),
          opt('epithelial', 'Epithelialising'),
          opt('necrotic', 'Necrotic'),
        ],
      ),
      select(
        'exudate_amount',
        'Exudate amount',
        [opt('none', 'None'), opt('scant', 'Scant'), opt('moderate', 'Moderate'), opt('heavy', 'Heavy')],
        { width: 'half' },
      ),
      select(
        'exudate_type',
        'Exudate type',
        [opt('serous', 'Serous'), opt('serosanguinous', 'Serosanguinous'), opt('sanguinous', 'Sanguinous'), opt('purulent', 'Purulent')],
        { width: 'half' },
      ),
      multi('signs_of_infection', 'Signs of infection', [
        opt('erythema', 'Surrounding erythema'),
        opt('warmth', 'Warmth'),
        opt('odour', 'Odour'),
        opt('pain', 'Increased pain'),
        opt('fever', 'Fever'),
        opt('none', 'None'),
      ]),
      text('cleansing_solution', 'Cleansing solution', { width: 'half' }),
      text('dressing_used', 'Dressing applied', { width: 'half' }),
      select(
        'next_dressing_change',
        'Next dressing change',
        [opt('q12', 'Every 12 hours'), opt('q24', 'Every 24 hours'), opt('q48', 'Every 48 hours'), opt('prn', 'PRN if soiled')],
        { width: 'half' },
      ),
      textarea('notes', 'Notes / progress', { rows: 3 }),
    ],
  },

  {
    name: 'Daily Nursing Progress Note',
    description:
      'End-of-shift narrative summary — subjective status, key observations, interventions and plan handed over to the next shift.',
    category: 'daily_note',
    fields: () => [
      datetime('shift_start', 'Shift start', true, 'half'),
      datetime('shift_end', 'Shift end', true, 'half'),
      select(
        'shift',
        'Shift',
        [opt('morning', 'Morning'), opt('evening', 'Evening'), opt('night', 'Night')],
        { required: true, width: 'half' },
      ),
      select(
        'overall_status',
        'Overall status',
        [opt('improving', 'Improving'), opt('stable', 'Stable'), opt('deteriorating', 'Deteriorating')],
        { required: true, width: 'half' },
      ),

      section('S — Subjective', 's_s'),
      textarea('subjective', "Patient's complaints / mood / concerns", { rows: 3 }),

      section('O — Objective', 's_o'),
      textarea('objective', 'Vitals trends, intake/output, assessment findings', { rows: 4 }),

      section('A — Assessment', 's_a'),
      textarea('assessment', 'Nursing assessment / problem list update', { rows: 3 }),

      section('P — Plan', 's_p'),
      textarea('plan', 'Plan for next shift', { rows: 3, required: true }),
      multi('interventions_done', 'Interventions performed this shift', [
        opt('medications', 'Medications administered as scheduled'),
        opt('iv_care', 'IV / line care'),
        opt('wound_care', 'Wound / dressing care'),
        opt('catheter_care', 'Catheter care'),
        opt('positioning', 'Position changes / pressure-area care'),
        opt('mobilisation', 'Mobilisation / physio'),
        opt('feeding', 'Assisted feeding'),
        opt('teaching', 'Patient / family education'),
      ]),
      check('doctor_informed', 'Doctor informed of any changes'),
      text('reporting_to', 'Handover received by (nurse name)', { required: true }),
    ],
  },

  {
    name: 'Intake & Output Chart',
    description:
      'Per-shift fluid balance — oral, IV, tube feeds in; urine, stool, drains, vomitus out. Used in renal, cardiac and post-op patients.',
    category: 'vitals',
    fields: () => [
      datetime('shift_start', 'Shift start', true, 'half'),
      datetime('shift_end', 'Shift end', true, 'half'),

      section('Intake (mL)', 's_intake'),
      num('oral_intake', 'Oral fluids', { min: 0, unit: 'mL', width: 'third' }),
      num('iv_fluids', 'IV fluids', { min: 0, unit: 'mL', width: 'third' }),
      num('iv_medications', 'IV medications', { min: 0, unit: 'mL', width: 'third' }),
      num('blood_products', 'Blood / products', { min: 0, unit: 'mL', width: 'third' }),
      num('tube_feeding', 'Tube feeding', { min: 0, unit: 'mL', width: 'third' }),
      num('other_intake', 'Other (irrigation etc.)', { min: 0, unit: 'mL', width: 'third' }),
      num('total_intake', 'Total intake', { min: 0, unit: 'mL', width: 'half', helpText: 'Sum of all intake fields above' }),

      section('Output (mL)', 's_output'),
      num('urine_output', 'Urine output', { min: 0, unit: 'mL', width: 'third' }),
      num('stool_count', 'Stool count', { min: 0, step: 1, unit: 'episodes', width: 'third' }),
      num('vomitus', 'Vomitus', { min: 0, unit: 'mL', width: 'third' }),
      num('ng_drainage', 'NG drainage', { min: 0, unit: 'mL', width: 'third' }),
      num('drain_1', 'Drain 1', { min: 0, unit: 'mL', width: 'third' }),
      num('drain_2', 'Drain 2', { min: 0, unit: 'mL', width: 'third' }),
      num('blood_loss', 'Estimated blood loss', { min: 0, unit: 'mL', width: 'third' }),
      num('insensible_loss', 'Insensible loss', { min: 0, unit: 'mL', width: 'third' }),
      num('total_output', 'Total output', { min: 0, unit: 'mL', width: 'half' }),

      section('Balance', 's_balance'),
      num('balance', 'Net balance (intake − output)', {
        unit: 'mL',
        width: 'half',
        helpText: 'Negative = diuresis. Flag the doctor if outside expected range.',
      }),
      check('catheter_in_situ', 'Indwelling urinary catheter in situ'),
      textarea('notes', 'Notes', { rows: 2 }),
    ],
  },

  {
    name: 'Pre-Operative Checklist',
    description:
      'Surgical safety checklist completed by the ward nurse before patient is shifted to OT — consent, fasting, jewellery, marking and prophylaxis.',
    category: 'procedure',
    fields: () => [
      datetime('completed_at', 'Completed at', true, 'half'),
      text('procedure', 'Planned procedure', { required: true, width: 'half' }),
      text('surgeon', 'Primary surgeon', { width: 'half' }),
      text('anaesthetist', 'Anaesthetist', { width: 'half' }),

      section('Identification & Consent', 's_consent'),
      check('id_band_verified', 'Patient ID band verified'),
      check('consent_signed', 'Surgical consent signed'),
      check('anaesthesia_consent_signed', 'Anaesthesia consent signed'),
      check('site_marked', 'Surgical site marked'),

      section('Preparation', 's_prep'),
      datetime('npo_since', 'NPO since', false, 'half'),
      check('skin_prep_done', 'Skin prep / shave done'),
      check('bowel_prep_done', 'Bowel prep done (if applicable)'),
      check('bladder_emptied', 'Bladder emptied'),
      check('bath_done', 'Pre-operative bath done'),
      check('jewellery_removed', 'Jewellery / dentures / prosthetics removed'),
      check('nail_polish_removed', 'Nail polish / make-up removed'),

      section('Investigations', 's_invest'),
      check('cbc_available', 'CBC available'),
      check('coag_available', 'Coagulation profile available'),
      check('grouping_crossmatch', 'Blood grouping & crossmatch'),
      check('xray_available', 'X-ray / imaging available'),
      check('ecg_available', 'ECG available'),
      num('blood_units_arranged', 'Blood units arranged', { min: 0, step: 1, width: 'half' }),

      section('Prophylaxis & Allergies', 's_prophy'),
      check('antibiotic_prophylaxis_given', 'Antibiotic prophylaxis given'),
      text('antibiotic_name', 'Antibiotic name & time', { width: 'full' }),
      check('dvt_prophylaxis', 'DVT prophylaxis ordered'),
      textarea('allergies_flagged', 'Allergies flagged to OT team', { rows: 2 }),

      section('Vitals on Transfer', 's_vitals'),
      num('temperature_c', 'Temperature', { min: 30, max: 45, step: 0.1, unit: '°C', width: 'third' }),
      num('pulse', 'Pulse', { min: 20, max: 250, unit: 'bpm', width: 'third' }),
      num('bp_systolic', 'BP systolic', { min: 40, max: 300, unit: 'mmHg', width: 'third' }),
      num('bp_diastolic', 'BP diastolic', { min: 20, max: 200, unit: 'mmHg', width: 'third' }),
      num('spo2', 'SpO₂', { min: 0, max: 100, unit: '%', width: 'third' }),

      section('Sign-off', 's_signoff'),
      text('handed_over_to', 'Handed over to (OT staff)', { required: true, width: 'half' }),
      text('nurse_name', 'Ward nurse', { required: true, width: 'half' }),
    ],
  },

  {
    name: 'Discharge Readiness Checklist',
    description:
      'Final pre-discharge confirmation — clinical criteria, medication reconciliation, follow-up, and patient education completed.',
    category: 'discharge',
    fields: () => [
      datetime('reviewed_at', 'Reviewed at', true, 'half'),
      select(
        'discharge_type',
        'Discharge type',
        [
          opt('routine', 'Routine'),
          opt('against_advice', 'Against medical advice'),
          opt('transfer', 'Transfer to another facility'),
          opt('absconded', 'Absconded'),
          opt('expired', 'Expired'),
        ],
        { required: true, width: 'half' },
      ),

      section('Clinical Criteria', 's_clin'),
      check('vitals_stable', 'Vitals stable for ≥ 24 hours'),
      check('afebrile', 'Afebrile for ≥ 24 hours'),
      check('pain_controlled', 'Pain controlled on oral analgesia'),
      check('tolerating_oral', 'Tolerating oral diet'),
      check('mobilising', 'Mobilising independently or with support'),
      check('wound_healing', 'Wound clean / healing well'),
      check('drains_removed', 'Drains / catheters removed (if applicable)'),

      section('Medications', 's_meds'),
      check('discharge_meds_reconciled', 'Discharge medications reconciled'),
      check('discharge_meds_dispensed', 'Discharge medications dispensed'),
      check('patient_understands_meds', 'Patient / caregiver understands medications'),
      textarea('medication_concerns', 'Medication concerns / clarifications', { rows: 2 }),

      section('Follow-up & Education', 's_followup'),
      date('followup_appointment_date', 'Follow-up appointment date', false, 'half'),
      text('followup_with', 'Follow-up with', { width: 'half' }),
      multi(
        'education_given',
        'Patient education given on',
        [
          opt('diagnosis', 'Diagnosis & expected recovery'),
          opt('medications', 'Medications & side-effects'),
          opt('wound_care', 'Wound / drain care'),
          opt('diet', 'Diet & lifestyle'),
          opt('activity', 'Activity restrictions'),
          opt('warning_signs', 'Warning signs requiring return'),
          opt('emergency_contact', 'Emergency contact number'),
        ],
      ),
      check('discharge_summary_given', 'Discharge summary handed over to patient'),
      check('investigations_handed_over', 'Reports / investigations handed over'),

      section('Logistics', 's_logistics'),
      check('billing_cleared', 'Billing cleared'),
      check('belongings_returned', 'Personal belongings returned'),
      select(
        'transport_arranged',
        'Transport arranged',
        [opt('self', 'Self'), opt('family', 'Family'), opt('ambulance', 'Ambulance'), opt('na', 'Not required')],
        { width: 'half' },
      ),
      text('escorted_by', 'Escorted by', { width: 'half' }),
      textarea('notes', 'Additional notes', { rows: 2 }),
    ],
  },
];

async function seed() {
  console.log('🌱 Seeding patient-form templates...\n');

  // Locate the platform super admin (created by main seed.ts).
  const superAdminUser = await prisma.user.findFirst({
    where: {
      email: 'admin@hospital.com',
      tenant: { slug: '__platform__' },
    },
    select: { id: true, email: true },
  });

  if (!superAdminUser) {
    throw new Error(
      'Super admin user (admin@hospital.com on __platform__ tenant) not found. Run `npm run db:seed` first.',
    );
  }
  console.log(`  ↳ owner: ${superAdminUser.email}\n`);

  let created = 0;
  let updated = 0;

  for (const tpl of TEMPLATES) {
    fieldCounter = 0; // restart so each template has stable f_1, f_2 ids
    const fields = tpl.fields();
    const schemaJson = formSchemaShape.parse({ fields, version: 1 });

    const existing = await prisma.formTemplate.findFirst({
      where: { name: tpl.name, createdById: superAdminUser.id },
      select: { id: true, version: true },
    });

    if (existing) {
      await prisma.formTemplate.update({
        where: { id: existing.id },
        data: {
          description: tpl.description,
          category: tpl.category,
          schema: schemaJson as unknown as Prisma.InputJsonValue,
          isPublished: true,
          version: existing.version + 1,
        },
      });
      updated += 1;
      console.log(`  ✏  updated  ${tpl.name}  (${tpl.category}, ${fields.length} fields)`);
    } else {
      await prisma.formTemplate.create({
        data: {
          name: tpl.name,
          description: tpl.description,
          category: tpl.category,
          schema: schemaJson as unknown as Prisma.InputJsonValue,
          isPublished: true,
          version: 1,
          createdById: superAdminUser.id,
        },
      });
      created += 1;
      console.log(`  ✓  created  ${tpl.name}  (${tpl.category}, ${fields.length} fields)`);
    }
  }

  console.log(`\n✅ Done. ${created} created, ${updated} updated, ${TEMPLATES.length} total.`);
}

export async function seedFormTemplates(client?: PrismaClient): Promise<void> {
  const owns = !client;
  prisma = client ?? new PrismaClient();
  try {
    await seed();
  } finally {
    if (owns) await prisma.$disconnect();
  }
}

if (require.main === module) {
  seedFormTemplates()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Seed failed:', err);
      process.exit(1);
    });
}
