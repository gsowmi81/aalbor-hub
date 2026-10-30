import { describe, expect, it } from 'vitest';
import { Calendar, fmtLong, mondayOf, todaySydney } from '../src/domain/dates.js';
import { DEFAULT_RULES, proposeDates, shiftStep, siteStartFromJobNumber } from '../src/domain/steps.js';

const NSW_2027 = [
  { day: '2027-01-01', scope: 'all' as const, reason: "New Year's Day" },
  { day: '2027-01-26', scope: 'all' as const, reason: 'Australia Day' },
  { day: '2027-03-26', scope: 'all' as const, reason: 'Good Friday' },
  { day: '2027-03-29', scope: 'all' as const, reason: 'Easter Monday' },
];

function byKind(rows: ReturnType<typeof proposeDates>) {
  return Object.fromEntries(rows.map((r) => [r.kind, r.end_date ? `${r.start_date}..${r.end_date}` : r.start_date]));
}

describe('working days', () => {
  const cal = new Calendar(NSW_2027);
  it('skips weekends and public holidays', () => {
    expect(cal.addWorkingDays('2027-01-22', 1)).toBe('2027-01-25'); // Fri to Mon
    expect(cal.addWorkingDays('2027-01-25', 1)).toBe('2027-01-27'); // over Australia Day
    expect(cal.addWorkingDays('2027-01-27', -1)).toBe('2027-01-25');
    expect(cal.onOrAfter('2027-01-23')).toBe('2027-01-25');
  });
  it('lets factory-blocked days stop factory steps only', () => {
    const c = new Calendar([{ day: '2027-02-17', scope: 'factory', reason: 'Clean-out' }]);
    expect(c.isWorkingDay('2027-02-17')).toBe(true);
    expect(c.isWorkingDay('2027-02-17', 'factory')).toBe(false);
    expect(c.addWorkingDays('2027-02-16', 1, 'factory')).toBe('2027-02-18');
  });
  it('counts working days between dates', () => {
    expect(cal.workingDaysBetween('2027-02-01', '2027-02-08')).toBe(5);
    expect(cal.workingDaysBetween('2027-02-08', '2027-02-01')).toBe(-5);
  });
  it('formats dates the house way', () => {
    expect(fmtLong('2027-02-04')).toBe('04 Feb 2027');
    expect(mondayOf('2027-02-07')).toBe('2027-02-01');
  });
  it('knows the date in Sydney', () => {
    expect(todaySydney(new Date('2026-10-28T14:30:00Z'))).toBe('2026-10-29');
  });
});

describe('proposed dates: the worked example in the approved build plan', () => {
  const cal = new Calendar(NSW_2027);
  const base = { added_on: '2026-10-28', site_start: '2027-02-01', has_painting: false, has_stone: true, factory_days: 2, install_days: 3 };

  it('melamine job 270201', () => {
    expect(byKind(proposeDates({ ...base, door_finish: 'melamine' }, DEFAULT_RULES, cal))).toEqual({
      contract_drafting: '2026-10-28..2026-11-03',
      check_measure: '2027-02-04',
      production_drawings: '2027-02-05..2027-02-11',
      materials_ordered: '2027-02-11',
      materials_in: '2027-02-16',
      factory: '2027-02-17..2027-02-18',
      delivery: '2027-02-26',
      install: '2027-03-01..2027-03-03',
      stone_measure: '2027-03-04',
      stone_install: '2027-03-11',
    });
  });

  it('polyurethane job 270201', () => {
    const p = byKind(proposeDates({ ...base, door_finish: 'polyurethane', has_painting: true }, DEFAULT_RULES, cal));
    expect(p.doors_to_painting).toBe('2027-02-19');
    expect(p.doors_back).toBe('2027-03-05');
    expect(p.delivery).toBe('2027-03-05');
    expect(p.install).toBe('2027-03-08..2027-03-10');
  });

  it('leaves painting off a job that does not need it, whatever the door finish', () => {
    const p = byKind(proposeDates({ ...base, door_finish: 'polyurethane', has_painting: false }, DEFAULT_RULES, cal));
    expect(p.doors_to_painting).toBeUndefined();
    expect(p.doors_back).toBeUndefined();
    expect(p.install).toBe('2027-03-01..2027-03-03');
  });

  it('leaves stone off a job without stone', () => {
    const p = byKind(proposeDates({ ...base, has_stone: false, door_finish: 'melamine' }, DEFAULT_RULES, cal));
    expect(p.stone_measure).toBeUndefined();
    expect(p.stone_install).toBeUndefined();
  });

  it('uses the job factory and install days', () => {
    const p = byKind(proposeDates({ ...base, factory_days: 4, install_days: 5, door_finish: 'melamine' }, DEFAULT_RULES, cal));
    expect(p.factory).toBe('2027-02-17..2027-02-22');
    expect(p.install).toBe('2027-03-01..2027-03-05');
  });

  it('pushes past Easter', () => {
    // Install target Mon 29 Mar 2027 is Easter Monday, so install starts Tue 30 Mar.
    const p = byKind(proposeDates({ ...base, site_start: '2027-03-01', door_finish: 'melamine' }, DEFAULT_RULES, cal));
    expect(p.install).toBe('2027-03-30..2027-04-01');
    expect(p.delivery).toBe('2027-03-25');
  });
});

describe('shift', () => {
  const cal = new Calendar(NSW_2027);
  it('moves a range by working days and keeps its length', () => {
    expect(shiftStep({ kind: 'install', start_date: '2027-03-01', end_date: '2027-03-03' }, 5, cal)).toEqual({
      start_date: '2027-03-08', end_date: '2027-03-10',
    });
    expect(shiftStep({ kind: 'install', start_date: '2027-02-26', end_date: '2027-03-02' }, 1, cal)).toEqual({
      start_date: '2027-03-01', end_date: '2027-03-03',
    });
  });
  it('moves back one day over a weekend', () => {
    expect(shiftStep({ kind: 'check_measure', start_date: '2027-02-08', end_date: null }, -1, cal)).toEqual({
      start_date: '2027-02-05', end_date: null,
    });
  });
});

describe('job number', () => {
  it('gives the site start', () => {
    expect(siteStartFromJobNumber('261110')).toBe('2026-11-10');
    expect(siteStartFromJobNumber('270201')).toBe('2027-02-01');
    expect(siteStartFromJobNumber('W2')).toBeNull();
    expect(siteStartFromJobNumber('261332')).toBeNull();
    expect(siteStartFromJobNumber('260230')).toBeNull();
  });
});
