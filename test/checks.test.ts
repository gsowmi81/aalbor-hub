import { describe, expect, it } from 'vitest';
import { Calendar } from '../src/domain/dates.js';
import { capacity, JobRow, needsDecision, overdue, StepRow } from '../src/domain/checks.js';
import { DEFAULT_RULES, StepKind } from '../src/domain/steps.js';

const cal = new Calendar([]);
const TODAY = '2026-10-28';

function job(id: number, over: Partial<JobRow> = {}): JobRow {
  return {
    id, job_number: null, brand: 'Aalbor', client_name: `Client ${id}`, suburb: 'Botany', door_finish: 'melamine', has_painting: false,
    has_stone: true, site_start: '2026-10-20', factory_days: 2, install_days: 3, status: 'live', at_risk: false, ...over,
  };
}
let nextId = 1;
function step(jobId: number, kind: StepKind, start: string | null, end: string | null = null, over: Partial<StepRow> = {}): StepRow {
  return { id: nextId++, job_id: jobId, kind, rework_id: null, label: '', start_date: start, end_date: end, confirmed: true, owner: '', done_at: null, ...over };
}
const keys = (d: { key: string }[]) => d.map((x) => x.key.replace(/^(job|step):\d+:/, ''));

describe('overdue', () => {
  it('lists undone steps whose last date has passed, oldest first', () => {
    const jobs = [job(1), job(2, { status: 'complete' })];
    const steps = [
      step(1, 'factory', '2026-10-26', '2026-10-27'),
      step(1, 'check_measure', '2026-10-20'),
      step(1, 'install', '2026-10-27', '2026-10-29'),
      step(1, 'delivery', '2026-10-26', null, { done_at: '2026-10-26T01:00:00Z' }),
      step(2, 'stone_install', '2026-10-01'),
    ];
    expect(overdue(jobs, steps, TODAY).map((s) => s.kind)).toEqual(['check_measure', 'factory']);
  });
});

describe('needs a decision', () => {
  it('flags a live job with no install date', () => {
    const d = needsDecision([job(1)], [step(1, 'install', null)], [], DEFAULT_RULES, cal, TODAY);
    expect(keys(d)).toEqual(['missing']);
  });

  it('flags a factory chain that finishes after delivery', () => {
    const d = needsDecision([job(1)], [
      step(1, 'factory', '2026-11-10', '2026-11-11'),
      step(1, 'delivery', '2026-11-09'),
      step(1, 'install', '2026-11-10', '2026-11-12'),
    ], [], DEFAULT_RULES, cal, TODAY);
    expect(keys(d)).toContain('chain');
    expect(d.find((x) => x.key.endsWith('chain'))!.fact).toBe('Cut, edge and assemble finishes Wed 11 Nov, but delivery is Mon 09 Nov.');
  });

  it('flags painted doors back after delivery but not on the day', () => {
    const base = [step(1, 'factory', '2026-11-02', '2026-11-03'), step(1, 'install', '2026-11-24', '2026-11-26')];
    const onDay = needsDecision([job(1, { door_finish: 'polyurethane', has_painting: true })], [...base, step(1, 'doors_back', '2026-11-23'), step(1, 'delivery', '2026-11-23')], [], DEFAULT_RULES, cal, TODAY);
    expect(keys(onDay)).not.toContain('chain');
    const late = needsDecision([job(1, { door_finish: 'polyurethane', has_painting: true })], [...base, step(1, 'doors_back', '2026-11-24'), step(1, 'delivery', '2026-11-23')], [], DEFAULT_RULES, cal, TODAY);
    expect(keys(late)).toContain('chain');
  });

  it('flags steps out of order, as on Bathroom Products', () => {
    const d = needsDecision([job(1)], [
      step(1, 'check_measure', '2026-11-23'),
      step(1, 'production_drawings', '2026-10-27', '2026-10-28'),
      step(1, 'install', '2026-12-10', '2026-12-11'),
    ], [], DEFAULT_RULES, cal, TODAY);
    expect(keys(d)).toContain('order:check_measure:production_drawings');
  });

  it('flags a weekend stone install, as on Tesoriero', () => {
    const d = needsDecision([job(1)], [step(1, 'install', '2026-11-02', '2026-11-04'), step(1, 'stone_install', '2026-11-07')], [], DEFAULT_RULES, cal, TODAY);
    expect(d.find((x) => x.key.endsWith('offday'))!.fact).toBe('Stone install is on Sat 07 Nov, a Saturday.');
  });

  it('flags a stone install more than 10 working days after measure', () => {
    const d = needsDecision([job(1)], [
      step(1, 'install', '2026-11-02', '2026-11-04'),
      step(1, 'stone_measure', '2026-11-05'),
      step(1, 'stone_install', '2026-11-20'),
    ], [], DEFAULT_RULES, cal, TODAY);
    expect(keys(d)).toContain('stonegap');
  });

  it('flags open rework with no dates', () => {
    const d = needsDecision([job(1)], [step(1, 'install', '2026-11-02', '2026-11-04')], [
      { id: 9, job_id: 1, cause: 'install', note: 'Rebuild cabinet', raised_at: '', raised_by_name: 'Gus', closed_on: null },
    ], DEFAULT_RULES, cal, TODAY);
    expect(d.map((x) => x.key)).toContain('rework:9:undated');
  });

  it('accepts materials ordered early, as on Boon Tan, Jones and Wilson', () => {
    const d = needsDecision([job(1)], [
      step(1, 'materials_ordered', '2026-10-27'),
      step(1, 'production_drawings', '2026-10-28', '2026-10-29'),
      step(1, 'install', '2026-11-19', '2026-11-20'),
    ], [], DEFAULT_RULES, cal, TODAY);
    expect(d).toEqual([]);
  });

  it("doesn't chase an install date for a job starting months away, as on Yamamoto", () => {
    expect(needsDecision([job(1, { site_start: '2027-03-08' })], [step(1, 'install', null)], [], DEFAULT_RULES, cal, TODAY)).toEqual([]);
    expect(keys(needsDecision([job(1, { site_start: '2026-11-20' })], [step(1, 'install', null)], [], DEFAULT_RULES, cal, TODAY))).toEqual(['missing']);
  });

  it('raises a late factory chain once, not twice, as on Patch', () => {
    const d = needsDecision([job(1, { door_finish: 'polyurethane', has_painting: true })], [
      step(1, 'doors_back', '2026-11-06'),
      step(1, 'delivery', '2026-10-30'),
      step(1, 'install', '2026-11-02', '2026-11-06'),
    ], [], DEFAULT_RULES, cal, TODAY);
    expect(keys(d)).toEqual(['chain']);
  });

  it('says nothing about a tidy job', () => {
    const d = needsDecision([job(1)], [
      step(1, 'check_measure', '2026-10-23', null, { done_at: 'x' }),
      step(1, 'factory', '2026-11-02', '2026-11-03'),
      step(1, 'delivery', '2026-11-20'),
      step(1, 'install', '2026-11-23', '2026-11-25'),
      step(1, 'stone_measure', '2026-11-26'),
      step(1, 'stone_install', '2026-12-03'),
    ], [], DEFAULT_RULES, cal, TODAY);
    expect(d).toEqual([]);
  });
});

describe('capacity', () => {
  it('warns when factory days in a week pass kitchens × default days', () => {
    const jobs = [job(1), job(2), job(3)];
    const steps = [
      step(1, 'factory', '2026-11-02', '2026-11-03'),
      step(2, 'factory', '2026-11-04', '2026-11-05'),
      step(3, 'factory', '2026-11-06', '2026-11-09'), // 1 day this week, 1 next
    ];
    const w = capacity(jobs, steps, DEFAULT_RULES, cal, TODAY);
    expect(w.map((x) => [x.row, x.period, x.booked, x.limit])).toEqual([['factory', '2026-11-02', 5, 4]]);
  });

  it('warns on more than 3 check measures in a day', () => {
    const jobs = [1, 2, 3, 4].map((i) => job(i));
    const steps = jobs.map((j) => step(j.id, 'check_measure', '2026-11-04'));
    expect(capacity(jobs, steps, DEFAULT_RULES, cal, TODAY).map((x) => x.row)).toEqual(['measure']);
  });

  it('follows the settings', () => {
    const jobs = [job(1), job(2), job(3)];
    const steps = jobs.map((j, i) => step(j.id, 'factory', `2026-11-0${2 + i}`));
    expect(capacity(jobs, steps, { ...DEFAULT_RULES, factory_kitchens_per_week: 1 }, cal, TODAY)).toHaveLength(1);
    expect(capacity(jobs, steps, { ...DEFAULT_RULES, factory_kitchens_per_week: 3 }, cal, TODAY)).toHaveLength(0);
  });
});
