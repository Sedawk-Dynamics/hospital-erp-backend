// Lightweight knowledge base for the platform-wide support chatbot (Use Case
// 3). Curated "how-to" docs are retrieved by keyword overlap and handed to the
// LLM as grounding context, so answers stay accurate to THIS product instead of
// generic guesses. Extend freely as the product grows.

export interface HowToDoc {
  title: string;
  keywords: string[];
  body: string;
}

export const HOW_TO_DOCS: HowToDoc[] = [
  {
    title: 'Add a new patient',
    keywords: ['add patient', 'register patient', 'new patient', 'patient registration', 'create patient'],
    body: 'Open the Hospital module → Patients (or Registry). Click "Add New Patient" / "Register Patient", fill name, age/date of birth, gender, phone and address, then Save. The system assigns an MRN automatically.',
  },
  {
    title: 'Book an appointment',
    keywords: ['book appointment', 'schedule appointment', 'new appointment', 'opd booking', 'appointment'],
    body: 'Go to Appointments. Click "New Appointment", search the patient (or register a walk-in), pick the doctor, date and time slot, then confirm. Front-desk can then check the patient in.',
  },
  {
    title: 'Admit a patient (IP)',
    keywords: ['admit patient', 'admission', 'inpatient', 'ip admission', 'reserve bed'],
    body: 'From the consultation, the doctor raises an Admission Request. Front-desk/admin opens IP Home → Reservation, assigns a floor → ward → bed, and confirms the admission. The patient then appears under In-Patient.',
  },
  {
    title: 'Write a prescription',
    keywords: ['prescription', 'prescribe', 'medicine', 'drug', 'prescription pad', 'rx'],
    body: 'In the doctor consultation, use the Prescription Pad: search the drug (formulary/catalog), set dosage, frequency, duration and route, then add it. The CDSS safety panel flags interactions/allergies before you sign.',
  },
  {
    title: 'Order a lab test',
    keywords: ['lab test', 'order lab', 'laboratory', 'blood test', 'investigation', 'lab order'],
    body: 'In the consultation, click "Order Lab", search the test catalog, add the tests and submit. The order appears in the Laboratory module for sample collection and result entry.',
  },
  {
    title: 'Order imaging / radiology',
    keywords: ['imaging', 'radiology', 'x-ray', 'ct', 'mri', 'scan', 'order imaging'],
    body: 'In the consultation, click "Order Imaging", choose the modality and body part, add the clinical indication, and submit. Radiology admin verifies payment, then the radiologist performs and reports it.',
  },
  {
    title: 'Generate a discharge summary',
    keywords: ['discharge summary', 'discharge', 'discharge document', 'mrd'],
    body: 'Doctor module → Discharge Summary. Select the admission; the summary auto-fills from the admission data (diagnoses, procedures, labs, medications). Edit the sections, use "Generate with AI" to draft the narrative, then Sign and Publish.',
  },
  {
    title: 'Record a payment / billing',
    keywords: ['billing', 'payment', 'bill', 'invoice', 'collect payment', 'cash counter'],
    body: 'Hospital module → Billing. Create or open the bill, add services, then take payment at the Cash Counter (cash/card/UPI). Pending bills are tracked under the Pending tab.',
  },
  {
    title: 'Add stock / inventory item',
    keywords: ['inventory', 'add stock', 'stock', 'medicine stock', 'stock inward', 'item', 'batch'],
    body: 'Inventory module → Storage. Use "Add Stock": "New Item" defines an item or medicine (with category and barcode), and Bulk Stock Inward receives quantities (with batch/expiry for medicines). Medicines expand inline to the batch workspace.',
  },
  {
    title: 'Enter / publish a lab report',
    keywords: ['lab report', 'enter results', 'publish report', 'lab result', 'upload report'],
    body: 'Laboratory module → open the order. A technician enters values or uploads the report and marks each test Done. The report goes to review; a lab supervisor clicks "Approve & Publish" to release it to the patient and doctor.',
  },
  {
    title: 'Select clinic and module',
    keywords: ['select clinic', 'switch clinic', 'change module', 'select module', 'navigation', 'login'],
    body: 'After login you choose a clinic (tenant), then a module (Hospital, Laboratory, Pharmacy, OT, etc.). Use the header switchers to change clinic or module at any time. The left sidebar lists the pages for the active module.',
  },
  {
    title: 'Add ICD diagnosis code',
    keywords: ['icd', 'diagnosis code', 'icd code', 'diagnosis'],
    body: 'When recording a diagnosis in the consultation, type in the Diagnosis/ICD field — it autocompletes from the ICD-10 catalog. Pick the matching code. Super-admins manage the shared catalog; hospitals can add custom codes.',
  },
  {
    title: 'Use the patient AI assistant (for doctors)',
    keywords: ['patient ai', 'ai assistant', 'ai chatbot doctor', 'patient analysis', 'cdss ai'],
    body: 'In a patient consultation, open the AI Assistant panel and ask questions like "summarise this patient\'s history" or "analyse the latest blood report". It reasons over the patient\'s record; it does not interpret radiology images.',
  },
  {
    title: 'Record vitals',
    keywords: ['vitals', 'blood pressure', 'temperature', 'record vitals', 'nursing'],
    body: 'Vitals are recorded by nursing staff in the Nurse module (charting/eMAR) or the patient workspace. Doctors see the latest vitals read-only in the consultation and prescription pad.',
  },
  {
    title: 'Configure AI / LLM provider (super-admin)',
    keywords: ['configure ai', 'llm settings', 'ai settings', 'gemini', 'openai', 'ai provider'],
    body: 'Super-admin panel → AI Settings. Choose the provider (Gemini or OpenAI) and model, set the temperature, and toggle each AI feature (patient chatbot, support chatbot, discharge generation). API keys are configured on the server via environment variables.',
  },
];

const STOP = new Set([
  'how', 'do', 'i', 'a', 'an', 'the', 'to', 'in', 'on', 'of', 'for', 'is', 'are',
  'can', 'my', 'me', 'we', 'this', 'that', 'and', 'or', 'with', 'add', 'new', 'get',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Return the top-N docs most relevant to the question by keyword overlap. */
export function retrieveDocs(question: string, n = 3): HowToDoc[] {
  const qTokens = new Set(tokenize(question));
  const ql = question.toLowerCase();

  const scored = HOW_TO_DOCS.map((doc) => {
    let score = 0;
    for (const kw of doc.keywords) {
      if (ql.includes(kw)) score += 5; // whole-phrase keyword hit
      for (const t of tokenize(kw)) if (qTokens.has(t)) score += 1;
    }
    for (const t of tokenize(doc.title)) if (qTokens.has(t)) score += 1;
    return { doc, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, n).map((s) => s.doc);
}
