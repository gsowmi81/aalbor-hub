// End to end: the real app over HTTP, against a fresh test database loaded with the Notion snapshot.
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { appDatabaseUrl } = await import('./db-setup.js');
process.env.DATABASE_URL = await appDatabaseUrl();
process.env.RESEND_API_KEY = '';
const { pool, withSystem, withPerson } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { importNotion } = await import('../scripts/import-notion.js');
const { createApp } = await import('../src/server.js');
const { addDays, mondayOf, todaySydney } = await import('../src/domain/dates.js');

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
    for (const p of ['/', '/?week=1', '/?brand=Origin', '/jobs', '/rework', '/suggestions', '/suggestions?status=all', '/settings', '/jobs/new', ...jobs.map((j) => `/jobs/${j.id}`)]) {
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
    const home = await req('GET', '/attention', 'George');
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

  it('suggests moving everything after a step by the same working days, and saves it confirmed (George, 6 Nov 2026)', async () => {
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
    expect(after.install.confirmed).toBe(true);
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
    const home = await req('GET', '/attention', 'George');
    expect(home.text).toContain("Delivery can&#39;t start before");
  });

  it('lets Editors drag cards on the Coming up board, by working days (George, 31 Oct 2026)', async () => {
    const board = await req('GET', '/?week=0', 'George');
    expect(board.text).toContain('data-dragdays');
    expect(board.text).toMatch(/class="chip [^"]*drag"/);
    for (const who of ['Phil', 'Angela']) {
      const r = await req('GET', '/', who);
      expect(r.text).not.toContain('data-dragdays');
      expect(r.text).not.toMatch(/class="chip [^"]*drag"/);
    }
    // Dragging Steven's check measure (Thu 12 Nov) two columns right means two working days: Mon 16 Nov.
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const cm = await one(`select id, start_date from steps where job_id = $1 and kind = 'check_measure'`, [job.id]);
    expect(cm.start_date).toBe('2026-11-12');
    const page = await req('GET', `/jobs/${job.id}/reschedule?step=${cm.id}&wd=2`, 'George');
    expect(page.text).toContain(`name="start" value="2026-11-16"`);
  });

  it('is for Editors only', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const del = await one(`select id from steps where job_id = $1 and kind = 'delivery'`, [job.id]);
    expect((await req('GET', `/jobs/${job.id}/reschedule?step=${del.id}`, 'Phil')).status).toBe(403);
  });
});

describe('round two revisions (George, 6 Nov 2026)', () => {
  const nextMonday = addDays(mondayOf(todaySydney()), 7);

  it('lists jobs in job-number order, oldest first, live jobs first', async () => {
    const job = await one(`select id from jobs where status = 'live' limit 1`);
    const page = await req('GET', `/jobs/${job.id}`, 'Angela');
    const picker = page.text.slice(page.text.indexOf('id="job-pick"'), page.text.indexOf('</select>', page.text.indexOf('id="job-pick"')));
    const nums = [...picker.matchAll(/<option value="\d+"[^>]*>(\d{6}) · [^<]*<\/option>/g)].filter((m) => !m[0].includes('(')).map((m) => m[1]);
    expect(nums.length).toBeGreaterThan(5);
    expect(nums).toEqual([...nums].sort());
    const rw = await req('GET', '/rework', 'Phil');
    expect(rw.text).toMatch(/<option value="\d+">\d{6} · /);
  });

  it('adds a task to one job, in an area, that moves with that area and saves confirmed', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const install = await one(`select id, start_date from steps where job_id = $1 and kind = 'install' and label = ''`, [job.id]);
    const r = await req('POST', `/jobs/${job.id}/tasks`, 'George', { label: 'Install painted doors', area: 'install', start: install.start_date });
    expect(r.status).toBe(302);
    const t = await one(`select id, kind, owner, confirmed, start_date from steps where job_id = $1 and label = 'Install painted doors'`, [job.id]);
    expect(t).toMatchObject({ kind: 'install', owner: 'Installer', confirmed: true, start_date: install.start_date });
    expect((await req('POST', `/jobs/${job.id}/tasks`, 'Phil', { label: 'x', area: 'install' })).status).toBe(403);
    const page = await req('GET', `/jobs/${job.id}`, 'George');
    expect(page.text).toContain('Tasks for this job only');
    expect(page.text).toContain('Install painted doors');
    // Dragging install one working day later in the box: the task goes with it, everything confirmed.
    const moved = await req('POST', `/jobs/${job.id}/reschedule/quick`, 'George', { step: String(install.id), wd: '1', mode: 'shift', back: `/jobs?brand=all` });
    expect(moved.location).toBe('/jobs?brand=all');
    const after = await one('select start_date, confirmed from steps where id = $1', [t.id]);
    const inst = await one('select start_date, confirmed from steps where id = $1', [install.id]);
    expect(after.start_date).toBe(inst.start_date);
    expect(after.start_date).not.toBe(install.start_date);
    expect(inst.confirmed).toBe(true);
    // Editing renames it and moves it to the Factory row.
    await req('POST', `/steps/${t.id}/edit`, 'George', { label: 'Spray doors', area: 'factory', owner: 'Phil' });
    expect(await one('select kind, label, owner from steps where id = $1', [t.id])).toEqual({ kind: 'factory', label: 'Spray doors', owner: 'Phil' });
  });

  it('sends a dragged move that makes a new clash to the Reschedule screen instead of saving it', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const fac = await one(`select id, start_date, end_date from steps where job_id = $1 and kind = 'factory' and label = ''`, [job.id]);
    const del = await one(`select id, start_date from steps where job_id = $1 and kind = 'delivery'`, [job.id]);
    // An earlier test left a clash on this job (Move anyway). Clear it first: that saves.
    const ok = await req('POST', `/jobs/${job.id}/reschedule/quick`, 'George', { step: String(fac.id), start: addDays(del.start_date, -7), mode: 'only', back: '/' });
    expect(ok.location).toBe('/');
    const cleared = await one('select start_date from steps where id = $1', [fac.id]);
    expect(cleared.start_date).toBe(addDays(del.start_date, -7));
    // Factory finishing after delivery is a new clash: nothing saves, the Reschedule screen opens.
    const r = await req('POST', `/jobs/${job.id}/reschedule/quick`, 'George', { step: String(fac.id), start: addDays(del.start_date, 7), mode: 'only', back: '/' });
    expect(r.location).toContain(`/jobs/${job.id}/reschedule?step=${fac.id}`);
    expect((await one('select start_date from steps where id = $1', [fac.id])).start_date).toBe(cleared.start_date);
    expect((await req('POST', `/jobs/${job.id}/reschedule/quick`, 'Christine', { step: String(fac.id), wd: '1', mode: 'only' })).status).toBe(302);
    expect((await req('POST', `/jobs/${job.id}/reschedule/quick`, 'Phil', { step: String(fac.id), wd: '1', mode: 'only' })).status).toBe(403);
  });

  it('can leave the moved dates provisional on the Reschedule screen', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const cm = await one(`select id, start_date from steps where job_id = $1 and kind = 'check_measure'`, [job.id]);
    await req('POST', `/jobs/${job.id}/reschedule`, 'George', { step: String(cm.id), mode: 'only', [`start_${cm.id}`]: addDays(cm.start_date, -1), provisional: '1', override: '1' });
    expect(await one('select start_date, confirmed from steps where id = $1', [cm.id])).toEqual({ start_date: addDays(cm.start_date, -1), confirmed: false });
  });

  it('lets a Doer raise rework with its tasks and hours, undated, and an Editor date them in order', async () => {
    const job = await one(`select id from jobs where client_name = 'Malcolm Patch'`);
    const missing = await req('POST', '/rework', 'Phil', { job_id: String(job.id), cause: 'factory', note: 'No hours given', task_factory: '1' });
    expect(missing.status).toBe(302); // the form comes back with the message shown
    const shown = await fetch(base + missing.location, { headers: { Cookie: `hub_session=${tokens.Phil}; hub_flash=x` } });
    expect(shown.status).toBe(200);
    expect(await one(`select count(*)::int as n from rework where note = 'No hours given'`)).toEqual({ n: 0 });

    await req('POST', '/rework', 'Phil', { job_id: String(job.id), cause: 'factory', note: 'Sink cabinet rebuilt', task_factory: '1', hours_factory: '4', task_delivery: '1', task_install: '1', hours_install: '2', start: nextMonday });
    const rwk = await one(`select id from rework where note = 'Sink cabinet rebuilt'`);
    const tasks = (await pool.query('select rework_area, label, hours, start_date, confirmed from steps where rework_id = $1 order by sort', [rwk.id])).rows;
    // A Doer's start date is ignored: Christine dates rework.
    expect(tasks).toEqual([
      { rework_area: 'factory', label: 'Rework: factory work', hours: 4, start_date: null, confirmed: false },
      { rework_area: 'delivery', label: 'Rework: delivery', hours: null, start_date: null, confirmed: false },
      { rework_area: 'install', label: 'Rework: install', hours: 2, start_date: null, confirmed: false },
    ]);
    expect((await req('POST', `/rework/${rwk.id}/date`, 'Phil', { start: nextMonday })).status).toBe(403);
    await req('POST', `/rework/${rwk.id}/date`, 'Christine', { start: nextMonday });
    const dated = (await pool.query('select rework_area, start_date, confirmed from steps where rework_id = $1 order by sort', [rwk.id])).rows;
    expect(dated).toEqual([
      { rework_area: 'factory', start_date: nextMonday, confirmed: true },
      { rework_area: 'delivery', start_date: addDays(nextMonday, 1), confirmed: true },
      { rework_area: 'install', start_date: addDays(nextMonday, 1), confirmed: true },
    ]);
    // Next week's board shows them in red in the Factory and Install rows.
    const board = await req('GET', '/?week=1', 'Angela');
    expect(board.text).toMatch(/class="chip lane-factory rw[^"]*"[^>]*>\s*<strong>Malcolm Patch[^<]*<\/strong><span>Rework: factory work/);
    expect(board.text).toMatch(/class="chip lane-install rw[^"]*"[^>]*>\s*<strong>Malcolm Patch[^<]*<\/strong><span>Rework: install/);
  });

  it('moves the later rework tasks with a dragged one, never the main job, and the job slip buttons leave rework alone', async () => {
    const job = await one(`select id from jobs where client_name = 'Malcolm Patch'`);
    const rwk = await one(`select id from rework where note = 'Sink cabinet rebuilt'`);
    const ids2 = Object.fromEntries((await pool.query('select rework_area, id from steps where rework_id = $1', [rwk.id])).rows.map((r) => [r.rework_area, r.id]));
    const mainBefore = (await pool.query(`select id, start_date from steps where job_id = $1 and kind <> 'rework' order by id`, [job.id])).rows;
    await req('POST', `/jobs/${job.id}/reschedule/quick`, 'George', { step: String(ids2.factory), wd: '2', mode: 'shift', back: '/' });
    const after = Object.fromEntries((await pool.query('select rework_area, start_date from steps where rework_id = $1', [rwk.id])).rows.map((r) => [r.rework_area, r.start_date]));
    expect(after).toEqual({ factory: addDays(nextMonday, 2), delivery: addDays(nextMonday, 3), install: addDays(nextMonday, 3) });
    expect((await pool.query(`select id, start_date from steps where job_id = $1 and kind <> 'rework' order by id`, [job.id])).rows).toEqual(mainBefore);
    await req('POST', `/jobs/${job.id}/shift`, 'George', { n: '1' });
    const still = Object.fromEntries((await pool.query('select rework_area, start_date from steps where rework_id = $1', [rwk.id])).rows.map((r) => [r.rework_area, r.start_date]));
    expect(still).toEqual(after);
  });

  it('lets an Editor edit a rework and its tasks, and keeps it in the history', async () => {
    const rwk = await one(`select id, job_id from rework where note = 'Sink cabinet rebuilt'`);
    const t = await one(`select id from steps where rework_id = $1 and rework_area = 'factory'`, [rwk.id]);
    expect((await req('POST', `/rework/${rwk.id}/edit`, 'Phil', { cause: 'drafting', note: 'x' })).status).toBe(403);
    await req('POST', `/rework/${rwk.id}/edit`, 'George', { cause: 'drafting', note: 'Sink cabinet drawn wrong, rebuilt' });
    expect(await one('select cause, note from rework where id = $1', [rwk.id])).toEqual({ cause: 'drafting', note: 'Sink cabinet drawn wrong, rebuilt' });
    await req('POST', `/steps/${t.id}/edit`, 'George', { label: 'Rebuild sink cabinet', owner: 'Phil', area: 'factory', hours: '6' });
    expect(await one('select label, owner, rework_area, hours from steps where id = $1', [t.id])).toEqual({ label: 'Rebuild sink cabinet', owner: 'Phil', rework_area: 'factory', hours: 6 });
    const page = await req('GET', `/jobs/${rwk.job_id}`, 'George');
    expect(page.text).toContain('Rebuild sink cabinet');
    expect(page.text).toContain('name Rework: factory work → Rebuild sink cabinet, hours 4 → 6');
  });

  it('files each added rework item under a category, not a person, and shows it in red in that row', async () => {
    const rwk = await one(`select id, job_id from rework where note like 'Sink cabinet%'`);
    const page = await req('GET', `/jobs/${rwk.job_id}`, 'George');
    expect(page.text).toContain('Add a rework item');
    const form = page.text.slice(page.text.indexOf(`action="/rework/${rwk.id}/steps"`));
    expect(form.slice(0, form.indexOf('</form>'))).not.toContain('name="owner"');
    // No category: refused, nothing added.
    await req('POST', `/rework/${rwk.id}/steps`, 'George', { label: 'Reorder 2 white boards', start: nextMonday });
    expect(await one(`select count(*)::int as n from steps where rework_id = $1 and label = 'Reorder 2 white boards'`, [rwk.id])).toEqual({ n: 0 });
    await req('POST', `/rework/${rwk.id}/steps`, 'George', { label: 'Reorder 2 white boards', area: 'materials_ordered', start: nextMonday });
    expect(await one(`select rework_area, owner, hours, confirmed from steps where rework_id = $1 and label = 'Reorder 2 white boards'`, [rwk.id]))
      .toEqual({ rework_area: 'materials_ordered', owner: 'Christine', hours: null, confirmed: true });
    const board = await req('GET', '/?week=1', 'Angela');
    expect(board.text).toMatch(/class="chip lane-orders rw[^"]*"[^>]*>\s*<strong>Malcolm Patch[^<]*<\/strong><span>Reorder 2 white boards/);
  });

  it('lets an Editor raise a dated rework in one go', async () => {
    const job = await one(`select id from jobs where client_name = 'Malcolm Patch'`);
    await req('POST', '/rework', 'Christine', { job_id: String(job.id), cause: 'drafting', note: 'Pantry redrawn', task_production_drawings: '1', task_factory: '1', hours_factory: '12', start: nextMonday });
    const rwk = await one(`select id from rework where note = 'Pantry redrawn'`);
    const tasks = (await pool.query('select rework_area, start_date, end_date, confirmed from steps where rework_id = $1 order by sort', [rwk.id])).rows;
    expect(tasks).toEqual([
      { rework_area: 'production_drawings', start_date: nextMonday, end_date: null, confirmed: true },
      { rework_area: 'factory', start_date: addDays(nextMonday, 1), end_date: addDays(nextMonday, 2), confirmed: true },
    ]);
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
    const settings = await req('GET', '/settings/people', 'Christine');
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

describe('the preview round (George, 7 Nov 2026)', () => {
  it('sends a Doer to My day and everyone else to the Board', async () => {
    const phil = await req('GET', '/', 'Phil');
    expect(phil.status).toBe(302);
    expect(phil.location).toBe('/me');
    expect((await req('GET', '/', 'George')).text).toContain('aria-current="page">Board');
    expect((await req('GET', '/board?week=1', 'Angela')).status).toBe(200);
  });

  it('shows a person their own steps on My day once their areas are set in Settings', async () => {
    const before = await req('GET', '/me', 'Phil');
    expect(before.text).toContain("Your areas aren't set yet");
    await req('POST', `/settings/people/${ids.Phil}`, 'George', { name: 'Phil', email: 'phil@test.au', role: 'doer', active: '1', areas: 'factory' });
    expect((await one('select areas from people where id = $1', [ids.Phil])).areas).toEqual(['factory']);
    const after = await req('GET', '/me', 'Phil');
    expect(after.text).toContain('your areas: Factory');
    expect(after.text).toContain('class="me-row lane-factory');
    expect(after.text).toContain('Cut, edge and assemble');
    expect(after.text).not.toContain('Check measure</div>');
  });

  it('pins a date so nothing moves it: not the job buttons, not a shift from an earlier step', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const install = await one(`select id, start_date from steps where job_id = $1 and kind = 'install'`, [job.id]);
    const dr = await one(`select id, start_date from steps where job_id = $1 and kind = 'production_drawings'`, [job.id]);
    expect((await req('POST', `/steps/${install.id}/pin`, 'George', { pinned: '1' })).status).toBe(302);
    expect(await one('select pinned, confirmed from steps where id = $1', [install.id])).toEqual({ pinned: true, confirmed: true });
    await req('POST', `/jobs/${job.id}/shift`, 'George', { n: '5' });
    expect((await one('select start_date from steps where id = $1', [install.id])).start_date).toBe(install.start_date);
    const page = await req('GET', `/jobs/${job.id}/reschedule?step=${dr.id}&wd=3`, 'George');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(new RegExp(`name="start_${install.id}" value="${install.start_date}"`));
    expect((await req('GET', `/jobs/${job.id}`, 'George')).text).toContain('Pinned');
    expect((await req('POST', `/steps/${install.id}/pin`, 'Phil', { pinned: '0' })).status).toBe(403);
    await req('POST', `/steps/${install.id}/pin`, 'George', { pinned: '0' });
    expect((await one('select pinned from steps where id = $1', [install.id])).pinned).toBe(false);
  });

  it('renders Pipeline, Attention and More, and Find opens a single match', async () => {
    for (const p of ['/pipeline', '/attention', '/more', '/find', '/find?q=zzzz']) expect((await req('GET', p, 'Angela')).status, p).toBe(200);
    const pipe = await req('GET', '/pipeline', 'George');
    expect(pipe.text).toContain('Greg Steven');
    expect(pipe.text).toMatch(/td class="pc st-(now|later|overdue|undated)[^"]*cur"/);
    // Imported jobs never had Drafting for contract ticked: it is skipped, not the current stage.
    expect(pipe.text).toContain('class="pc st-skipped"');
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const found = await req('GET', '/find?q=Greg%20Stev', 'Phil');
    expect(found.location).toBe(`/jobs/${job.id}`);
    expect((await req('GET', '/find?q=zzzz', 'Phil')).text).toContain('No job matches');
    const more = await req('GET', '/more', 'Angela');
    expect(more.text).not.toContain('href="/settings"');
  });

  it('keeps a drawings link on the job, web addresses only, and shows it on My day', async () => {
    const job = await one(`select id, client_name from jobs where client_name = 'Greg Steven'`);
    const base = { client_name: job.client_name, factory_days: '2', install_days: '3', status: 'live' };
    await req('POST', `/jobs/${job.id}/details`, 'George', { ...base, drawings_url: 'https://www.dropbox.com/sh/abc' });
    expect((await one('select drawings_url from jobs where id = $1', [job.id])).drawings_url).toBe('https://www.dropbox.com/sh/abc');
    expect((await req('GET', `/jobs/${job.id}`, 'Phil')).text).toContain('Drawings folder ↗');
    const bad = await req('POST', `/jobs/${job.id}/details`, 'George', { ...base, drawings_url: 'ftp://nope' });
    expect(bad.status).toBe(302);
    expect((await one('select drawings_url from jobs where id = $1', [job.id])).drawings_url).toBe('https://www.dropbox.com/sh/abc');
  });

  it('shows the office message on My day and the board', async () => {
    await req('POST', '/settings/message', 'George', { message: 'Factory clean-out Friday afternoon' });
    expect((await req('GET', '/me', 'Phil')).text).toContain('Factory clean-out Friday afternoon');
    expect((await req('GET', '/board', 'George')).text).toContain('Factory clean-out Friday afternoon');
    await req('POST', '/settings/message', 'George', { message: '' });
    expect((await req('GET', '/me', 'Phil')).text).not.toContain('me-msg');
  });
});

describe('round two of the preview (George, 7 Nov 2026)', () => {
  it('capacity is in hours per area, seeded from the old settings, and the load page renders', async () => {
    const f = await one(`select mon, tue, wed, thu, fri from labour_centres where key = 'factory'`);
    expect(Number(f.mon)).toBe(6.4); // 2 kitchens × 2 days × 8 h over 5 days
    expect(await one(`select 1 from settings where key = 'factory_kitchens_per_week'`)).toBeUndefined();
    expect((await req('GET', '/load', 'Phil')).status).toBe(200);
    await req('POST', '/settings/centres/factory', 'George', { mon: '8', tue: '8', wed: '8', thu: '8', fri: '4' });
    expect(Number((await one(`select fri from labour_centres where key = 'factory'`)).fri)).toBe(4);
    const r = await req('POST', '/settings/adjustments', 'George', { centre: 'factory', from: '2027-01-04', to: '2027-01-08', hours: '0', reason: 'Shutdown' });
    expect(r.status).toBe(302);
    const a = await one(`select id, hours from capacity_adjustments where reason = 'Shutdown'`);
    expect(Number(a.hours)).toBe(0);
    const load = await req('GET', '/load', 'George');
    expect(load.text).toContain('Factory');
    await req('POST', `/settings/adjustments/${a.id}/delete`, 'George', {});
    expect(await one(`select 1 from capacity_adjustments where id = $1`, [a.id])).toBeUndefined();
  });

  it('lets a Doer flag a problem with a photo; it reaches Attention, the job and the person responsible', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const step = await one(`select id from steps where job_id = $1 and kind = 'factory'`, [job.id]);
    await req('POST', '/settings/flag-types/materials_short', 'George', { responsible: String(ids.Gus), active: '1' });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const boundary = 'hubtest';
    const part = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const body = Buffer.concat([
      Buffer.from(part('job_id', String(job.id)) + part('step_id', String(step.id)) + part('type', 'materials_short') + part('note', 'Short two sheets of Classic White') + part('back', `/jobs/${job.id}#flags`)),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await fetch(base + '/issues', { method: 'POST', headers: { Origin: base, Cookie: `hub_session=${tokens.Phil}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, redirect: 'manual' });
    expect(res.status).toBe(302);
    const i = await one(`select id, raised_by, status, type_key from issues where note = 'Short two sheets of Classic White'`);
    expect(i.raised_by).toBe(ids.Phil);
    expect(i.status).toBe('open');
    const photo = await one(`select id, size, content_type from issue_photos where issue_id = $1`, [i.id]);
    expect(photo.size).toBe(png.length);
    expect((await req('GET', `/issues/${i.id}/photos/${photo.id}`, 'Angela')).type).toBe('image/png');
    const att = await req('GET', '/attention', 'Christine');
    expect(att.text).toContain('Short two sheets of Classic White');
    expect(att.text).toContain('Gus looks after these');
    expect((await req('GET', `/jobs/${job.id}`, 'Angela')).text).toContain('Short two sheets of Classic White');
    // Gus is responsible, so he can move it along; Angela (Viewer) cannot; the database agrees.
    expect((await req('GET', '/me', 'Gus')).text).toContain('Flags for you');
    expect((await req('POST', `/issues/${i.id}/status`, 'Angela', { status: 'fixed' })).status).toBe(403);
    await req('POST', `/issues/${i.id}/status`, 'Gus', { status: 'looking' });
    expect((await one('select status from issues where id = $1', [i.id])).status).toBe('looking');
    await req('POST', `/issues/${i.id}/status`, 'Gus', { status: 'fixed', note: 'Boards came in' });
    const fixed = await one('select status, close_note, closed_by from issues where id = $1', [i.id]);
    expect(fixed).toEqual({ status: 'fixed', close_note: 'Boards came in', closed_by: ids.Gus });
    expect((await req('GET', '/attention', 'Christine')).text).not.toContain('Short two sheets of Classic White');
  });

  it('refuses a flag without a type or a note, and a Doer changing a flag that is not theirs', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    expect((await req('POST', '/issues', 'Phil', { job_id: String(job.id), type: 'other', note: '' })).status).toBe(302);
    expect(await one(`select 1 from issues where job_id = $1 and type_key = 'other'`, [job.id])).toBeUndefined();
    await req('POST', '/issues', 'Gus', { job_id: String(job.id), type: 'site_not_ready', note: 'Tiler still on site' });
    const i = await one(`select id from issues where note = 'Tiler still on site'`);
    // Phil neither raised it nor looks after site problems.
    const r = await req('POST', `/issues/${i.id}/status`, 'Phil', { status: 'fixed' });
    expect(r.status).toBe(302);
    expect((await one('select status from issues where id = $1', [i.id])).status).toBe('open');
    // Raising rework for it (Editor) answers the flag.
    await req('POST', '/rework', 'George', { job_id: String(job.id), cause: 'install', note: 'Tiler still on site', flag_id: String(i.id) });
    const after = await one('select status, close_note, rework_id from issues where id = $1', [i.id]);
    expect(after.status).toBe('fixed');
    expect(after.close_note).toBe('Rework raised');
    expect(after.rework_id).not.toBeNull();
  });

  it('shows what the 7 am emails would be, sends them once a day, and leaves people who opted out', async () => {
    const preview = await req('GET', '/settings/emails', 'George');
    expect(preview.status).toBe(200);
    expect(preview.text).toContain('What the 7 am run would send today');
    await req('POST', `/settings/people/${ids.Phil}`, 'George', { name: 'Phil', email: 'phil@test.au', role: 'doer', active: '1', areas: 'factory', email_digest: '0' });
    expect((await one('select email_digest from people where id = $1', [ids.Phil])).email_digest).toBe(false);
    const run = await req('POST', '/settings/emails/run', 'George', {});
    expect(run.status).toBe(302);
    const today = todaySydney();
    expect(await one(`select kind from digest_runs where day = $1`, [today])).toEqual({ kind: 'daily' });
    await req('POST', `/settings/people/${ids.Phil}`, 'George', { name: 'Phil', email: 'phil@test.au', role: 'doer', active: '1', areas: 'factory', email_digest: '1' });
  });

  it('ticking Materials in tells the factory without breaking the tick', async () => {
    const s = await one(`select s.id from steps s join jobs j on j.id = s.job_id where j.client_name = 'Jenny Vassiniotis' and s.kind = 'materials_in'`);
    const r = await req('POST', `/steps/${s.id}/done`, 'Christine', { done: '1', back: '/board' });
    expect(r.status).toBe(302);
    expect((await one('select done_at from steps where id = $1', [s.id])).done_at).not.toBeNull();
    await req('POST', `/steps/${s.id}/done`, 'Christine', { done: '0', back: '/board' });
  });
});

describe('round three of the preview (George, 7 Nov 2026)', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const multipart = (fields: Record<string, string>, photos = 0) => {
    const boundary = 'hubtest3';
    const part = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const parts = [Buffer.from(Object.entries(fields).map(([k, v]) => part(k, v)).join(''))];
    for (let i = 0; i < photos; i++) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="p${i}.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
  };
  const post = async (path: string, who: string, m: { body: Buffer; type: string }) =>
    fetch(base + path, { method: 'POST', headers: { Origin: base, Cookie: `hub_session=${tokens[who]}`, 'Content-Type': m.type }, body: m.body, redirect: 'manual' });

  it('ticking Install cabinets asks about gaps and the site and keeps the photos on the job and in History', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const s = await one(`select id from steps where job_id = $1 and kind = 'install' and label = ''`, [job.id]);
    const r = await post(`/steps/${s.id}/done`, 'Phil', multipart({ done: '1', gaps: '1', clean: '0', back: `/jobs/${job.id}` }, 4));
    expect(r.status).toBe(302);
    const row = await one('select done_at, done_by, gaps_adjusted, site_clean from steps where id = $1', [s.id]);
    expect(row.done_by).toBe(ids.Phil);
    expect(row.gaps_adjusted).toBe(true);
    expect(row.site_clean).toBe(false);
    const photos = (await pool.query('select id, added_by from step_photos where step_id = $1 order by id', [s.id])).rows;
    expect(photos).toHaveLength(3); // up to three
    expect(photos[0].added_by).toBe(ids.Phil);
    expect((await req('GET', `/steps/${s.id}/photos/${photos[0].id}`, 'Angela')).type).toBe('image/png');
    const page = (await req('GET', `/jobs/${job.id}`, 'Angela')).text;
    expect(page).toContain('Gaps adjusted: yes');
    expect(page).toContain('Site clean: no');
    expect(page).toContain(`/steps/${s.id}/photos/${photos[0].id}`);
    expect(page).toContain('ticked done (gaps adjusted yes, site left clean no)');
    expect(page).toContain(`/jobs/${job.id}/sheet`);
    // The Monday email lists it for Editors.
    const { installsDone } = await import('../src/db/queries.js');
    const today = todaySydney();
    expect((await installsDone(today, today)).map((i) => [i.id, i.photos, i.done_by_name])).toEqual([[s.id, 3, 'Phil']]);
    // Untick: the answers go too, the photos stay with the step.
    await req('POST', `/steps/${s.id}/done`, 'Christine', { done: '0', back: '/board' });
    expect(await one('select done_at, gaps_adjusted, site_clean from steps where id = $1', [s.id])).toEqual({ done_at: null, gaps_adjusted: null, site_clean: null });
  });

  it('prints a job sheet with a QR code that opens the job on My day', async () => {
    const job = await one(`select id, job_number from jobs where job_number is not null and status = 'live' order by job_number limit 1`);
    const sheet = await req('GET', `/jobs/${job.id}/sheet`, 'Phil');
    expect(sheet.status).toBe(200);
    expect(sheet.text).toContain('<svg');
    expect(sheet.text).toContain(`/me?job=${job.id}`);
    expect(sheet.text).toContain(job.job_number);
    expect(sheet.text).toContain('Scan to tick steps');
    const day = await req('GET', `/me?job=${job.id}`, 'Phil');
    expect(day.status).toBe(200);
    expect(day.text).toContain('from the job sheet');
    expect(day.text).toContain('Back to My day');
    expect(day.text).toContain('Install cabinets');
    expect((day.text.match(/action="\/steps\/\d+\/done"/g) ?? []).length).toBeGreaterThan(1);
    expect((await req('GET', '/me?job=999999', 'Phil')).status).toBe(400);
  });

  it('shows a new job the weeks it lands in and offers the next week with room when they are full', async () => {
    // Shut the factory for March 2027, then propose a job whose factory week lands in it.
    await req('POST', '/settings/adjustments', 'George', { centre: 'factory', from: '2027-03-01', to: '2027-03-31', hours: '0', reason: 'Test shutdown' });
    const values = { client_name: 'Room Test', suburb: 'Botany', template: 'melamine', door_finish: 'melamine', has_stone: '1', factory_days: '2', install_days: '3', anchor: 'install', anchor_date: '2027-03-22' };
    const preview = await req('POST', '/jobs/preview', 'George', values);
    expect(preview.text).toContain('Where it lands');
    expect(preview.text).toMatch(/Factory week of \d\d Mar/);
    expect(preview.text).toContain('Use the next week with room');
    const m = preview.text.match(/name="use_week" value="(\d{4}-\d{2}-\d{2})"/);
    expect(m).not.toBeNull();
    expect(m![1] > '2027-03-31').toBe(true);
    // Tapping it re-proposes from that week; nothing is saved.
    const page = await req('POST', '/jobs/new', 'George', { ...values, use_week: m![1], action: 'save' });
    expect(page.status).toBe(200);
    expect(page.text).toContain(`value="${m![1]}"`);
    expect(page.text).not.toContain('Use the next week with room');
    expect(await one(`select 1 from jobs where client_name = 'Room Test'`)).toBeUndefined();
    const a = await one(`select id from capacity_adjustments where reason = 'Test shutdown'`);
    await req('POST', `/settings/adjustments/${a.id}/delete`, 'George', {});
  });
});

describe('files on a job (George, 7 Nov 2026)', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  const upload = (jobId: number, who: string, fields: Record<string, string>, name = 'plans.pdf', type = 'application/pdf', bytes: Buffer = pdf) => {
    const boundary = 'hubfiles';
    const part = (n: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
    const body = Buffer.concat([Buffer.from(Object.entries(fields).map(([k, v]) => part(k, v)).join('')),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return fetch(base + `/jobs/${jobId}/files`, { method: 'POST', headers: { Origin: base, Cookie: `hub_session=${tokens[who]}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, redirect: 'manual' });
  };

  it('lets an Editor add classed files; a second of the same class becomes v2 and the first is superseded', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    expect((await upload(job.id, 'Christine', { kind: 'contract_plans', note: 'Signed 02 Oct' })).status).toBe(302);
    expect((await upload(job.id, 'Christine', { kind: 'production_plans', note: 'Rev B' })).status).toBe(302);
    expect((await upload(job.id, 'Christine', { kind: 'production_plans', note: 'Rev C, after check measure' }, 'plans-revC.pdf')).status).toBe(302);
    const rows = (await pool.query('select kind, version, name, note, added_by, size from job_files where job_id = $1 order by kind, version', [job.id])).rows;
    expect(rows.map((r) => [r.kind, r.version, r.name])).toEqual([['contract_plans', 1, 'plans.pdf'], ['production_plans', 1, 'plans.pdf'], ['production_plans', 2, 'plans-revC.pdf']]);
    expect(rows[0].added_by).toBe(ids.Christine);
    expect(rows[0].size).toBe(pdf.length);
    const page = (await req('GET', `/jobs/${job.id}`, 'Angela')).text;
    expect(page).toContain('Production plans v2 ↗');
    expect(page).toContain('Contract plans v1 ↗');
    expect(page).toContain('Earlier versions (1)');
    expect(page).toContain('v1 · superseded');
    expect(page).toContain('File added, Production plans v2: plans-revC.pdf (Rev C, after check measure)');
    // Everyone opens them, inline for a PDF
    const v2 = rows[2];
    const f = await one('select id from job_files where job_id = $1 and kind = $2 and version = 2', [job.id, 'production_plans']);
    const dl = await fetch(base + `/jobs/${job.id}/files/${f.id}`, { headers: { Cookie: `hub_session=${tokens.Angela}` } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/pdf');
    expect(dl.headers.get('content-disposition')).toContain('inline');
    expect(Buffer.from(await dl.arrayBuffer()).equals(pdf)).toBe(true);
    expect(v2.note).toBe('Rev C, after check measure');
    // My day and the sheet point at the current plans
    expect((await req('GET', `/me?job=${job.id}`, 'Phil')).text).toContain(`/jobs/${job.id}/files/${f.id}`);
    expect((await req('GET', `/jobs/${job.id}/sheet`, 'Phil')).text).toContain('Production plans v2');
  });

  it('refuses files from Doers and Viewers, needs a class, and lets an Editor remove one (kept in History)', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    expect((await upload(job.id, 'Phil', { kind: 'other' })).status).toBe(403);
    expect((await upload(job.id, 'Angela', { kind: 'other' })).status).toBe(403);
    const bad = await upload(job.id, 'Christine', { kind: '' });
    expect(bad.status).toBe(302); // sent back with the message, nothing added
    expect(Number((await one('select count(*) from job_files where job_id = $1', [job.id])).count)).toBe(3);
    const f = await one('select id from job_files where job_id = $1 and kind = $2 and version = 2', [job.id, 'production_plans']);
    const r = await req('POST', `/jobs/${job.id}/files/${f.id}/delete`, 'Christine', { back: `/jobs/${job.id}#files` });
    expect(r.status).toBe(302);
    expect(await one('select 1 from job_files where id = $1', [f.id])).toBeUndefined();
    expect(await one('select 1 from job_file_blobs where file_id = $1', [f.id])).toBeUndefined();
    const page = (await req('GET', `/jobs/${job.id}`, 'Christine')).text;
    expect(page).toContain('Production plans v1 ↗'); // v1 is current again
    expect(page).toContain('File removed, Production plans v2: plans-revC.pdf');
    expect((await req('GET', `/jobs/${job.id}/files/${f.id}`, 'Christine')).status).toBe(404);
  });
});

describe('stock and the factory TV (George, 7 Nov 2026)', () => {
  const csvUpload = (path: string, who: string, fields: Record<string, string>, name: string, text: string) => {
    const boundary = 'hubstock';
    const part = (n: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
    const body = Buffer.concat([Buffer.from(Object.entries(fields).map(([k, v]) => part(k, v)).join('')),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/csv\r\n\r\n`), Buffer.from(text), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return fetch(base + path, { method: 'POST', headers: { Origin: base, Cookie: `hub_session=${tokens[who]}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, redirect: 'manual' });
  };
  const itemId = async (name: string) => (await one('select id from stock_items where name = $1', [name])).id as number;

  it('loads the Notion catalogue with its opening balances, and the Stock tick lets a Viewer change it', async () => {
    expect(Number((await one('select count(*) from stock_items')).count)).toBe(183);
    const page = (await req('GET', '/stock/items', 'Angela')).text;
    expect(page).toContain('Classic White Sheen');
    const cws = await itemId('Classic White Sheen');
    expect((await req('GET', `/stock/items/${cws}`, 'Angela')).text).toContain('Opening balance');
    expect(Number((await one('select sum(qty) from stock_moves where item_id = $1', [cws])).sum)).toBe(38);
    const edit = { name: 'Classic White Sheen', code: 'CWS-2415', kind: 'board', category: 'Boards – full sheets', unit: 'sheet', supplier: 'Polytec', lead_days: '5', minimum: '10', reorder_qty: '20', bin: 'B1', standing: '1', active: '1' };
    expect((await req('POST', `/stock/items/${cws}`, 'Angela', edit)).status).toBe(403);
    await req('POST', `/settings/people/${ids.Angela}`, 'George', { name: 'Angela', email: 'angela@test.au', role: 'viewer', active: '1', email_digest: '1', can_stock: '1' });
    expect((await req('POST', `/stock/items/${cws}`, 'Angela', edit)).status).toBe(302);
    const row = await one('select code, minimum, reorder_qty, bin, standing from stock_items where id = $1', [cws]);
    expect(row).toEqual({ code: 'CWS-2415', minimum: 10, reorder_qty: 20, bin: 'B1', standing: true });
    // Phil (Doer) can't touch the catalogue, on the page or in the database.
    expect((await req('POST', `/stock/items/${cws}`, 'Phil', edit)).status).toBe(403);
    await expect(withPerson(ids.Phil, (db) => db.query('update stock_items set bin = $2 where id = $1', [cws, 'X']))).rejects.toThrow(/Doers/);
  });

  it('the Friday count logs differences as moves, and the ledger is never edited', async () => {
    const cws = await itemId('Classic White Sheen');
    const r = await req('POST', '/stock/count', 'Phil', { [`c_${cws}`]: '36' });
    expect(r.status).toBe(302);
    const mv = await one(`select kind, qty, moved_by from stock_moves where item_id = $1 and kind = 'counted'`, [cws]);
    expect(mv).toEqual({ kind: 'counted', qty: -2, moved_by: ids.Phil });
    expect(Number((await one('select sum(qty) from stock_moves where item_id = $1', [cws])).sum)).toBe(36);
    await expect(withPerson(ids.George, (db) => db.query('update stock_moves set qty = 0 where item_id = $1', [cws]))).rejects.toThrow(/never changed/);
    expect((await req('GET', '/stock/count', 'Phil')).text).toContain('Classic White Sheen');
  });

  it('loads a cut list: known codes go straight in, unknown ones are matched once and remembered', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const csv = 'Code,Description,Qty\nT90D8,Soft close hinges,24\nCWS-NEW,Classic White Sheen 2415,6\n';
    const r = await csvUpload(`/jobs/${job.id}/materials/upload`, 'Christine', { nested: '1' }, 'greg-cutlist.csv', csv);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("1 code the hub doesn't know");
    expect(html).toContain('CWS-NEW');
    expect(Number((await one('select count(*) from job_materials where job_id = $1', [job.id])).count)).toBe(1);
    const m = await req('POST', `/jobs/${job.id}/materials/match`, 'Christine', { nested: '1', code_0: 'CWS-NEW', qty_0: '6', item_0: 'Classic White Sheen [CWS-2415]' });
    expect(m.status).toBe(302);
    expect((await one(`select item_id from code_aliases where alias = 'CWS-NEW'`)).item_id).toBe(await itemId('Classic White Sheen'));
    const lines = (await pool.query('select i.name, m.qty, m.nested from job_materials m join stock_items i on i.id = m.item_id where m.job_id = $1 order by i.name', [job.id])).rows;
    expect(lines).toEqual([{ name: 'Classic White Sheen', qty: 6, nested: true }, { name: 'Soft close hinges', qty: 24, nested: true }]);
    // Same file again: the alias is known now, so no matching page.
    expect((await csvUpload(`/jobs/${job.id}/materials/upload`, 'Christine', { nested: '1' }, 'greg-cutlist.csv', csv)).status).toBe(302);
    expect((await req('GET', `/jobs/${job.id}`, 'Angela')).text).toContain('from the nested file');
  });

  it('sources stock first and lists the rest; ordered, then in, makes the job ready; picking takes it off the shelf', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    await req('POST', `/jobs/${job.id}/materials`, 'Christine', { item: 'Satin White', qty: '4', back: `/jobs/${job.id}#materials` });
    const r = await req('POST', `/jobs/${job.id}/materials/source`, 'Christine', { hold: '1', back: `/jobs/${job.id}#materials` });
    expect(r.status).toBe(302);
    const lines = (await pool.query('select i.name, m.qty, m.allocated from job_materials m join stock_items i on i.id = m.item_id where m.job_id = $1 order by i.name', [job.id])).rows;
    expect(lines).toEqual([{ name: 'Classic White Sheen', qty: 6, allocated: 6 }, { name: 'Satin White', qty: 4, allocated: 0 }, { name: 'Soft close hinges', qty: 24, allocated: 24 }]);
    const o = await one(`select o.id, o.qty, o.reason, o.status, o.order_by from orders o join stock_items i on i.id = o.item_id where o.job_id = $1 and i.name = 'Satin White'`, [job.id]);
    expect(o).toMatchObject({ qty: 4, reason: 'shortfall', status: 'listed' });
    expect(o.order_by).not.toBeNull();
    let page = (await req('GET', `/jobs/${job.id}`, 'Angela')).text;
    expect(page).toContain('On order');
    expect((await req('GET', '/stock/orders', 'Angela')).text).toContain('Satin White');
    // Angela (Stock tick) marks it ordered; the factory receives it; the job is ready.
    expect((await req('POST', `/stock/orders/${o.id}/ordered`, 'Phil', { expected: '2026-11-20' })).status).toBe(403);
    expect((await req('POST', `/stock/orders/${o.id}/ordered`, 'Angela', { expected: '2026-11-20' })).status).toBe(302);
    expect((await one('select status, expected from orders where id = $1', [o.id])).status).toBe('ordered');
    expect((await req('POST', `/stock/orders/${o.id}/received`, 'Phil', { qty: '4', back: '/stock/orders' })).status).toBe(302);
    expect(await one('select status, received_qty from orders where id = $1', [o.id])).toEqual({ status: 'received', received_qty: 4 });
    const sw = await itemId('Satin White');
    expect(await one(`select kind, qty, job_id, moved_by from stock_moves where item_id = $1 and kind = 'received'`, [sw])).toEqual({ kind: 'received', qty: 4, job_id: job.id, moved_by: ids.Phil });
    page = (await req('GET', `/jobs/${job.id}`, 'Angela')).text;
    expect(page).toContain('Ready to cut');
    // Phil picks everything: the moves are negative and the lines show picked.
    const mids = (await pool.query('select id from job_materials where job_id = $1', [job.id])).rows.map((x) => String(x.id));
    const body = new URLSearchParams(mids.map((id) => ['pick', id]));
    body.set('back', `/jobs/${job.id}#materials`);
    const pick = await fetch(base + `/jobs/${job.id}/materials/pick`, { method: 'POST', headers: { Origin: base, Cookie: `hub_session=${tokens.Phil}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'manual' });
    expect(pick.status).toBe(302);
    expect(Number((await one(`select sum(qty) from stock_moves where kind = 'picked' and job_id = $1`, [job.id])).sum)).toBe(-34);
    expect(Number((await one('select sum(qty) from stock_moves where item_id = $1', [sw])).sum)).toBe(0);
    expect((await pool.query('select qty, picked from job_materials where job_id = $1', [job.id])).rows.every((x) => x.qty === x.picked)).toBe(true);
  });

  it('need and supply shows the gap and puts it on the order list; a bin flags running low once', async () => {
    const jenny = await one(`select id from jobs where client_name = 'Jenny Vassiniotis'`);
    await req('POST', `/jobs/${jenny.id}/materials`, 'Christine', { item: 'Satin White', qty: '5' });
    const home = (await req('GET', '/stock', 'Angela')).text;
    expect(home).toContain('Satin White');
    expect(home).toContain('Put the 1 gap on the order list');
    expect((await req('POST', '/stock/orders/from-gaps', 'Angela', {})).status).toBe(302);
    const sw = await itemId('Satin White');
    expect(await one(`select qty, reason, job_id from orders where item_id = $1 and status = 'listed'`, [sw])).toEqual({ qty: 5, reason: 'shortfall', job_id: null });
    // Jenny's line is still short: a stock order doesn't cover a job until the job is sourced from it.
    let att = (await req('GET', '/attention', 'Christine')).text;
    expect(att).toContain('Short for the factory');
    expect(att).toContain('Jenny Vassiniotis');
    expect((await req('GET', '/pipeline', 'Christine')).text).toContain('rdy-short');
    await req('POST', `/jobs/${jenny.id}/materials/source`, 'Christine', { hold: '1' });
    const split = await one(`select qty, job_id, reason, status from orders where item_id = $1 and job_id = $2 and status = 'listed'`, [sw, jenny.id]);
    expect(split).toEqual({ qty: 5, job_id: jenny.id, reason: 'job', status: 'listed' });
    att = (await req('GET', '/attention', 'Christine')).text;
    expect(att).not.toContain('Short for the factory');
    // The bin QR: Phil flags Classic White Sheen (36 on hand, 6 picked... free 30 > min 10, but a flag is a flag) once.
    const cws = await itemId('Classic White Sheen');
    expect((await req('GET', `/stock/bin/${cws}`, 'Phil')).text).toContain('Running low');
    expect((await req('POST', `/stock/bin/${cws}/low`, 'Phil', {})).status).toBe(302);
    expect((await req('POST', `/stock/bin/${cws}/low`, 'Phil', {})).status).toBe(302);
    expect(Number((await one(`select count(*) from orders where item_id = $1 and reason = 'low'`, [cws])).count)).toBe(1);
    expect((await one(`select qty, note from orders where item_id = $1 and reason = 'low'`, [cws])).qty).toBe(20);
    expect((await req('GET', '/stock/labels', 'Phil')).text).toContain('<svg');
    // An offcut, logged by the floor
    expect((await req('POST', '/stock/offcuts', 'Phil', { item_id: String(sw), length_mm: '1800', width_mm: '900', location: 'Rack 2' })).status).toBe(302);
    expect((await req('GET', '/stock/offcuts', 'Angela')).text).toContain('1800 × 900');
  });

  it('a job with picked stock can still be deleted; the ledger keeps the moves without the job', async () => {
    const job = await one(`select id from jobs where client_name = 'Greg Steven'`);
    const moves = Number((await one(`select count(*) from stock_moves where job_id = $1`, [job.id])).count);
    expect(moves).toBeGreaterThan(0);
    const r = await req('POST', `/jobs/${job.id}/delete`, 'George', {});
    expect(r.status).toBe(302);
    expect(r.location).toBe('/jobs');
    expect(await one('select 1 from jobs where id = $1', [job.id])).toBeUndefined();
    expect(Number((await one(`select count(*) from stock_moves where job_id is null and kind in ('picked', 'received')`)).count)).toBeGreaterThanOrEqual(moves);
  });

  it('the factory TV opens with the link key from Settings, and with nothing else', async () => {
    expect((await req('GET', '/tv')).status).toBe(403);
    expect((await req('POST', '/settings/tv', 'George', {})).status).toBe(302);
    const key = (await one(`select value from app_settings where key = 'tv_token'`)).value;
    expect(key.length).toBeGreaterThan(10);
    const tv = await req('GET', `/tv?k=${key}`);
    expect(tv.status).toBe(200);
    expect(tv.text).toContain('Factory · week of');
    expect(tv.text).toContain('http-equiv="refresh"');
    expect((await req('GET', '/tv?k=wrong')).status).toBe(403);
    expect((await req('GET', '/tv', 'Phil')).status).toBe(200);
    expect((await req('GET', '/settings/tv', 'George')).text).toContain(`/tv?k=${key}`);
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

describe('the redesigns (George, 7 Nov 2026)', () => {
  const tabsOf = (text: string) => [...text.matchAll(/<nav class="tabs"[\s\S]*?<\/nav>/g)][0]?.[0] ?? '';
  it('A: tabs by role, and More completes the set', async () => {
    const editor = tabsOf((await req('GET', '/board', 'George')).text);
    expect(editor).toContain('href="/attention"');
    expect(editor).not.toContain('href="/me"');
    const doer = tabsOf((await req('GET', '/me', 'Phil')).text);
    expect(doer).toContain('href="/jobs/last"');
    expect(doer).toContain('href="/stock"');
    expect(doer).not.toContain('href="/board"');
    expect((await req('GET', '/more', 'Phil')).text).toContain('href="/board"');
    const viewer = tabsOf((await req('GET', '/board', 'Angela')).text);
    expect(viewer).toContain('href="/pipeline"');
    expect(viewer).not.toContain('href="/attention"');
    // A screen off the role's row lights More.
    expect(tabsOf((await req('GET', '/rework', 'Phil')).text)).toMatch(/href="\/more" aria-current="page"/);
  });
  it('A: This job is the job last opened on this phone, else Find', async () => {
    expect((await req('GET', '/jobs/last', 'Phil')).location).toBe('/find');
    const job = await one(`select id from jobs where status = 'live' order by id limit 1`);
    const r = await fetch(`${base}/jobs/${job.id}`, { headers: { Cookie: `hub_session=${tokens.Phil}` } });
    const cookie = r.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`hub_lastjob=${job.id}`);
    const again = await fetch(`${base}/jobs/last`, { headers: { Cookie: `hub_session=${tokens.Phil}; hub_lastjob=${job.id}` }, redirect: 'manual' });
    expect(again.headers.get('location')).toBe(`/jobs/${job.id}`);
  });
  it('B: the job page carries a section strip with ids for every part', async () => {
    const job = await one(`select id from jobs where status = 'live' order by id limit 1`);
    const t = (await req('GET', `/jobs/${job.id}`, 'George')).text;
    expect(t).toContain('class="jobnav"');
    for (const id of ['steps', 'materials', 'files', 'flags', 'tasks', 'rework', 'details', 'history']) {
      expect(t).toContain(`data-section="${id}"`);
      expect(t).toContain(`id="${id}"`);
    }
    expect((await req('GET', `/jobs/${job.id}`, 'Phil')).text).not.toContain('data-section="tasks"');
  });
  it('C: Settings is a menu of pages, each with a status line, and the old anchors land on pages', async () => {
    const menu = (await req('GET', '/settings', 'George')).text;
    for (const k of ['people', 'capacity', 'job-types', 'durations', 'blocked-days', 'flag-types', 'emails', 'message', 'tv', 'bot']) {
      expect(menu).toContain(`href="/settings/${k}"`);
      expect((await req('GET', `/settings/${k}`, 'George')).status).toBe(200);
      expect((await req('GET', `/settings/${k}`, 'Phil')).status).toBe(403);
    }
    expect(menu).toContain('can sign in');
    expect((await req('POST', '/settings/message', 'George', { message: 'Hello' })).location).toBe('/settings/message');
    expect((await req('POST', '/settings/message', 'George', { message: '' })).location).toBe('/settings/message');
    expect((await req('GET', '/settings/people', 'George')).text).toContain('class="cards people"');
  });
});

describe('redesigns D and E (George, 7 Nov 2026)', () => {
  it('D: Pipeline, Need and supply and Count carry the phone card markup', async () => {
    const pipe = (await req('GET', '/pipeline', 'George')).text;
    expect(pipe).toContain('class="pipe smc"');
    expect(pipe).toContain('data-l="Factory"');
    expect(pipe).toContain('class="pj full"');
    expect((await req('GET', '/stock/count', 'George')).text).toContain('data-l="On the shelf"');
  });
  it('E: each screen has one guide line with a key and a "?" button', async () => {
    for (const [path, key] of [['/board', 'board'], ['/pipeline', 'pipeline'], ['/jobs', 'jobs'], ['/jobs/new', 'new-job'], ['/stock/count', 'count']]) {
      const t = (await req('GET', path, 'George')).text;
      expect(t).toContain(`data-guide="${key}"`);
      expect(t).toContain('class="guide-q"');
    }
    // My day's line needs areas set (Phil's are, from the People test above); without them the "areas aren't set" notice shows instead.
    for (const [path, key] of [['/me', 'me']]) {
      const t = (await req('GET', path, 'Phil')).text;
      expect(t).toContain(`data-guide="${key}"`);
      expect(t).toContain('class="guide-q"');
    }
    const job = await one(`select id from jobs where status = 'live' order by id limit 1`);
    expect((await req('GET', `/jobs/${job.id}`, 'Phil')).text).toContain('data-guide="job-steps"');
  });
});

describe('the site link and the site log (George, 7 Nov 2026)', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const multipart = (fields: Record<string, string>, photos = 0) => {
    const boundary = 'hubsite';
    const part = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const parts = [Buffer.from(Object.entries(fields).map(([k, v]) => part(k, v)).join(''))];
    for (let i = 0; i < photos; i++) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="p${i}.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
  };
  let jobId = 0; let link = ''; let cookie = '';
  const asInstaller = (method: string, path: string, m?: { body: Buffer; type: string }) =>
    fetch(base + path, { method, headers: { Origin: base, Cookie: cookie, ...(m ? { 'Content-Type': m.type } : {}) }, body: m?.body, redirect: 'manual' });

  it('an Editor makes a link for a named installer; the installer record can never sign in by email', async () => {
    jobId = (await one(`select id from jobs where status = 'live' and exists (select 1 from steps s where s.job_id = jobs.id and s.kind = 'install' and s.label = '' and s.done_at is null) order by id limit 1`)).id;
    const r = await req('POST', `/jobs/${jobId}/site-links`, 'George', { name: 'Mick (ABC Installs)' });
    expect(r.status).toBe(302);
    const l = await one('select l.token, p.email, p.role, p.areas, p.link_only from site_links l join people p on p.id = l.person_id where l.job_id = $1 and l.revoked_at is null', [jobId]);
    expect(l.link_only).toBe(true);
    expect(l.role).toBe('doer');
    expect(l.areas).toEqual(['install']);
    link = `/site/go/${l.token}`;
    const login = await req('POST', '/login', undefined, { email: l.email });
    expect((await one('select count(*)::int as n from sign_in_links where person_id = (select person_id from site_links where token = $1)', [l.token])).n).toBe(0);
    expect(login.status).toBe(200);
    // Doers can't make links.
    expect((await req('POST', `/jobs/${jobId}/site-links`, 'Phil', { name: 'Someone' })).status).toBe(403);
    // The same name on another job reuses the installer.
    const other = (await one(`select id from jobs where id <> $1 and status = 'live' order by id limit 1`, [jobId])).id;
    await req('POST', `/jobs/${other}/site-links`, 'George', { name: 'mick (abc installs)' });
    expect((await one(`select count(*)::int as n from people where link_only`)).n).toBe(1);
    expect((await req('GET', '/settings/people', 'George')).text).toContain('Mick (ABC Installs)');
  });

  it('the link opens one job and nothing else', async () => {
    const r = await fetch(base + link, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/site');
    cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie.startsWith('hub_session=')).toBe(true);
    const site = await asInstaller('GET', '/site');
    expect(site.status).toBe(200);
    const t = await site.text();
    expect(t).toContain('action="/site/log"');
    expect(t).toContain('Finished from our side');
    expect(t).not.toContain('class="tabs"');
    for (const p of ['/board', '/me', `/jobs/${jobId}`, '/stock', '/settings', '/jobs/last']) {
      const x = await asInstaller('GET', p);
      expect([p, x.status, x.headers.get('location')]).toEqual([p, 302, '/site']);
    }
    expect((await asInstaller('POST', `/steps/1/done`, multipart({ done: '1' }))).headers.get('location')).toBe('/site');
    expect((await fetch(base + '/site/go/not-a-real-token', { redirect: 'manual' })).status).toBe(404);
  });

  it('a daily log with photos, something missing as a flag to Gus, and finished from their side', async () => {
    const log = await asInstaller('POST', '/site/log', multipart({ note: 'Base cabinets in' }, 2));
    expect(log.headers.get('location')).toBe('/site#log');
    const l = await one(`select l.id, l.kind, l.person_id, (select count(*)::int from site_log_photos p where p.log_id = l.id) as photos from site_logs l where l.job_id = $1 order by l.id desc limit 1`, [jobId]);
    expect(l.kind).toBe('log');
    expect(l.photos).toBe(2);
    // The photo is served to the installer, and to staff, and the scope can't reach another job's.
    const pid = (await one('select id from site_log_photos where log_id = $1 limit 1', [l.id])).id;
    expect((await asInstaller('GET', `/site/logs/${l.id}/photos/${pid}`)).status).toBe(200);
    expect((await req('GET', `/site/logs/${l.id}/photos/${pid}`, 'Christine')).status).toBe(200);

    const miss = await asInstaller('POST', '/site/missing', multipart({ note: 'No handles for the pantry' }, 1));
    expect(miss.status).toBe(302);
    const issue = await one(`select i.type_key, i.status, i.raised_by, t.responsible, (select count(*)::int from issue_photos p where p.issue_id = i.id) as photos from issues i join issue_types t on t.key = i.type_key where i.job_id = $1 order by i.id desc limit 1`, [jobId]);
    expect(issue.type_key).toBe('missing_on_site');
    expect(issue.photos).toBe(1);
    expect(issue.raised_by).toBe(l.person_id);
    expect((await one(`select issue_id from site_logs where job_id = $1 and kind = 'missing' order by id desc limit 1`, [jobId])).issue_id).not.toBeNull();
    expect((await req('GET', `/jobs/${jobId}`, 'George')).text).toContain('Missing on site');

    const fin = await asInstaller('POST', '/site/finished', multipart({ note: 'All done' }, 1));
    expect(fin.headers.get('location')).toBe('/site');
    const s = await one(`select site_finished_at, site_finished_by, done_at from steps where job_id = $1 and kind = 'install' and label = ''`, [jobId]);
    expect(s.site_finished_at).not.toBeNull();
    expect(s.site_finished_by).toBe(l.person_id);
    expect(s.done_at).toBeNull();
    expect(await asInstaller('GET', '/site').then((r) => r.text())).toContain('Waiting on the site manager');
  });

  it('a site manager sees it under Needs your sign-off and signs off with the install tick; the installer sees Signed off', async () => {
    await req('POST', `/settings/people/${ids.Gus}`, 'George', { name: 'Gus', email: 'gus@test.au', role: 'doer', active: '1', areas: 'install', is_owner: '1', email_digest: '1' });
    const me = (await req('GET', '/me', 'Gus')).text;
    expect(me).toContain('Needs your sign-off');
    expect((await req('GET', `/jobs/${jobId}`, 'Gus')).text).toContain('needs sign-off');
    const s = await one(`select id from steps where job_id = $1 and kind = 'install' and label = ''`, [jobId]);
    const r = await fetch(base + `/steps/${s.id}/done`, { method: 'POST', headers: { Origin: base, Cookie: `hub_session=${tokens.Gus}`, 'Content-Type': multipart({}).type }, body: multipart({ done: '1', gaps: '1', clean: '1', back: '/me' }, 1).body, redirect: 'manual' });
    expect(r.status).toBe(302);
    expect((await one('select done_at, done_by from steps where id = $1', [s.id])).done_by).toBe(ids.Gus);
    expect((await req('GET', '/me', 'Gus')).text).not.toContain('Needs your sign-off');
    expect(await asInstaller('GET', '/site').then((x) => x.text())).toContain('Install signed off');
  });

  it('stopping the link signs the phone out, and switching the installer off stops every link', async () => {
    const lid = (await one('select id from site_links where job_id = $1 and revoked_at is null', [jobId])).id;
    await req('POST', `/site-links/${lid}/revoke`, 'Christine', {});
    expect((await asInstaller('GET', '/site')).headers.get('location')).toContain('/login');
    expect((await fetch(base + link, { redirect: 'manual' })).status).toBe(404);
    const installer = await one('select id from people where link_only');
    await req('POST', `/settings/installers/${installer.id}`, 'George', { active: '0' });
    expect((await one('select active from people where id = $1', [installer.id])).active).toBe(false);
    expect((await one('select count(*)::int as n from site_links l join people p on p.id = l.person_id where p.active and l.revoked_at is null')).n).toBe(0);
  });
});

describe('fixes 2 and 4 (George, 7 Nov 2026)', () => {
  it('2: a move drawn with a date the step no longer has is refused', async () => {
    const s = await one(`select s.id, s.job_id, s.start_date from steps s join jobs j on j.id = s.job_id where j.status = 'live' and s.kind = 'production_drawings' and s.label = '' and s.done_at is null and s.start_date is not null order by s.id limit 1`);
    const stale = await fetch(base + `/jobs/${s.job_id}/reschedule/quick`, { method: 'POST', headers: { Origin: base, Cookie: `hub_session=${tokens.George}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ step: String(s.id), start: '2027-02-01', mode: 'only', was: '2020-01-01' }).toString(), redirect: 'manual' });
    expect(stale.status).toBe(302);
    expect(decodeURIComponent(stale.headers.get('set-cookie') ?? '')).toContain('has moved since you opened this page');
    expect((await one('select start_date from steps where id = $1', [s.id])).start_date).toBe(s.start_date);
    const fresh = await req('POST', `/jobs/${s.job_id}/reschedule/quick`, 'George', { step: String(s.id), start: '2027-02-01', mode: 'only', was: s.start_date });
    expect(fresh.status).toBe(302);
    expect((await one('select start_date from steps where id = $1', [s.id])).start_date).toBe('2027-02-01');
    expect((await req('GET', `/jobs/${s.job_id}`, 'George')).text).toContain(`data-was="2027-02-01"`);
    expect((await req('GET', `/jobs/${s.job_id}/reschedule?step=${s.id}`, 'George')).text).toContain('name="was" value="2027-02-01"');
  });
  it('4: Done from My day leaves an Undo line once, and Undo unticks', async () => {
    await req('POST', `/settings/people/${ids.Phil}`, 'George', { name: 'Phil', email: 'phil@test.au', role: 'doer', active: '1', areas: 'factory', email_digest: '1' });
    const s = await one(`select s.id from steps s join jobs j on j.id = s.job_id where j.status = 'live' and s.kind = 'factory' and s.label = '' and s.done_at is null and s.start_date is not null order by s.id limit 1`);
    const r = await req('POST', `/steps/${s.id}/done`, 'Phil', { done: '1', back: '/me' });
    const undo = (r as unknown as { headers?: Headers }).headers ? '' : '';
    expect(r.status).toBe(302);
    const res = await fetch(base + `/steps/${s.id}/done`, { method: 'POST', headers: { Origin: base, Cookie: `hub_session=${tokens.Phil}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ done: '0', back: '/me' }).toString(), redirect: 'manual' });
    expect(res.status).toBe(302);
    const r2 = await fetch(base + `/steps/${s.id}/done`, { method: 'POST', headers: { Origin: base, Cookie: `hub_session=${tokens.Phil}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ done: '1', back: '/me' }).toString(), redirect: 'manual' });
    const set = r2.headers.get('set-cookie') ?? '';
    expect(set).toContain(`hub_undo=${s.id}`);
    const me = await fetch(base + '/me', { headers: { Cookie: `hub_session=${tokens.Phil}; hub_undo=${s.id}` } });
    const t = await me.text();
    expect(t).toContain('class="notice ok undo"');
    expect(t).toContain(`action="/steps/${s.id}/done"`);
    expect(me.headers.get('set-cookie')).toContain('hub_undo=;');
    expect((await req('GET', '/me', 'Phil')).text).not.toContain('class="notice ok undo"');
    expect(undo).toBe('');
  });
});
