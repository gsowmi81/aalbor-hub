// Suggestions from the bot (Grokbot) that compares the hub with Buildertrend.
// The bot adds them through /api (src/web/api.ts); Editors accept or decline them on the
// Suggestions screen. Accepting runs the same edits (edits.ts) as the job screens, inside a
// transaction that first checks the hub still shows what the bot saw.
import { pool, withPerson, Db, isPermissionError } from './pool.js';
import { loadTemplates } from './queries.js';
import { addDays, daysBetween, Iso, todaySydney } from '../domain/dates.js';
import { FLOW, KINDS, StepKind } from '../domain/steps.js';
import { createJob, JOB_STATUSES, setJobStatus, setStepConfirmed, setStepDates, setStepDone, UserError } from './edits.js';

export const TYPES = ['update_date', 'update_status', 'tick_confirmed', 'add_job', 'note'] as const;
export type SuggestionType = (typeof TYPES)[number];
export const PRIORITIES = ['urgent', 'normal', 'info'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const STATUSES = ['pending', 'accepted', 'declined', 'bt_wrong', 'superseded', 'failed'] as const;
export type SuggestionStatus = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<SuggestionStatus, string> = {
  pending: 'Waiting', accepted: 'Accepted', declined: 'Declined', bt_wrong: 'Buildertrend is wrong', superseded: 'Replaced by a newer one', failed: "Couldn't apply",
};
export const JOB_STATUS_LABEL: Record<string, string> = { live: 'Live', on_hold: 'On hold', complete: 'Complete', cancelled: 'Cancelled' };

export interface Suggestion {
  id: number;
  created_at: string;
  source: string;
  batch_id: string;
  job_id: number | null;
  job_number: string | null;
  stage_key: StepKind | null;
  type: SuggestionType;
  field: string | null;
  current_value: string | null;
  proposed_value: string | null;
  reason: string;
  priority: Priority;
  status: SuggestionStatus;
  superseded_by: number | null;
  decided_by: number | null;
  decided_by_name?: string | null;
  /** Set when the bot's token decided it (a bulk supersede, or a newer suggestion). */
  decided_by_token?: number | null;
  decided_by_token_name?: string | null;
  decided_at: string | null;
  decision_note: string;
  failure: string;
  payload: AddJobPayload | null;
  client_name?: string | null;
}

export interface AddJobPayload {
  client_name: string;
  suburb?: string;
  brand?: 'Aalbor' | 'Origin';
  scope?: string;
  template?: string;
  door_finish?: 'melamine' | 'polyurethane';
  has_painting?: boolean;
  has_stone?: boolean;
  site_start?: Iso | null;
  factory_days?: number;
  install_days?: number;
  notes?: string;
  stages?: Partial<Record<StepKind, { start_date?: Iso | null; end_date?: Iso | null }>>;
}

export const MAX_ITEMS = 500;

// ---------- Checking what the bot sends ----------

const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

/** Phone numbers and email addresses stay in Buildertrend; take them out of free text. */
export function scrubContact(text: string): string {
  return text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[removed]')
    .replace(/(\+?61[\s-]?|\b0)[2-478](?:[\s-]?\d){8}\b/g, '[removed]')
    .replace(/\(0[2-478]\)\s?\d{4}[\s-]?\d{4}\b/g, '[removed]')
    .replace(/\b1[38]00[\s-]?\d{3}[\s-]?\d{3}\b/g, '[removed]');
}

/** A street address keeps only its suburb: "12 Smith St, Botany NSW 2019" → "Botany". */
export function suburbOnly(v: string): string {
  let s = v.trim();
  if (s.includes(',')) s = s.split(',').map((x) => x.trim()).filter(Boolean).pop() ?? '';
  s = s.replace(/\b(NSW|VIC|QLD|ACT|SA|WA|TAS|NT)\b/gi, '').replace(/\b\d{4}\b/g, '').trim();
  if (/\d/.test(s)) return ''; // still looks like a street: leave it out
  return s.replace(/\s+/g, ' ');
}

function normValue(type: SuggestionType, field: string | null, v: unknown, what: string): string | null {
  const s = str(v);
  if (type === 'update_date') {
    if (!s || /^(none|no date|null)$/i.test(s)) return null;
    if (!isIso(s)) throw new UserError(`${what} must be a date as YYYY-MM-DD, or empty for no date.`);
    return s;
  }
  if (type === 'update_status' && field === 'status') {
    if (!s) return null;
    const k = s.toLowerCase().replace(/[\s-]+/g, '_');
    if (!(JOB_STATUSES as readonly string[]).includes(k)) throw new UserError(`${what} must be one of: ${JOB_STATUSES.join(', ')}.`);
    return k;
  }
  if (type === 'update_status' && field === 'done') {
    if (/^(true|yes|done|complete|completed|1)$/i.test(s)) return 'done';
    if (!s || /^(false|no|not[ _]?done|open|0)$/i.test(s)) return 'not_done';
    throw new UserError(`${what} must be "done" or "not_done".`);
  }
  if (type === 'tick_confirmed') {
    if (/^(true|yes|1|confirmed)$/i.test(s)) return 'yes';
    if (!s || /^(false|no|0|provisional)$/i.test(s)) return 'no';
    throw new UserError(`${what} must be true or false.`);
  }
  return s ? scrubContact(s).slice(0, 2000) : null;
}

const KEEP = ['client_name', 'suburb', 'brand', 'scope', 'template', 'door_finish', 'has_painting', 'has_stone', 'site_start', 'factory_days', 'install_days', 'notes', 'stages'];

function addJobPayload(raw: unknown, warnings: string[]): AddJobPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UserError('add_job needs a payload object with at least client_name.');
  const p = raw as Record<string, unknown>;
  const dropped = Object.keys(p).filter((k) => !KEEP.includes(k));
  if (dropped.length) warnings.push(`left out ${dropped.join(', ')} (addresses, phone numbers and emails stay in Buildertrend)`);
  const client = scrubContact(str(p.client_name)).slice(0, 200);
  if (!client) throw new UserError('add_job: payload.client_name is missing.');
  const out: AddJobPayload = { client_name: client };
  if (p.suburb !== undefined) {
    out.suburb = suburbOnly(str(p.suburb)).slice(0, 100);
    if (str(p.suburb) && out.suburb !== str(p.suburb)) warnings.push(`suburb kept as "${out.suburb}" (no street address)`);
  }
  if (p.brand !== undefined) {
    if (!['Aalbor', 'Origin'].includes(str(p.brand))) throw new UserError('add_job: brand must be Aalbor or Origin.');
    out.brand = str(p.brand) as 'Aalbor' | 'Origin';
  }
  if (p.scope !== undefined) out.scope = scrubContact(str(p.scope)).slice(0, 300);
  if (p.notes !== undefined) out.notes = scrubContact(str(p.notes)).slice(0, 2000);
  if (p.template !== undefined) out.template = str(p.template);
  if (p.door_finish !== undefined) {
    if (!['melamine', 'polyurethane'].includes(str(p.door_finish))) throw new UserError('add_job: door_finish must be melamine or polyurethane.');
    out.door_finish = str(p.door_finish) as 'melamine' | 'polyurethane';
  }
  for (const k of ['has_painting', 'has_stone'] as const) if (p[k] !== undefined) out[k] = p[k] === true || /^(true|yes|1)$/i.test(str(p[k]));
  for (const k of ['factory_days', 'install_days'] as const) {
    if (p[k] === undefined) continue;
    const n = Number(p[k]);
    if (!Number.isInteger(n) || n < 1 || n > 30) throw new UserError(`add_job: ${k} must be a whole number from 1 to 30.`);
    out[k] = n;
  }
  if (p.site_start !== undefined && str(p.site_start)) {
    if (!isIso(str(p.site_start))) throw new UserError('add_job: site_start must be YYYY-MM-DD.');
    out.site_start = str(p.site_start);
  }
  if (p.stages !== undefined) {
    if (!p.stages || typeof p.stages !== 'object' || Array.isArray(p.stages)) throw new UserError('add_job: stages must be an object keyed by stage, e.g. {"install": {"start_date": "2026-12-01"}}.');
    out.stages = {};
    for (const [k, v] of Object.entries(p.stages as Record<string, unknown>)) {
      if (!FLOW.includes(k as StepKind)) throw new UserError(`add_job: "${k}" isn't a stage. Use one of: ${FLOW.join(', ')}.`);
      const o = (v ?? {}) as Record<string, unknown>;
      const a = str(o.start_date), b = str(o.end_date);
      if ((a && !isIso(a)) || (b && !isIso(b))) throw new UserError(`add_job: ${k} dates must be YYYY-MM-DD.`);
      if (!a && b) throw new UserError(`add_job: ${k} has an end_date but no start_date.`);
      if (a && b && b < a) throw new UserError(`add_job: ${k} ends before it starts.`);
      out.stages[k as StepKind] = { start_date: a || null, end_date: b || null };
    }
  }
  return out;
}

export interface NewSuggestion {
  job_id: number | null;
  job_number: string | null;
  stage_key: StepKind | null;
  type: SuggestionType;
  field: string | null;
  current_value: string | null;
  proposed_value: string | null;
  reason: string;
  priority: Priority;
  payload: AddJobPayload | null;
}

interface KnownJob { id: number; job_number: string; kinds: Set<string> }

/** Checks one item from the bot. Throws UserError with a plain reason if it can't be taken. */
export function checkItem(raw: unknown, jobs: Map<string, KnownJob>, warnings: string[]): NewSuggestion {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UserError('Each suggestion must be an object.');
  const it = raw as Record<string, unknown>;
  const type = str(it.type) as SuggestionType;
  if (!TYPES.includes(type)) throw new UserError(`type must be one of: ${TYPES.join(', ')}.`);
  const priority = (str(it.priority) || 'normal') as Priority;
  if (!PRIORITIES.includes(priority)) throw new UserError(`priority must be one of: ${PRIORITIES.join(', ')}.`);
  const reason = scrubContact(str(it.reason)).slice(0, 2000);
  const jobNumber = str(it.job_number) || null;
  const stage = (str(it.stage_key) || null) as StepKind | null;
  if (stage && !FLOW.includes(stage)) throw new UserError(`stage_key "${stage}" isn't a stage. Use one of: ${FLOW.join(', ')}.`);

  if (type !== 'note' && !jobNumber) throw new UserError('job_number is missing.');
  const job = jobNumber ? jobs.get(jobNumber.toLowerCase()) : undefined;

  if (type === 'add_job') {
    if (job) throw new UserError(`Job ${jobNumber} is already in the hub; send update_date suggestions instead.`);
    if (stage) throw new UserError('add_job takes no stage_key; put stage dates in payload.stages.');
    return { job_id: null, job_number: jobNumber, stage_key: null, type, field: null, current_value: null, proposed_value: null, reason, priority, payload: addJobPayload(it.payload, warnings) };
  }
  if (jobNumber && !job) throw new UserError(`There's no job ${jobNumber} in the hub. Use add_job to suggest adding it.`);
  if (stage && job && !job.kinds.has(stage)) throw new UserError(`Job ${jobNumber} has no ${KINDS[stage].label} stage (it may have no painting or stone).`);

  let field: string | null = null;
  if (type === 'update_date') {
    if (!stage) throw new UserError('update_date needs a stage_key.');
    field = str(it.field) || 'start_date';
    if (!['start_date', 'end_date'].includes(field)) throw new UserError('field must be start_date or end_date.');
  } else if (type === 'update_status') {
    field = stage ? 'done' : 'status';
  } else if (type === 'tick_confirmed') {
    if (!stage) throw new UserError('tick_confirmed needs a stage_key.');
    field = 'confirmed';
  }
  const proposed = normValue(type, field, it.proposed_value, 'proposed_value');
  if (type === 'update_status' && field === 'status' && !proposed) throw new UserError('proposed_value is missing.');
  if (type === 'note' && !proposed && !reason) throw new UserError('A note needs some text in proposed_value or reason.');
  return {
    job_id: job?.id ?? null, job_number: job?.job_number ?? jobNumber, stage_key: stage, type, field,
    current_value: type === 'note' ? null : normValue(type, field, it.current_value, 'current_value'),
    proposed_value: proposed, reason, priority, payload: null,
  };
}

export async function knownJobs(): Promise<Map<string, KnownJob>> {
  const r = await pool.query(`select j.id, j.job_number, coalesce(array_agg(s.kind) filter (where s.label = '' and s.kind <> 'rework'), '{}') as kinds
    from jobs j left join steps s on s.job_id = j.id where j.job_number is not null group by j.id`);
  return new Map(r.rows.map((j) => [String(j.job_number).toLowerCase(), { id: j.id, job_number: j.job_number, kinds: new Set(j.kinds) }]));
}

/** Saves checked suggestions as the bot's token. Returns their ids in order. */
export async function insertSuggestions(db: Db, rows: NewSuggestion[], batchId: string, source: string): Promise<number[]> {
  const ids: number[] = [];
  for (const s of rows) {
    const r = await db.query(
      `insert into suggestions (source, batch_id, job_id, job_number, stage_key, type, field, current_value, proposed_value, reason, priority, payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [source, batchId, s.job_id, s.job_number, s.stage_key, s.type, s.field, s.current_value, s.proposed_value, s.reason, s.priority, s.payload ? JSON.stringify(s.payload) : null]);
    ids.push(Number(r.rows[0].id));
  }
  return ids;
}

// ---------- Reading ----------

export interface SuggestionFilter { id?: number; status?: string; priority?: string; job?: string; batchDate?: string; jobId?: number; since?: string; limit?: number }

export async function loadSuggestions(f: SuggestionFilter = {}): Promise<Suggestion[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.id) add('s.id = ?', f.id);
  if (f.status && f.status !== 'all') add('s.status = ?', f.status);
  if (f.priority && f.priority !== 'all') add('s.priority = ?', f.priority);
  if (f.job) add('lower(s.job_number) = lower(?)', f.job);
  if (f.jobId) add('s.job_id = ?', f.jobId);
  if (f.batchDate) add(`(s.created_at at time zone 'Australia/Sydney')::date = ?::date`, f.batchDate);
  if (f.since) add('greatest(s.created_at, s.decided_at) >= ?::timestamptz', f.since);
  params.push(Math.min(f.limit ?? 500, 2000));
  const r = await pool.query(
    `select s.*, s.id::int as id, s.superseded_by::int as superseded_by, p.name as decided_by_name, t.name as decided_by_token_name, j.client_name
     from suggestions s left join people p on p.id = s.decided_by left join api_tokens t on t.id = s.decided_by_token left join jobs j on j.id = s.job_id
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by case s.priority when 'urgent' then 0 when 'normal' then 1 else 2 end, s.job_number nulls last, s.id
     limit $${params.length}`, params);
  return r.rows;
}

export const SUPERSEDE_NOTE = 'Superseded by bot rebuild';

/**
 * Clear the queue before a fresh rebuild (George, 6 Nov 2026): every pending suggestion becomes
 * superseded, with the reason. Run as the bot's token (withToken) or an Editor (withPerson); the
 * database records who and when on each row and refuses anyone else. Decided ones never change.
 */
export async function supersedePending(db: Db, note: string): Promise<number[]> {
  const r = await db.query(
    `update suggestions set status = 'superseded', decision_note = $1 where status = 'pending' returning id::int as id`,
    [note.trim().slice(0, 300) || SUPERSEDE_NOTE]);
  return r.rows.map((x) => x.id).sort((a, b) => a - b);
}

export async function pendingCount(): Promise<number> {
  return (await pool.query(`select count(*)::int as n from suggestions where status = 'pending'`)).rows[0].n;
}

// ---------- Deciding ----------

/** What the hub shows now for the thing a suggestion is about, in the same form the bot sends. */
async function hubValue(db: Db, s: Suggestion): Promise<{ value: string | null; stepId?: number; step?: { start_date: Iso | null; end_date: Iso | null; done_at: string | null } }> {
  if (s.type === 'update_status' && s.field === 'status') {
    const j = (await db.query('select status from jobs where id = $1 for update', [s.job_id])).rows[0];
    if (!j) throw new UserError('That job is no longer in the hub.');
    return { value: j.status };
  }
  const st = (await db.query(`select id, start_date, end_date, confirmed, done_at from steps where job_id = $1 and kind = $2 and label = '' for update`, [s.job_id, s.stage_key])).rows[0];
  if (!st) throw new UserError(`This job has no ${KINDS[s.stage_key!]?.label ?? 'such'} stage now.`);
  const value = s.type === 'update_date'
    ? (s.field === 'end_date' ? st.end_date ?? st.start_date : st.start_date)
    : s.type === 'tick_confirmed' ? (st.confirmed ? 'yes' : 'no')
    : st.done_at ? 'done' : 'not_done';
  return { value, stepId: st.id, step: st };
}

export function showValue(s: Pick<Suggestion, 'type' | 'field'>, v: string | null): string {
  if (s.type === 'update_date') return v ?? 'No date';
  if (s.field === 'status') return v ? JOB_STATUS_LABEL[v] ?? v : '—';
  if (s.field === 'done') return v === 'done' ? 'Done' : 'Not done';
  if (s.type === 'tick_confirmed') return v === 'yes' ? 'Confirmed' : 'Provisional';
  return v ?? '';
}

async function apply(db: Db, s: Suggestion, now: { value: string | null; stepId?: number; step?: { start_date: Iso | null; end_date: Iso | null } }): Promise<string | { message: string; jobId: number }> {
  const label = s.stage_key ? KINDS[s.stage_key].label : '';
  switch (s.type) {
    case 'update_date': {
      const st = now.step!;
      const p = s.proposed_value;
      if (s.field === 'start_date') {
        let end = st.end_date;
        if (!p) end = null;
        else if (end && st.start_date && end < p) end = addDays(p, daysBetween(st.start_date, end)); // keep its length
        else if (end && end < p) end = null;
        await setStepDates(db, now.stepId!, p, end, label);
      } else {
        if (!st.start_date) throw new UserError(`${label} has no start date, so it can't take an end date.`);
        await setStepDates(db, now.stepId!, st.start_date, p, label);
      }
      // Accepting a date from Buildertrend confirms it (George, 1 Nov 2026).
      await setStepConfirmed(db, now.stepId!, true);
      return p ? `${label} moved to ${p}, confirmed.` : `${label} date cleared.`;
    }
    case 'tick_confirmed':
      if (s.proposed_value === 'yes' && !now.step?.start_date) throw new UserError(`${label} has no date to confirm.`);
      await setStepConfirmed(db, now.stepId!, s.proposed_value === 'yes');
      return `${label} ${s.proposed_value === 'yes' ? 'confirmed' : 'marked provisional'}.`;
    case 'update_status':
      if (s.field === 'status') {
        await setJobStatus(db, s.job_id!, s.proposed_value!);
        return `Job is now ${JOB_STATUS_LABEL[s.proposed_value!]}.`;
      }
      await setStepDone(db, now.stepId!, s.proposed_value === 'done');
      return `${label} ${s.proposed_value === 'done' ? 'ticked done' : 'unticked'}.`;
    case 'add_job': {
      const p = s.payload!;
      const templates = await loadTemplates();
      const t = templates.find((x) => x.key === p.template)
        ?? templates.find((x) => x.has_painting === (p.has_painting ?? p.door_finish === 'polyurethane'))
        ?? templates[0];
      const door = p.door_finish ?? t?.door_finish ?? 'melamine';
      const steps = Object.entries(p.stages ?? {}).map(([kind, d]) => ({ kind: kind as StepKind, start_date: d?.start_date ?? null, end_date: d?.end_date ?? null }));
      const jobId = await createJob(db, {
        job_number: s.job_number, brand: p.brand ?? 'Aalbor', client_name: p.client_name, suburb: p.suburb ?? '', scope: p.scope ?? '',
        door_finish: door, has_painting: p.has_painting ?? t?.has_painting ?? door === 'polyurethane', has_stone: p.has_stone ?? t?.has_stone ?? true,
        site_start: p.site_start ?? null, factory_days: p.factory_days ?? t?.factory_days ?? 2, install_days: p.install_days ?? t?.install_days ?? 3,
        notes: p.notes ?? '', template: t?.key ?? null,
      }, steps, todaySydney(), true);
      return { message: `Job ${s.job_number} added.`, jobId };
    }
    case 'note':
      return 'Noted.';
  }
}

export type Action = 'accept' | 'decline' | 'bt_wrong';
export interface Outcome { id: number; result: 'accepted' | 'declined' | 'bt_wrong' | 'failed' | 'skipped'; message: string }

const same = (a: string | null, b: string | null) => (a ?? '') === (b ?? '');

/** Accept, decline or mark "Buildertrend is wrong", as the signed-in Editor. One transaction per suggestion. */
export async function decide(personId: number, id: number, action: Action, note: string): Promise<Outcome> {
  return withPerson(personId, async (db) => {
    await db.query("select set_config('hub.suggestion_id', $1, true)", [String(id)]);
    const s: Suggestion | undefined = (await db.query('select *, id::int as id from suggestions where id = $1 for update', [id])).rows[0];
    if (!s) return { id, result: 'skipped', message: `Suggestion ${id} isn't there.` };
    if (s.status !== 'pending') return { id, result: 'skipped', message: `Suggestion ${id} was already ${STATUS_LABEL[s.status].toLowerCase()}.` };
    const decideAs = async (status: SuggestionStatus, failure = '', jobId: number | null = s.job_id) =>
      db.query('update suggestions set status = $2, decision_note = $3, failure = $4, job_id = $5 where id = $1', [id, status, note.slice(0, 1000), failure, jobId]);

    if (action !== 'accept') {
      await decideAs(action === 'decline' ? 'declined' : 'bt_wrong');
      return { id, result: action === 'decline' ? 'declined' : 'bt_wrong', message: action === 'decline' ? 'Declined.' : 'Marked: Buildertrend is wrong.' };
    }
    if (s.type === 'add_job' && (await db.query('select 1 from jobs where lower(job_number) = lower($1)', [s.job_number])).rowCount) {
      const msg = `Job ${s.job_number} is already in the hub.`;
      await decideAs('failed', msg);
      return { id, result: 'failed', message: msg };
    }
    if ((s.type !== 'note' && s.type !== 'add_job') && !s.job_id) {
      const msg = 'That job is no longer in the hub.';
      await decideAs('failed', msg);
      return { id, result: 'failed', message: msg };
    }
    await db.query('savepoint apply');
    try {
      let now: Awaited<ReturnType<typeof hubValue>> = { value: null };
      if (s.type !== 'note' && s.type !== 'add_job') {
        now = await hubValue(db, s);
        if (!same(now.value, s.current_value)) {
          throw new UserError(`The hub changed since the bot looked: it expected ${showValue(s, s.current_value)}, the hub now shows ${showValue(s, now.value)}. Nothing changed.`);
        }
      }
      const done = await apply(db, s, now);
      await db.query('release savepoint apply');
      if (typeof done === 'string') {
        await decideAs('accepted');
        return { id, result: 'accepted', message: done };
      }
      await decideAs('accepted', '', done.jobId);
      return { id, result: 'accepted', message: done.message };
    } catch (err) {
      if (!(err instanceof UserError) && !isPermissionError(err) && !(typeof err === 'object' && err && 'code' in err && String((err as { code: string }).code).startsWith('23'))) throw err;
      await db.query('rollback to savepoint apply');
      const msg = err instanceof Error ? err.message : String(err);
      await decideAs('failed', msg);
      return { id, result: 'failed', message: msg };
    }
  });
}

/** Order to apply several at once: job, then the order the job runs, start dates before end dates. */
export function applyOrder(a: Suggestion, b: Suggestion): number {
  const fa = a.stage_key ? FLOW.indexOf(a.stage_key) : -1, fb = b.stage_key ? FLOW.indexOf(b.stage_key) : -1;
  return (a.job_number ?? '').localeCompare(b.job_number ?? '') || (a.type === 'add_job' ? -1 : 0) - (b.type === 'add_job' ? -1 : 0)
    || fa - fb || (a.field === 'start_date' ? 0 : 1) - (b.field === 'start_date' ? 0 : 1) || a.id - b.id;
}
