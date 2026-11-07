// The writes behind every edit. The screens and accepted suggestions (suggestions.ts) both use
// these, so the same checks run whichever way a change arrives. Each takes a client from
// withPerson(), so Postgres still checks the role and records who made the change.
import type { Db } from './pool.js';
import { syncStepSet } from './queries.js';
import type { Iso } from '../domain/dates.js';
import { FLOW, KINDS, StepKind } from '../domain/steps.js';

/** A mistake in what someone typed (or the bot sent). Shown back to them, not logged as a fault. */
export class UserError extends Error {}

export const JOB_STATUSES = ['live', 'on_hold', 'complete', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Checks a from/to pair; returns the "to" date to store (null when it's the same day). */
export function checkDates(start: Iso | null, end: Iso | null, label: string): Iso | null {
  if (!start && end) throw new UserError(`${label}: give a "from" date as well as a "to" date.`);
  if (start && end && end < start) throw new UserError(`${label}: the "to" date is before the "from" date.`);
  return end && end !== start ? end : null;
}

export async function setStepDates(db: Db, stepId: number, start: Iso | null, end: Iso | null, label: string): Promise<void> {
  await db.query('update steps set start_date = $2, end_date = $3 where id = $1', [stepId, start, checkDates(start, end, label)]);
}

/** Confirmed only means something on a dated step. */
export async function setStepConfirmed(db: Db, stepId: number, confirmed: boolean): Promise<void> {
  await db.query('update steps set confirmed = ($2 and start_date is not null) where id = $1', [stepId, confirmed]);
}

export async function setStepDone(db: Db, stepId: number, done: boolean): Promise<void> {
  await db.query(`update steps set done_at = ${done ? 'coalesce(done_at, now())' : 'null'} where id = $1`, [stepId]);
}

export async function setJobStatus(db: Db, jobId: number, status: string): Promise<void> {
  if (!(JOB_STATUSES as readonly string[]).includes(status)) throw new UserError(`"${status}" isn't a job status. Use one of: ${JOB_STATUSES.join(', ')}.`);
  await db.query('update jobs set status = $2 where id = $1', [jobId, status]);
}

export interface NewJob {
  job_number: string | null;
  brand: string;
  client_name: string;
  suburb: string;
  scope: string;
  door_finish: 'melamine' | 'polyurethane';
  has_painting: boolean;
  has_stone: boolean;
  site_start: Iso | null;
  factory_days: number;
  install_days: number;
  notes: string;
  template: string | null;
  drawings_url?: string;
}

/** A web address for the drawings folder, or '' (George, 7 Nov 2026). Never a file, never anything but http(s). */
export function checkUrl(v: unknown, what: string): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  let u: URL;
  try { u = new URL(s); } catch { throw new UserError(`${what}: paste the full web address, starting with https://`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UserError(`${what}: paste a web address, starting with https://`);
  return s.slice(0, 500);
}

/** Adds a job with the given step dates; every other step the job needs is created with no date. */
export async function createJob(
  db: Db,
  v: NewJob,
  steps: { kind: StepKind; start_date: Iso | null; end_date: Iso | null }[],
  addedOn: Iso,
  confirmed = false,
): Promise<number> {
  if (!v.client_name.trim()) throw new UserError('Add the client name.');
  const job = await db.query(
    `insert into jobs (job_number, brand, client_name, suburb, scope, door_finish, has_painting, has_stone, site_start, factory_days, install_days, notes, added_on, template, drawings_url)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
    [v.job_number, v.brand, v.client_name, v.suburb, v.scope, v.door_finish, v.has_painting, v.has_stone, v.site_start, v.factory_days, v.install_days, v.notes, addedOn, v.template, v.drawings_url ?? '']);
  const jobId = job.rows[0].id as number;
  for (const p of steps) {
    const end = checkDates(p.start_date, p.end_date, KINDS[p.kind].label);
    await db.query(`insert into steps (job_id, kind, start_date, end_date, owner, sort, confirmed) values ($1,$2,$3,$4,$5,$6,$7)`,
      [jobId, p.kind, p.start_date, end, KINDS[p.kind].owner, FLOW.indexOf(p.kind) * 10, confirmed && !!p.start_date]);
  }
  await syncStepSet(db, jobId);
  return jobId;
}
