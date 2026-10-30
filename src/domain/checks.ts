// Overdue, Needs a decision and capacity. Pure functions over jobs and steps as
// loaded from the database, so they can be tested without one.

import { Calendar, fmtShort, Iso, mondayOf, addDays, fmtRange } from './dates.js';
import { KINDS, Rules, DEFAULT_RULES, StepKind, FLOW } from './steps.js';

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

    // The factory chain finishes after delivery (or after the install starts if there's no delivery).
    const delivery = std.get('delivery');
    const needBy = delivery?.start_date ?? install?.start_date;
    let chainRaised = false;
    if (needBy && !(install?.done_at)) {
      const chain = (['factory', 'doors_back'] as StepKind[])
        .map((k) => open(k))
        .filter((s): s is StepRow => !!s && !!s.start_date);
      const latest = chain.map((s) => ({ s, d: lastDate(s)! })).sort((a, b) => b.d.localeCompare(a.d))[0];
      if (latest && latest.d > needBy) {
        const what = delivery?.start_date ? `delivery is ${fmtShort(needBy)}` : `install starts ${fmtShort(needBy)}`;
        out.push({
          key: `job:${j.id}:chain`, jobId: j.id, title,
          fact: `${stepLabel(latest.s)} finishes ${fmtShort(latest.d)}, but ${what}.`,
          ask: 'Bring the factory forward, or move delivery and install.',
          okText: `Kept as is`,
          fields: [latest.s, delivery, install].filter((s): s is StepRow => !!s).map(field),
          fingerprint: fp([latest.d, needBy]),
        });
        chainRaised = true;
      }
    }

    // Steps out of order. Materials are often ordered early on purpose, so ordering is left out.
    // If the factory chain is already flagged above, its clash with delivery isn't raised twice.
    const chainKinds: StepKind[] = ['factory', 'doors_to_painting', 'doors_back'];
    const dated = FLOW.filter((k) => k !== 'materials_ordered').map((k) => open(k)).filter((s): s is StepRow => !!s && !!s.start_date);
    for (let i = 0; i < dated.length - 1; i++) {
      const a = dated[i];
      const b = dated[i + 1];
      if (chainRaised && chainKinds.includes(a.kind) && (b.kind === 'delivery' || b.kind === 'install')) continue;
      const bad = a.kind === 'delivery' || b.kind === 'delivery' ? lastDate(a)! > b.start_date! : a.start_date! > b.start_date!;
      if (bad) {
        out.push({
          key: `job:${j.id}:order:${a.kind}:${b.kind}`, jobId: j.id, title,
          fact: `${stepLabel(a)} (${fmtRange(a.start_date, a.end_date)}) is dated after ${stepLabel(b)} (${fmtRange(b.start_date, b.end_date)}).`,
          ask: 'Which comes first?',
          okText: 'Kept in this order',
          fields: [field(a), field(b)],
          fingerprint: fp([a.start_date, a.end_date, b.start_date, b.end_date]),
        });
      }
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

  out.push(...capacity(jobs, steps, rules, cal, today).map((c) => c.decision));
  return out;
}

export interface CapacityWarning {
  row: 'factory' | 'install' | 'measure';
  /** Monday of the week, or the day for check measures. */
  period: Iso;
  booked: number;
  limit: number;
  jobIds: number[];
  decision: Decision;
}

/**
 * Factory and install load per week in job-days, against kitchens a week × default days.
 * Check measures per day against the daily limit. Looks from this week forward.
 */
export function capacity(jobs: JobRow[], steps: StepRow[], rulesIn: Rules, cal: Calendar, today: Iso): CapacityWarning[] {
  const rules = { ...DEFAULT_RULES, ...rulesIn };
  const live = new Map(jobs.filter((j) => j.status === 'live').map((j) => [j.id, j]));
  const from = mondayOf(today);
  const out: CapacityWarning[] = [];

  const weekly = (kind: 'factory' | 'install', limit: number, label: string) => {
    const scope = KINDS[kind].scope;
    const weeks = new Map<Iso, { days: number; jobs: Set<number> }>();
    for (const s of steps) {
      if (s.kind !== kind || !s.start_date || !live.has(s.job_id)) continue;
      const end = s.end_date ?? s.start_date;
      if (end < from) continue;
      for (let w = mondayOf(s.start_date); w <= end; w = addDays(w, 7)) {
        if (w < from) continue;
        const n = cal.workingDaysWithin(s.start_date, end, w, addDays(w, 4), scope);
        if (!n) continue;
        const e = weeks.get(w) ?? weeks.set(w, { days: 0, jobs: new Set() }).get(w)!;
        e.days += n;
        e.jobs.add(s.job_id);
      }
    }
    for (const [w, e] of [...weeks].sort()) {
      if (e.days <= limit) continue;
      const names = [...e.jobs].map((id) => live.get(id)!.client_name).join(', ');
      out.push({
        row: kind, period: w, booked: e.days, limit, jobIds: [...e.jobs],
        decision: {
          key: `cap:${kind}:${w}`, jobId: null, title: `${label} · week of ${fmtShort(w)}`,
          fact: `${e.days} ${kind} days booked against ${limit} (${names}).`,
          ask: 'Move a job to another week, or OK the extra load.',
          okText: 'Extra load OK',
          fields: [],
          fingerprint: fp([e.days, limit, [...e.jobs].sort()]),
        },
      });
    }
  };
  weekly('factory', rules.factory_kitchens_per_week * rules.default_factory_days, 'Factory overbooked');
  weekly('install', rules.install_kitchens_per_week * rules.default_install_days, 'Install crew overbooked');

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
