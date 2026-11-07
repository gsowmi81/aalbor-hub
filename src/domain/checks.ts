// Overdue, Needs a decision and capacity. Pure functions over jobs and steps as
// loaded from the database, so they can be tested without one.

import { Calendar, fmtShort, Iso, mondayOf, addDays, dayOfWeek } from './dates.js';
import { KINDS, Rules, DEFAULT_RULES, StepKind, FLOW } from './steps.js';
import { PlanRow, violations } from './schedule.js';

export interface JobRow {
  id: number;
  job_number: string | null;
  brand: string;
  client_name: string;
  suburb: string;
  door_finish: 'melamine' | 'polyurethane';
  has_painting: boolean;
  has_stone: boolean;
  site_start: Iso | null;
  factory_days: number;
  install_days: number;
  status: string;
  at_risk: boolean;
}

export interface StepRow {
  id: number;
  job_id: number;
  kind: StepKind;
  rework_id: number | null;
  label: string;
  start_date: Iso | null;
  end_date: Iso | null;
  confirmed: boolean;
  owner: string;
  done_at: string | null;
  /** A promised date: shift, squeeze and drags leave it alone (George, 7 Nov 2026). */
  pinned?: boolean;
  /** Rework tasks: the standard step it stands for (its board row), and hours needed. */
  rework_area?: StepKind | null;
  hours?: number | null;
  /** Install cabinets, ticked done: the two answers (George, 7 Nov 2026). */
  gaps_adjusted?: boolean | null;
  site_clean?: boolean | null;
}

export interface ReworkRow {
  id: number;
  job_id: number;
  cause: string | null;
  note: string;
  raised_at: string;
  raised_by_name: string | null;
  closed_on: Iso | null;
}

export function stepLabel(s: Pick<StepRow, 'kind' | 'label'>): string {
  return s.label || KINDS[s.kind].label;
}
export function lastDate(s: Pick<StepRow, 'start_date' | 'end_date'>): Iso | null {
  return s.end_date ?? s.start_date;
}
export function jobTitle(j: Pick<JobRow, 'client_name' | 'suburb'>): string {
  return j.suburb ? `${j.client_name} · ${j.suburb}` : j.client_name;
}

export function planRow(s: StepRow): PlanRow {
  return { id: s.id, kind: s.kind, label: s.label, start_date: s.start_date, end_date: s.end_date, done: !!s.done_at, confirmed: s.confirmed, pinned: !!s.pinned, rework_id: s.rework_id, rework_area: s.rework_area ?? null };
}

/** The stages of the Pipeline grid (George, 7 Nov 2026): each groups the standard steps it stands for. */
export const STAGES: { key: string; label: string; short: string; kinds: StepKind[] }[] = [
  { key: 'contract', label: 'Drafting for contract', short: 'Drafting', kinds: ['contract_drafting'] },
  { key: 'measure', label: 'Check measure', short: 'Measure', kinds: ['check_measure'] },
  { key: 'drawings', label: 'Production drawings', short: 'Drawings', kinds: ['production_drawings'] },
  { key: 'materials', label: 'Materials', short: 'Materials', kinds: ['materials_ordered', 'materials_in'] },
  { key: 'factory', label: 'Factory', short: 'Factory', kinds: ['factory'] },
  { key: 'painting', label: 'Painting', short: 'Painting', kinds: ['doors_to_painting', 'doors_back'] },
  { key: 'delivery', label: 'Delivery', short: 'Delivery', kinds: ['delivery'] },
  { key: 'install', label: 'Install cabinets', short: 'Install', kinds: ['install'] },
  { key: 'stone', label: 'Stone', short: 'Stone', kinds: ['stone_measure', 'stone_install'] },
];

export type StageState = 'done' | 'overdue' | 'now' | 'later' | 'undated' | 'skipped' | 'na';

export interface StageCell {
  key: string;
  state: StageState;
  /** The first open step in the stage, or the last done one. */
  step: StepRow | null;
  /** Pinned step in the stage. */
  pinned: boolean;
}

/**
 * One job across the stages: done when every standard step in the stage is ticked, overdue when
 * one is past its date, now when one is dated this week, later when dated ahead, undated when
 * a step exists with no date, n/a when the job has no step of that stage (no painting, no stone).
 * An undated stage before one already done is "skipped": it happened without being recorded
 * (the imported jobs never had Drafting for contract ticked).
 */
export function stageCells(steps: StepRow[], weekMon: Iso, weekSun: Iso, today: Iso): StageCell[] {
  const std = steps.filter((s) => s.kind !== 'rework' && !s.label);
  const cells: StageCell[] = STAGES.map((st) => {
    const mine = std.filter((s) => st.kinds.includes(s.kind)).sort((a, b) => FLOW.indexOf(a.kind) - FLOW.indexOf(b.kind));
    if (!mine.length) return { key: st.key, state: 'na', step: null, pinned: false };
    const open = mine.filter((s) => !s.done_at);
    const pinned = mine.some((s) => s.pinned);
    if (!open.length) return { key: st.key, state: 'done', step: mine[mine.length - 1], pinned };
    const dated = open.filter((s) => s.start_date);
    const first = dated.sort((a, b) => a.start_date!.localeCompare(b.start_date!))[0] ?? open[0];
    let state: StageState = 'undated';
    if (dated.some((s) => lastDate(s)! < today)) state = 'overdue';
    else if (dated.some((s) => s.start_date! <= weekSun && lastDate(s)! >= weekMon)) state = 'now';
    else if (dated.length) state = 'later';
    return { key: st.key, state, step: first, pinned };
  });
  const lastDone = cells.reduce((m, c, i) => (c.state === 'done' ? i : m), -1);
  for (let i = 0; i < lastDone; i++) if (cells[i].state === 'undated') cells[i].state = 'skipped';
  return cells;
}

/** The stage a job is at: the first not done after the last one done (ignoring n/a), or null when every stage is done. */
export function currentStage(cells: StageCell[]): StageCell | null {
  const open = (c: StageCell) => c.state !== 'done' && c.state !== 'na' && c.state !== 'skipped';
  const lastDone = cells.reduce((m, c, i) => (c.state === 'done' ? i : m), -1);
  return cells.slice(lastDone + 1).find(open) ?? cells.find(open) ?? null;
}

/** The step a job is at, by the same rule: the first open standard step after the last one done. */
export function currentStep(steps: StepRow[]): StepRow | undefined {
  const std = steps.filter((s) => s.kind !== 'rework' && !s.label).sort((a, b) => FLOW.indexOf(a.kind) - FLOW.indexOf(b.kind));
  const lastDone = std.reduce((m, s, i) => (s.done_at ? i : m), -1);
  return std.slice(lastDone + 1).find((s) => !s.done_at) ?? std.find((s) => !s.done_at);
}

/** Steps whose last date has passed and nobody has ticked. */
export function overdue(jobs: JobRow[], steps: StepRow[], today: Iso): StepRow[] {
  const live = new Set(jobs.filter((j) => j.status === 'live').map((j) => j.id));
  return steps
    .filter((s) => live.has(s.job_id) && !s.done_at && s.start_date && lastDate(s)! < today)
    .sort((a, b) => lastDate(a)!.localeCompare(lastDate(b)!));
}

export interface DecisionField {
  stepId: number | null;
  /** 'site_start' edits the job's site start rather than a step. */
  kind: StepKind | 'site_start';
  label: string;
  start: Iso | null;
  end: Iso | null;
  range: boolean;
}

export interface Decision {
  key: string;
  jobId: number | null;
  title: string;
  fact: string;
  ask: string;
  okText: string;
  fields: DecisionField[];
  fingerprint: string;
}

function field(s: StepRow): DecisionField {
  return { stepId: s.id, kind: s.kind, label: stepLabel(s), start: s.start_date, end: s.end_date, range: KINDS[s.kind].range };
}

function fp(parts: unknown[]): string {
  return JSON.stringify(parts);
}

/** Everything in Needs a decision, before "OK as is" choices are taken off. */
export function needsDecision(
  jobs: JobRow[],
  steps: StepRow[],
  rework: ReworkRow[],
  rulesIn: Rules,
  cal: Calendar,
  today: Iso,
  cap?: CapacityInput,
): Decision[] {
  const rules = { ...DEFAULT_RULES, ...rulesIn };
  const out: Decision[] = [];
  const byJob = new Map<number, StepRow[]>();
  for (const s of steps) (byJob.get(s.job_id) ?? byJob.set(s.job_id, []).get(s.job_id)!).push(s);

  for (const j of jobs.filter((x) => x.status === 'live')) {
    const js = byJob.get(j.id) ?? [];
    const std = new Map(js.filter((s) => s.kind !== 'rework' && !s.label).map((s) => [s.kind, s]));
    const title = jobTitle(j);
    const open = (k: StepKind) => {
      const s = std.get(k);
      return s && !s.done_at ? s : undefined;
    };

    // Missing site start or install date.
    const install = std.get('install');
    // A job starting more than 8 weeks out isn't expected to have an install date yet.
    const soon = !j.site_start || cal.workingDaysBetween(today, j.site_start) <= 40;
    if (soon && (!j.site_start || !install?.start_date)) {
      const missing = [!j.site_start && 'site start', !install?.start_date && 'install date'].filter(Boolean).join(' or ');
      const fields = [install ?? std.get('check_measure'), std.get('factory')].filter((s): s is StepRow => !!s).map(field);
      if (!j.site_start) fields.unshift({ stepId: null, kind: 'site_start', label: 'Site start', start: null, end: null, range: false });
      out.push({
        key: `job:${j.id}:missing`, jobId: j.id, title,
        fact: `No ${missing}.`,
        ask: j.site_start ? 'Set the install dates.' : 'Set the site start on the job, then the install.',
        okText: 'Left undated for now',
        fields,
        fingerprint: fp([j.site_start, install?.start_date ?? null]),
      });
    }

    // Dependency rules (schedule.ts): a step dated before something it has to wait for.
    // Hard rules only (materials ordered early is fine), one item per broken rule. Saving
    // dates with "Move anyway" lands here, so an override stays visible until it's fixed or OK'd.
    const planRows: PlanRow[] = js.map(planRow);
    for (const v of violations(planRows, cal).filter((x) => x.dep.hard)) {
      const a = js.find((s) => s.id === v.pred.id)!;
      const b = js.find((s) => s.id === v.succ.id)!;
      out.push({
        key: a.kind === 'rework' ? `job:${j.id}:dep:rw:${a.id}:${b.id}` : `job:${j.id}:dep:${a.kind}:${b.kind}`, jobId: j.id, title,
        fact: `${stepLabel(b)} is on ${fmtShort(b.start_date!)}, but ${stepLabel(a)} ${a.end_date ? 'runs to' : 'is on'} ${fmtShort(lastDate(a)!)}.`,
        ask: `${stepLabel(b)} can't start before ${fmtShort(v.earliest)}. Reschedule it, or OK it as is.`,
        okText: 'Kept as is (override)',
        fields: [field(a), field(b)],
        fingerprint: fp([a.start_date, a.end_date, b.start_date, b.end_date]),
      });
    }

    // Stone install too long after stone measure.
    const sm = open('stone_measure');
    const si = open('stone_install');
    if (sm?.start_date && si?.start_date) {
      const gap = cal.workingDaysBetween(sm.start_date, si.start_date);
      if (gap > rules.stone_install_max) {
        out.push({
          key: `job:${j.id}:stonegap`, jobId: j.id, title,
          fact: `Stone install is ${gap} working days after the stone measure (limit ${rules.stone_install_max}).`,
          ask: 'Bring the stone install forward, or confirm with Lunastone.',
          okText: 'Gap confirmed with Lunastone',
          fields: [field(sm), field(si)],
          fingerprint: fp([sm.start_date, si.start_date]),
        });
      }
    }

    // Dates on a weekend, holiday or blocked day.
    for (const s of js.filter((x) => !x.done_at && x.start_date && x.start_date >= today)) {
      const scope = KINDS[s.kind].scope;
      const days = [s.start_date!, s.end_date].filter((d): d is Iso => !!d);
      const hit = days.map((d) => ({ d, why: cal.whyNotWorking(d, scope) })).find((x) => x.why);
      if (hit) {
        out.push({
          key: `step:${s.id}:offday`, jobId: j.id, title,
          fact: `${stepLabel(s)} is on ${fmtShort(hit.d)}, ${hit.why}.`,
          ask: 'Confirm it, or move it to a working day.',
          okText: `${fmtShort(hit.d)} confirmed`,
          fields: [field(s)],
          fingerprint: fp([s.start_date, s.end_date]),
        });
      }
    }
  }

  // Open rework with nothing dated.
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  for (const r of rework.filter((x) => !x.closed_on)) {
    const j = jobById.get(r.job_id);
    if (!j || j.status !== 'live') continue;
    if (steps.some((s) => s.rework_id === r.id && s.start_date)) continue;
    out.push({
      key: `rework:${r.id}:undated`, jobId: j.id, title: `${jobTitle(j)} · rework`,
      fact: r.note,
      ask: 'Set the rework dates on the job.',
      okText: 'Logged, dates to follow',
      fields: [],
      fingerprint: fp([r.id]),
    });
  }

  out.push(...capacity(jobs, steps, rules, cal, today, cap).map((c) => c.decision));
  return out;
}

export interface CapacityWarning {
  row: 'factory' | 'install' | 'measure';
  /** Monday of the week, or the day for check measures. */
  period: Iso;
  /** Job-days (hours ÷ hours_per_day) for factory and install; a count for check measures. */
  booked: number;
  limit: number;
  jobIds: number[];
  decision: Decision;
}

/** Hours available each weekday in an area (Jobman's labour centre; George, 7 Nov 2026). */
export interface LabourCentre {
  key: 'factory' | 'install';
  label: string;
  mon: number;
  tue: number;
  wed: number;
  thu: number;
  fri: number;
}

/** A period with different hours: a shutdown (0), someone on leave, an extra pair of hands. */
export interface CapacityAdjustment {
  id?: number;
  centre: string;
  from_day: Iso;
  to_day: Iso;
  hours: number;
  reason: string;
}

export interface CapacityInput {
  centres: LabourCentre[];
  adjustments: CapacityAdjustment[];
}

/**
 * Before migration 010 capacity was kitchens a week × default days; the same numbers as hours
 * spread over five days. Used when no centres are given (tests, and as a fallback).
 */
export function centresFromRules(rulesIn: Rules): CapacityInput {
  const r = { ...DEFAULT_RULES, ...rulesIn };
  const spread = (perWeek: number): Omit<LabourCentre, 'key' | 'label'> => {
    const h = Math.round((perWeek * r.hours_per_day) / 5 * 10) / 10;
    return { mon: h, tue: h, wed: h, thu: h, fri: h };
  };
  return {
    centres: [
      { key: 'factory', label: 'Factory', ...spread(r.factory_kitchens_per_week * r.default_factory_days) },
      { key: 'install', label: 'Install crew', ...spread(r.install_kitchens_per_week * r.default_install_days) },
    ],
    adjustments: [],
  };
}

/** Hours available in a centre on a day: 0 on weekends, holidays and blocked days; an adjustment's hours in its period. */
export function availableHours(c: LabourCentre, adjustments: CapacityAdjustment[], d: Iso, cal: Calendar): number {
  if (!cal.isWorkingDay(d, KINDS[c.key].scope)) return 0;
  const a = adjustments.find((x) => x.centre === c.key && x.from_day <= d && d <= x.to_day);
  if (a) return a.hours;
  return [0, c.mon, c.tue, c.wed, c.thu, c.fri, 0][dayOfWeek(d)];
}

export interface DayLoad {
  day: Iso;
  available: number;
  booked: number;
  jobIds: number[];
  /** Why the day has no hours, when it is not a weekend. */
  closed: string | null;
}

/**
 * Hours booked in a centre each day: a kitchen's factory or install day is hours_per_day hours;
 * a rework task spreads its hours over its working days. Live jobs only, standard steps and
 * rework tasks in that area.
 */
export function bookedHours(kind: 'factory' | 'install', jobs: JobRow[], steps: StepRow[], rulesIn: Rules, cal: Calendar, from: Iso, to: Iso): Map<Iso, { hours: number; jobs: Set<number> }> {
  const rules = { ...DEFAULT_RULES, ...rulesIn };
  const live = new Set(jobs.filter((j) => j.status === 'live').map((j) => j.id));
  const scope = KINDS[kind].scope;
  const out = new Map<Iso, { hours: number; jobs: Set<number> }>();
  for (const s of steps) {
    const rework = s.kind === 'rework' && s.rework_area === kind;
    if ((s.kind !== kind && !rework) || s.label || !s.start_date || !live.has(s.job_id)) continue;
    const end = s.end_date ?? s.start_date;
    if (end < from || s.start_date > to) continue;
    const total = cal.workingDaysWithin(s.start_date, end, s.start_date, end, scope);
    const perDay = rework && s.hours && total ? s.hours / total : rules.hours_per_day;
    for (let d = s.start_date; d <= end; d = addDays(d, 1)) {
      if (d < from || d > to || !cal.isWorkingDay(d, scope)) continue;
      const e = out.get(d) ?? out.set(d, { hours: 0, jobs: new Set() }).get(d)!;
      e.hours = Math.round((e.hours + perDay) * 10) / 10;
      e.jobs.add(s.job_id);
    }
  }
  return out;
}

/** One area's week: hours booked against hours available, Monday to Sunday (the first week with room, R7). */
export function weekHours(kind: 'factory' | 'install', jobs: JobRow[], steps: StepRow[], rulesIn: Rules, cal: Calendar, cap: CapacityInput, monday: Iso): { booked: number; available: number } {
  const c = cap.centres.find((x) => x.key === kind) ?? centresFromRules(rulesIn).centres.find((x) => x.key === kind)!;
  const sunday = addDays(monday, 6);
  const booked = bookedHours(kind, jobs, steps, rulesIn, cal, monday, sunday);
  let b = 0, a = 0;
  for (let d = monday; d <= sunday; d = addDays(d, 1)) {
    b += booked.get(d)?.hours ?? 0;
    a += availableHours(c, cap.adjustments, d, cal);
  }
  return { booked: Math.round(b * 10) / 10, available: Math.round(a * 10) / 10 };
}

/** The load chart: each centre, each working day from a Monday for n weeks. */
export function loadByDay(jobs: JobRow[], steps: StepRow[], rulesIn: Rules, cal: Calendar, cap: CapacityInput, from: Iso, weeks: number): { centre: LabourCentre; days: DayLoad[] }[] {
  const to = addDays(from, weeks * 7 - 1);
  return cap.centres.map((c) => {
    const booked = bookedHours(c.key, jobs, steps, rulesIn, cal, from, to);
    const days: DayLoad[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (dayOfWeek(d) === 0 || dayOfWeek(d) === 6) continue;
      const b = booked.get(d);
      days.push({ day: d, available: availableHours(c, cap.adjustments, d, cal), booked: b?.hours ?? 0, jobIds: [...(b?.jobs ?? [])], closed: cal.whyNotWorking(d, KINDS[c.key].scope) });
    }
    return { centre: c, days };
  });
}

/**
 * Factory and install load per week in hours against the centre's hours (George, 7 Nov 2026),
 * shown as job-days so the team's language still works. Check measures per day against the
 * daily limit. Looks from this week forward.
 */
export function capacity(jobs: JobRow[], steps: StepRow[], rulesIn: Rules, cal: Calendar, today: Iso, capIn?: CapacityInput): CapacityWarning[] {
  const rules = { ...DEFAULT_RULES, ...rulesIn };
  const cap = capIn ?? centresFromRules(rules);
  const live = new Map(jobs.filter((j) => j.status === 'live').map((j) => [j.id, j]));
  const from = mondayOf(today);
  const out: CapacityWarning[] = [];
  const hpd = Math.max(1, rules.hours_per_day);
  const days = (h: number) => Math.round((h / hpd) * 10) / 10;

  for (const c of cap.centres) {
    const last = steps.reduce((m, s) => ((s.kind === c.key || (s.kind === 'rework' && s.rework_area === c.key)) && s.start_date ? (lastDate(s)! > m ? lastDate(s)! : m) : m), from);
    const to = addDays(mondayOf(last), 6);
    const booked = bookedHours(c.key, jobs, steps, rules, cal, from, to);
    for (let w = from; w <= to; w = addDays(w, 7)) {
      let hours = 0;
      let avail = 0;
      const ids = new Set<number>();
      for (let i = 0; i < 5; i++) {
        const d = addDays(w, i);
        avail += availableHours(c, cap.adjustments, d, cal);
        const b = booked.get(d);
        if (b) { hours += b.hours; b.jobs.forEach((j) => ids.add(j)); }
      }
      hours = Math.round(hours * 10) / 10;
      if (hours <= avail) continue;
      const names = [...ids].map((id) => live.get(id)!.client_name).join(', ');
      const label = c.key === 'factory' ? 'Factory overbooked' : 'Install crew overbooked';
      out.push({
        row: c.key, period: w, booked: days(hours), limit: days(avail), jobIds: [...ids],
        decision: {
          key: `cap:${c.key}:${w}`, jobId: null, title: `${label} · week of ${fmtShort(w)}`,
          fact: `${hours} h booked against ${avail} h (${days(hours)} ${c.key} days against ${days(avail)}: ${names}).`,
          ask: 'Move a job to another week, or OK the extra load.',
          okText: 'Extra load OK',
          fields: [],
          fingerprint: fp([hours, avail, [...ids].sort()]),
        },
      });
    }
  }

  const perDay = new Map<Iso, number[]>();
  for (const s of steps) {
    if (s.kind !== 'check_measure' || !s.start_date || s.start_date < today || !live.has(s.job_id)) continue;
    (perDay.get(s.start_date) ?? perDay.set(s.start_date, []).get(s.start_date)!).push(s.job_id);
  }
  for (const [d, ids] of [...perDay].sort()) {
    if (ids.length <= rules.check_measures_per_day) continue;
    out.push({
      row: 'measure', period: d, booked: ids.length, limit: rules.check_measures_per_day, jobIds: ids,
      decision: {
        key: `cap:measure:${d}`, jobId: null, title: `Check measures · ${fmtShort(d)}`,
        fact: `${ids.length} check measures booked for Gus (limit ${rules.check_measures_per_day}): ${ids.map((id) => live.get(id)!.client_name).join(', ')}.`,
        ask: 'Move one to another day, or OK it.',
        okText: 'OK for Gus',
        fields: [],
        fingerprint: fp([ids.slice().sort()]),
      },
    });
  }
  return out;
}

/** The first step not yet done that has a date. */
export function nextUp(steps: StepRow[]): StepRow | undefined {
  const order = (s: StepRow) => (s.kind === 'rework' ? 99 : FLOW.indexOf(s.kind));
  return steps
    .filter((s) => !s.done_at && s.start_date)
    .sort((a, b) => a.start_date!.localeCompare(b.start_date!) || order(a) - order(b))[0];
}
