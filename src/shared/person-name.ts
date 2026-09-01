/**
 * Joining a person's name parts, without printing the word "null".
 *
 * `` `${firstName} ${lastName}` `` is the obvious thing to write and it is
 * wrong whenever a last name is missing: a template literal stringifies null,
 * so the screen reads "Walkin null" — which looks like corrupted data rather
 * than an absent surname. `.trim()` does not help, because the "null" lands in
 * the middle.
 *
 * A missing last name is NORMAL here, not an edge case. Every temporary patient
 * is created with only a first name — that is the whole point of the temporary
 * patient flow, where somebody arrives unable to give their details. Eight of
 * the development hospital's patients are in that state.
 *
 * The frontend has the same helper at `src/lib/person-name.ts`; this is its
 * counterpart for everything the server writes itself — notification and
 * reminder text, audit descriptions, PDF fields, and any name the API composes
 * rather than passing through as parts.
 */

/** A person's parts, however the caller's query happens to select them. */
export interface NameParts {
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * "Asha Menon", or "Walkin" when there is no surname.
 *
 * @param fallback what to return when there is no name at all — a message or a
 *                 report row still needs something to render, and an empty
 *                 string reads as missing data.
 */
export function fullName(person: NameParts | null | undefined, fallback = ''): string {
  if (!person) return fallback;
  const parts = [person.firstName, person.lastName]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean);
  return parts.length ? parts.join(' ') : fallback;
}

/**
 * The same, prefixed for a clinician — "Dr. Asha Menon".
 *
 * The prefix is dropped along with the name when there is nobody, so a caller
 * never renders a bare "Dr.".
 */
export function doctorName(person: NameParts | null | undefined, fallback = ''): string {
  const name = fullName(person);
  return name ? `Dr. ${name}` : fallback;
}
