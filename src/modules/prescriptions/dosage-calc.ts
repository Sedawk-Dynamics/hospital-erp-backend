/**
 * Dosage → quantity calculation.
 *
 * Doctors prescribe using the Indian "M-A-N" notation (Morning-Afternoon-Night),
 * e.g. `1-1-1` means one unit at each of the three times of day. Combined with a
 * duration ("3 days") this lets us derive the *total number of units* the patient
 * needs to finish the course — `(1+1+1) × 3 = 9 tablets` — which is exactly the
 * quantity the pharmacist must dispense and bill.
 *
 * The same logic also runs on the frontend (`frontend/src/lib/dosage-calc.ts`);
 * keep the two in sync. We compute server-side as well so the stored
 * `PrescriptionItem.quantity` is always populated even for prescriptions created
 * outside the doctor UI (raw API, imports, etc.) — the pharmacy queue depends on
 * it.
 *
 * Frequency strings reach the DB already "encoded" by the doctor UI, so this
 * parser tolerates the timing suffix the UI appends:
 *   "1-1-1 - After Meal" | "0-1-0" | "1/2-0-1/2" | "Stat" | "As Needed (SOS)"
 */

/** Parse a single dose slot — a plain number ("1", "2") or a fraction ("1/2"). */
function parseDoseToken(token: string): number | null {
  const t = token.trim();
  if (!t) return 0; // empty slot counts as zero doses
  const frac = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const denom = Number(frac[2]);
    return denom === 0 ? null : Number(frac[1]) / denom;
  }
  if (/^\d*\.?\d+$/.test(t)) return Number(t);
  return null; // non-numeric token → not an M-A-N pattern
}

/**
 * Total doses-per-day implied by a frequency string.
 *  - `1-1-1`            → 3
 *  - `1/2-0-1/2`        → 1
 *  - `Stat`             → 1  (single immediate dose)
 *  - `SOS` / As Needed  → null (PRN — quantity can't be derived)
 *  - `BD`, `Q6H`, …     → null (not an M-A-N pattern we can sum)
 */
export function parseFrequencyPerDay(frequency?: string | null): number | null {
  if (!frequency) return null;
  const raw = frequency.trim();
  const lower = raw.toLowerCase();

  // PRN / as-needed has no fixed daily count.
  if (lower.includes('sos') || lower.includes('as needed') || lower.includes('prn')) {
    return null;
  }
  // A single stat dose.
  if (lower === 'stat') return 1;

  // Strip any " - After Meal" style timing suffix the UI appends.
  const code = raw.split(' - ')[0].trim();
  const segments = code.split('-');
  // A real M-A-N pattern has at least two slots; a bare token like "BD" does not.
  if (segments.length < 2) return null;

  let sum = 0;
  for (const seg of segments) {
    const val = parseDoseToken(seg);
    if (val === null) return null; // any non-numeric slot → bail out
    sum += val;
  }
  return sum > 0 ? sum : null;
}

/**
 * Number of days a duration string represents.
 *  - "7 days" → 7 | "2 weeks" → 14 | "1 month" → 30 | "5" → 5 (assumes days)
 */
export function parseDurationDays(duration?: string | null): number | null {
  if (!duration) return null;
  const m = String(duration)
    .trim()
    .toLowerCase()
    .match(/(\d*\.?\d+)\s*(day|week|month|year)?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? 'day';
  const mult = unit.startsWith('week')
    ? 7
    : unit.startsWith('month')
      ? 30
      : unit.startsWith('year')
        ? 365
        : 1;
  return n * mult;
}

/**
 * Total units to dispense for a course, or `null` when it can't be derived
 * (PRN frequency, non-numeric pattern, or missing/zero duration).
 *
 * Rounds *up* — a patient must have enough to finish the course, and you can't
 * dispense a fraction of a tablet.
 */
export function calcDispenseQuantity(
  frequency?: string | null,
  duration?: string | null,
): number | null {
  const perDay = parseFrequencyPerDay(frequency);
  const days = parseDurationDays(duration);
  if (perDay === null || days === null) return null;
  const total = Math.ceil(perDay * days);
  return total > 0 ? total : null;
}
