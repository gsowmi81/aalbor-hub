import { describe, expect, it } from 'vitest';
import { Calendar } from '../src/domain/dates.js';
import { DEFAULT_RULES, proposeDates, StepKind } from '../src/domain/steps.js';
import { applyChanges, PlanRow, proposeFromAnchor, reschedule, violations } from '../src/domain/schedule.js';

const cal = new Calendar([]);
const job = { added_on: '2026-10-28', site_start: '2027-02-01', door_finish: 'melamine' as const, has_painting: false, has_stone: true, factory_days: 2, install_days: 3 };

/** The plan's worked example (melamine job 270201) as rows. */
function plan(over: Partial<typeof job> = {}): PlanRow[] {
  return proposeDates({ ...job, ...over }, DEFAULT_RULES, cal).map((p, i) => ({
    id: i + 1, kind: p.kind, label: '', start_date: p.start_date, end_date: p.end_date, done: false, confirmed: true,
  }));
}
const dates = (rows: PlanRow[]) => Object.fromEntries(rows.map((r) => [r.kind, r.end_date ? `${r.start_date}..${r.end_date}` : r.start_date]));
const idOf = (rows: PlanRow[], k: StepKind) => rows.find((r) => r.kind === k)!.id;

describe('dependencies', () => {
  it('a proposed job breaks none', () => {
    expect(violations(plan(), cal)).toEqual([]);
    expect(violations(plan({ has_painting: true, door_finish: 'polyurethane' } as never), cal)).toEqual([]);
  });
  it('catches delivery before the factory finishes', () => {
    const rows = plan().map((r) => (r.kind === 'delivery' ? { ...r, start_date: '2027-02-17' } : r));
    const v = violations(rows, cal).filter((x) => x.dep.hard);
    expect(v.map((x) => `${x.pred.kind}>${x.succ.kind}`)).toEqual(['factory>delivery']);
    expect(v[0].earliest).toBe('2027-02-18');
  });
  it('lets delivery and install be on the same day, but stone measure only after install', () => {
    const rows = plan().map((r) => (r.kind === 'delivery' ? { ...r, start_date: '2027-03-01' } : r.kind === 'stone_measure' ? { ...r, start_date: '2027-03-03' } : r));
    expect(violations(rows, cal).map((x) => x.succ.kind)).toEqual(['stone_measure']);
  });
  it('ignores steps already done', () => {
    const rows = plan().map((r) => (r.kind === 'delivery' ? { ...r, start_date: '2027-02-01', done: true } : r));
    expect(violations(rows, cal)).toEqual([]);
  });
});

describe('reschedule', () => {
  it('moves everything after production drawings by the same working days (the default)', () => {
    const rows = plan();
    const next = applyChanges(rows, reschedule(rows, idOf(rows, 'production_drawings'), '2027-02-08', null, 'shift', cal));
    expect(dates(next)).toMatchObject({
      check_measure: '2027-02-04',
      production_drawings: '2027-02-08..2027-02-12',
      materials_ordered: '2027-02-12',
      factory: '2027-02-18..2027-02-19',
      delivery: '2027-03-01',
      install: '2027-03-02..2027-03-04',
      stone_install: '2027-03-12',
    });
  });

  it('squeezes the steps before install to keep the install date', () => {
    const rows = plan();
    const next = applyChanges(rows, reschedule(rows, idOf(rows, 'production_drawings'), '2027-02-08', null, 'squeeze', cal));
    const d = dates(next);
    expect(d.install).toBe('2027-03-01..2027-03-03');
    expect(d.delivery).toBe('2027-02-26');
    expect(d.materials_ordered).toBe('2027-02-11'); // soft rule: not pushed
    expect(d.materials_in).toBe('2027-02-16'); // still after ordering, so it stays
    expect(d.factory).toBe('2027-02-17..2027-02-18');
    expect(violations(next, cal).filter((v) => v.dep.hard)).toEqual([]);
  });

  it('uses spare days first: materials in on Fri 26 Feb still keeps install on Mon 01 Mar', () => {
    const rows = plan();
    const next = applyChanges(rows, reschedule(rows, idOf(rows, 'materials_in'), '2027-02-26', null, 'squeeze', cal));
    expect(dates(next)).toMatchObject({ factory: '2027-02-26..2027-03-01', delivery: '2027-03-01', install: '2027-03-01..2027-03-03' });
    expect(violations(next, cal).filter((v) => v.dep.hard)).toEqual([]);
  });

  it('says when squeezing still cannot keep the install date', () => {
    const rows = plan();
    // Materials in on Mon 01 Mar: factory 01 to 02 Mar, so delivery can't be before Tue 02 Mar.
    const next = applyChanges(rows, reschedule(rows, idOf(rows, 'materials_in'), '2027-03-01', null, 'squeeze', cal));
    const v = violations(next, cal).filter((x) => x.dep.hard).map((x) => `${x.pred.kind}>${x.succ.kind}`);
    expect(dates(next).install).toBe('2027-03-01..2027-03-03');
    expect(v).toContain('delivery>install');
  });

  it('moves delivery with install, and stone after it', () => {
    const rows = plan();
    const next = applyChanges(rows, reschedule(rows, idOf(rows, 'install'), '2027-03-08', null, 'shift', cal));
    expect(dates(next)).toMatchObject({ delivery: '2027-03-05', install: '2027-03-08..2027-03-10', stone_measure: '2027-03-11', factory: '2027-02-17..2027-02-18' });
  });

  it('moves only the one step when asked, and never moves steps already done', () => {
    const rows = plan().map((r) => (r.kind === 'factory' ? { ...r, done: true } : r));
    expect(reschedule(rows, idOf(rows, 'check_measure'), '2027-02-05', null, 'only', cal)).toHaveLength(1);
    const ch = reschedule(rows, idOf(rows, 'check_measure'), '2027-02-05', null, 'shift', cal);
    expect(ch.find((c) => c.id === idOf(rows, 'factory'))).toBeUndefined();
  });
});

describe('templates: propose from the one date you know', () => {
  const tpl = { ...job, site_start: null, install_weeks: 4 };
  it('from site start matches the worked example', () => {
    const p = proposeFromAnchor({ ...tpl, site_start: null }, 'site_start', '2027-02-01', DEFAULT_RULES, cal);
    expect(p.steps.find((s) => s.kind === 'install')).toMatchObject({ start_date: '2027-03-01', end_date: '2027-03-03' });
  });
  it('from the check measure date works out site start and the rest', () => {
    const p = proposeFromAnchor(tpl, 'check_measure', '2027-02-04', DEFAULT_RULES, cal);
    expect(p.site_start).toBe('2027-02-01');
    expect(p.steps.find((s) => s.kind === 'check_measure')!.start_date).toBe('2027-02-04');
    expect(p.steps.find((s) => s.kind === 'install')!.start_date).toBe('2027-03-01');
  });
  it('from the install date keeps install on that day', () => {
    const p = proposeFromAnchor(tpl, 'install', '2027-03-10', DEFAULT_RULES, cal);
    expect(p.steps.find((s) => s.kind === 'install')).toMatchObject({ start_date: '2027-03-10', end_date: '2027-03-12' });
    expect(p.steps.find((s) => s.kind === 'delivery')!.start_date).toBe('2027-03-09');
    const rows = p.steps.map((s, i) => ({ id: i, kind: s.kind, label: '', start_date: s.start_date, end_date: s.end_date, done: false, confirmed: false }));
    expect(violations(rows, cal).filter((v) => v.dep.hard)).toEqual([]);
  });
});
