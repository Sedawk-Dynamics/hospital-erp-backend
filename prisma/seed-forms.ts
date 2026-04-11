/**
 * Seeds 4 published Form Templates owned by the platform super_admin.
 *
 * Idempotent: re-running this script won't create duplicates — it upserts
 * each template by name. Run with:
 *
 *   npx tsx prisma/seed-forms.ts
 *
 * Hospital admins can clone any of these from /hospital/settings/forms →
 * Template Library tab.
 */
import { PrismaClient, FormCategory, FormTrigger, FormTemplateStatus } from '@prisma/client';

const prisma = new PrismaClient();

interface SeedTemplate {
  name: string;
  description: string;
  category: FormCategory;
  defaultTrigger: FormTrigger;
  schema: {
    version: number;
    fields: Array<{
      id: string;
      type: string;
      label: string;
      placeholder?: string;
      helpText?: string;
      required: boolean;
      options?: { value: string; label: string }[];
      width: 'full' | 'half' | 'third';
    }>;
  };
}

const TEMPLATES: SeedTemplate[] = [
  // ════════════════════════════════════════════════════════
  // 1. Patient Health Intake Form
  //    Category: intake | Trigger: appointment_booking
  //    The patient fills this when they book an OP appointment.
  //    Captures the basic medical context the doctor needs upfront.
  // ════════════════════════════════════════════════════════
  {
    name: 'Patient Health Intake Form',
    description:
      'Pre-visit medical history, current symptoms, allergies, and lifestyle. Patient fills this at the time of booking so the doctor and front desk have full context before the consultation.',
    category: 'intake',
    defaultTrigger: 'appointment_booking',
    schema: {
      version: 1,
      fields: [
        // ── Vitals & Body ──
        {
          id: 'sec_vitals',
          type: 'section_header',
          label: 'Body Measurements',
          required: false,
          width: 'full',
        },
        {
          id: 'height_cm',
          type: 'number',
          label: 'Height (cm)',
          placeholder: '170',
          required: false,
          width: 'half',
        },
        {
          id: 'weight_kg',
          type: 'number',
          label: 'Weight (kg)',
          placeholder: '70',
          required: false,
          width: 'half',
        },

        // ── Reason for visit ──
        {
          id: 'sec_visit',
          type: 'section_header',
          label: 'Why are you visiting today?',
          required: false,
          width: 'full',
        },
        {
          id: 'main_complaint',
          type: 'textarea',
          label: 'Main complaint / symptoms',
          placeholder: 'Describe what brings you in today…',
          helpText: 'Be as specific as possible — when it started, where it hurts, etc.',
          required: true,
          width: 'full',
        },
        {
          id: 'symptom_duration',
          type: 'select',
          label: 'How long have you had these symptoms?',
          required: true,
          options: [
            { value: 'less_than_1_day', label: 'Less than 1 day' },
            { value: '1_to_3_days', label: '1–3 days' },
            { value: '4_to_7_days', label: '4–7 days' },
            { value: '1_to_2_weeks', label: '1–2 weeks' },
            { value: '2_to_4_weeks', label: '2–4 weeks' },
            { value: 'more_than_1_month', label: 'More than 1 month' },
          ],
          width: 'half',
        },
        {
          id: 'pain_level',
          type: 'select',
          label: 'Pain level (0 = none, 10 = severe)',
          required: false,
          options: Array.from({ length: 11 }, (_, i) => ({
            value: String(i),
            label: String(i),
          })),
          width: 'half',
        },

        // ── Medical history ──
        {
          id: 'sec_history',
          type: 'section_header',
          label: 'Medical History',
          required: false,
          width: 'full',
        },
        {
          id: 'chronic_conditions',
          type: 'multi_select',
          label: 'Do you have any chronic conditions? (select all that apply)',
          required: false,
          options: [
            { value: 'diabetes', label: 'Diabetes' },
            { value: 'hypertension', label: 'High Blood Pressure' },
            { value: 'asthma', label: 'Asthma' },
            { value: 'heart_disease', label: 'Heart Disease' },
            { value: 'kidney_disease', label: 'Kidney Disease' },
            { value: 'liver_disease', label: 'Liver Disease' },
            { value: 'thyroid', label: 'Thyroid Disorder' },
            { value: 'cancer', label: 'Cancer' },
            { value: 'none', label: 'None of the above' },
          ],
          width: 'full',
        },
        {
          id: 'previous_surgeries',
          type: 'textarea',
          label: 'Past surgeries or hospitalizations',
          placeholder: 'e.g. Appendectomy in 2019',
          required: false,
          width: 'full',
        },
        {
          id: 'family_history',
          type: 'textarea',
          label: 'Family history of major illnesses',
          placeholder: 'e.g. Father — diabetes; Mother — hypertension',
          required: false,
          width: 'full',
        },

        // ── Allergies & meds ──
        {
          id: 'sec_allergies',
          type: 'section_header',
          label: 'Allergies & Medications',
          required: false,
          width: 'full',
        },
        {
          id: 'has_allergies',
          type: 'radio',
          label: 'Do you have any known allergies?',
          required: true,
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ],
          width: 'half',
        },
        {
          id: 'allergies_list',
          type: 'textarea',
          label: 'List your allergies (drugs, food, environmental)',
          placeholder: 'e.g. Penicillin, peanuts, dust',
          helpText: 'Only fill if you answered Yes above.',
          required: false,
          width: 'full',
        },
        {
          id: 'current_medications',
          type: 'textarea',
          label: 'Current medications you are taking',
          placeholder: 'Drug name + dose + frequency',
          required: false,
          width: 'full',
        },

        // ── Lifestyle ──
        {
          id: 'sec_lifestyle',
          type: 'section_header',
          label: 'Lifestyle',
          required: false,
          width: 'full',
        },
        {
          id: 'smoking',
          type: 'radio',
          label: 'Smoking status',
          required: false,
          options: [
            { value: 'never', label: 'Never' },
            { value: 'former', label: 'Former smoker' },
            { value: 'current', label: 'Current smoker' },
          ],
          width: 'half',
        },
        {
          id: 'alcohol',
          type: 'radio',
          label: 'Alcohol consumption',
          required: false,
          options: [
            { value: 'none', label: 'None' },
            { value: 'occasional', label: 'Occasional' },
            { value: 'moderate', label: 'Moderate' },
            { value: 'heavy', label: 'Heavy' },
          ],
          width: 'half',
        },
      ],
    },
  },

  // ════════════════════════════════════════════════════════
  // 2. Surgical Consent Form
  //    Category: consent | Trigger: pre_op
  //    Required acknowledgements + e-signature before surgery.
  // ════════════════════════════════════════════════════════
  {
    name: 'Surgical Consent & Authorization',
    description:
      'Standard surgical consent capturing patient acknowledgement of risks, anesthesia preference, and authorization for the procedure. Filled before any operative procedure.',
    category: 'consent',
    defaultTrigger: 'pre_op',
    schema: {
      version: 1,
      fields: [
        {
          id: 'sec_verify',
          type: 'section_header',
          label: 'Patient Identification',
          required: false,
          width: 'full',
        },
        {
          id: 'patient_name',
          type: 'text',
          label: 'Full Name',
          required: true,
          width: 'half',
        },
        {
          id: 'dob',
          type: 'date',
          label: 'Date of Birth',
          required: true,
          width: 'half',
        },

        {
          id: 'sec_procedure',
          type: 'section_header',
          label: 'Procedure Details',
          required: false,
          width: 'full',
        },
        {
          id: 'procedure_name',
          type: 'text',
          label: 'Name of Procedure',
          placeholder: 'e.g. Laparoscopic cholecystectomy',
          required: true,
          width: 'full',
        },
        {
          id: 'surgeon_name',
          type: 'text',
          label: 'Operating Surgeon',
          required: true,
          width: 'half',
        },
        {
          id: 'scheduled_date',
          type: 'date',
          label: 'Scheduled Date',
          required: true,
          width: 'half',
        },

        {
          id: 'sec_acknowledge',
          type: 'section_header',
          label: 'Acknowledgements',
          helpText: 'Please tick each box to confirm.',
          required: false,
          width: 'full',
        },
        {
          id: 'ack_explained',
          type: 'checkbox',
          label: 'I confirm the procedure has been explained to me in language I understand.',
          placeholder: 'Yes, I understand',
          required: true,
          width: 'full',
        },
        {
          id: 'ack_risks',
          type: 'checkbox',
          label:
            'I understand the risks may include bleeding, infection, complications from anesthesia, scarring, and in rare cases, death.',
          placeholder: 'I accept these risks',
          required: true,
          width: 'full',
        },
        {
          id: 'ack_alternatives',
          type: 'checkbox',
          label: 'I have been informed about alternative treatments and the option to refuse.',
          placeholder: 'I understand my alternatives',
          required: true,
          width: 'full',
        },
        {
          id: 'ack_questions',
          type: 'checkbox',
          label: 'All my questions have been answered to my satisfaction.',
          placeholder: 'My questions have been answered',
          required: true,
          width: 'full',
        },

        {
          id: 'sec_anesthesia',
          type: 'section_header',
          label: 'Anesthesia & Additional Consent',
          required: false,
          width: 'full',
        },
        {
          id: 'anesthesia_type',
          type: 'radio',
          label: 'Anesthesia type discussed',
          required: true,
          options: [
            { value: 'general', label: 'General' },
            { value: 'regional', label: 'Regional' },
            { value: 'local', label: 'Local' },
            { value: 'sedation', label: 'Sedation' },
          ],
          width: 'full',
        },
        {
          id: 'blood_consent',
          type: 'radio',
          label: 'Do you consent to blood transfusion if medically necessary?',
          required: true,
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ],
          width: 'half',
        },
        {
          id: 'photo_consent',
          type: 'checkbox',
          label: 'I consent to medical photography for educational/training purposes (optional).',
          placeholder: 'Optional',
          required: false,
          width: 'full',
        },

        {
          id: 'sec_signature',
          type: 'section_header',
          label: 'Signature',
          required: false,
          width: 'full',
        },
        {
          id: 'patient_signature',
          type: 'signature',
          label: 'Patient Signature (type your full name)',
          required: true,
          width: 'full',
        },
        {
          id: 'signed_date',
          type: 'date',
          label: 'Date',
          required: true,
          width: 'half',
        },
        {
          id: 'witness_name',
          type: 'text',
          label: 'Witness Name',
          required: false,
          width: 'half',
        },
      ],
    },
  },

  // ════════════════════════════════════════════════════════
  // 3. IPD Admission Checklist
  //    Category: checklist | Trigger: admission
  //    Filled by nurse / front desk during patient admission.
  // ════════════════════════════════════════════════════════
  {
    name: 'IPD Admission Checklist',
    description:
      'Standard checklist completed by the admitting nurse for every inpatient admission. Covers identification, clinical baseline, room setup, and safety steps.',
    category: 'checklist',
    defaultTrigger: 'admission',
    schema: {
      version: 1,
      fields: [
        {
          id: 'sec_id',
          type: 'section_header',
          label: 'Patient Identification',
          required: false,
          width: 'full',
        },
        {
          id: 'id_verified',
          type: 'checkbox',
          label: 'Patient identity verified against ID proof',
          placeholder: 'Verified',
          required: true,
          width: 'full',
        },
        {
          id: 'mrn_confirmed',
          type: 'checkbox',
          label: 'MRN matches admission record',
          placeholder: 'Confirmed',
          required: true,
          width: 'full',
        },
        {
          id: 'wristband_applied',
          type: 'checkbox',
          label: 'Patient wristband applied',
          placeholder: 'Applied',
          required: true,
          width: 'full',
        },

        {
          id: 'sec_clinical',
          type: 'section_header',
          label: 'Clinical Baseline',
          required: false,
          width: 'full',
        },
        {
          id: 'allergies_reviewed',
          type: 'checkbox',
          label: 'Allergies reviewed and documented',
          placeholder: 'Reviewed',
          required: true,
          width: 'full',
        },
        {
          id: 'meds_recorded',
          type: 'checkbox',
          label: 'Current medications recorded',
          placeholder: 'Recorded',
          required: true,
          width: 'full',
        },
        {
          id: 'vitals_taken',
          type: 'checkbox',
          label: 'Initial vital signs recorded',
          placeholder: 'Done',
          required: true,
          width: 'full',
        },
        {
          id: 'height_cm',
          type: 'number',
          label: 'Height (cm)',
          required: false,
          width: 'half',
        },
        {
          id: 'weight_kg',
          type: 'number',
          label: 'Weight (kg)',
          required: false,
          width: 'half',
        },

        {
          id: 'sec_room',
          type: 'section_header',
          label: 'Room Setup',
          required: false,
          width: 'full',
        },
        {
          id: 'room_number',
          type: 'text',
          label: 'Room Number',
          required: true,
          width: 'half',
        },
        {
          id: 'bed_number',
          type: 'text',
          label: 'Bed Number',
          required: true,
          width: 'half',
        },
        {
          id: 'call_bell_tested',
          type: 'checkbox',
          label: 'Call bell tested and working',
          placeholder: 'Tested',
          required: false,
          width: 'half',
        },
        {
          id: 'bed_rails_up',
          type: 'checkbox',
          label: 'Bed rails up (if applicable)',
          placeholder: 'Up',
          required: false,
          width: 'half',
        },
        {
          id: 'fall_risk',
          type: 'select',
          label: 'Fall risk assessment',
          required: true,
          options: [
            { value: 'low', label: 'Low' },
            { value: 'moderate', label: 'Moderate' },
            { value: 'high', label: 'High' },
          ],
          width: 'half',
        },

        {
          id: 'sec_belongings',
          type: 'section_header',
          label: 'Belongings & Family',
          required: false,
          width: 'full',
        },
        {
          id: 'valuables',
          type: 'radio',
          label: 'Valuables handling',
          required: true,
          options: [
            { value: 'stored_with_security', label: 'Stored with hospital security' },
            { value: 'sent_with_family', label: 'Sent home with family' },
            { value: 'none_brought', label: 'None brought' },
          ],
          width: 'full',
        },
        {
          id: 'emergency_contact_present',
          type: 'checkbox',
          label: 'Emergency contact present / informed',
          placeholder: 'Yes',
          required: false,
          width: 'half',
        },
        {
          id: 'visiting_hours_explained',
          type: 'checkbox',
          label: 'Visiting hours and policies explained',
          placeholder: 'Explained',
          required: false,
          width: 'half',
        },

        {
          id: 'admitting_nurse',
          type: 'text',
          label: 'Admitting Nurse Name',
          required: true,
          width: 'full',
        },
        {
          id: 'notes',
          type: 'textarea',
          label: 'Additional Notes',
          required: false,
          width: 'full',
        },
      ],
    },
  },

  // ════════════════════════════════════════════════════════
  // 4. Patient Satisfaction Feedback
  //    Category: feedback | Trigger: feedback (post-visit)
  //    Light, ratings-driven survey emailed/handed out after discharge.
  // ════════════════════════════════════════════════════════
  {
    name: 'Patient Satisfaction Feedback',
    description:
      'Post-visit feedback to capture overall experience, service quality ratings, and improvement suggestions. Helps the hospital track quality and follow up where needed.',
    category: 'feedback',
    defaultTrigger: 'feedback',
    schema: {
      version: 1,
      fields: [
        {
          id: 'sec_overall',
          type: 'section_header',
          label: 'Overall Experience',
          required: false,
          width: 'full',
        },
        {
          id: 'overall_rating',
          type: 'radio',
          label: 'How would you rate your overall experience?',
          required: true,
          options: [
            { value: '5', label: '★★★★★ Excellent' },
            { value: '4', label: '★★★★ Good' },
            { value: '3', label: '★★★ Average' },
            { value: '2', label: '★★ Poor' },
            { value: '1', label: '★ Very poor' },
          ],
          width: 'full',
        },
        {
          id: 'would_recommend',
          type: 'radio',
          label: 'Would you recommend us to friends or family?',
          required: true,
          options: [
            { value: 'definitely', label: 'Definitely' },
            { value: 'probably', label: 'Probably' },
            { value: 'maybe', label: 'Maybe' },
            { value: 'probably_not', label: 'Probably not' },
            { value: 'definitely_not', label: 'Definitely not' },
          ],
          width: 'full',
        },

        {
          id: 'sec_specific',
          type: 'section_header',
          label: 'Specific Ratings',
          required: false,
          width: 'full',
        },
        {
          id: 'doctor_rating',
          type: 'select',
          label: 'Doctor / Consultation Quality',
          required: true,
          options: [
            { value: 'excellent', label: 'Excellent' },
            { value: 'good', label: 'Good' },
            { value: 'average', label: 'Average' },
            { value: 'poor', label: 'Poor' },
          ],
          width: 'half',
        },
        {
          id: 'staff_rating',
          type: 'select',
          label: 'Nursing & Front Desk Staff',
          required: false,
          options: [
            { value: 'excellent', label: 'Excellent' },
            { value: 'good', label: 'Good' },
            { value: 'average', label: 'Average' },
            { value: 'poor', label: 'Poor' },
          ],
          width: 'half',
        },
        {
          id: 'facility_rating',
          type: 'select',
          label: 'Cleanliness & Facility',
          required: false,
          options: [
            { value: 'excellent', label: 'Excellent' },
            { value: 'good', label: 'Good' },
            { value: 'average', label: 'Average' },
            { value: 'poor', label: 'Poor' },
          ],
          width: 'half',
        },
        {
          id: 'wait_time_rating',
          type: 'select',
          label: 'Waiting Time',
          required: false,
          options: [
            { value: 'excellent', label: 'Excellent' },
            { value: 'good', label: 'Good' },
            { value: 'average', label: 'Average' },
            { value: 'poor', label: 'Poor' },
          ],
          width: 'half',
        },

        {
          id: 'sec_feedback',
          type: 'section_header',
          label: 'Tell Us More',
          required: false,
          width: 'full',
        },
        {
          id: 'positives',
          type: 'textarea',
          label: 'What did we do well?',
          placeholder: 'Anything that stood out positively…',
          required: false,
          width: 'full',
        },
        {
          id: 'improvements',
          type: 'textarea',
          label: 'What could we improve?',
          placeholder: 'Be honest — we read every response.',
          required: false,
          width: 'full',
        },
        {
          id: 'allow_followup',
          type: 'checkbox',
          label: 'You may contact me to follow up on this feedback.',
          placeholder: 'Yes, you can contact me',
          required: false,
          width: 'full',
        },
        {
          id: 'followup_phone',
          type: 'phone',
          label: 'Best phone number to reach you',
          placeholder: '+91 98xxxxxxxx',
          required: false,
          width: 'half',
        },
      ],
    },
  },
];

async function main() {
  console.log('🌱 Seeding Form Templates…\n');

  // Find the platform super admin (creator of all global templates)
  const superAdmin = await prisma.user.findFirst({
    where: { email: 'admin@hospital.com', tenant: { slug: '__platform__' } },
  });
  if (!superAdmin) {
    throw new Error(
      'Super admin user not found. Run `npx tsx prisma/seed.ts` first to create the platform tenant + super admin.',
    );
  }

  let created = 0;
  let updated = 0;

  for (const t of TEMPLATES) {
    // Idempotent: find by name (no unique constraint, so we use findFirst)
    const existing = await prisma.formTemplate.findFirst({ where: { name: t.name } });

    if (existing) {
      await prisma.formTemplate.update({
        where: { id: existing.id },
        data: {
          description: t.description,
          category: t.category,
          schema: t.schema as object,
          defaultTrigger: t.defaultTrigger,
          status: FormTemplateStatus.published,
          publishedAt: existing.publishedAt ?? new Date(),
        },
      });
      updated++;
      console.log(`  ✓ Updated:  ${t.name}  (${t.category} / ${t.defaultTrigger})`);
    } else {
      await prisma.formTemplate.create({
        data: {
          name: t.name,
          description: t.description,
          category: t.category,
          schema: t.schema as object,
          defaultTrigger: t.defaultTrigger,
          status: FormTemplateStatus.published,
          publishedAt: new Date(),
          createdBy: superAdmin.id,
        },
      });
      created++;
      console.log(`  ✓ Created:  ${t.name}  (${t.category} / ${t.defaultTrigger})`);
    }
  }

  console.log(`\n✅ Done. ${created} new, ${updated} updated.`);
  console.log('   Hospital admins can clone these from /hospital/settings/forms → Template Library.');
}

main()
  .catch((e) => {
    console.error('\n❌ Form seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
