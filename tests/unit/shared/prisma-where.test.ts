import { describe, it, expect } from 'vitest';
import { notStartingWith } from '../../../src/shared/prisma-where';

describe('notStartingWith', () => {
  it('keeps the rows where the column is null', () => {
    expect(notStartingWith('transactionId', 'IPDEP:')).toEqual({
      OR: [
        { transactionId: null },
        { NOT: { transactionId: { startsWith: 'IPDEP:' } } },
      ],
    });
  });

  // The whole reason this exists. Written the obvious way the filter compiles
  // to `NOT (col LIKE 'p%')`, which is NULL — not true — on a null column, and
  // Postgres keeps only rows the predicate is TRUE for. On this database that
  // was 60 of 68 payment rows disappearing from a report that looked fine.
  it('is not the plain NOT filter', () => {
    expect(notStartingWith('transactionId', 'IPDEP:')).not.toEqual({
      NOT: { transactionId: { startsWith: 'IPDEP:' } },
    });
  });

  it('works for any column', () => {
    expect(notStartingWith('billNumber', 'ADV-')).toEqual({
      OR: [{ billNumber: null }, { NOT: { billNumber: { startsWith: 'ADV-' } } }],
    });
  });
});
