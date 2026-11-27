import { buildPatientContext } from './src/modules/ai/ai.context';
import { PATIENT_CHAT_SYSTEM } from './src/modules/ai/ai.chat.service';

const tenantId = 'eb1364dc-a987-4470-9c59-39f78048b5d7';
const patientId = 'caf8bd14-99df-4bbf-a53d-6a8201c64e7d';

(async () => {
  const context = await buildPatientContext(tenantId, patientId);
  const system = [PATIENT_CHAT_SYSTEM, '', '=== PATIENT CONTEXT ===', context.text].join('\n');
  const userMsg =
    "Summarise this patient's history and current clinical status. Cover demographics, " +
    'known diagnoses (with ICD codes), allergies, social and family history, the current ' +
    'visit and vitals, current medications, and recent labs — highlighting any allergies or ' +
    'abnormal values. End with suggested next steps (investigations, monitoring, follow-up).\n\n' +
    'STRICT: Use ONLY the data present in the patient record above. Do NOT invent, infer, ' +
    'assume, or self-generate any value, diagnosis, medication, allergy, lab, vital or history. ' +
    'If something is not in the record, state clearly that it is "Not recorded" rather than ' +
    'guessing or filling it in.';

  console.log('\n===== SYSTEM =====\n');
  console.log(system);
  console.log('\n===== USER MESSAGE =====\n');
  console.log(userMsg);
  process.exit(0);
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});



























































































