// Dependencies between steps, and rescheduling a job when one date moves
// (George, 30 Oct 2026). Pure functions; the Reschedule screen, dragging on the
// timeline, Overdue "New date" and new-job templates all use these.

import { Calendar, Iso } from './dates.js';
import { FLOW, KINDS, ProposalInput, proposeDates, Rules, DEFAULT_RULES, shiftStep, StepKind } from './steps.js';

export interface Dependency {
  pred: StepKind;
  succ: StepKind;
  /** succ can start this many working days after pred finishes (0 = the same day). */
  lag: number;
  /** Soft rules only warn; hard rules go to Needs a decision when broken. */
  hard: boolean;
}

/** Finish-to-start rules. Same day is fine unless the lag says otherwise. */
export const DEPENDENCIES: Dependency[] = [
  { pred: 'check_measure', succ: 'production_drawings', lag: 0, hard: true },
  // Materials are sometimes ordered before drawings are signed off, on purpose.
  { pred: 'production_drawings', succ: 'materials_ordered', lag: 0, hard: false },
  { pred: 'materials_ordered', succ: 'materials_in', lag: 0, hard: true },
  { pred: 'materials_in', succ: 'factory', lag: 0, hard: true },
  { pred: 'factory', succ: 'doors_to_painting', lag: 0, hard: true },
  { pred: 'doors_to_painting', succ: 'doors_back', lag: 0, hard: true },
  { pred: 'doors_back', succ: 'delivery', lag: 0, hard: true },
  { pred: 'factory', succ: 'delivery', lag: 0, hard: true },
  { pred: 'delivery', succ: 'install', lag: 0, hard: true },
  { pred: 'install', succ: 'stone_measure', lag: 1, hard: true },
  { pred: 'stone_measure', succ: 'stone_install', lag: 1, hard: true },
];

/** Steps that travel with another when it moves: delivery is the day before install. */
const COMPANIONS: Partial<Record<StepKind, StepKind[]>> = { install: ['delivery'] };

export interface PlanRow {
  id: number;
  kind: StepKind;
  label: string;
  start_date: Iso | null;
  end_date: Iso | null;
  done: boolean;
  confirmed: boolean;
}

export type Mode = 'shift' | 'squeeze' | 'only';

/** Every step that depends, directly or not, on this kind. */
export function descendants(kind: StepKind): Set<StepKind> {
  const out = new Set<StepKind>();
  const todo = [kind];
  while (todo.length) {
    const k = todo.pop()!;
    for (const d of DEPENDENCIES) if (d.pred === k && !out.has(d.succ)) { out.add(d.succ); todo.push(d.succ); }
  }
  return out;
}

const isStandard = (r: PlanRow) => r.kind !== 'rework' && !r.label;
const last = (r: { start_date: Iso | null; end_date: Iso | null }) => r.end_date ?? r.start_date;

export interface Violation {
  dep: Dependency;
  pred: PlanRow;
  succ: PlanRow;
  /** The earliest the later step may start. */
  earliest: Iso;
}

/** Rules broken by these dates. Steps already done don't count: they happened. */
export function violations(rows: PlanRow[], cal: Calendar): Violation[] {
  const std = new Map(rows.filter(isStandard).map((r) => [r.kind, r]));
  const out: Violation[] = [];
  for (const dep of DEPENDENCIES) {
    const p = std.get(dep.pred);
    const s = std.get(dep.succ);
    if (!p || !s || !p.start_date || !s.start_date || p.done || s.done) continue;
    const earliest = cal.addWorkingDays(last(p)!, dep.lag);
    if (s.start_date < earliest) out.push({ dep, pred: p, succ: s, earliest });
  }
  return out;
}

export interface Change {
  id: number;
  start_date: Iso | null;
  end_date: Iso | null;
}

/** Same working-day length, starting on a new date. */
function moveTo(r: PlanRow, start: Iso, cal: Calendar): Change {
  const scope = KINDS[r.kind].scope;
  if (!r.end_date || !r.start_date) return { id: r.id, start_date: start, end_date: null };
  const len = cal.workingDaysBetween(cal.onOrAfter(r.start_date, scope), r.end_date, scope);
  return { id: r.id, start_date: start, end_date: cal.addWorkingDays(cal.onOrAfter(start, scope), Math.max(len, 0), scope) };
}

/**
 * Work out the job after one step moves. Returns the new dates for every step that changes.
 * - shift:   everything that depends on the moved step moves by the same number of working days.
 * - squeeze: install (and after) stays put; the steps between take up their spare days first and
 *            only move as far as the rules force them to.
 * - only:    just the moved step.
 * Steps already done never move.
 */
export function reschedule(
  rows: PlanRow[],
  movedId: number,
  newStart: Iso,
  newEnd: Iso | null,
  mode: Mode,
  cal: Calendar,
): Change[] {
  const moved = rows.find((r) => r.id === movedId);
  if (!moved) return [];
  const scope = KINDS[moved.kind].scope;
  const first: Change = newEnd !== null || !moved.end_date
    ? { id: moved.id, start_date: newStart, end_date: newEnd && newEnd !== newStart ? newEnd : null }
    : moveTo(moved, newStart, cal);
  const changes = new Map<number, Change>([[moved.id, first]]);
  if (mode === 'only' || !isStandard(moved) || !moved.start_date) return [...changes.values()];

  const after = descendants(moved.kind);
  for (const c of COMPANIONS[moved.kind] ?? []) after.add(c);
  const later = rows
    .filter((r) => isStandard(r) && after.has(r.kind) && !r.done && r.start_date)
    .sort((a, b) => FLOW.indexOf(a.kind) - FLOW.indexOf(b.kind));

  if (mode === 'shift') {
    const delta = cal.workingDaysBetween(cal.onOrAfter(moved.start_date, scope), cal.onOrAfter(newStart, scope), scope);
    for (const r of later) {
      const s = shiftStep(r, delta, cal);
      changes.set(r.id, { id: r.id, start_date: s.start_date, end_date: s.end_date });
    }
    return [...changes.values()];
  }

  // squeeze: hold install and everything after it; push the steps in between only as far as needed.
  const held = new Set<StepKind>(['install', ...descendants('install')]);
  const current = (r: PlanRow): PlanRow => {
    const c = changes.get(r.id);
    return c ? { ...r, start_date: c.start_date, end_date: c.end_date } : r;
  };
  const byKind = () => new Map(rows.filter(isStandard).map((r) => [r.kind, current(r)]));
  for (const r of later) {
    if (held.has(r.kind)) continue;
    const now = byKind();
    let earliest: Iso | null = null;
    for (const dep of DEPENDENCIES.filter((d) => d.succ === r.kind && d.hard)) {
      const p = now.get(dep.pred);
      if (!p || !p.start_date || p.done) continue;
      const e = cal.addWorkingDays(last(p)!, dep.lag);
      if (!earliest || e > earliest) earliest = e;
    }
    if (earliest && r.start_date! < earliest) changes.set(r.id, moveTo(r, cal.onOrAfter(earliest, KINDS[r.kind].scope), cal));
  }
  return [...changes.values()];
}

/** Apply changes to rows (for previews and checking). */
export function applyChanges(rows: PlanRow[], changes: Change[]): PlanRow[] {
  const m = new Map(changes.map((c) => [c.id, c]));
  return rows.map((r) => (m.has(r.id) ? { ...r, start_date: m.get(r.id)!.start_date, end_date: m.get(r.id)!.end_date } : r));
}

// ---------- New-job templates ----------

export interface Template {
  key: string;
  name: string;
  door_finish: 'melamine' | 'polyurethane';
  has_painting: boolean;
  has_stone: boolean;
  factory_days: number;
  install_days: number;
  install_weeks: number;
}

export type AnchorKind = 'site_start' | 'check_measure' | 'production_drawings' | 'install';

export const ANCHORS: { kind: AnchorKind; label: string }[] = [
  { kind: 'site_start', label: 'Site start' },
  { kind: 'check_measure', label: 'Check measure' },
  { kind: 'production_drawings', label: 'Production drawings start' },
  { kind: 'install', label: 'Install start' },
];

/**
 * Propose every date for a new job from the one date you know. Site start comes from the
 * job number or the form; if it's blank it's worked out back from the anchor date.
 */
export function proposeFromAnchor(
  job: Omit<ProposalInput, 'site_start'> & { site_start: Iso | null; install_weeks: number },
  anchor: AnchorKind,
  anchorDate: Iso,
  rulesIn: Rules,
  cal: Calendar,
): { site_start: Iso; steps: { kind: StepKind; start_date: Iso; end_date: Iso | null }[] } {
  const rules = { ...DEFAULT_RULES, ...rulesIn };
  let site = anchor === 'site_start' ? anchorDate : job.site_start;
  if (!site) {
    if (anchor === 'check_measure') site = cal.addWorkingDays(anchorDate, -rules.check_measure_after_start);
    else if (anchor === 'production_drawings') site = cal.addWorkingDays(cal.addWorkingDays(anchorDate, -1), -rules.check_measure_after_start);
    else site = cal.addWorkingDays(anchorDate, -job.install_weeks * 5);
  }
  const proposed = proposeDates({ ...job, site_start: site }, rules, cal);
  if (anchor === 'site_start') return { site_start: site, steps: proposed };
  const rows: PlanRow[] = proposed.map((p, i) => ({ id: i + 1, kind: p.kind, label: '', start_date: p.start_date, end_date: p.end_date, done: false, confirmed: false }));
  const pinned = rows.find((r) => r.kind === anchor);
  if (!pinned) return { site_start: site, steps: proposed };
  const changed = applyChanges(rows, reschedule(rows, pinned.id, anchorDate, null, 'shift', cal));
  return { site_start: site, steps: changed.map((r) => ({ kind: r.kind, start_date: r.start_date!, end_date: r.end_date })) };
}
