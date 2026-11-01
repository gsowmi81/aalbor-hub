// The bot's API (Grokbot, George 1 Nov 2026). Bearer token only, no cookies. A token can add
// and read suggestions and read jobs; it can never change a job (Postgres refuses: see
// withToken() and migration 005). Every call is logged in api_calls; 60 calls a minute per token.
import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import { pool, withSystem, withToken } from '../db/pool.js';
import { checkItem, insertSuggestions, knownJobs, loadSuggestions, MAX_ITEMS, NewSuggestion, STATUSES, Suggestion } from '../db/suggestions.js';
import { UserError } from '../db/edits.js';
import { FLOW, KINDS, StepKind } from '../domain/steps.js';
import { config } from '../config.js';
import { sendSuggestionsEmail } from './mail.js';

export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
export const newToken = () => `hub_${crypto.randomBytes(32).toString('base64url')}`;

const PER_MINUTE = 60;
const windows = new Map<string, { start: number; n: number }>();
function overLimit(key: string, now = Date.now()): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    windows.set(key, { start: now, n: 1 });
    if (windows.size > 5000) for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
    return false;
  }
  w.n += 1;
  return w.n > PER_MINUTE;
}

interface ApiLocals { tokenId?: number; tokenName?: string; items?: number }
const loc = (res: Response) => res.locals as ApiLocals;

function fail(res: Response, status: number, error: string) {
  res.status(status).json({ error });
}

export function apiRoutes(): express.Router {
  const r = express.Router();

  // Log every call, good token or not.
  r.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      withSystem((db) => db.query('insert into api_calls (token_id, method, path, status, items, ip) values ($1,$2,$3,$4,$5,$6)',
        [loc(res).tokenId ?? null, req.method, req.originalUrl.slice(0, 300), res.statusCode, loc(res).items ?? null, req.ip ?? null]))
        .catch((err) => console.error('api_calls', err));
    });
    next();
  });

  r.use(async (req: Request, res: Response, next: NextFunction) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    // Calls without a good token are limited by address, so guessing tokens is slow.
    if (!m) return fail(res, overLimit(`ip:${req.ip}`) ? 429 : 401, 'Send the API token as: Authorization: Bearer <token>.');
    const t = (await pool.query('select id, name from api_tokens where token_hash = $1 and revoked_at is null', [hashToken(m[1])])).rows[0];
    if (!t) return fail(res, overLimit(`ip:${req.ip}`) ? 429 : 401, 'That API token is wrong or has been revoked.');
    loc(res).tokenId = t.id;
    loc(res).tokenName = t.name;
    if (overLimit(`token:${t.id}`)) return fail(res, 429, `More than ${PER_MINUTE} calls in a minute. Wait a minute.`);
    await withSystem((db) => db.query('update api_tokens set last_used_at = now() where id = $1', [t.id]));
    next();
  });

  r.use(express.json({ limit: '2mb' }));

  // ---------- Jobs, read only ----------

  r.get('/jobs', async (req, res) => {
    const all = req.query.status === 'all';
    const jobs = (await pool.query(
      `select id, job_number, brand, client_name, suburb, scope, door_finish, has_painting, has_stone, site_start, status, at_risk, notes, template
       from jobs ${all ? '' : `where status in ('live', 'on_hold')`} order by job_number nulls last, id`)).rows;
    const steps = (await pool.query(
      `select s.job_id, s.kind, s.label, s.start_date, s.end_date, s.confirmed, s.done_at, s.note, s.owner
       from steps s where s.kind <> 'rework' order by s.job_id, s.sort, s.id`)).rows;
    const byJob = new Map<number, typeof steps>();
    for (const s of steps) (byJob.get(s.job_id) ?? byJob.set(s.job_id, []).get(s.job_id)!).push(s);
    res.json({
      stages: FLOW.map((k) => ({ key: k, label: KINDS[k].label })),
      jobs: jobs.map((j) => ({
        ...j,
        stages: (byJob.get(j.id) ?? []).map((s) => ({
          key: s.label ? null : s.kind, kind: s.kind, label: s.label || KINDS[s.kind as StepKind].label, extra: !!s.label,
          start_date: s.start_date, end_date: s.end_date ?? s.start_date, confirmed: s.confirmed,
          status: s.done_at ? 'done' : 'not_done', done_at: s.done_at, owner: s.owner, note: s.note,
        })),
      })),
    });
  });

  // ---------- Suggestions ----------

  r.get('/suggestions', async (req, res) => {
    const status = String(req.query.status ?? 'all');
    if (status !== 'all' && !(STATUSES as readonly string[]).includes(status)) return fail(res, 400, `status must be all or one of: ${STATUSES.join(', ')}.`);
    const since = req.query.since ? String(req.query.since) : undefined;
    if (since && Number.isNaN(Date.parse(since))) return fail(res, 400, 'since must be a date or time, e.g. 2026-11-02 or 2026-11-02T06:00:00Z.');
    const rows = await loadSuggestions({ status, since, job: req.query.job_number ? String(req.query.job_number) : undefined, limit: 2000 });
    res.json({ suggestions: rows.map(publicRow) });
  });

  r.post('/suggestions', async (req, res) => {
    const body = req.body ?? {};
    const items: unknown[] = Array.isArray(body) ? body : body.suggestions;
    if (!Array.isArray(items)) return fail(res, 400, 'Send {"batch_id": "...", "suggestions": [ ... ]}.');
    if (items.length > MAX_ITEMS) return fail(res, 413, `At most ${MAX_ITEMS} suggestions per call.`);
    loc(res).items = items.length;
    const batchId = String((Array.isArray(body) ? '' : body.batch_id) ?? '').trim().slice(0, 100) || `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
    const source = String((Array.isArray(body) ? '' : body.source) ?? '').trim().slice(0, 60) || loc(res).tokenName || 'Bot';

    const jobs = await knownJobs();
    const good: { index: number; row: NewSuggestion; warnings: string[] }[] = [];
    const errors: { index: number; job_number?: string; error: string }[] = [];
    items.forEach((it, index) => {
      const warnings: string[] = [];
      try {
        good.push({ index, row: checkItem(it, jobs, warnings), warnings });
      } catch (err) {
        if (!(err instanceof UserError)) throw err;
        const jn = it && typeof it === 'object' ? (it as { job_number?: unknown }).job_number : undefined;
        errors.push({ index, ...(jn ? { job_number: String(jn) } : {}), error: err.message });
      }
    });

    const firstOfBatch = !(await pool.query('select 1 from suggestions where batch_id = $1 limit 1', [batchId])).rowCount;
    const ids = good.length ? await withToken(loc(res).tokenId!, (db) => insertSuggestions(db, good.map((g) => g.row), batchId, source)) : [];
    const created = good.map((g, i) => ({ index: g.index, id: ids[i], ...(g.warnings.length ? { warnings: g.warnings } : {}) }));
    res.status(errors.length && !created.length ? 400 : 201).json({ batch_id: batchId, created, errors });

    // One email per batch, only if something needs a person.
    const n = { urgent: 0, normal: 0, info: 0 };
    for (const g of good) n[g.row.priority] += 1;
    if (firstOfBatch && (n.urgent || n.normal)) {
      pool.query(`select value from app_settings where key = 'suggestions_email'`)
        .then((q) => q.rows[0]?.value && sendSuggestionsEmail(q.rows[0].value, n, source, `${config.appUrl}/suggestions?batch=${encodeURIComponent(batchId)}`))
        .catch((err) => console.error('suggestions email', err));
    }
  });

  r.use((_req: Request, res: Response) => fail(res, 404, 'No such API call. See README: GET /api/jobs, GET /api/suggestions, POST /api/suggestions.'));
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string })?.type === 'entity.parse.failed') return fail(res, 400, 'That body is not valid JSON.');
    if ((err as { type?: string })?.type === 'entity.too.large') return fail(res, 413, 'That body is too large.');
    console.error(err);
    fail(res, 500, 'The hub hit an error and nothing was saved.');
  });
  return r;
}

function publicRow(s: Suggestion) {
  return {
    id: s.id, created_at: s.created_at, source: s.source, batch_id: s.batch_id, job_id: s.job_id, job_number: s.job_number,
    stage_key: s.stage_key, type: s.type, field: s.field, current_value: s.current_value, proposed_value: s.proposed_value,
    reason: s.reason, priority: s.priority, status: s.status, superseded_by: s.superseded_by,
    decided_by: s.decided_by_name ?? null, decided_at: s.decided_at, decision_note: s.decision_note, failure: s.failure || null,
    payload: s.payload,
  };
}
