// Reads. Everyone signed in can read everything, so reads use the pool directly;
// every write goes through withPerson() so the database checks the role.
import { pool, Db, withPerson } from './pool.js';
import type { PlanRow, Template } from '../domain/schedule.js';
import { Calendar, BlockedDay } from '../domain/dates.js';
import type { CapacityAdjustment, CapacityInput, JobRow, LabourCentre, ReworkRow, StepRow } from '../domain/checks.js';
import { DEFAULT_RULES, FLOW, kindsFor, Rules, StepKind, KINDS } from '../domain/steps.js';

export interface FullJob extends JobRow {
  scope: string;
  notes: string;
  added_on: string;
  /** Where the drawings live: a folder link, no files in the hub (George, 7 Nov 2026). */
  drawings_url: string;
}

/** One text setting from app_settings, or '' when it isn't set. */
export async function appSetting(key: string): Promise<string> {
  return (await pool.query('select value from app_settings where key = $1', [key])).rows[0]?.value ?? '';
}

/** Jobs matching a typed search: number, client or suburb (the header search, George, 7 Nov 2026). */
export async function findJobs(q: string): Promise<{ id: number; job_number: string | null; client_name: string; suburb: string; status: string }[]> {
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return (await pool.query(
    `select id, job_number, client_name, suburb, status from jobs
      where job_number ilike $1 or client_name ilike $1 or suburb ilike $1
      order by status = 'live' desc, ${JOB_NUMBER_ORDER} limit 50`, [like])).rows;
}

export interface ReworkFull extends ReworkRow {
  extra_hours: number | null;
  extra_material_cost: number | null;
}

export async function loadRules(): Promise<Rules> {
  const r = await pool.query('select key, value from settings');
  return { ...DEFAULT_RULES, ...Object.fromEntries(r.rows.map((x) => [x.key, x.value])) };
}

export async function loadBlocked(): Promise<(BlockedDay & { id: number })[]> {
  return (await pool.query('select id, day, scope, reason from blocked_days order by day')).rows;
}

export async function loadCalendar(): Promise<Calendar> {
  const [blocked, rules] = await Promise.all([loadBlocked(), loadRules()]);
  return new Calendar(blocked, { saturdays: rules.saturday_working === 1 });
}

const STEP_COLS = 'id, job_id, kind, rework_id, rework_area, hours, label, start_date, end_date, confirmed, pinned, owner, done_at, note, sort, gaps_adjusted, site_clean, site_finished_at, site_finished_by';

/** Job-number order, oldest first (George, 6 Nov 2026): YYMMDD numbers by value, then any others, then none. */
export const JOB_NUMBER_ORDER = `coalesce(job_number ~ '^[0-9]+$', false) desc, case when job_number ~ '^[0-9]{1,15}$' then job_number::bigint end, job_number nulls last, client_name`;

export async function loadEverything(): Promise<{ jobs: FullJob[]; steps: (StepRow & { note: string })[]; rework: ReworkFull[] }> {
  const [jobs, steps, rework] = await Promise.all([
    pool.query(`select * from jobs where status <> 'cancelled' order by client_name`),
    pool.query(`select ${STEP_COLS} from steps order by job_id, sort, id`),
    pool.query(`select r.*, p.name as raised_by_name from rework r left join people p on p.id = r.raised_by order by r.raised_at desc`),
  ]);
  return { jobs: jobs.rows, steps: steps.rows, rework: rework.rows };
}

export async function loadJob(id: number) {
  const job = (await pool.query('select * from jobs where id = $1', [id])).rows[0] as FullJob | undefined;
  if (!job) return null;
  const steps = (await pool.query(`select ${STEP_COLS} from steps where job_id = $1 order by sort, id`, [id])).rows as (StepRow & { note: string })[];
  const rework = (await pool.query(
    `select r.*, p.name as raised_by_name from rework r left join people p on p.id = r.raised_by where r.job_id = $1 order by r.raised_at`, [id])).rows as ReworkFull[];
  return { job, steps, rework, stepPhotos: await loadStepPhotos(id), files: await loadJobFiles(id) };
}

/** A file on a job (George, 7 Nov 2026): the record; the bytes live in job_file_blobs. */
export interface JobFile {
  id: number;
  job_id: number;
  kind: string;
  version: number;
  name: string;
  content_type: string;
  size: number;
  note: string;
  added_by: number | null;
  added_by_name: string | null;
  added_at: string;
}

const FILE_SQL = `select f.id, f.job_id, f.kind, f.version, f.name, f.content_type, f.size, f.note, f.added_by, p.name as added_by_name, f.added_at
  from job_files f left join people p on p.id = f.added_by`;

export async function loadJobFiles(jobId: number): Promise<JobFile[]> {
  return (await pool.query(`${FILE_SQL} where f.job_id = $1 order by f.kind, f.version desc, f.id desc`, [jobId])).rows;
}

/** The current (latest) file of each class on every job: job id → files. For My day and the board. */
export async function loadCurrentFiles(): Promise<Map<number, JobFile[]>> {
  const rows = (await pool.query(`${FILE_SQL} where f.version = (select max(g.version) from job_files g where g.job_id = f.job_id and g.kind = f.kind) order by f.job_id, f.kind`)).rows as JobFile[];
  const out = new Map<number, JobFile[]>();
  for (const r of rows) out.set(r.job_id, [...(out.get(r.job_id) ?? []), r]);
  return out;
}

/** Install photos on a job's steps: step id → photo ids (George, 7 Nov 2026). */
export async function loadStepPhotos(jobId: number): Promise<Map<number, number[]>> {
  const rows = (await pool.query('select p.id, p.step_id from step_photos p join steps s on s.id = p.step_id where s.job_id = $1 order by p.id', [jobId])).rows as { id: number; step_id: number }[];
  const out = new Map<number, number[]>();
  for (const r of rows) out.set(r.step_id, [...(out.get(r.step_id) ?? []), r.id]);
  return out;
}

/** Standard install steps ticked done in a date range, with their answers and photo counts (the Monday email). */
export async function installsDone(from: string, to: string): Promise<{ id: number; job_id: number; client_name: string; suburb: string; done_at: string; done_by_name: string | null; gaps_adjusted: boolean | null; site_clean: boolean | null; photos: number }[]> {
  return (await pool.query(`select s.id, s.job_id, j.client_name, j.suburb, s.done_at, p.name as done_by_name, s.gaps_adjusted, s.site_clean,
      (select count(*)::int from step_photos ph where ph.step_id = s.id) as photos
    from steps s join jobs j on j.id = s.job_id left join people p on p.id = s.done_by
    where s.kind = 'install' and s.label = '' and s.done_at is not null
      and (s.done_at at time zone 'Australia/Sydney')::date between $1 and $2
    order by s.done_at`, [from, to])).rows;
}

export async function loadJobList(): Promise<{ id: number; job_number: string | null; client_name: string; suburb: string; status: string }[]> {
  return (await pool.query(`select id, job_number, client_name, suburb, status from jobs where status <> 'cancelled' order by status = 'live' desc, ${JOB_NUMBER_ORDER}`)).rows;
}

export interface LogEntry {
  table_name: string;
  record_id: string;
  action: string;
  person_name: string;
  changed_at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Set when the change came from accepting a bot suggestion. */
  suggestion_id?: number | null;
}

/** Change log for a job, its steps and its rework, newest first. */
export async function loadJobHistory(jobId: number, limit = 40): Promise<LogEntry[]> {
  return (await pool.query(
    `select table_name, record_id, action, person_name, changed_at, before, after, suggestion_id::int as suggestion_id from change_log
     where (table_name = 'jobs' and record_id = $1)
        or (table_name in ('steps', 'rework', 'job_files') and coalesce(after->>'job_id', before->>'job_id') = $1)
     order by id desc limit $2`,
    [String(jobId), limit],
  )).rows;
}

/** Creates any standard steps the job should have and doesn't, and removes ones it no longer needs (if untouched). */
export async function syncStepSet(db: Db, jobId: number): Promise<void> {
  const job = (await db.query('select has_painting, has_stone from jobs where id = $1', [jobId])).rows[0];
  const want = new Set<StepKind>(kindsFor(job));
  const have = (await db.query(`select id, kind, start_date, done_at from steps where job_id = $1 and kind <> 'rework' and label = ''`, [jobId])).rows;
  const haveKinds = new Set(have.map((s) => s.kind));
  for (const k of FLOW) {
    if (want.has(k) && !haveKinds.has(k)) {
      await db.query('insert into steps (job_id, kind, owner, sort) values ($1, $2, $3, $4)', [jobId, k, KINDS[k].owner, FLOW.indexOf(k) * 10]);
    }
  }
  for (const s of have) {
    if (!want.has(s.kind) && !s.done_at) await db.query('delete from steps where id = $1', [s.id]);
  }
}

// ---------- Capacity in hours (George, 7 Nov 2026) ----------

export async function loadCapacity(): Promise<CapacityInput> {
  const [c, a] = await Promise.all([
    pool.query('select key, label, mon, tue, wed, thu, fri, sat from labour_centres order by sort'),
    pool.query('select id, centre, from_day, to_day, hours, reason from capacity_adjustments order by from_day, id'),
  ]);
  const num = (r: Record<string, unknown>) => ({ ...r, mon: Number(r.mon), tue: Number(r.tue), wed: Number(r.wed), thu: Number(r.thu), fri: Number(r.fri), sat: Number(r.sat ?? 0) });
  return { centres: c.rows.map(num) as LabourCentre[], adjustments: a.rows.map((r) => ({ ...r, hours: Number(r.hours) })) as CapacityAdjustment[] };
}

// ---------- Flagged problems (George, 7 Nov 2026) ----------

export interface IssueType {
  key: string;
  label: string;
  responsible: number | null;
  responsible_name: string | null;
  sort: number;
  active: boolean;
}

export interface IssueRow {
  id: number;
  job_id: number;
  step_id: number | null;
  type_key: string;
  type_label: string;
  responsible: number | null;
  responsible_name: string | null;
  note: string;
  raised_by: number | null;
  raised_by_name: string | null;
  raised_at: string;
  status: 'open' | 'looking' | 'fixed';
  closed_at: string | null;
  closed_by_name: string | null;
  close_note: string;
  rework_id: number | null;
  client_name: string;
  suburb: string;
  step_kind: string | null;
  step_label: string | null;
  photo_ids: number[];
}

export async function loadIssueTypes(): Promise<IssueType[]> {
  return (await pool.query(`select t.key, t.label, t.responsible, p.name as responsible_name, t.sort, t.active
    from issue_types t left join people p on p.id = t.responsible order by t.sort`)).rows;
}

const ISSUE_SQL = `select i.id, i.job_id, i.step_id, i.type_key, t.label as type_label, t.responsible, rp.name as responsible_name,
    i.note, i.raised_by, p.name as raised_by_name, i.raised_at, i.status, i.closed_at, cp.name as closed_by_name, i.close_note, i.rework_id,
    j.client_name, j.suburb, s.kind as step_kind, s.label as step_label,
    coalesce((select array_agg(ph.id order by ph.id) from issue_photos ph where ph.issue_id = i.id), '{}') as photo_ids
  from issues i join issue_types t on t.key = i.type_key join jobs j on j.id = i.job_id
  left join people p on p.id = i.raised_by left join people rp on rp.id = t.responsible left join people cp on cp.id = i.closed_by
  left join steps s on s.id = i.step_id`;

/** Flags, open ones first then newest, optionally for one job or open only. */
export async function loadIssues(opts: { jobId?: number; open?: boolean; limit?: number } = {}): Promise<IssueRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.jobId) { params.push(opts.jobId); where.push(`i.job_id = $${params.length}`); }
  if (opts.open) where.push(`i.status <> 'fixed'`);
  params.push(opts.limit ?? 200);
  return (await pool.query(`${ISSUE_SQL} ${where.length ? `where ${where.join(' and ')}` : ''} order by i.status = 'fixed', i.raised_at desc limit $${params.length}`, params)).rows;
}

export async function loadIssue(id: number): Promise<IssueRow | undefined> {
  return (await pool.query(`${ISSUE_SQL} where i.id = $1`, [id])).rows[0];
}

// ---------- Templates and scheduling ----------

export async function loadTemplates(): Promise<Template[]> {
  return (await pool.query('select * from job_templates order by sort, name')).rows;
}

/** A job's template, or for jobs from before templates, the one matching its painting choice. */
export async function templateFor(job: { template?: string | null; has_painting: boolean }): Promise<Template> {
  const all = await loadTemplates();
  return all.find((t) => t.key === job.template) ?? all.find((t) => t.has_painting === job.has_painting) ?? all[0];
}

export async function loadPlanRows(jobId: number): Promise<(PlanRow & { owner: string })[]> {
  return (await pool.query(
    `select id, kind, label, start_date, end_date, done_at is not null as done, confirmed, pinned, owner, rework_id, rework_area from steps where job_id = $1 order by sort, id`,
    [jobId],
  )).rows;
}

// ---------- Owners only ----------

export interface Responsible {
  rework_id: number;
  responsible: string;
  note: string;
  set_by_name: string | null;
  set_at: string;
}

/**
 * Who was responsible for each rework. Read as the signed-in person, so Postgres's
 * row-level security decides: an owner gets the rows, anyone else gets none.
 */
export async function loadResponsible(personId: number): Promise<Map<number, Responsible>> {
  const rows = await withPerson(personId, async (db) => (await db.query(
    `select r.rework_id, r.responsible, r.note, r.set_at, p.name as set_by_name
       from rework_responsible r left join people p on p.id = r.set_by`)).rows as Responsible[]);
  return new Map(rows.map((r) => [r.rework_id, r]));
}
