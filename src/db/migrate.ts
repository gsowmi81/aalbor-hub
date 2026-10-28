// Applies migrations/*.sql in name order, once each, as the system.
// Render runs this before every deploy (preDeployCommand in render.yaml).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withSystem } from './pool.js';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/db (tsx) and dist/src/db (compiled).
const dir = [path.resolve(here, '../../migrations'), path.resolve(here, '../../../migrations')].find((d) => fs.existsSync(d))!;

export async function migrate(log = console.log): Promise<void> {
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await withSystem(async (db) => {
      await db.query(sql);
      await db.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    log(`Applied ${file}`);
  }
  if (config.initialEditorEmail) {
    await withSystem(async (db) => {
      await db.query(
        `insert into people (name, email, role) values ($1, $2, 'editor') on conflict (email) do nothing`,
        [config.initialEditorName, config.initialEditorEmail],
      );
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
