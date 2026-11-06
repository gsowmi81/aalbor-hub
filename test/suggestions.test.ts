// Suggestions from the bot, end to end: the API with a token, the Suggestions screen, and
// what Postgres lets a token, a Viewer and a Doer do. Fresh test database with the Notion jobs.
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { appDatabaseUrl } = await import('./db-setup.js');
process.env.DATABASE_URL = await appDatabaseUrl();
process.env.RESEND_API_KEY = '';
const { pool, withPerson, withSystem, withToken, isPermissionError } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { importNotion } = await import('../scripts/import-notion.js');
const { createApp } = await import('../src/server.js');
const { scrubContact, suburbOnly } = await import('../src/db/suggestions.js');

let server: Server;
let base = '';
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};
let token = '';
let tokenId = 0;

beforeAll(async () => {
  await migrate(() => {});
  await importNotion(() => {});
  await withSystem(async (db) => {
    for (const [name, role, owner] of [['George', 'editor', true], ['Christine', 'editor', false], ['Phil', 'doer', false], ['Angela', 'viewer', false]] as const) {
      const id = (await db.query(`insert into people (name, email, role, is_owner) values ($1, $2, $3, $4) returning id`, [name, `${name.toLowerCase()}@s.test`, role, owner])).rows[0].id;
      const t = crypto.randomBytes(16).toString('hex');
      await db.query(`insert into sessions (token_hash, person_id, expires_at) values ($1, $2, now() + interval '1 day')`, [crypto.createHash('sha256').update(t).digest('hex'), id]);
      cookies[name] = t;
      ids[name] = id;
    }
  });
  server = createApp().listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.close();
  await pool.end();
});

async function page(method: string, path: string, who?: string, body?: Record<string, string | string[]>) {
  const headers: Record<string, string> = { Origin: base };
  if (who) headers.Cookie = `hub_session=${cookies[who]}`;
  let data: string | undefined;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
    data = p.toString();
  }
  const res = await fetch(base + path, { method, headers, body: data, redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), text: await res.text(), cookie: res.headers.get('set-cookie') ?? '' };
}
async function api(method: string, path: string, body?: unknown, tok: string | null = token) {
  const headers: Record<string, string> = {};
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}
const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
const flashOf = (cookie: string) => decodeURIComponent(/hub_flash=([^;]*)/.exec(cookie)?.[1] ?? '');

/** A live job with a dated, unfinished install, for the date tests. */
async function liveInstall() {
  return one(`select j.id as job_id, j.job_number, s.id as step_id, s.start_date, s.end_date from jobs j join steps s on s.job_id = j.id
    where j.status = 'live' and j.job_number is not null and s.kind = 'install' and s.label = '' and s.start_date is not null and s.done_at is null
    order by j.id limit 1`);
}

async function refused(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) { if (isPermissionError(err)) return err.message; throw err; }
  throw new Error('expected the database to refuse this');
}

describe('API tokens', () => {
  it('an owner makes one, sees it once, and the hub keeps only its hash', async () => {
    const r = await page('POST', '/settings/tokens', 'George', { name: 'Grokbot' });
    expect(r.status).toBe(200);
    token = /value="(hub_[A-Za-z0-9_-]+)"/.exec(r.text)![1];
    const row = await one(`select id, token_hash, created_by from api_tokens where name = 'Grokbot'`);
    tokenId = row.id;
    expect(row.token_hash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(row.created_by).toBe(ids.George);
    expect((await page('GET', '/settings', 'George')).text).not.toContain(token);
  });

  it('an Editor who is not an owner cannot make or see tokens', async () => {
    const r = await page('POST', '/settings/tokens', 'Christine', { name: 'Sneaky' });
    expect(r.status).toBe(302);
    expect(flashOf(r.cookie)).toContain('Only an owner');
    expect((await page('GET', '/settings', 'Christine')).text).not.toContain('API tokens');
    expect(await refused(withPerson(ids.Christine, (db) => db.query(`insert into api_tokens (name, token_hash) values ('x', 'y')`)))).toContain('Only an owner');
  });

  it('refuses calls with no token or a wrong one, and logs them', async () => {
    expect((await api('GET', '/jobs', undefined, null)).status).toBe(401);
    expect((await api('GET', '/jobs', undefined, 'hub_wrong')).status).toBe(401);
    await new Promise((r) => setTimeout(r, 100));
    expect((await one(`select count(*)::int as n from api_calls where token_id is null and status = 401`)).n).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /api/jobs', () => {
  it('gives live jobs with every stage, read only', async () => {
    const r = await api('GET', '/jobs');
    expect(r.status).toBe(200);
    const j = await liveInstall();
    const job = r.json.jobs.find((x: { job_number: string }) => x.job_number === j.job_number);
    const install = job.stages.find((s: { key: string }) => s.key === 'install');
    expect(install).toMatchObject({ start_date: j.start_date, end_date: j.end_date ?? j.start_date, status: 'not_done' });
    expect(r.json.stages.map((s: { key: string }) => s.key)).toContain('check_measure');
    expect(JSON.stringify(r.json)).not.toContain('responsible');
    expect((await one(`select last_used_at from api_tokens where id = $1`, [tokenId])).last_used_at).toBeTruthy();
  });
});

describe('POST /api/suggestions', () => {
  it('takes a batch, saves the good ones and explains each bad one', async () => {
    const j = await liveInstall();
    const r = await api('POST', '/suggestions', {
      batch_id: 'test-1', source: 'Grokbot',
      suggestions: [
        { job_number: j.job_number, stage_key: 'install', type: 'update_date', field: 'start_date', current_value: j.start_date, proposed_value: '2026-12-07', reason: 'Buildertrend shows 07 Dec', priority: 'urgent' },
        { job_number: j.job_number, type: 'note', proposed_value: 'Client asked about handles, call 0412 345 678', priority: 'info' },
        { job_number: '999999', stage_key: 'install', type: 'update_date', proposed_value: '2026-12-01' },
        { job_number: j.job_number, stage_key: 'wardrobe', type: 'update_date', proposed_value: '2026-12-01' },
        { job_number: j.job_number, stage_key: 'install', type: 'update_date', proposed_value: '7/12/2026' },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.json.batch_id).toBe('test-1');
    expect(r.json.created.map((c: { index: number }) => c.index)).toEqual([0, 1]);
    expect(r.json.errors.map((e: { index: number }) => e.index)).toEqual([2, 3, 4]);
    expect(r.json.errors[0].error).toContain('no job 999999');
    expect(r.json.errors[1].error).toContain("isn't a stage");
    expect(r.json.errors[2].error).toContain('YYYY-MM-DD');
    const note = await one('select proposed_value, token_id, status from suggestions where id = $1', [r.json.created[1].id]);
    expect(note.proposed_value).not.toContain('0412');
    expect(note).toMatchObject({ token_id: tokenId, status: 'pending' });
  });

  it('a newer suggestion for the same job, stage and field replaces the older pending one', async () => {
    const j = await liveInstall();
    const older = await one(`select id from suggestions where batch_id = 'test-1' and type = 'update_date'`);
    const r = await api('POST', '/suggestions', { batch_id: 'test-2', suggestions: [
      { job_number: j.job_number, stage_key: 'install', type: 'update_date', current_value: j.start_date, proposed_value: '2026-12-08', reason: 'Moved again', priority: 'urgent' },
    ] });
    const newer = r.json.created[0].id;
    expect(await one('select status, superseded_by::int as by from suggestions where id = $1', [older.id])).toEqual({ status: 'superseded', by: newer });
    expect((await one('select status from suggestions where id = $1', [newer])).status).toBe('pending');
  });

  it('refuses a body that is not a batch, and more than 500 at once', async () => {
    expect((await api('POST', '/suggestions', { hello: 1 })).status).toBe(400);
    expect((await api('POST', '/suggestions', { suggestions: Array.from({ length: 501 }, () => ({})) })).status).toBe(413);
  });

  it('GET lists them by status and since', async () => {
    const r = await api('GET', '/suggestions?status=pending');
    expect(r.json.suggestions.length).toBeGreaterThanOrEqual(2);
    expect(r.json.suggestions.every((s: { status: string }) => s.status === 'pending')).toBe(true);
    expect((await api('GET', '/suggestions?since=2099-01-01')).json.suggestions).toEqual([]);
    expect((await api('GET', '/suggestions?status=maybe')).status).toBe(400);
  });
});

describe('what a token can do in the database', () => {
  it('cannot change a job or a step, only add suggestions', async () => {
    const j = await liveInstall();
    expect(await refused(withToken(tokenId, (db) => db.query(`update steps set start_date = '2027-01-01' where id = $1`, [j.step_id])))).toBe('Not signed in');
    expect(await refused(withToken(tokenId, (db) => db.query(`update jobs set status = 'cancelled' where id = $1`, [j.job_id])))).toBe('Not signed in');
    expect(await refused(withToken(tokenId, (db) => db.query(`insert into jobs (client_name) values ('Bot job')`)))).toBe('Not signed in');
    const pending = await one(`select id from suggestions where status = 'pending' limit 1`);
    expect(await refused(withToken(tokenId, (db) => db.query(`update suggestions set status = 'accepted' where id = $1`, [pending.id])))).toContain('only add');
    expect(await refused(withToken(tokenId, (db) => db.query(`delete from suggestions where id = $1`, [pending.id])))).toContain('never deleted');
  });
});

describe('deciding', () => {
  it('Accept moves the date, ticks it Confirmed and records the suggestion in the job history', async () => {
    const j = await liveInstall();
    await withSystem((db) => db.query('update steps set confirmed = false where id = $1', [j.step_id]));
    const s = await one(`select id from suggestions where status = 'pending' and type = 'update_date' and job_number = $1`, [j.job_number]);
    const r = await page('POST', '/suggestions/act', 'Christine', { act: `accept:${s.id}`, [`note_${s.id}`]: 'Checked with the client', back: '/suggestions' });
    expect(flashOf(r.cookie)).toContain('moved to 2026-12-08');
    const step = await one('select start_date, end_date, confirmed from steps where id = $1', [j.step_id]);
    expect(step.start_date).toBe('2026-12-08');
    expect(step.confirmed).toBe(true);
    if (j.end_date) expect(step.end_date).not.toBeNull(); // keeps its length
    expect(await one('select status, decided_by, decision_note from suggestions where id = $1', [s.id])).toEqual({ status: 'accepted', decided_by: ids.Christine, decision_note: 'Checked with the client' });
    const log = await one(`select person_name, suggestion_id::int as sid from change_log where table_name = 'steps' and record_id = $1 order by id desc limit 1`, [String(j.step_id)]);
    expect(log).toEqual({ person_name: 'Christine', sid: Number(s.id) });
    expect((await page('GET', `/jobs/${j.job_id}`, 'George')).text).toContain(`(suggestion #${s.id})`);
  });

  it('marks a suggestion "Couldn\'t apply" and changes nothing if the hub moved since the bot looked', async () => {
    const j = await liveInstall();
    const r = await api('POST', '/suggestions', { batch_id: 'test-3', suggestions: [
      { job_number: j.job_number, stage_key: 'install', type: 'update_date', current_value: '2026-01-01', proposed_value: '2026-12-20', priority: 'normal' },
    ] });
    const id = r.json.created[0].id;
    const before = await one('select start_date from steps where id = $1', [j.step_id]);
    const res = await page('POST', '/suggestions/act', 'George', { act: `accept:${id}` });
    expect(flashOf(res.cookie)).toContain('The hub changed since the bot looked');
    expect(await one('select start_date from steps where id = $1', [j.step_id])).toEqual(before);
    const s = await one('select status, failure from suggestions where id = $1', [id]);
    expect(s.status).toBe('failed');
    expect(s.failure).toContain('expected 2026-01-01');
  });

  it('Decline and "Buildertrend is wrong" change nothing in the job', async () => {
    const j = await liveInstall();
    const r = await api('POST', '/suggestions', { batch_id: 'test-4', suggestions: [
      { job_number: j.job_number, stage_key: 'install', type: 'update_date', current_value: j.start_date, proposed_value: '2027-02-01' },
      { job_number: j.job_number, stage_key: 'check_measure', type: 'tick_confirmed', current_value: 'true', proposed_value: 'false' },
    ] });
    const [a, b] = r.json.created.map((c: { id: number }) => c.id);
    const logBefore = (await one('select count(*)::int as n from change_log')).n;
    await page('POST', '/suggestions/act', 'George', { act: `decline:${a}` });
    await page('POST', '/suggestions/act', 'George', { act: `bt_wrong:${b}`, [`note_${b}`]: 'Christine re-measured' });
    expect((await one('select count(*)::int as n from change_log')).n).toBe(logBefore);
    expect((await one('select start_date from steps where id = $1', [j.step_id])).start_date).toBe(j.start_date);
    expect(await one('select status, decision_note from suggestions where id = $1', [b])).toEqual({ status: 'bt_wrong', decision_note: 'Christine re-measured' });
    expect((await one('select status from suggestions where id = $1', [a])).status).toBe('declined');
    // Once decided, it stays decided.
    expect(await refused(withPerson(ids.George, (db) => db.query(`update suggestions set status = 'accepted' where id = $1`, [a])))).toContain('already been dealt with');
  });

  it('a Viewer or a Doer can look but not act', async () => {
    const s = await one(`select id from suggestions where status = 'pending' limit 1`);
    const viewer = await page('GET', '/suggestions', 'Angela');
    expect(viewer.status).toBe(200);
    expect(viewer.text).toContain(`#${s.id}`);
    expect(viewer.text).not.toContain(`accept:${s.id}`);
    expect((await page('POST', '/suggestions/act', 'Angela', { act: `accept:${s.id}` })).status).toBe(403);
    expect((await page('POST', '/suggestions/act', 'Phil', { act: `decline:${s.id}` })).status).toBe(403);
    expect(await refused(withPerson(ids.Angela, (db) => db.query(`update suggestions set status = 'declined' where id = $1`, [s.id])))).toContain('Only Editors');
    expect(await refused(withPerson(ids.Phil, (db) => db.query(`update suggestions set status = 'declined' where id = $1`, [s.id])))).toContain('Only Editors');
    expect((await one('select status from suggestions where id = $1', [s.id])).status).toBe('pending');
  });

  it('status and done suggestions use the same edits as the job screen', async () => {
    const j = await liveInstall();
    const cm = await one(`select id, done_at from steps where job_id = $1 and kind = 'check_measure' and label = ''`, [j.job_id]);
    const r = await api('POST', '/suggestions', { batch_id: 'test-5', suggestions: [
      { job_number: j.job_number, type: 'update_status', current_value: 'live', proposed_value: 'on hold' },
      { job_number: j.job_number, stage_key: 'check_measure', type: 'update_status', current_value: cm.done_at ? 'done' : 'not_done', proposed_value: cm.done_at ? 'not_done' : 'done' },
    ] });
    expect(r.json.errors).toEqual([]);
    const created = r.json.created.map((c: { id: number }) => String(c.id));
    const res = await page('POST', '/suggestions/act', 'George', { act: 'accept-selected', ids: created });
    expect(flashOf(res.cookie)).toBe('2 done.');
    expect((await one('select status from jobs where id = $1', [j.job_id])).status).toBe('on_hold');
    const after = await one('select done_at, done_by from steps where id = $1', [cm.id]);
    expect(!!after.done_at).toBe(!cm.done_at);
    if (after.done_at) expect(after.done_by).toBe(ids.George);
    await withSystem((db) => db.query(`update jobs set status = 'live' where id = $1`, [j.job_id]));
  });

  it('add_job keeps the suburb only, drops contact details, and accepting adds the job with No date for unknown stages', async () => {
    const r = await api('POST', '/suggestions', { batch_id: 'test-6', suggestions: [{
      job_number: '261120', type: 'add_job', priority: 'normal', reason: 'New contract in Buildertrend',
      payload: { client_name: 'Jo Bloggs', suburb: '12 Smith St, Botany NSW 2019', phone: '0412 345 678', email: 'jo@example.com', address: '12 Smith St',
        template: 'kitchen_melamine', site_start: '2026-11-20', notes: 'Call jo@example.com', stages: { install: { start_date: '2026-12-14', end_date: '2026-12-16' } } },
    }] });
    expect(r.json.created[0].warnings.join(' ')).toContain('left out');
    const id = r.json.created[0].id;
    const stored = JSON.stringify((await one('select payload from suggestions where id = $1', [id])).payload);
    expect(stored).not.toMatch(/Smith|0412|example\.com/);
    expect(stored).toContain('"suburb":"Botany"');
    const res = await page('POST', '/suggestions/act', 'George', { act: `accept:${id}` });
    expect(flashOf(res.cookie)).toContain('Job 261120 added');
    const job = await one(`select id, client_name, suburb, door_finish, has_painting, site_start from jobs where job_number = '261120'`);
    expect(job).toMatchObject({ client_name: 'Jo Bloggs', suburb: 'Botany', door_finish: 'melamine', has_painting: false, site_start: '2026-11-20' });
    const steps = (await pool.query(`select kind, start_date, end_date, confirmed from steps where job_id = $1`, [job.id])).rows;
    expect(steps.find((s) => s.kind === 'install')).toMatchObject({ start_date: '2026-12-14', end_date: '2026-12-16', confirmed: true });
    expect(steps.filter((s) => s.kind !== 'install').every((s) => s.start_date === null)).toBe(true);
    expect((await one('select job_id from suggestions where id = $1', [id])).job_id).toBe(job.id);
    // The same job again is refused at the door.
    const again = await api('POST', '/suggestions', { suggestions: [{ job_number: '261120', type: 'add_job', payload: { client_name: 'Jo' } }] });
    expect(again.status).toBe(400);
    expect(again.json.errors[0].error).toContain('already in the hub');
  });
});

describe('screens', () => {
  it('shows the waiting count on the tab, groups by job, and has panels on Coming up and the job', async () => {
    const j = await liveInstall();
    await api('POST', '/suggestions', { batch_id: 'test-7', suggestions: [
      { job_number: j.job_number, stage_key: 'install', type: 'update_date', current_value: j.start_date, proposed_value: '2027-03-01', priority: 'urgent' },
    ] });
    const n = (await one(`select count(*)::int as n from suggestions where status = 'pending'`)).n;
    const home = await page('GET', '/', 'Christine');
    expect(home.text).toContain(`aria-label="${n} waiting"`);
    expect(home.text).toContain('Pending suggestions');
    expect((await page('GET', `/jobs/${j.job_id}`, 'Christine')).text).toContain('Pending suggestions');
    const list = await page('GET', '/suggestions?priority=urgent', 'Christine');
    expect(list.text).toContain('Urgent');
    expect((await page('GET', '/suggestions?status=all&date=2026-01-01', 'Christine')).text).toContain('No suggestions match');
    expect((await page('GET', '/suggestions?batch=test-7', 'Christine')).text).toContain('Only batch test-7');
  });

  it('an Editor changes where the suggestions email goes', async () => {
    await page('POST', '/settings/suggestions-email', 'Christine', { email: 'Office@Aalborkitchens.com.au' });
    expect((await one(`select value from app_settings where key = 'suggestions_email'`)).value).toBe('office@aalborkitchens.com.au');
    expect((await one(`select person_name from change_log where table_name = 'app_settings' order by id desc limit 1`)).person_name).toBe('Christine');
  });

  it('sends one email per batch, and none for info-only batches', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const j = await liveInstall();
    await api('POST', '/suggestions', { batch_id: 'mail-1', suggestions: [{ job_number: j.job_number, type: 'note', proposed_value: 'FYI', priority: 'info' }] });
    await api('POST', '/suggestions', { batch_id: 'mail-2', suggestions: [{ job_number: j.job_number, stage_key: 'install', type: 'tick_confirmed', current_value: 'yes', proposed_value: 'no', priority: 'urgent' }] });
    await api('POST', '/suggestions', { batch_id: 'mail-2', suggestions: [{ job_number: j.job_number, type: 'note', proposed_value: 'More', priority: 'normal' }] });
    await new Promise((r) => setTimeout(r, 150));
    const sent = log.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[suggestions email'));
    log.mockRestore();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('office@aalborkitchens.com.au');
    expect(sent[0]).toContain('1 urgent');
  });
});

describe('clearing the pending queue before a fresh rebuild (George, 6 Nov 2026)', () => {
  const pendingN = async () => (await one(`select count(*)::int as n from suggestions where status = 'pending'`)).n;
  const decided = async () => (await pool.query(`select id, status, decided_by, decided_at, decision_note from suggestions where status not in ('pending', 'superseded') order by id`)).rows;
  async function queue(batch: string, n = 2) {
    const j = await liveInstall();
    const r = await api('POST', '/suggestions', { batch_id: batch, suggestions: Array.from({ length: n }, (_, i) =>
      ({ job_number: j.job_number, type: 'note', proposed_value: `Check ${batch} ${i}`, priority: 'info' })) });
    expect(r.status).toBe(201);
  }

  it('the bot supersedes every pending suggestion, keeps decided ones, records why and who, and sends no email', async () => {
    await queue('stale-1', 3);
    const before = await pendingN();
    const keep = await decided();
    expect(before).toBeGreaterThan(2);
    expect(keep.length).toBeGreaterThan(0);
    const waiting = (await pool.query(`select id::int as id from suggestions where status = 'pending' order by id`)).rows.map((r) => r.id);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await api('POST', '/suggestions/supersede-pending', { reason: 'Fresh rebuild 2026-11-06-refresh', batch_id: '2026-11-06-refresh' });
    await new Promise((x) => setTimeout(x, 150));
    const mails = log.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[suggestions email'));
    log.mockRestore();

    expect(r.status).toBe(200);
    expect(r.json).toEqual({ superseded: before, ids: waiting });
    expect(mails).toHaveLength(0);
    expect(await pendingN()).toBe(0);
    expect(await decided()).toEqual(keep);
    const row = await one('select status, decision_note, decided_by, decided_by_token, decided_at from suggestions where id = $1', [waiting[0]]);
    expect(row).toMatchObject({ status: 'superseded', decision_note: 'Fresh rebuild 2026-11-06-refresh', decided_by: null, decided_by_token: tokenId });
    expect(row.decided_at).not.toBeNull();
    const listed = await api('GET', '/suggestions?status=superseded');
    expect(listed.json.suggestions.find((x: { id: number }) => x.id === waiting[0]).decided_by).toMatch(/^api:/);
    const call = await one(`select status, items from api_calls where path = '/api/suggestions/supersede-pending' order by id desc limit 1`);
    expect(call).toEqual({ status: 200, items: before });
  });

  it('with nothing waiting, or no body at all, it supersedes nothing; a default reason is used', async () => {
    expect((await api('POST', '/suggestions/supersede-pending')).json).toEqual({ superseded: 0, ids: [] });
    await queue('stale-2', 1);
    const r = await api('POST', '/suggestions/supersede-pending', { batch_id: 'b-7' });
    expect(r.json.superseded).toBe(1);
    expect((await one('select decision_note from suggestions where id = $1', [r.json.ids[0]])).decision_note).toBe('Superseded by bot rebuild (b-7)');
  });

  it('still lets the token do nothing else: no accepting, no undoing a decision, no job edits', async () => {
    await queue('stale-3', 1);
    const s = await one(`select id from suggestions where status = 'pending' limit 1`);
    const done = await one(`select id from suggestions where status in ('accepted', 'declined', 'bt_wrong') limit 1`);
    const j = await liveInstall();
    expect(await refused(withToken(tokenId, (db) => db.query(`update suggestions set status = 'accepted' where id = $1`, [s.id])))).toMatch(/token/);
    expect(await refused(withToken(tokenId, (db) => db.query(`update suggestions set status = 'superseded' where id = $1`, [done.id])))).toMatch(/token/);
    expect(await refused(withToken(tokenId, (db) => db.query(`update suggestions set status = 'superseded', proposed_value = 'x' where id = $1`, [s.id])))).toMatch(/token/);
    expect(await refused(withToken(tokenId, (db) => db.query(`update steps set start_date = '2026-12-01' where id = $1`, [j.step_id])))).toBeTruthy();
  });

  it('an Editor can do the same from the Suggestions screen; Viewers and Doers cannot', async () => {
    const viewer = await page('GET', '/suggestions', 'Angela');
    expect(viewer.text).not.toContain('/suggestions/supersede-pending');
    expect((await page('POST', '/suggestions/supersede-pending', 'Angela', {})).status).toBe(403);
    expect((await page('POST', '/suggestions/supersede-pending', 'Phil', {})).status).toBe(403);
    expect(await pendingN()).toBe(1);
    const ed = await page('GET', '/suggestions', 'Christine');
    expect(ed.text).toContain('Supersede all 1 waiting');
    const r = await page('POST', '/suggestions/supersede-pending', 'Christine', { reason: '' });
    expect(flashOf(r.cookie)).toContain('1 waiting suggestion marked superseded');
    expect(await pendingN()).toBe(0);
    const row = await one(`select decided_by, decision_note from suggestions where batch_id = 'stale-3'`);
    expect(row).toEqual({ decided_by: ids.Christine, decision_note: 'Cleared by Christine before a fresh rebuild' });
    expect((await page('GET', '/suggestions?status=superseded', 'Angela')).text).toContain('by Christine');
  });
});

describe('limits', () => {
  it('a revoked token stops working', async () => {
    await page('POST', `/settings/tokens/${tokenId}/revoke`, 'George');
    expect((await api('GET', '/jobs')).status).toBe(401);
    expect(await refused(withPerson(ids.George, (db) => db.query(`update api_tokens set revoked_at = null where id = $1`, [tokenId])))).toContain('only be revoked');
  });

  it('more than 60 calls a minute from one token get "too many"', async () => {
    const r = await page('POST', '/settings/tokens', 'George', { name: 'Burst' });
    const t = /value="(hub_[A-Za-z0-9_-]+)"/.exec(r.text)![1];
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await api('GET', '/suggestions?since=2099-01-01', undefined, t)).status);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes[61]).toBe(429);
  });
});

describe('cleaning what the bot sends', () => {
  it('keeps the suburb from a street address', () => {
    expect(suburbOnly('12 Smith St, Botany NSW 2019')).toBe('Botany');
    expect(suburbOnly('Rose Bay')).toBe('Rose Bay');
    expect(suburbOnly('12 Smith St')).toBe('');
  });
  it('takes phone numbers and emails out of text', () => {
    expect(scrubContact('ring 0412 345 678 or (02) 9666 1234? jo@x.com')).not.toMatch(/0412|jo@x/);
    expect(scrubContact('Install 07 Dec, 3 days')).toBe('Install 07 Dec, 3 days');
  });
});

describe('database functions', () => {
  it('pin the search path, like the others (backups)', async () => {
    const r = await pool.query(`select proname, proconfig from pg_proc where proname in ('hub_token', 'hub_token_guard', 'hub_suggestion_guard', 'hub_suggestion_supersede', 'hub_log')`);
    expect(r.rows).toHaveLength(5);
    for (const f of r.rows) expect(f.proconfig, f.proname).toContain('search_path=public, pg_temp');
  });
});
