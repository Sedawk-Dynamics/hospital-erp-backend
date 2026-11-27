import { AppError } from "../../shared/appError";
import { audioToText } from "./transcribe.ai"
import { generateJson } from "../../services/ai";

export interface TranscriptSections {
    chiefComplaint: string;
    generalExamination: string;
    investigationsSummary: string;
    impression: string;
    advice: string;
    referralNotes: string;
}

export const transcribeUpload = async (file: Express.Multer.File, tenantId: string) => {
    const transcriptText = await audioToText(file);
    console.log('[transcribe] raw transcript text from Whisper:', transcriptText);
    if (!transcriptText.length) throw new AppError('error in transcripting the audio file', 500);

    const system = `You are a clinical documentation assistant for a doctor's consultation. You are given a raw transcript of a doctor-patient conversation. The transcript may be in English, Hindi, or a mix (Hinglish).

Your job: read the transcript and organise its content into the structured fields below. Then return ONLY a JSON object — no prose, no markdown, no code fences.

Return exactly this shape:
{
  "chiefComplaint": string,
  "generalExamination": string,
  "investigationsSummary": string,
  "impression": string,
  "advice": string,
  "referralNotes": string
}

Field meaning:
- chiefComplaint: the patient's presenting symptoms/problems in their own words (what they came for).
- generalExamination: what the doctor observed or found on examination (vitals, physical exam, signs).
- investigationsSummary: tests, labs, or imaging ordered or discussed.
- impression: the doctor's diagnosis or clinical impression.
- advice: instructions/advice given to the patient (medication, diet, follow-up).
- referralNotes: any referral to another doctor or specialist, with the reason if stated.

STRICT RULES:
1. Use ONLY information that is actually present in the transcript. Do NOT invent, assume, guess, or add anything that was not said. No hallucination.
2. If a field has no information in the transcript, return an empty string "" for it. Never fill a field with made-up content.
3. If the transcript is in Hindi or Hinglish, translate the content into clear, professional English. The entire JSON output must be in English.
4. Assign each piece of information to the single most appropriate field. Do not duplicate the same content across multiple fields.
5. Keep clinical terms accurate. Do not change the meaning of what was said.
6. Return valid JSON only. No explanations before or after.
`

    const result = await generateJson<TranscriptSections>(
        { system, messages: [{ role: 'user', content: transcriptText }] },
        { tenantId },
    );
    console.log('[transcribe] AI structured result:', result);

    return result;
}
















