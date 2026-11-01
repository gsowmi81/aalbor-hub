// Example suggestions for trying the Suggestions screen on your own computer. Never live:
// it refuses when NODE_ENV is production. Run after the Notion import:
//   npm run seed:suggestions:dev
// It writes as the system, the way a bot's token would, so the screen looks as it will.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { pool, withSystem } from '../src/db/pool.js';
import { checkItem, insertSuggestions, knownJobs } from '../src/db/suggestions.js';
import { addDays } from '../src/domain/dates.js';

export async function seedSuggestions(log: (m: string) => void = console.log): Promise<void> {
  if (config.production) throw new Error('seed:suggestions is for local copies only, never the live hub.');
  const rows = (await pool.query(
    `select j.job_number, s.kind, s.start_date, s.end_date, s.confirmed, s.done_at, j.status from jobs j join steps s on s.job_id = j.id
     where j.status = 'live' and j.job_number is not null and s.label = '' and s.kind <> 'rework' order by j.job_number, s.sort`)).rows;
  if (!rows.length) throw new Error('No jobs yet: run npm run import:notion:dev first.');
  const dated = rows.filter((r) => r.start_date && !r.done_at);
  const pick = (kind: string, n = 0) => dated.filter((r) => r.kind === kind)[n];
  const items: unknown[] = [];
  const install = pick('install');
  if (install) items.push({ job_number: install.job_number, stage_key: 'install', type: 'update_date', field: 'start_date', current_value: install.start_date, proposed_value: addDays(install.start_date, 7), reason: 'Buildertrend has install a week later (client away).', priority: 'urgent' });
  const cm = pick('check_measure');
  if (cm) items.push({ job_number: cm.job_number, stage_key: 'check_measure', type: 'update_date', current_value: cm.start_date, proposed_value: addDays(cm.start_date, 1), reason: 'Moved by a day in Buildertrend.', priority: 'normal' });
  const prov = rows.find((r) => r.start_date && !r.confirmed && !r.done_at);
  if (prov) items.push({ job_number: prov.job_number, stage_key: prov.kind, type: 'tick_confirmed', current_value: 'false', proposed_value: 'true', reason: 'Same date in Buildertrend.', priority: 'normal' });
  const f = pick('factory', 1);
  if (f) items.push({ job_number: f.job_number, stage_key: 'factory', type: 'update_date', field: 'end_date', current_value: f.end_date ?? f.start_date, proposed_value: addDays(f.end_date ?? f.start_date, 1), reason: 'Factory runs a day longer in Buildertrend.', priority: 'normal' });
  items.push({ job_number: '269999', type: 'add_job', priority: 'normal', reason: 'Contract signed in Buildertrend.',
    payload: { client_name: 'Example Client', suburb: 'Mascot', template: 'kitchen_poly', site_start: addDays(rows[0].start_date ?? '2026-12-01', 28), stages: { check_measure: { start_date: addDays(rows[0].start_date ?? '2026-12-01', 3) } } } });
  items.push({ job_number: rows[0].job_number, type: 'note', proposed_value: 'Buildertrend shows a change order for extra pantry shelves.', priority: 'info' });

  const jobs = await knownJobs();
  const good = items.map((it) => { try { return checkItem(it, jobs, []); } catch (err) { log(`skipped: ${(err as Error).message}`); return null; } }).filter((x) => x !== null);
  const ids = await withSystem((db) => insertSuggestions(db, good, `example-${new Date().toISOString().slice(0, 10)}`, 'Grokbot (example)'));
  log(`Added ${ids.length} example suggestions. Open /suggestions.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seedSuggestions()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
}
