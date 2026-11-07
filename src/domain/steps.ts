// The steps a job moves through, which board row each sits on, who owns it, and
// the rules that propose its dates. Change a rule here and in docs/build-plan.html.

import { addDays, Calendar, Iso, mondayOf, Scope } from './dates.js';

export type StepKind =
  | 'contract_drafting' | 'check_measure' | 'production_drawings'
  | 'materials_ordered' | 'materials_in' | 'factory'
  | 'doors_to_painting' | 'doors_back' | 'delivery' | 'install'
  | 'stone_measure' | 'stone_install' | 'rework';

export type BoardRow = 'contract' | 'measure' | 'drawings' | 'orders' | 'factory' | 'install' | 'stone' | 'rework';

interface KindInfo {
  label: string;
  owner: string;
  row: BoardRow;
  /** Two-letter code on the All jobs timeline. */
  code: string;
  /** Can run over several days (has a "to" date). */
  range: boolean;
  scope: Scope;
}

export const KINDS: Record<StepKind, KindInfo> = {
  contract_drafting:   { label: 'Drafting for contract',   owner: 'Christine', row: 'contract', code: 'CD', range: true,  scope: 'all' },
  check_measure:       { label: 'Check measure',           owner: 'Gus',       row: 'measure',  code: 'CM', range: false, scope: 'all' },
  production_drawings: { label: 'Production drawings',     owner: 'Christine', row: 'drawings', code: 'DR', range: true,  scope: 'all' },
  materials_ordered:   { label: 'Materials ordered',       owner: 'Christine', row: 'orders',   code: 'MO', range: false, scope: 'all' },
  materials_in:        { label: 'Materials in',            owner: 'Factory',   row: 'orders',   code: 'MI', range: false, scope: 'all' },
  factory:             { label: 'Cut, edge and assemble',  owner: 'Phil',      row: 'factory',  code: 'F',  range: true,  scope: 'factory' },
  doors_to_painting:   { label: 'Doors to painting',       owner: 'Phil',      row: 'factory',  code: 'P',  range: false, scope: 'factory' },
  doors_back:          { label: 'Doors back from painting', owner: 'Factory',  row: 'factory',  code: 'PB', range: false, scope: 'all' },
  // Delivery sits in the Factory row: the factory sends it (George, 6 Nov 2026).
  delivery:            { label: 'Delivery',                owner: 'Factory',   row: 'factory',  code: 'DL', range: false, scope: 'all' },
  install:             { label: 'Install cabinets',        owner: 'Installer', row: 'install',  code: 'IN', range: true,  scope: 'all' },
  stone_measure:       { label: 'Stone measure',           owner: 'Lunastone', row: 'stone',    code: 'SM', range: false, scope: 'all' },
  stone_install:       { label: 'Stone install',           owner: 'Lunastone', row: 'stone',    code: 'SI', range: false, scope: 'all' },
  rework:              { label: 'Rework',                  owner: '',          row: 'rework',   code: 'RW', range: true,  scope: 'all' },
};

/** The standard steps, in the order a job moves through them. */
export const FLOW: StepKind[] = [
  'contract_drafting', 'check_measure', 'production_drawings', 'materials_ordered', 'materials_in',
  'factory', 'doors_to_painting', 'doors_back', 'delivery', 'install', 'stone_measure', 'stone_install',
];

export const BOARD_ROWS: { row: BoardRow; label: string }[] = [
  { row: 'contract', label: 'Drafting for contract' },
  { row: 'measure', label: 'Check measure' },
  { row: 'drawings', label: 'Production drawings' },
  { row: 'orders', label: 'Materials orders' },
  { row: 'factory', label: 'Factory' },
  { row: 'install', label: 'Install cabinets' },
  { row: 'stone', label: 'Stone' },
  { row: 'rework', label: 'Rework' },
];

/** The areas a person can work in (Settings → People): the board rows, less Rework. Their steps make up My day. */
export const PEOPLE_AREAS: { area: BoardRow; label: string }[] = BOARD_ROWS.filter((r) => r.row !== 'rework').map((r) => ({ area: r.row, label: r.label }));

/**
 * Rework is a mini job (George, 6 Nov 2026): its tasks are picked from these standard steps,
 * in this order, and each shows on the board in its step's row, in red.
 */
export type ReworkArea = 'production_drawings' | 'factory' | 'delivery' | 'install';
export const REWORK_AREAS: { kind: ReworkArea; label: string; task: string; hours: boolean }[] = [
  { kind: 'production_drawings', label: 'Drafting / production drawings', task: 'Rework: drawings', hours: false },
  { kind: 'factory', label: 'Factory work (cut, edge, assemble)', task: 'Rework: factory work', hours: true },
  { kind: 'delivery', label: 'Delivery to site', task: 'Rework: delivery', hours: false },
  { kind: 'install', label: 'Install', task: 'Rework: install', hours: true },
];
export const REWORK_ORDER: ReworkArea[] = REWORK_AREAS.map((a) => a.kind);
export function isReworkArea(k: unknown): k is ReworkArea {
  return (REWORK_ORDER as unknown[]).includes(k);
}

/**
 * The categories a rework item can sit in (George, 6 Nov 2026): one per board row, each the
 * standard step it stands for. Picked from a list when adding an item; owner comes from it.
 */
export const REWORK_CATEGORIES: { kind: StepKind; label: string }[] = [
  { kind: 'contract_drafting', label: 'Drafting for contract' },
  { kind: 'check_measure', label: 'Check measure' },
  { kind: 'production_drawings', label: 'Production drawings' },
  { kind: 'materials_ordered', label: 'Materials orders' },
  { kind: 'factory', label: 'Factory' },
  { kind: 'delivery', label: 'Delivery' },
  { kind: 'install', label: 'Install' },
  { kind: 'stone_install', label: 'Stone' },
];
export function isReworkCategory(k: unknown): k is StepKind {
  return REWORK_CATEGORIES.some((c) => c.kind === k);
}
/** Only factory and install rework items take hours: they count toward the weekly loads. */
export const takesHours = (k: StepKind | null | undefined) => k === 'factory' || k === 'install';

/** Where a task added to one job can go (George, 6 Nov 2026): its row and the step it travels with. */
export const TASK_AREAS: { kind: StepKind; label: string }[] = [
  { kind: 'production_drawings', label: 'Production' },
  { kind: 'factory', label: 'Factory' },
  { kind: 'install', label: 'Site' },
];

/** The standard step whose rules (row, scope, length) a step follows: a rework task follows the one it stands for. */
export function baseKind(s: { kind: StepKind; rework_area?: StepKind | null }): StepKind {
  return s.kind === 'rework' && s.rework_area ? s.rework_area : s.kind;
}
/** The board row a step sits in. Rework tasks sit in the row of the step they stand for. */
export function rowOf(s: { kind: StepKind; rework_area?: StepKind | null }): BoardRow {
  return KINDS[baseKind(s)].row;
}

export type DoorFinish = 'melamine' | 'polyurethane';

/** Which standard steps a job has. Painting steps only when the job needs painting, stone steps only with stone. */
export function kindsFor(job: { has_painting: boolean; has_stone: boolean }): StepKind[] {
  return FLOW.filter((k) => {
    if ((k === 'doors_to_painting' || k === 'doors_back') && !job.has_painting) return false;
    if ((k === 'stone_measure' || k === 'stone_install') && !job.has_stone) return false;
    return true;
  });
}

export type Rules = Record<string, number>;

export const DEFAULT_RULES: Rules = {
  factory_kitchens_per_week: 2,
  install_kitchens_per_week: 2,
  check_measures_per_day: 3,
  default_factory_days: 2,
  default_install_days: 3,
  drafting_days: 5,
  check_measure_after_start: 3,
  drawings_days: 5,
  materials_lead_days: 3,
  painting_days: 10,
  install_weeks_melamine: 4,
  install_weeks_poly: 5,
  stone_measure_after_install: 1,
  stone_install_after_measure: 5,
  stone_install_max: 10,
  rework_drawings_days: 1,
  hours_per_day: 8,
};

export interface ProposalInput {
  added_on: Iso;
  site_start: Iso;
  door_finish: DoorFinish;
  has_painting: boolean;
  has_stone: boolean;
  factory_days: number;
  install_days: number;
  /** From the job's template; if missing, the install-weeks settings by painting. */
  install_weeks?: number;
}

export interface ProposedStep {
  kind: StepKind;
  start_date: Iso;
  end_date: Iso | null;
}

/** Every date for a new job, worked out from the day it's added and its site start. All provisional. */
export function proposeDates(job: ProposalInput, rules: Rules, cal: Calendar): ProposedStep[] {
  const r = { ...DEFAULT_RULES, ...rules };
  const out = new Map<StepKind, ProposedStep>();
  const put = (kind: StepKind, start: Iso, end: Iso | null = null) =>
    out.set(kind, { kind, start_date: start, end_date: end && end !== start ? end : null });

  const draft = cal.span(job.added_on, r.drafting_days);
  put('contract_drafting', draft.start, draft.end);

  const cm = cal.addWorkingDays(cal.onOrAfter(job.site_start), r.check_measure_after_start);
  put('check_measure', cm);

  const drawingsEnd = cal.addWorkingDays(cm, r.drawings_days);
  put('production_drawings', cal.addWorkingDays(cm, 1), drawingsEnd);

  put('materials_ordered', drawingsEnd);
  const materialsIn = cal.addWorkingDays(drawingsEnd, r.materials_lead_days);
  put('materials_in', materialsIn);

  const factoryStart = cal.onOrAfter(cal.addWorkingDays(materialsIn, 1), 'factory');
  const factoryEnd = cal.addWorkingDays(factoryStart, job.factory_days - 1, 'factory');
  put('factory', factoryStart, factoryEnd);

  if (job.has_painting) {
    const out1 = cal.onOrAfter(cal.addWorkingDays(factoryEnd, 1, 'factory'), 'factory');
    put('doors_to_painting', out1);
    put('doors_back', cal.addWorkingDays(out1, r.painting_days));
  }

  // The extra install week on poly jobs is there for painting, so it follows the painting choice.
  const weeks = job.install_weeks ?? (job.has_painting ? r.install_weeks_poly : r.install_weeks_melamine);
  const install = cal.span(mondayOf(addDays(job.site_start, weeks * 7)), job.install_days);
  put('delivery', cal.addWorkingDays(install.start, -1));
  put('install', install.start, install.end);

  if (job.has_stone) {
    const sm = cal.addWorkingDays(install.end, r.stone_measure_after_install);
    put('stone_measure', sm);
    put('stone_install', cal.addWorkingDays(sm, r.stone_install_after_measure));
  }

  return kindsFor(job).map((k) => out.get(k)!).filter(Boolean);
}

/** Shift a step's dates by n working days, keeping it on working days for its scope. */
export function shiftStep(
  s: { kind: StepKind; rework_area?: StepKind | null; start_date: Iso | null; end_date: Iso | null },
  n: number,
  cal: Calendar,
): { start_date: Iso | null; end_date: Iso | null } {
  const scope = KINDS[baseKind(s)].scope;
  const move = (d: Iso | null) => (d ? cal.addWorkingDays(cal.onOrAfter(d, scope), n, scope) : null);
  if (!s.start_date) return { start_date: null, end_date: null };
  if (!s.end_date) return { start_date: move(s.start_date), end_date: null };
  // Keep the same number of working days in a multi-day step.
  const len = cal.workingDaysBetween(cal.onOrAfter(s.start_date, scope), s.end_date, scope);
  const start = move(s.start_date)!;
  return { start_date: start, end_date: cal.addWorkingDays(start, Math.max(len, 0), scope) };
}

/** Job number YYMMDD → site start date, or null if it isn't one. */
export function siteStartFromJobNumber(jobNumber: string): Iso | null {
  const m = jobNumber.trim().match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [2000 + Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${m[2]}-${m[3]}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}
