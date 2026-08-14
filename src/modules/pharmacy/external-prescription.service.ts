import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { getPaginationParams } from '../../shared/pagination';
import { callGeminiVision } from '../../services/gemini-vision';

// ============================================================
// Outside (paper) prescriptions presented at the pharmacy counter
// ============================================================
// A walk-in arrives holding a prescription written somewhere else. There is no
// in-system Prescription to point at, so the counter captures the paper one:
// the prescriber, their council registration number, the date, and a photo of
// the slip.
//
// This exists BEFORE any schedule is enforced, deliberately. The day a
// Schedule H/H1/X sale starts requiring a prescription, a customer holding a
// valid paper Rx must already have a lawful path through the counter —
// otherwise switching enforcement on would block legitimate sales.

/** Statutory retention, in years, by the strictest schedule on the sale. */
const RETENTION_YEARS: Record<string, number> = {
  // Rule 65(9): a Schedule X prescription copy is retained for two years.
  X: 2,
  // Rule 65(11A): the Schedule H1 register runs for three years.
  H1: 3,
  H: 2,
};

/**
 * How long this prescription must be kept. Defaults to the longest ordinary
 * period so a record is never destroyed too early because a schedule was not
 * passed in.
 */
export function computeRetainUntil(schedules: string[] = [], from = new Date()): Date {
  const years = Math.max(3, ...schedules.map((s) => RETENTION_YEARS[s] ?? 0));
  const d = new Date(from);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

export interface CreateExternalPrescriptionData {
  patientId?: string | null;
  patientNameRaw?: string | null;
  patientAge?: number | null;
  patientSex?: string | null;
  patientAddress?: string | null;
  prescriberName: string;
  prescriberRegNo?: string | null;
  prescriberQualification?: string | null;
  hospitalName?: string | null;
  prescribedDate?: string | null;
  imageUrl?: string | null;
  ocrJson?: unknown;
  notes?: string | null;
  /** Schedules present on the cart, so retention matches the strictest one. */
  schedules?: string[];
}

export async function createExternalPrescription(
  tenantId: string,
  userId: string,
  data: CreateExternalPrescriptionData,
) {
  const prescriberName = data.prescriberName?.trim();
  if (!prescriberName) {
    throw AppError.badRequest("The prescriber's name is required to record an outside prescription.");
  }

  // A named patient must belong to this hospital. A walk-in has no patientId and
  // is identified by the raw name captured off the slip.
  if (data.patientId) {
    const patient = await prisma.patient.findFirst({
      where: { id: data.patientId, tenantId },
      select: { id: true },
    });
    if (!patient) throw AppError.notFound('Patient not found');
  }

  const created = await prisma.externalPrescription.create({
    data: {
      tenantId,
      patientId: data.patientId ?? null,
      patientNameRaw: data.patientNameRaw?.trim() || null,
      patientAge: data.patientAge ?? null,
      patientSex: data.patientSex?.trim() || null,
      patientAddress: data.patientAddress?.trim() || null,
      prescriberName,
      prescriberRegNo: data.prescriberRegNo?.trim() || null,
      prescriberQualification: data.prescriberQualification?.trim() || null,
      hospitalName: data.hospitalName?.trim() || null,
      prescribedDate: data.prescribedDate ? new Date(data.prescribedDate) : null,
      imageUrl: data.imageUrl ?? null,
      ocrJson: (data.ocrJson ?? undefined) as never,
      notes: data.notes?.trim() || null,
      capturedById: userId,
      retainUntil: computeRetainUntil(data.schedules ?? []),
    },
  });

  logger.info(
    { tenantId, externalPrescriptionId: created.id, prescriber: prescriberName },
    'Outside prescription captured at the pharmacy counter',
  );
  return created;
}

export async function getExternalPrescription(tenantId: string, id: string) {
  const row = await prisma.externalPrescription.findFirst({
    where: { id, tenantId },
    include: {
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
    },
  });
  if (!row) throw AppError.notFound('Outside prescription not found');
  return row;
}

export async function listExternalPrescriptions(
  tenantId: string,
  query: { patientId?: string; search?: string; page?: number; limit?: number } = {},
) {
  const { skip, take, page, limit } = getPaginationParams(query as never);
  const where: Record<string, unknown> = { tenantId };
  if (query.patientId) where.patientId = query.patientId;
  if (query.search?.trim()) {
    const q = query.search.trim();
    where.OR = [
      { prescriberName: { contains: q, mode: 'insensitive' } },
      { prescriberRegNo: { contains: q, mode: 'insensitive' } },
      { patientNameRaw: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.externalPrescription.findMany({
      where: where as never,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: { patient: { select: { id: true, mrn: true, firstName: true, lastName: true } } },
    }),
    prisma.externalPrescription.count({ where: where as never }),
  ]);
  return { items, total, page, limit };
}

// ── OCR ─────────────────────────────────────────────────────
// Reads a photo of the slip and pre-fills the form. It is a TYPING AID, never a
// source of truth: the counter operator confirms every field before the record
// is created, because a mis-read registration number would make the statutory
// register wrong.

export interface OcrPrescriptionResult {
  model: string;
  patientName: string | null;
  patientAge: number | null;
  patientSex: string | null;
  patientAddress: string | null;
  prescriberName: string | null;
  prescriberRegNo: string | null;
  prescriberQualification: string | null;
  hospitalName: string | null;
  prescribedDate: string | null;
  /** Free-text medicine lines, shown to the operator to check against the cart. */
  medicines: string[];
  warnings: string[];
}

function buildPrescriptionPrompt(): string {
  return [
    'You are a data-entry assistant at a pharmacy counter in India. You are given a photo or scan of a DOCTOR\'S PRESCRIPTION.',
    'Read it and extract the prescriber, the patient and the medicines listed.',
    '',
    'Rules:',
    '- Extract ONLY what is written. Never invent or complete a value. If a field is absent or unreadable, use null.',
    '- prescriberName: the doctor\'s name, without the "Dr." title.',
    '- prescriberRegNo: the medical council registration number. Indian prescriptions print it as "Reg. No.", "NMC", "MCI" or a state council number. Return the digits and any letters exactly as printed, with no prefix.',
    '- prescriberQualification: e.g. "MBBS, MD", if printed.',
    '- hospitalName: the clinic or hospital on the letterhead.',
    '- prescribedDate: ISO "YYYY-MM-DD". Indian prescriptions usually write dd/mm/yyyy — convert accordingly.',
    '- patientAge: a whole number of years only. If the age is in months, convert and round down; if under one year, use 0.',
    '- patientSex: exactly "male", "female" or "other", else null.',
    '- medicines: one string per prescribed line, as written, including strength and dosage if present.',
    '',
    'Return ONLY a JSON object with this exact shape (no prose, no markdown):',
    '{',
    '  "patientName": string|null, "patientAge": number|null, "patientSex": string|null, "patientAddress": string|null,',
    '  "prescriberName": string|null, "prescriberRegNo": string|null, "prescriberQualification": string|null,',
    '  "hospitalName": string|null, "prescribedDate": string|null, "medicines": string[]',
    '}',
    'If the image is not a medical prescription, return every field as null with an empty medicines array.',
  ].join('\n');
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
};

const int = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 && n < 130 ? Math.trunc(n) : null;
};

/** dd/mm/yyyy and friends → ISO. Anything unrecognised becomes null. */
export function normalizePrescribedDate(raw: unknown): string | null {
  const s = str(raw);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const dd = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  let yy = Number.parseInt(m[3], 10);
  if (m[3].length === 2) yy = yy <= 70 ? 2000 + yy : 1900 + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export function parsePrescriptionJson(text: string): Omit<OcrPrescriptionResult, 'model' | 'warnings'> {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error('No JSON object found in OCR response');
  const obj = JSON.parse(match[0]) as Record<string, unknown>;
  const meds = Array.isArray(obj.medicines) ? obj.medicines : [];
  const sex = str(obj.patientSex)?.toLowerCase();
  return {
    patientName: str(obj.patientName),
    patientAge: int(obj.patientAge),
    patientSex: sex === 'male' || sex === 'female' || sex === 'other' ? sex : null,
    patientAddress: str(obj.patientAddress),
    prescriberName: str(obj.prescriberName),
    // Strip a leading label the model sometimes keeps, along with whatever
    // separator followed it — prescriptions print "Reg. No. 12345", "NMC-9875"
    // and "MCI: 999" interchangeably, and a stray hyphen would corrupt the
    // number the statutory register is keyed on.
    prescriberRegNo: str(obj.prescriberRegNo)?.replace(/^(reg\.?\s*no\.?|nmc|mci)[\s:.\-–]*/i, '') || null,
    prescriberQualification: str(obj.prescriberQualification),
    hospitalName: str(obj.hospitalName),
    prescribedDate: normalizePrescribedDate(obj.prescribedDate),
    medicines: meds.map((m) => str(m)).filter((m): m is string => !!m),
  };
}

export async function parsePrescriptionFile(file: {
  path: string;
  mimetype: string;
  originalname?: string;
}): Promise<OcrPrescriptionResult> {
  const { text, model } = await callGeminiVision({
    prompt: buildPrescriptionPrompt(),
    file,
    feature: 'Prescription OCR',
    fallbackHint: 'You can still type the prescriber details in by hand.',
  });

  let parsed: Omit<OcrPrescriptionResult, 'model' | 'warnings'>;
  try {
    parsed = parsePrescriptionJson(text);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, preview: text.slice(0, 200) },
      'Failed to parse prescription OCR result',
    );
    throw AppError.badRequest(
      'Could not read that prescription. Try a clearer photo, or type the details in by hand.',
    );
  }

  const warnings: string[] = [];
  // The registration number is what makes a prescription verifiable, and it is
  // the field the statutory register needs, so its absence is worth saying out
  // loud rather than leaving as a quietly empty box.
  if (!parsed.prescriberRegNo) {
    warnings.push("The prescriber's registration number could not be read — please enter it.");
  }
  if (!parsed.prescriberName) {
    warnings.push("The prescriber's name could not be read — please enter it.");
  }
  if (!parsed.prescribedDate) {
    warnings.push('The prescription date could not be read.');
  }

  return { model, warnings, ...parsed };
}
