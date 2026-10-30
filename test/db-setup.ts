// The tests run as an ordinary database user, like Render's, not as a superuser:
// superusers skip row-level security, so the owners-only rules would go untested.
import pg from 'pg';

export async function appDatabaseUrl(): Promise<string> {
  const superUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/hub_test?host=/var/tmp/hubpg';
  const u = new URL(superUrl);
  const dbName = u.pathname.slice(1);
  const c = new pg.Client({ connectionString: superUrl });
  await c.connect();
  await c.query(`do $$ begin
    if not exists (select from pg_roles where rolname = 'hub_app') then
      create role hub_app login password 'hub_app' nosuperuser nobypassrls;
    end if; end $$`);
  await c.query(`grant create, connect on database "${dbName}" to hub_app`);
  await c.query('drop schema if exists public cascade');
  await c.query('create schema public authorization hub_app');
  await c.end();
  u.username = 'hub_app';
  u.password = 'hub_app';
  return u.toString();
}
