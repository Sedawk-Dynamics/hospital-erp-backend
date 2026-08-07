import type { PdfDocumentType } from '../../services/pdf-template';
import type { PdfMetaItem } from '../../services/pdf-branding';
import type { TableColumn } from '../../services/pdf-doc';

// ---------------------------------------------------------------------------
// Sample content for the PDF Builder preview.
//
// The preview used to mimic three document types with the same invented two-row
// table, so an admin styling the NDPS register or a payslip was really looking
// at a prescription. Each registered document type now previews with content
// shaped like the real thing — the same headings, the same column counts, the
// same density — because that is what tells you whether 8pt Courier on A5 is
// actually going to work.
//
// Everything here is obviously fake. No sample carries a plausible real name,
// MRN or amount that could be mistaken for a record.
// ---------------------------------------------------------------------------

export interface PreviewSection {
  heading: string;
  /** Free text paragraph, a table, or a label/value card. */
  paragraph?: string;
  columns?: TableColumn[];
  rows?: string[][];
  card?: Array<[string, string]>;
}

export interface PreviewDoc {
  title: string;
  subtitle: string;
  meta: PdfMetaItem[];
  /** The label/value card most documents open with. */
  header: Array<[string, string]>;
  sections: PreviewSection[];
}

const today = () =>
  new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

const SAMPLE_PATIENT: Array<[string, string]> = [
  ['Patient Name', 'Sample Patient'],
  ['MRN / UHID', 'SAMPLE-000000'],
  ['Age / Gender', '42 / Male'],
  ['Doctor', 'Dr. Sample Consultant'],
];

export function previewDoc(type: PdfDocumentType): PreviewDoc {
  switch (type) {
    case 'prescription':
      return {
        title: 'Prescription',
        subtitle: 'Outpatient (OP)',
        meta: [
          { label: 'Date', value: today() },
          { label: 'Rx No', value: 'SAMPLE-RX-0001' },
        ],
        header: SAMPLE_PATIENT,
        sections: [
          {
            heading: 'Diagnosis',
            paragraph: 'Sample diagnosis text — acute pharyngitis, no red flags on examination.',
          },
          {
            heading: '℞  Medications',
            columns: [
              { header: 'Medication', width: 0.42 },
              { header: 'Dosage', width: 0.16 },
              { header: 'Frequency', width: 0.22 },
              { header: 'Duration', width: 0.2 },
            ],
            rows: [
              ['Paracetamol 650mg', '1 tab', '1-1-1 after food', '5 days'],
              ['Pantoprazole 40mg', '1 tab', '1-0-0 before food', '5 days'],
              ['Cetirizine 10mg', '1 tab', '0-0-1', '3 days'],
            ],
          },
          {
            heading: 'Advice',
            paragraph:
              'Sample advice — warm saline gargles, adequate hydration, review after five days or earlier if fever persists.',
          },
        ],
      };

    case 'discharge_summary':
      return {
        title: 'Discharge Summary',
        subtitle: 'Inpatient (IP)',
        meta: [
          { label: 'MRN', value: 'SAMPLE-000000' },
          { label: 'Doc No', value: 'SAMPLE-DS-0001' },
        ],
        header: [
          ['Patient Name', 'Sample Patient'],
          ['MRN / UHID', 'SAMPLE-000000'],
          ['Admitted', today()],
          ['Discharged', today()],
          ['Ward / Bed', 'Sample Ward / B-000'],
          ['Consultant', 'Dr. Sample Consultant'],
        ],
        sections: [
          {
            heading: 'Diagnosis on discharge',
            paragraph: 'Sample final diagnosis with the clinical course summarised in a short paragraph.',
          },
          {
            heading: 'Investigations',
            columns: [
              { header: 'Test', width: 0.34 },
              { header: 'Result', width: 0.22, align: 'right' },
              { header: 'Unit', width: 0.16 },
              { header: 'Reference', width: 0.28 },
            ],
            rows: [
              ['Haemoglobin', '12.4', 'g/dL', '13.0 – 17.0'],
              ['Total Leucocyte Count', '9,100', '/µL', '4,000 – 11,000'],
              ['Serum Creatinine', '0.9', 'mg/dL', '0.6 – 1.2'],
            ],
          },
          {
            heading: 'Medications on discharge',
            columns: [
              { header: 'Medication', width: 0.44 },
              { header: 'Dose', width: 0.18 },
              { header: 'Frequency', width: 0.38 },
            ],
            rows: [
              ['Sample Tablet 500mg', '1 tab', '1-0-1 · 7 days'],
              ['Sample Capsule 20mg', '1 cap', '1-0-0 · 14 days'],
            ],
          },
          {
            heading: 'Follow-up',
            paragraph: 'Sample follow-up instruction — review in OPD after one week with these reports.',
          },
        ],
      };

    case 'ip_bill':
      return {
        title: 'Inpatient Bill',
        subtitle: 'Final bill · Sample admission',
        meta: [
          { label: 'Bill No', value: 'SAMPLE-INV-0001' },
          { label: 'Date', value: today() },
        ],
        header: [
          ['Patient Name', 'Sample Patient'],
          ['MRN / UHID', 'SAMPLE-000000'],
          ['Admission', 'SAMPLE-ADM-0001'],
          ['Ward / Bed', 'Sample Ward / B-000'],
        ],
        sections: [
          {
            heading: 'Charges',
            columns: [
              { header: 'Particulars', width: 0.46 },
              { header: 'Qty', width: 0.1, align: 'right' },
              { header: 'Rate', width: 0.2, align: 'right' },
              { header: 'Amount', width: 0.24, align: 'right' },
            ],
            rows: [
              ['Room rent — Sample Ward', '3', '2,000.00', '6,000.00'],
              ['Consultant visit', '4', '600.00', '2,400.00'],
              ['Investigations — sample panel', '1', '1,850.00', '1,850.00'],
              ['Pharmacy — sample issue', '1', '2,310.00', '2,310.00'],
            ],
          },
          {
            heading: 'Summary',
            card: [
              ['Gross', '12,560.00'],
              ['Discount', '560.00'],
              ['Deposit received', '5,000.00'],
              ['Balance due', '7,000.00'],
            ],
          },
        ],
      };

    case 'payment_receipt':
      return {
        title: 'Payment Receipt',
        subtitle: 'Bill SAMPLE-INV-0001',
        meta: [
          { label: 'Receipt', value: 'SAMPLE-RCP-0001' },
          { label: 'Date', value: today() },
        ],
        header: [
          ['Patient Name', 'Sample Patient'],
          ['MRN / UHID', 'SAMPLE-000000'],
          ['Bill No', 'SAMPLE-INV-0001'],
          ['Mode', 'UPI'],
        ],
        sections: [
          {
            heading: 'Bill items',
            columns: [
              { header: 'Description', width: 0.54 },
              { header: 'Qty', width: 0.12, align: 'right' },
              { header: 'Amount', width: 0.34, align: 'right' },
            ],
            rows: [
              ['Consultation — General OPD', '1', '500.00'],
              ['Investigation — sample panel', '1', '350.00'],
            ],
          },
          {
            heading: 'This receipt',
            card: [
              ['Amount received', '850.00'],
              ['Method', 'UPI'],
              ['Reference', 'SAMPLE-TXN-0001'],
              ['Balance after payment', '0.00'],
            ],
          },
        ],
      };

    case 'salary_slip':
      return {
        title: 'Salary Slip',
        subtitle: 'Sample month',
        meta: [
          { label: 'Employee', value: 'SAMPLE-EMP-001' },
          { label: 'Period', value: today() },
        ],
        header: [
          ['Employee', 'Sample Employee'],
          ['Employee ID', 'SAMPLE-EMP-001'],
          ['Designation', 'Sample Designation'],
          ['Department', 'Sample Department'],
        ],
        sections: [
          {
            heading: 'Earnings & deductions',
            columns: [
              { header: 'Component', width: 0.5 },
              { header: 'Earnings', width: 0.25, align: 'right' },
              { header: 'Deductions', width: 0.25, align: 'right' },
            ],
            rows: [
              ['Basic', '30,000.00', '—'],
              ['House rent allowance', '12,000.00', '—'],
              ['Provident fund', '—', '1,800.00'],
              ['Professional tax', '—', '200.00'],
            ],
          },
          {
            heading: 'Net pay',
            card: [
              ['Gross earnings', '42,000.00'],
              ['Total deductions', '2,000.00'],
              ['Net payable', '40,000.00'],
              ['Paid on', today()],
            ],
          },
        ],
      };

    case 'ndps_register':
      return {
        title: 'NDPS Register',
        subtitle: 'Statutory narcotics record',
        meta: [
          { label: 'Register', value: 'SAMPLE-NDPS-01' },
          { label: 'Period', value: today() },
        ],
        header: [
          ['Drug', 'Sample Controlled Substance'],
          ['Schedule', 'Sample Schedule'],
          ['Opening balance', '40'],
          ['Closing balance', '31'],
        ],
        sections: [
          {
            heading: 'Movements',
            columns: [
              { header: 'Date', width: 0.14 },
              { header: 'Patient / Reference', width: 0.24 },
              { header: 'Prescriber', width: 0.18 },
              { header: 'In', width: 0.1, align: 'right' },
              { header: 'Out', width: 0.1, align: 'right' },
              { header: 'Balance', width: 0.12, align: 'right' },
              { header: 'Witness', width: 0.12 },
            ],
            rows: [
              [today(), 'SAMPLE-000000', 'Dr. Sample', '—', '2', '38', 'S. Nurse'],
              [today(), 'SAMPLE-000001', 'Dr. Sample', '—', '4', '34', 'S. Nurse'],
              [today(), 'Sample inward', '—', '—', '3', '31', 'S. Pharm'],
            ],
          },
          {
            heading: 'Certification',
            paragraph:
              'Sample certification text — the balance above was physically verified and matches this register.',
          },
        ],
      };

    case 'ndps_daily':
      return {
        title: 'NDPS Daily Statement',
        subtitle: today(),
        meta: [{ label: 'Date', value: today() }],
        header: [
          ['Statement date', today()],
          ['Prepared by', 'Sample Pharmacist'],
          ['Items moved', '3'],
          ['Discrepancies', 'Nil'],
        ],
        sections: [
          {
            heading: 'Day summary',
            columns: [
              { header: 'Drug', width: 0.4 },
              { header: 'Opening', width: 0.15, align: 'right' },
              { header: 'Issued', width: 0.15, align: 'right' },
              { header: 'Received', width: 0.15, align: 'right' },
              { header: 'Closing', width: 0.15, align: 'right' },
            ],
            rows: [
              ['Sample Controlled Substance A', '40', '6', '3', '37'],
              ['Sample Controlled Substance B', '25', '2', '0', '23'],
            ],
          },
        ],
      };

    default:
      return {
        title: 'Sample Document',
        subtitle: 'Preview',
        meta: [{ label: 'Date', value: today() }],
        header: SAMPLE_PATIENT,
        sections: [{ heading: 'Sample section', paragraph: 'Sample body text.' }],
      };
  }
}
