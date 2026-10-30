// End to end: the real app over HTTP, against a fresh test database loaded with the Notion snapshot.
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { appDatabaseUrl } = await import('./db-setup.js');
process.env.DATABASE_URL = await appDatabaseUrl();
process.env.RESEND_API_KEY = '';
const { pool, withSystem } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { importNotion } = await import('../scripts/import-notion.js');
const { createApp } = await import('../src/server.js');

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const ids: Record<string, number> = {};

beforeAll(async () => {
  await migrate(() => {});
  await importNotion(() => {});
  await withSystem(async (db) => {
    const christine = (await db.query(`select id from people where email = 'design@aalborkitchens.com.au'`)).rows[0].id;
    for (const [name, role, owner] of [['George', 'editor', true], ['Phil', 'doer', false], ['Angela', 'viewer', false], ['Gus', 'doer', true], ['Christine', 'editor', false]] as const) {
      const id = name === 'Christine' ? christine
        : (await db.query(`insert into people (name, email, role, is_owner) values ($1, $2, $3, $4) returning id`, [name, `${name.toLowerCase()}@test.au`, role, owner])).rows[0].id;
      const t = crypto.randomBytes(16).toString('hex');
      await db.query(`insert into sessions (token_hash, person_id, expires_at) values ($1, $2, now() + interval '1 day')`, [crypto.createHash('sha256').update(t).digest('hex'), id]);
      tokens[name] = t;
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

async function req(method: string, path: string, who?: string, body?: Record<string, string>, origin = base) {
  const headers: Record<string, string> = { Origin: origin };
  if (who) headers.Cookie = `hub_session=${tokens[who]}`;
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(base + path, { method, headers, body: body ? new URLSearchParams(body).toString() : undefined, redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), text: await res.text(), type: res.headers.get('content-type') };
}
const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

describe('sign-in', () => {
  it('sends people who are not signed in to the sign-in page', async () => {
    const r = await req('GET', '/');
    expect(r.status).toBe(302);
    expect(r.location).toBe('/login?next=%2F');
  });

  it('gives an unknown address the same answer and no link', async () => {
    const r = await req('POST', '/login', undefined, { email: 'stranger@example.com' });
    expect(r.text).toContain('a sign-in link is on its way');
    expect(r.text).not.toContain('open the sign-in link');
  });

  it('signs in with the emailed link once, through the button', async () => {
    const r = await req('POST', '/login', undefined, { email: 'GEORGE@test.au', next: '/jobs' });
    const link = r.text.match(/href="(http[^"]+auth\/verify[^"]+)"/)![1].replace(/&amp;/g, '&');
    const t = new URL(link).searchParams.get('t')!;
    const page = await req('GET', `/auth/verify?t=${t}`);
    expect(page.text).toContain('Sign in to the Aalbor Hub');
    const ok = await req('POST', '/auth/verify', undefined, { t, next: '/jobs' });
    expect(ok.status).toBe(302);
    expect(ok.location).toBe('/jobs');
    const again = await req('POST', '/auth/verify', undefined, { t, next: '/' });
    expect(again.status).toBe(400);
  });

  it('refuses a form posted from another site', async () => {
    const r = await req('POST', '/rework', 'Phil', { job_id: '1', cause: 'factory', note: 'x' }, 'https://evil.example');
    expect(r.status).toBe(403);
  });
});

describe('every screen renders', () => {
  it('for an Editor', async () => {
    const jobs = (await pool.query('select id from jobs')).rows;
    for (const p of ['/', '/?week=1', '/?brand=Origin', '/jobs', '/rework', '/settings', '/jobs/new', ...jobs.map((j) => `/jobs/${j.id}`)]) {
      const r = await req('GET', p, 'George');
      expect(r.status, p).toBe(200);
    }
  });

  it('for a Viewer, without Settings or New job', async () => {
    const r = await req('GET', '/', 'Angela');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('href="/settings"');
    expect((await req('GET', '/settings', 'Angela')).status).toBe(403);
  });

  it('shows the imported jobs on the board', async () => {
    const r = await req('GET', '/jobs', 'George');
    for (const name of ['Sean McGing', 'Nick Tesoriero', 'Bathroom Products Australia P/L', 'Wissam, Stage 3 Master wardrobe']) expect(r.text).toContain(name);
  });

  it('imports painting only on the 2-pac jobs, not on Polytec melamine', async () => {
    const painted = (await pool.query(`select client_name from jobs where has_painting order by client_name`)).rows.map((x) => x.client_name);
    expect(painted).toEqual(['Jonathan Sheridan', 'Malcolm Patch', 'Melissa Sharpe', 'Nick Tesoriero']);
  });
});

describe('Doers and Viewers', () => {
  it('lets a Doer tick a step, recorded against them', async () => {
    const s = await one(`select s.id from steps s join jobs j on j.id = s.job_id where j.client_name = 'Peter Jones' and s.kind = 'check_measure'`);
    const r = await req('POST', `/steps/${s.id}/done`, 'Phil', { done: '1', back: '/' });
    expect(r.status).toBe(302);
    expect((await one('select done_by from steps where id = $1', [s.id])).done_by).toBe(ids.Phil);
  });

  it("stops a Viewer ticking and a Doer changing dates", async () => {
    const s = await one(`select s.id, s.job_id from steps s join jobs j on j.id = s.job_id where j.client_name = 'Peter Jones' and s.kind = 'factory'`);
    expect((await req('POST', `/steps/${s.id}/done`, 'Angela', { done: '1' })).status).toBe(403);
    expect((await req('POST', `/jobs/${s.job_id}/dates`, 'Phil', { [`start_${s.id}`]: '2026-12-01' })).status).toBe(403);
  });
});

describe('Editors', () => {
  it('add a job with proposed, provisional dates', async () => {
    const r = await req('POST', '/jobs/new', 'George', {
      action: 'save', job_number: '270201', client_name: 'Test Client', suburb: 'Botany', brand: 'Origin',
      door_finish: 'melamine', has_stone: '1', factory_days: '2', install_days: '3', site_start: '',
    });
    expect(r.status).toBe(302);
    const job = await one(`select id, site_start, brand from jobs where job_number = '270201'`);
    expect(job.site_start).toBe('2027-02-01');
    expect(job.brand).toBe('Origin');
    const install = await one(`select start_date, end_date, confirmed from steps where job_id = $1 and kind = 'install'`, [job.id]);
    expect(install).toEqual({ start_date: '2027-03-01', end_date: '2027-03-03', confirmed: false });
    const dup = await req('POST', '/jobs/new', 'George', { action: 'save', job_number: '270201', client_name: 'Again', factory_days: '2', install_days: '3' });
    expect(dup.text).toContain('already in the hub');
  });

  it('move every open step a week with one tap', async () => {
    const job = await one(`select id from jobs where job_number = '270201'`);
    await req('POST', `/jobs/${job.id}/shift`, 'George', { n: '5' });
    const install = await one(`select start_date from steps where job_id = $1 and kind = 'install'`, [job.id]);
    expect(install.start_date).toBe('2027-03-08');
  });

  it('confirm a date and keep a history of the change', async () => {
    const job = await one(`select id from jobs where job_number = '270201'`);
    const s = await one(`select id, start_date from steps where job_id = $1 and kind = 'check_measure'`, [job.id]);
    await req('POST', `/jobs/${job.id}/dates`, 'George', { [`start_${s.id}`]: s.start_date, [`confirmed_${s.id}`]: '1' });
    expect(await one('select confirmed from steps where id = $1', [s.id])).toEqual({ confirmed: true });
    const page = await req('GET', `/jobs/${job.id}`, 'George');
    expect(page.text).toContain('Check measure: confirmed no → yes');
  });

  it('send a single date change with later steps to the Reschedule screen', async () => {
    const job = await one(`select id from jobs where job_number = '270201'`);
    const s = await one(`select id from steps where job_id = $1 and kind = 'check_measure'`, [job.id]);
    const r = await req('POST', `/jobs/${job.id}/dates`, 'George', { [`start_${s.id}`]: '2027-02-12' });
    expect(r.location).toBe(`/jobs/${job.id}/reschedule?step=${s.id}&start=2027-02-12`);
    expect((await one('select start_date from steps where id = $1', [s.id])).start_date).toBe('2027-02-11');
  });

  it('refuse a "to" date before the "from" date', async () => {
    const job = await one(`select id from jobs where job_number = '270201'`);
    const s = await one(`select id, start_date from steps where job_id = $1 and kind = 'contract_drafting'`, [job.id]);
    const r = await req('POST', `/jobs/${job.id}/dates`, 'George', { [`start_${s.id}`]: '2026-11-10', [`end_${s.id}`]: '2026-11-02' });
    expect(r.status).toBe(302);
    expect(decodeURIComponent(r.location ?? '')).toBe('/');
    expect((await one('select start_date from steps where id = $1', [s.id])).start_date).toBe(s.start_date);
  });

  it('clear a Needs a decision item with OK as is, and undo it', async () => {
    const home = await req('GET', '/', 'George');
    const m = home.text.match(/name="key" value="([^"]+)"><input type="hidden" name="fingerprint" value="([^"]+)">/)!;
    const key = m[1];
    const fingerprint = m[2].replace(/&quot;/g, '"');
    await req('POST', '/decisions/ok', 'George', { key, fingerprint, note: 'Kept' });
    expect((await one('select note from decisions where key = $1', [key])).note).toBe('Kept');
    await req('POST', '/decisions/undo', 'George', { key });
    expect(await one('select 1 from decisions where key = $1', [key])).toBeUndefined();
  });

  it('add blocked days, skipping weekends', async () => {
    await req('POST', '/settings/blocked', 'George', { from: '2026-12-24', to: '2027-01-05', scope: 'all', reason: 'Christmas shutdown' });
    const n = (await one(`select count(*)::int as n from blocked_days where reason = 'Christmas shutdown'`)).n;
    // Weekdays 24 Dec to 5 Jan are 24, 25, 28, 29, 30, 31 Dec, 1, 4, 5 Jan; 25 and 28 Dec and 1 Jan are already public holidays.
    expect(n).toBe(6);
  });
});

describe('rework', () => {
  it('is raised by a Doer and closed by an Editor', async () => {
    const job = await one(`select id from jobs where client_name = 'Malcolm Patch'`);
    await req('POST', '/rework', 'Phil', { job_id: String(job.id), cause: 'factory', note: 'Door chipped in the factory' });
    const rw = await one(`select id, raised_by from rework where note = 'Door chipped in the factory'`);
    expect(rw.raised_by).toBe(ids.Phil);
    expect((await req('POST', `/rework/${rw.id}/close`, 'Phil', { extra_hours: '2', extra_material_cost: '80', cause: 'factory' })).status).toBe(403);
    await req('POST', `/rework/${rw.id}/close`, 'George', { extra_hours: '2.5', extra_material_cost: '80', cause: 'factory' });
    expect(await one('select extra_hours, extra_material_cost from rework where id = $1', [rw.id])).toEqual({ extra_hours: 2.5, extra_material_cost: 80 });
    const page = await req('GET', '/rework', 'Angela');
    expect(page.text).toContain('Door chipped in the factory');
  });
});

describe('rescheduling (George, 30 Oct 2026)', () => {
  const stepsOf = async (jobId: number) => Object.fromEntries((await pool.query(
    `select kind, start_date, end_date, confirmed from steps where job_id = $1 and label = '' and kind <> 'rework'`, [jobId])).rows.map((r) => [r.kind, r]));

  it('suggests moving everything after a step by the same working days, and saves it as provisional', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const before = await stepsOf(job.id);
    const dr = await one(`select id from steps where job_id = $1 and kind = 'production_drawings'`, [job.id]);
    const page = await req('GET', `/jobs/${job.id}/reschedule?step=${dr.id}&start=2026-11-16`, 'George');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Move everything after it');
    // Save what the screen suggests: post every date input it shows.
    const fields = Object.fromEntries([...page.text.matchAll(/name="((?:start|end)_\d+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const r = await req('POST', `/jobs/${job.id}/reschedule`, 'George', { step: String(dr.id), mode: 'shift', ...fields });
    expect(r.location).toBe(`/jobs/${job.id}`);
    const after = await stepsOf(job.id);
    expect(after.production_drawings.start_date).toBe('2026-11-16');
    expect(after.install.start_date).toBe('2026-12-01'); // was Mon 30 Nov, one working day later
    expect(after.install.confirmed).toBe(false);
    expect(after.check_measure.start_date).toBe(before.check_measure.start_date);
  });

  it('can keep the install date and squeeze the steps before it', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const before = await stepsOf(job.id);
    const dr = await one(`select id from steps where job_id = $1 and kind = 'production_drawings'`, [job.id]);
    const page = await req('GET', `/jobs/${job.id}/reschedule?step=${dr.id}&start=2026-11-17&mode=squeeze`, 'George');
    const fields = Object.fromEntries([...page.text.matchAll(/name="((?:start|end)_\d+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    await req('POST', `/jobs/${job.id}/reschedule`, 'George', { step: String(dr.id), mode: 'squeeze', ...fields });
    const after = await stepsOf(job.id);
    expect(after.production_drawings.start_date).toBe('2026-11-17');
    expect(after.install.start_date).toBe(before.install.start_date);
  });

  it('stops a step moving before what it waits for, unless you Move anyway, and then flags it', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const del = await one(`select id from steps where job_id = $1 and kind = 'delivery'`, [job.id]);
    const body = { step: String(del.id), mode: 'only', [`start_${del.id}`]: '2026-11-10' };
    const blocked = await req('POST', `/jobs/${job.id}/reschedule`, 'George', body);
    expect(blocked.status).toBe(200);
    expect(blocked.text).toContain('Move anyway');
    expect((await one('select start_date from steps where id = $1', [del.id])).start_date).not.toBe('2026-11-10');
    await req('POST', `/jobs/${job.id}/reschedule`, 'George', { ...body, override: '1' });
    expect((await one('select start_date from steps where id = $1', [del.id])).start_date).toBe('2026-11-10');
    const home = await req('GET', '/', 'George');
    expect(home.text).toContain("Delivery can&#39;t start before");
  });

  it('is for Editors only', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const del = await one(`select id from steps where job_id = $1 and kind = 'delivery'`, [job.id]);
    expect((await req('GET', `/jobs/${job.id}/reschedule?step=${del.id}`, 'Phil')).status).toBe(403);
  });
});

describe('templates (George, 30 Oct 2026)', () => {
  it('adds a job from its install date with the melamine kitchen template', async () => {
    const r = await req('POST', '/jobs/new', 'George', {
      action: 'save', client_name: 'Template Test', suburb: 'Mascot', template: 'kitchen_melamine', anchor: 'install', anchor_date: '2027-03-10',
      door_finish: 'melamine', has_stone: '1', factory_days: '2', install_days: '3', site_start: '',
    });
    expect(r.status).toBe(302);
    const job = await one(`select id, site_start, template from jobs where client_name = 'Template Test'`);
    expect(job.template).toBe('kitchen_melamine');
    expect(job.site_start).toBeTruthy();
    const install = await one(`select start_date, end_date from steps where job_id = $1 and kind = 'install'`, [job.id]);
    expect(install).toEqual({ start_date: '2027-03-10', end_date: '2027-03-12' });
  });
});

describe('round 1 changes (George, 30 Oct 2026)', () => {
  it('sends a checklist tick back to the same item, not the top of the page', async () => {
    const s = await one(`select s.id, s.job_id from steps s join jobs j on j.id = s.job_id where j.client_name = 'Greg Steven' and s.kind = 'check_measure'`);
    const page = await req('GET', `/jobs/${s.job_id}`, 'Phil');
    expect(page.text).toContain(`value="/jobs/${s.job_id}#c-${s.id}"`);
    const r = await req('POST', `/steps/${s.id}/done`, 'Phil', { done: '1', back: `/jobs/${s.job_id}#c-${s.id}` });
    expect(r.location).toBe(`/jobs/${s.job_id}#c-${s.id}`);
  });

  it('makes painting a choice when adding a job', async () => {
    const base = { action: 'save', suburb: 'Botany', door_finish: 'polyurethane', has_stone: '1', factory_days: '2', install_days: '3', site_start: '2027-02-01' };
    await req('POST', '/jobs/new', 'George', { ...base, client_name: 'Poly No Paint' });
    await req('POST', '/jobs/new', 'George', { ...base, client_name: 'Poly With Paint', has_painting: '1' });
    const kinds = async (name: string) => (await pool.query(
      `select s.kind from steps s join jobs j on j.id = s.job_id where j.client_name = $1 and s.kind like 'doors%' order by s.kind`, [name])).rows.map((x) => x.kind);
    expect(await kinds('Poly No Paint')).toEqual([]);
    expect(await kinds('Poly With Paint')).toEqual(['doors_back', 'doors_to_painting']);
  });

  it('adds or removes the painting steps when painting is ticked or unticked on a job', async () => {
    const job = await one(`select * from jobs where client_name = 'Poly No Paint'`);
    const form = { client_name: job.client_name, suburb: job.suburb, brand: job.brand, door_finish: job.door_finish, has_stone: '1', site_start: job.site_start, factory_days: '2', install_days: '3', status: 'live' };
    await req('POST', `/jobs/${job.id}/details`, 'George', { ...form, has_painting: '1' });
    expect((await one(`select count(*)::int as n from steps where job_id = $1 and kind like 'doors%'`, [job.id])).n).toBe(2);
    await req('POST', `/jobs/${job.id}/details`, 'George', form);
    expect((await one(`select count(*)::int as n from steps where job_id = $1 and kind like 'doors%'`, [job.id])).n).toBe(0);
  });

  it('lets an Editor delete a rework raised by mistake, with its steps, and keeps a record', async () => {
    const job = await one(`select id from jobs where client_name = 'Peter Jones'`);
    await req('POST', '/rework', 'Phil', { job_id: String(job.id), cause: 'install', note: 'Raised on the wrong job' });
    const rw = await one(`select id from rework where note = 'Raised on the wrong job'`);
    await req('POST', `/rework/${rw.id}/steps`, 'George', { label: 'Refit door', start: '2026-11-20' });
    expect((await req('POST', `/rework/${rw.id}/delete`, 'Phil', {})).status).toBe(403);
    await req('POST', `/rework/${rw.id}/delete`, 'George', { back: `/jobs/${job.id}#rework` });
    expect(await one('select 1 from rework where id = $1', [rw.id])).toBeUndefined();
    expect(await one(`select 1 from steps where rework_id = $1`, [rw.id])).toBeUndefined();
    const log = await one(`select person_name from change_log where table_name = 'rework' and record_id = $1 and action = 'delete'`, [String(rw.id)]);
    expect(log.person_name).toBe('George');
  });

  it("won't delete a standard step, but will delete a job added by mistake", async () => {
    const s = await one(`select s.id from steps s join jobs j on j.id = s.job_id where j.client_name = 'Poly With Paint' and s.kind = 'install'`);
    await req('POST', `/steps/${s.id}/delete`, 'George', {});
    expect(await one('select 1 from steps where id = $1', [s.id])).toBeTruthy();
    const job = await one(`select id from jobs where client_name = 'Poly With Paint'`);
    expect((await req('POST', `/jobs/${job.id}/delete`, 'Phil', {})).status).toBe(403);
    const r = await req('POST', `/jobs/${job.id}/delete`, 'George', {});
    expect(r.location).toBe('/jobs');
    expect(await one('select 1 from jobs where id = $1', [job.id])).toBeUndefined();
    expect((await one(`select count(*)::int as n from change_log where table_name = 'jobs' and record_id = $1 and action = 'delete'`, [String(job.id)])).n).toBe(1);
  });
});

describe('who was responsible: owners only (George, 30 Oct 2026)', () => {
  let reworkId = 0;
  let jobId = 0;

  it('lets an owner record it when raising a rework', async () => {
    jobId = (await one(`select id from jobs where client_name = 'Malcolm Patch'`)).id;
    await req('POST', '/rework', 'Gus', { job_id: String(jobId), cause: 'factory', note: 'Wrong hinge holes', responsible: 'Phil', responsible_note: 'Drilled to the old drawing' });
    reworkId = (await one(`select id from rework where note = 'Wrong hinge holes'`)).id;
    const page = await req('GET', `/jobs/${jobId}`, 'George');
    expect(page.text).toContain('Responsible: Phil');
  });

  it('shows nothing of it to Christine or anyone else who is not an owner', async () => {
    for (const who of ['Christine', 'Phil', 'Angela']) {
      for (const path of [`/jobs/${jobId}`, '/rework']) {
        const r = await req('GET', path, who);
        expect(r.text, `${who} ${path}`).not.toContain('Responsible: Phil');
        expect(r.text, `${who} ${path}`).not.toContain('Owners only');
        expect(r.text, `${who} ${path}`).not.toContain('Drilled to the old drawing');
      }
    }
    const history = await req('GET', `/jobs/${jobId}`, 'Christine');
    expect(history.text).not.toContain('Phil · Drilled');
  });

  it('is refused by the database itself for non-owners, reading or writing', async () => {
    const { withPerson } = await import('../src/db/pool.js');
    const christine = (await one(`select id from people where email = 'design@aalborkitchens.com.au'`)).id;
    const seen = await withPerson(christine, async (db) => (await db.query('select * from rework_responsible')).rows);
    expect(seen).toEqual([]);
    await expect(withPerson(christine, (db) => db.query(`insert into rework_responsible (rework_id, responsible) values ($1, 'Gus')`, [reworkId]))).rejects.toThrow(/row-level security/);
    const r = await req('POST', `/rework/${reworkId}/responsible`, 'Christine', { responsible: 'Gus' });
    expect(r.status).toBe(302);
    expect((await withPerson(ids.George, async (db) => (await db.query('select responsible from rework_responsible where rework_id = $1', [reworkId])).rows[0])).responsible).toBe('Phil');
  });

  it("stops a non-owner making themselves an owner, or taking over an owner's sign-in", async () => {
    const { withPerson, isPermissionError } = await import('../src/db/pool.js');
    const christine = (await one(`select id from people where email = 'design@aalborkitchens.com.au'`)).id;
    const refused = async (sql: string, params: unknown[]) => {
      try { await withPerson(christine, (db) => db.query(sql, params)); } catch (e) { return isPermissionError(e); }
      return false;
    };
    expect(await refused('update people set is_owner = true where id = $1', [christine])).toBe(true);
    expect(await refused(`update people set email = 'design@aalborkitchens.com.au.x' where id = $1`, [ids.George])).toBe(true);
    expect(await refused('update people set active = false where id = $1', [ids.Gus])).toBe(true);
    const settings = await req('GET', '/settings', 'Christine');
    expect(settings.text).not.toContain('name="is_owner"');
    expect(settings.text).toContain('Only an owner can change this person.');
  });

  it('gives owners a tally by person, and keeps an owners-only log even when an Editor deletes the rework', async () => {
    const tally = await req('GET', '/rework', 'George');
    expect(tally.text).toContain('Who was responsible');
    await req('POST', `/rework/${reworkId}/delete`, 'Christine', {});
    expect(await one('select 1 from rework where id = $1', [reworkId])).toBeUndefined();
    const { withPerson } = await import('../src/db/pool.js');
    const log = await withPerson(ids.George, async (db) => (await db.query(`select action, person_name from owners_log where rework_id = $1 order by id`, [reworkId])).rows);
    expect(log).toEqual([{ action: 'insert', person_name: 'Gus' }, { action: 'delete', person_name: 'Christine' }]);
    expect(await withPerson(ids.Phil, async (db) => (await db.query('select * from owners_log')).rows)).toEqual([]);
  });
});

describe('export', () => {
  it('downloads a spreadsheet', async () => {
    const r = await fetch(`${base}/export.xlsx`, { headers: { Cookie: `hub_session=${tokens.Angela}` } });
    expect(r.headers.get('content-type')).toContain('spreadsheetml');
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });
});
