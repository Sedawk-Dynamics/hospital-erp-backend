import { describe, it, expect } from 'vitest';
import {
  istDayRange,
  istDayStart,
  istDayEnd,
  getISTDateStr,
  istDayNumber,
  istDateStr,
  istMinutesOfDay,
  isFutureISTDate,
  toEventInstant,
  formatIST,
} from '../../../src/shared/date.utils';

// The hospital runs on IST. Every "today's collection", "day end" and
// "receipts between these dates" query depends on turning a date string into
// the right pair of UTC instants — and getting it wrong is silent: the query
// succeeds and simply returns nothing.

describe('istDayRange', () => {
  // 10 Aug 2026 in IST is 09 Aug 18:30 UTC → 10 Aug 18:29:59.999 UTC.
  const START = '2026-08-09T18:30:00.000Z';
  const END = '2026-08-10T18:29:59.999Z';

  it('spans a whole IST day, not a single instant', () => {
    const { start, end } = istDayRange('2026-08-10');

    expect(start.toISOString()).toBe(START);
    expect(end.toISOString()).toBe(END);

    // The bug this exists to prevent: `new Date('2026-08-10')` for BOTH ends
    // made the range one millisecond wide, so the Cash Counter — which asks for
    // startDate === endDate === today every time it loads — reported zero
    // collection all day long.
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it('accepts the compact YYYYMMDD that getISTDateStr returns', () => {
    // Day End defaults its date to getISTDateStr(). Built by hand as
    // `${dateStr}T00:00:00.000+05:30` that string is an Invalid Date, so any
    // caller omitting the date got a broken query.
    expect(new Date(`${getISTDateStr()}T00:00:00.000+05:30`).getTime()).toBeNaN();

    const { start, end } = istDayRange('20260810');
    expect(start.toISOString()).toBe(START);
    expect(end.toISOString()).toBe(END);
  });

  it('reads the IST calendar date out of a full timestamp', () => {
    // 19:45 UTC is already 01:15 the next morning in IST, so this timestamp
    // belongs to 11 Aug — not to the 10 Aug sitting in its prefix.
    const { start } = istDayRange('2026-08-10T19:45:00.000Z');
    expect(start.toISOString()).toBe('2026-08-10T18:30:00.000Z');

    // Before 18:30 UTC the two agree.
    expect(istDayRange('2026-08-10T06:00:00.000Z').start.toISOString()).toBe(START);
  });

  it('falls back to today rather than to an empty range', () => {
    for (const bad of ['', 'not-a-date', '2026-13-45']) {
      const { start, end } = istDayRange(bad);
      expect(start.getTime()).not.toBeNaN();
      expect(end.getTime()).not.toBeNaN();
      expect(istDayNumber(start)).toBe(istDayNumber(new Date()));
    }
  });

  it('bounds today when given no argument', () => {
    const { start, end } = istDayRange();
    const now = new Date();
    expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(end.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(istDayNumber(start)).toBe(istDayNumber(now));
  });

  it('exposes the same bounds through the single-sided helpers', () => {
    // getBills / getPayments / listReceipts take fromDate and toDate
    // independently, so each end has to be correct on its own. Using the naive
    // parse as an `lte` cut the chosen end date off the results entirely.
    expect(istDayStart('2026-08-10').toISOString()).toBe(START);
    expect(istDayEnd('2026-08-10').toISOString()).toBe(END);
  });

  it('covers an instant late in the IST evening', () => {
    // 23:30 IST on 10 Aug is 18:00 UTC on 10 Aug — inside the day's range, and
    // the case the naive `lte: new Date('2026-08-10')` dropped.
    const lateEvening = new Date('2026-08-10T18:00:00.000Z');
    const { start, end } = istDayRange('2026-08-10');

    expect(lateEvening.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(lateEvening.getTime()).toBeLessThanOrEqual(end.getTime());
    expect(new Date('2026-08-10').getTime()).toBeLessThan(lateEvening.getTime());
  });
});

// ── Time-zone helpers (gaps 329 / 330 / 342 / 362) ─────────────────────────

describe('istDateStr / istMinutesOfDay', () => {
  it('gives the IST calendar date of an instant', () => {
    // 19:00 UTC on the 19th is 00:30 IST on the 20th.
    expect(istDateStr(new Date('2026-11-19T19:00:00.000Z'))).toBe('2026-11-20');
    expect(istDateStr(new Date('2026-11-19T08:00:00.000Z'))).toBe('2026-11-19');
    expect(istDateStr('2026-11-19')).toBe('2026-11-19');
  });

  it('counts minutes from IST midnight', () => {
    expect(istMinutesOfDay(new Date('2026-11-19T08:00:00.000Z'))).toBe(13 * 60 + 30);
    expect(istMinutesOfDay(new Date('2026-11-19T18:30:00.000Z'))).toBe(0);
  });
});

describe('isFutureISTDate (date-of-birth guard)', () => {
  const now = new Date('2026-11-19T08:00:00.000Z');
  it('rejects a date after today', () => {
    expect(isFutureISTDate('2030-01-01', now)).toBe(true);
    expect(isFutureISTDate('2026-11-20', now)).toBe(true);
  });
  it('accepts today (a newborn) and earlier', () => {
    expect(isFutureISTDate('2026-11-19', now)).toBe(false);
    expect(isFutureISTDate('1990-05-01', now)).toBe(false);
  });
  it('uses the IST date, which is a day ahead of UTC after 18:30 UTC', () => {
    const lateUtc = new Date('2026-11-19T19:00:00.000Z'); // 20 Nov in IST
    expect(isFutureISTDate('2026-11-20', lateUtc)).toBe(false);
  });
  it('leaves unparseable input to the format validator', () => {
    expect(isFutureISTDate('not-a-date', now)).toBe(false);
  });
});

describe('toEventInstant (admission / discharge times)', () => {
  const now = new Date('2026-11-19T08:10:00.000Z'); // 13:40 IST

  it('turns a date-only value for today into now, not 05:30 IST', () => {
    expect(toEventInstant('2026-11-19', now)).toEqual(now);
    // What `new Date('2026-11-19').toISOString()` sends.
    expect(toEventInstant('2026-11-19T00:00:00.000Z', now)).toEqual(now);
  });

  it('turns a date-only value for another day into that IST day start', () => {
    expect(toEventInstant('2026-11-17', now).toISOString()).toBe('2026-11-16T18:30:00.000Z');
  });

  it('keeps a real timestamp exactly and defaults to now', () => {
    expect(toEventInstant('2026-11-19T06:15:00.000Z', now).toISOString()).toBe('2026-11-19T06:15:00.000Z');
    expect(toEventInstant(undefined, now)).toEqual(now);
    expect(toEventInstant('', now)).toEqual(now);
  });
});

describe('formatIST (PDF timestamps)', () => {
  it('prints hospital time whatever the host zone', () => {
    // 08:04 UTC is 13:34 IST — the PDF used to print 8:04 am.
    const out = formatIST(new Date('2026-11-19T08:04:00.000Z'), { hour: '2-digit', minute: '2-digit', hour12: false });
    expect(out).toBe('13:34');
  });
});
