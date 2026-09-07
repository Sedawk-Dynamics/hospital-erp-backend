// ---------------------------------------------------------------------------
// Prisma `where` fragments for the traps that do not look like traps.
// ---------------------------------------------------------------------------

/**
 * "This column does not start with `prefix`" — INCLUDING the rows where it is
 * null.
 *
 * `NOT: { col: { startsWith: p } }` and `col: { not: { startsWith: p } }` both
 * compile to `NOT (col LIKE 'p%')`, and in SQL that is NULL — not true — when
 * the column is null. Postgres keeps only rows where the predicate is TRUE, so
 * every null-valued row silently vanishes from the result.
 *
 * On a nullable column that is nearly always the wrong answer, and it is
 * invisible: the query runs, returns rows, and is simply missing most of them.
 * Measured on this database, 60 of 68 payments carry no transactionId — an
 * exclusion written the obvious way returned 5 rows where it should return 65.
 *
 * Spreads into a `where`, so it collides with an existing top-level `OR`. Put
 * it under `AND` if the query already has one.
 */
export function notStartingWith(field: string, prefix: string): Record<string, unknown> {
  return {
    OR: [{ [field]: null }, { NOT: { [field]: { startsWith: prefix } } }],
  };
}
