// Runs against a real Postgres. Locally: TEST_DATABASE_URL, or the dev cluster
// described in CLAUDE.md. In GitHub Actions: the postgres service in ci.yml.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { appDatabaseUrl } = await import('./db-setup.js');
process.env.DATABASE_URL = await appDatabaseUrl();
const { pool, withPerson, withSystem, isPermissionError } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');

let editor: number, doer: number, viewer: number, jobId: number, stepId: number;

beforeAll(async () => {
  await migrate(() => {});
  await withSystem(async (db) => {
    const ids = await db.query(
      `insert into people (name, email, role) values ('Christine', 'c@x.au', 'editor'), ('Phil', 'p@x.au', 'doer'), ('Angela', 'a@x.au', 'viewer') returning id`,
    );
    [editor, doer, viewer] = ids.rows.map((r) => r.id);
  });
});
afterAll(() => pool.end());

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (isPermissionError(err)) return err.message;
    throw err;
  }
  throw new Error('expected the database to refuse this');
}

describe('roles are enforced by the database', () => {
  it('lets an Editor add a job and its steps', async () => {
    await withPerson(editor, async (db) => {
      jobId = (await db.query(`insert into jobs (client_name, suburb) values ('Jones', 'Surry Hills') returning id`)).rows[0].id;
      stepId = (await db.query(`insert into steps (job_id, kind, start_date) values ($1, 'factory', '2026-11-03') returning id`, [jobId])).rows[0].id;
    });
    expect(jobId).toBeGreaterThan(0);
  });

  it('refuses a write when nobody is signed in', async () => {
    expect(await refused(pool.query(`insert into jobs (client_name) values ('Nobody')`))).toBe('Not signed in');
  });

  it('refuses every write from a Viewer', async () => {
    expect(await refused(withPerson(viewer, (db) => db.query(`update steps set done_at = now() where id = $1`, [stepId])))).toMatch(/Viewers/);
    expect(await refused(withPerson(viewer, (db) => db.query(`insert into jobs (client_name) values ('X')`)))).toMatch(/Viewers/);
  });

  it('lets a Doer tick a step, and records who did it', async () => {
    await withPerson(doer, (db) => db.query(`update steps set done_at = now(), done_by = $2 where id = $1`, [stepId, editor]));
    const row = (await pool.query('select done_by from steps where id = $1', [stepId])).rows[0];
    expect(row.done_by).toBe(doer);
  });

  it('refuses a Doer changing dates, jobs or settings', async () => {
    expect(await refused(withPerson(doer, (db) => db.query(`update steps set start_date = '2026-11-04' where id = $1`, [stepId])))).toMatch(/Doers/);
    expect(await refused(withPerson(doer, (db) => db.query(`update jobs set client_name = 'Smith' where id = $1`, [jobId])))).toMatch(/Doers/);
    expect(await refused(withPerson(doer, (db) => db.query(`update settings set value = 9 where key = 'factory_kitchens_per_week'`)))).toMatch(/Doers/);
    expect(await refused(withPerson(doer, (db) => db.query(`delete from steps where id = $1`, [stepId])))).toMatch(/Doers/);
  });

  it('lets a Doer raise rework but not close it', async () => {
    const id = await withPerson(doer, async (db) =>
      (await db.query(`insert into rework (job_id, cause, note) values ($1, 'factory', 'Door chipped') returning id`, [jobId])).rows[0].id);
    expect(await refused(withPerson(doer, (db) => db.query(`update rework set closed_on = current_date where id = $1`, [id])))).toMatch(/Doers/);
    expect(await refused(withPerson(doer, (db) =>
      db.query(`insert into rework (job_id, note, extra_hours) values ($1, 'x', 3)`, [jobId])))).toMatch(/Doers/);
    const r = (await pool.query('select raised_by from rework where id = $1', [id])).rows[0];
    expect(r.raised_by).toBe(doer);
  });

  it('refuses a person who has been switched off', async () => {
    await withPerson(editor, (db) => db.query(`update people set active = false where id = $1`, [doer]));
    expect(await refused(withPerson(doer, (db) => db.query(`update steps set done_at = null where id = $1`, [stepId])))).toMatch(/no access/);
    await withPerson(editor, (db) => db.query(`update people set active = true where id = $1`, [doer]));
  });
});

describe('change log', () => {
  it('records who changed what, before and after', async () => {
    await withPerson(editor, (db) => db.query(`update jobs set suburb = 'Redfern' where id = $1`, [jobId]));
    const log = (await pool.query(
      `select person_name, action, before->>'suburb' as was, after->>'suburb' as now from change_log where table_name = 'jobs' and record_id = $1 order by id desc limit 1`,
      [String(jobId)],
    )).rows[0];
    expect(log).toEqual({ person_name: 'Christine', action: 'update', was: 'Surry Hills', now: 'Redfern' });
  });

  it('records the Doer tick', async () => {
    const log = (await pool.query(
      `select person_name from change_log where table_name = 'steps' and record_id = $1 and action = 'update' order by id limit 1`, [String(stepId)],
    )).rows[0];
    expect(log.person_name).toBe('Phil');
  });

  it("can't be edited or deleted", async () => {
    expect(await refused(withSystem((db) => db.query('delete from change_log')))).toMatch(/change log/);
  });
});

describe('sign-in tables', () => {
  it('refuse writes from people', async () => {
    expect(await refused(withPerson(editor, (db) =>
      db.query(`insert into sessions (token_hash, person_id, expires_at) values ('x', $1, now())`, [editor])))).toMatch(/sign-in/);
  });
});

describe('nightly backup (failed 31 Oct 2026 until migration 004)', () => {
  it('pins the search path on every function row-level security and the triggers call', async () => {
    const r = await pool.query(`select proname, proconfig from pg_proc where proname in ('hub_actor', 'hub_is_owner', 'hub_owner_guard', 'hub_owners_log', 'hub_guard', 'hub_log')`);
    expect(r.rows).toHaveLength(6);
    for (const f of r.rows) expect(f.proconfig, f.proname).toContain('search_path=public, pg_temp');
  });

  it('dumps every table, owners-only ones included, the way backup.sh does', async () => {
    const { execFileSync } = await import('node:child_process');
    let version = '';
    try { version = execFileSync('pg_dump', ['--version']).toString(); } catch { return; } // no client here: covered by the check above
    if (!/\b16\./.test(version)) return;
    const out = execFileSync('pg_dump', [process.env.DATABASE_URL!, '--format=plain', '--no-owner', '--enable-row-security', '--data-only', '--table=owners_log'],
      { env: { ...process.env, PGOPTIONS: '-c hub.system=on' } }).toString();
    expect(out).toContain('COPY public.owners_log');
  });
});
