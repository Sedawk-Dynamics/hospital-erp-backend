// ---------------------------------------------------------------------------
// Which 6-digit PINs a patient may not choose. Five guesses per device is only
// a real limit if the PIN is not among the first five anybody would try.
// ---------------------------------------------------------------------------

/** Keyboard walks and favourites the structural rules below do not catch. */
const COMMON = new Set([
  '112358', '123654', '142536', '145236', '147258', '147852', '159357', '159753', '258456',
  '321456', '357159', '456123', '741852', '789456', '852456', '963852', '987456',
]);

function isSequence(pin: string): boolean {
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => (x - d[i] + 10) % 10);
  // 123456, 890123 / 654321, 210987 / 135791, 246802 and their reverses.
  return steps.every((s) => s === steps[0]) && [1, 2, 8, 9].includes(steps[0]);
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** Every 6-digit way of writing a date of birth. `Patient.dateOfBirth` is a date-only column. */
function dobForms(dob: Date): string[] {
  const d = pad(dob.getUTCDate());
  const m = pad(dob.getUTCMonth() + 1);
  const yyyy = pad(dob.getUTCFullYear(), 4);
  const yy = yyyy.slice(2);
  const eight = [`${d}${m}${yyyy}`, `${m}${d}${yyyy}`, `${yyyy}${m}${d}`, `${yyyy}${d}${m}`];
  return [
    `${d}${m}${yy}`, `${m}${d}${yy}`, `${yy}${m}${d}`, `${yy}${d}${m}`,
    `${m}${yyyy}`, `${yyyy}${m}`, `${d}${yyyy}`, `${yyyy}${d}`,
    ...eight.flatMap((e) => [e.slice(0, 6), e.slice(-6)]),
  ];
}

/** Why this PIN is refused, in words for the patient, or null when it is fine. */
export function pinProblem(
  pin: string,
  about: { phones?: (string | null | undefined)[]; datesOfBirth?: (Date | null | undefined)[] } = {},
): string | null {
  if (!/^\d{6}$/.test(pin)) return 'Choose a 6-digit PIN';

  if (new Set(pin).size < 3) return 'This PIN is too easy to guess. Use more different digits.';
  if (isSequence(pin)) return 'This PIN is too easy to guess. Avoid runs like 123456.';
  const [a, b] = [pin.slice(0, 3), pin.slice(3)];
  const pairs = pin.match(/../g)!;
  if (
    a === b || // 123123
    a === [...b].reverse().join('') || // 123321
    pairs.every((p) => p[0] === p[1]) || // 112233
    (pairs[0] === pairs[1] && pairs[1] === pairs[2]) || // 121212
    /^(\d)\1\1(\d)\2\2$/.test(pin) || // 111222
    /(\d)\1{3}/.test(pin) || // 1111xx
    pairs.every((p, i) => Number(p) === Number(pairs[0]) + i) || // 010203, 101112
    (pairs.every((p) => p[1] === '0') && isRun(pairs.map((p) => Number(p[0])))) || // 102030
    COMMON.has(pin)
  ) {
    return 'This PIN is too easy to guess. Avoid repeats and patterns like 123123.';
  }

  for (const phone of about.phones ?? []) {
    const digits = (phone ?? '').replace(/\D/g, '').slice(-10);
    if (digits.length >= 6 && (digits.slice(-6) === pin || digits.slice(0, 6) === pin)) {
      return 'Do not use digits from your phone number as your PIN.';
    }
  }
  for (const dob of about.datesOfBirth ?? []) {
    if (dob && dobForms(dob).includes(pin)) return 'Do not use a date of birth as your PIN.';
  }
  return null;
}

function isRun(n: number[]): boolean {
  const step = n[1] - n[0];
  return Math.abs(step) === 1 && n.slice(1).every((x, i) => x - n[i] === step);
}
