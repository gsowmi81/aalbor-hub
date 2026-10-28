// End to end: the real app over HTTP, against a fresh test database loaded with the Notion snapshot.
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/hub_test?host=/var/tmp/hubpg';
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
  await pool.query('drop schema public cascade; create schema public');
  await migrate(() => {});
  await importNotion(() => {});
  await withSystem(async (db) => {
    for (const [name, role] of [['George', 'editor'], ['Phil', 'doer'], ['Angela', 'viewer']]) {
      const id = (await db.query(`insert into people (name, email, role) values ($1, $2, $3) returning id`, [name, `${name.toLowerCase()}@test.au`, role])).rows[0].id;
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

  it('confirm dates and keep a history of the change', async () => {
    const job = await one(`select id from jobs where job_number = '270201'`);
    const s = await one(`select id from steps where job_id = $1 and kind = 'check_measure'`, [job.id]);
    await req('POST', `/jobs/${job.id}/dates`, 'George', { [`start_${s.id}`]: '2027-02-12', [`confirmed_${s.id}`]: '1' });
    expect(await one('select start_date, confirmed from steps where id = $1', [s.id])).toEqual({ start_date: '2027-02-12', confirmed: true });
    const page = await req('GET', `/jobs/${job.id}`, 'George');
    expect(page.text).toContain('Check measure: from Thu 11 Feb → Fri 12 Feb, confirmed no → yes');
  });

  it('refuse a "to" date before the "from" date', async () => {
    const job = await one(`select id from jobs where job_number = '270201'`);
    const s = await one(`select id from steps where job_id = $1 and kind = 'install'`, [job.id]);
    const r = await req('POST', `/jobs/${job.id}/dates`, 'George', { [`start_${s.id}`]: '2027-03-10', [`end_${s.id}`]: '2027-03-01' });
    expect(r.status).toBe(302);
    expect(decodeURIComponent(r.location ?? '')).toBe('/');
    expect((await one('select start_date from steps where id = $1', [s.id])).start_date).toBe('2027-03-08');
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

describe('export', () => {
  it('downloads a spreadsheet', async () => {
    const r = await fetch(`${base}/export.xlsx`, { headers: { Cookie: `hub_session=${tokens.Angela}` } });
    expect(r.headers.get('content-type')).toContain('spreadsheetml');
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });
});
