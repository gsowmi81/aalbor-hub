// Reads. Everyone signed in can read everything, so reads use the pool directly;
// every write goes through withPerson() so the database checks the role.
import { pool, Db } from './pool.js';
import { Calendar, BlockedDay } from '../domain/dates.js';
import type { JobRow, ReworkRow, StepRow } from '../domain/checks.js';
import { DEFAULT_RULES, FLOW, kindsFor, Rules, StepKind, KINDS } from '../domain/steps.js';

export interface FullJob extends JobRow {
  scope: string;
  notes: string;
  added_on: string;
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
  return new Calendar(await loadBlocked());
}

const STEP_COLS = 'id, job_id, kind, rework_id, label, start_date, end_date, confirmed, owner, done_at, note, sort';

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
  return { job, steps, rework };
}

export async function loadJobList(): Promise<{ id: number; job_number: string | null; client_name: string; suburb: string; status: string }[]> {
  return (await pool.query(`select id, job_number, client_name, suburb, status from jobs where status <> 'cancelled' order by status = 'live' desc, client_name`)).rows;
}

export interface LogEntry {
  table_name: string;
  record_id: string;
  action: string;
  person_name: string;
  changed_at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Change log for a job, its steps and its rework, newest first. */
export async function loadJobHistory(jobId: number, limit = 40): Promise<LogEntry[]> {
  return (await pool.query(
    `select table_name, record_id, action, person_name, changed_at, before, after from change_log
     where (table_name = 'jobs' and record_id = $1)
        or (table_name in ('steps', 'rework') and coalesce(after->>'job_id', before->>'job_id') = $1)
     order by id desc limit $2`,
    [String(jobId), limit],
  )).rows;
}

/** Creates any standard steps the job should have and doesn't, and removes ones it no longer needs (if untouched). */
export async function syncStepSet(db: Db, jobId: number): Promise<void> {
  const job = (await db.query('select door_finish, has_stone from jobs where id = $1', [jobId])).rows[0];
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
