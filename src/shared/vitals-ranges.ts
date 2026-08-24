// What counts as an abnormal adult vital sign — the SERVER's copy.
//
// Deliberately a mirror of the frontend's `lib/vitals-ranges.ts`, value for
// value. These numbers were re-implemented per screen once before and drifted
// apart in ways that mattered clinically (hypotension and hypothermia read as
// normal on one nurse screen and abnormal on another), so if either side
// changes, change both.
//
// The server needs its own copy because deciding whether a reading is worth
// waking a doctor for is a server decision: the notification is written where
// the vital is saved, not in the browser that happened to type it.
//
// Adult ranges. Paediatric and neonatal thresholds differ by age and are NOT
// modelled here.

export interface VitalRange {
  /** Below this is abnormal. Undefined = no lower bound. */
  low?: number;
  /** Above this is abnormal. Undefined = no upper bound. */
  high?: number;
  unit: string;
  label: string;
}

/** Keyed by the field name on the Vital record. */
export const VITAL_RANGES: Record<string, VitalRange> = {
  bloodPressureSystolic: { low: 90, high: 140, unit: 'mmHg', label: 'BP systolic' },
  bloodPressureDiastolic: { low: 60, high: 90, unit: 'mmHg', label: 'BP diastolic' },
  // Celsius. Values are STORED in °C whatever unit they were typed in.
  temperature: { low: 35, high: 38, unit: '°C', label: 'Temperature' },
  pulseRate: { low: 60, high: 100, unit: 'bpm', label: 'Pulse' },
  respiratoryRate: { low: 12, high: 20, unit: '/min', label: 'Respiratory rate' },
  oxygenSaturation: { low: 94, unit: '%', label: 'SpO₂' },
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** True when the reading falls outside the range for that vital. */
export function isValueAbnormal(key: string, value: unknown): boolean {
  const n = toNumber(value);
  if (n === null) return false;
  const r = VITAL_RANGES[key];
  if (!r) return false;
  if (r.low !== undefined && n < r.low) return true;
  if (r.high !== undefined && n > r.high) return true;
  return false;
}

/**
 * Every out-of-range reading in a set of vitals, worded for a human —
 * `["Pulse 132 bpm (high)", "SpO₂ 88 % (low)"]`. Empty when nothing is out.
 */
export function abnormalFindings(vitals: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, range] of Object.entries(VITAL_RANGES)) {
    const n = toNumber(vitals[key]);
    if (n === null) continue;
    if (range.low !== undefined && n < range.low) {
      out.push(`${range.label} ${n} ${range.unit} (low)`);
    } else if (range.high !== undefined && n > range.high) {
      out.push(`${range.label} ${n} ${range.unit} (high)`);
    }
  }
  return out;
}
