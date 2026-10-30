// One-off load of the live jobs from the Notion Production Hub, read on 28 Oct 2026
// and frozen in data/notion-snapshot-2026-10-28.json. Run once on Render:
//   npm run import:notion
// It refuses to run if the hub already has jobs, so it can't double-load.
//
// How Notion's operations become hub steps:
//   Contract drawings → Drafting for contract     Draft → Production drawings
//   Order materials → Materials ordered           Receive materials → Materials in
//   Cut & edge + Assemble + QC & wrap → one Factory step (earliest to latest date; done when all are done)
//   Doors to painter / back → Doors to painting / Doors back from painting
//   Deliver → Delivery    Install cabinets → Install cabinets (a second, named one becomes an extra step)
//   Stone measure / install → same    Factory / non-job (ZZ row) → factory-blocked days
//   Material take-off → dropped (not a hub step)
// Dates the team is working to come in as confirmed. Missing dates stay blank.
// "Booked (pre-contract)" becomes Live.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withSystem } from '../src/db/pool.js';
import { syncStepSet } from '../src/db/queries.js';
import { FLOW, StepKind } from '../src/domain/steps.js';

interface SnapJob { key: string; title: string; status: string; health: string | null; benchtop: string; finish: string | null; scope: string | null; start: string | null; notes: string }
interface SnapOp { job: string; type: string; status: string; start: string | null; end: string | null; owner: string; name: string | null }
interface Snapshot { read_on: string; jobs: SnapJob[]; operations: SnapOp[]; rework: { job: string; raised_on: string; note: string }[] }

const here = path.dirname(fileURLToPath(import.meta.url));
const file = [path.resolve(here, '../data/notion-snapshot-2026-10-28.json'), path.resolve(here, '../../data/notion-snapshot-2026-10-28.json')].find((f) => fs.existsSync(f))!;

const TYPE_TO_KIND: Record<string, StepKind | 'factory_part' | null> = {
  'Contract drawings': 'contract_drafting',
  Draft: 'production_drawings',
  'Order materials': 'materials_ordered',
  'Receive materials': 'materials_in',
  'Cut & edge': 'factory_part',
  Assemble: 'factory_part',
  'QC & wrap': 'factory_part',
  'Doors to painter': 'doors_to_painting',
  'Doors back from painter': 'doors_back',
  Deliver: 'delivery',
  'Install cabinets': 'install',
  'Stone measure': 'stone_measure',
  'Stone install': 'stone_install',
  'Check measure': 'check_measure',
  'Material take-off': null,
};

/** Owners George set on 28 Oct 2026: Christine orders; the factory sign-in receives, delivers and takes doors back. */
const OWNER_OVERRIDE: Partial<Record<StepKind, string>> = {
  materials_ordered: 'Christine', materials_in: 'Factory', doors_back: 'Factory', delivery: 'Factory',
};

function parseTitle(title: string): { job_number: string | null; client_name: string; suburb: string } {
  const parts = title.split(' — ').map((s) => s.trim());
  if (/^\d{6}$/.test(parts[0])) return { job_number: parts[0], client_name: parts[1], suburb: parts[2] ?? '' };
  // "Wissam — Croydon — Stage 2 Study + daughter's wardrobe"
  return { job_number: null, client_name: `${parts[0]}, ${parts[2] ?? ''}`.replace(/, $/, ''), suburb: parts[1] ?? '' };
}

const doneAt = (d: string | null, fallback: string) => `${d ?? fallback}T01:00:00Z`;

export async function importNotion(log = console.log): Promise<void> {
  const snap: Snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const existing = (await pool.query('select count(*)::int as n from jobs')).rows[0].n;
  if (existing > 0) throw new Error(`The hub already has ${existing} jobs. The Notion import only runs into an empty hub.`);

  await withSystem(async (db) => {
    await db.query(`insert into people (name, email, role) values ('Christine', 'design@aalborkitchens.com.au', 'editor') on conflict (email) do nothing`);

    for (const sj of snap.jobs) {
      const ops = snap.operations.filter((o) => o.job === sj.key);
      const t = parseTitle(sj.title);
      // "Polytec" is a board brand, not polyurethane: match 2-pac, polyurethane or "poly" as a word.
      const poly = /2-pac|polyurethane|\bpoly\b/i.test(sj.finish ?? '') || ops.some((o) => o.type.startsWith('Doors '));
      const stone = sj.benchtop === 'Stone' || (sj.benchtop === 'TBC' && ops.some((o) => o.type.startsWith('Stone ')));
      const scope = [sj.scope, sj.finish && sj.finish !== 'TBC' ? `Finishes: ${sj.finish}` : null].filter(Boolean).join('\n');
      const job = await db.query(
        `insert into jobs (job_number, brand, client_name, suburb, scope, door_finish, has_painting, has_stone, site_start, status, at_risk, notes, added_on)
         values ($1, 'Aalbor', $2, $3, $4, $5, $6, $7, $8, 'live', $9, $10, $11) returning id`,
        [t.job_number, t.client_name, t.suburb, scope, poly ? 'polyurethane' : 'melamine', poly, stone, sj.start, sj.health === 'At risk',
          sj.notes ? `From Notion, ${snap.read_on}: ${sj.notes}` : '', snap.read_on]);
      const jobId = job.rows[0].id as number;

      const put = async (kind: StepKind, start: string | null, end: string | null, done: boolean, owner: string, label = '') => {
        await db.query(
          `insert into steps (job_id, kind, label, start_date, end_date, confirmed, owner, done_at, sort) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [jobId, kind, label, start, end && end !== start ? end : null, !!start, OWNER_OVERRIDE[kind] ?? owner,
            done ? doneAt(end ?? start, snap.read_on) : null, FLOW.indexOf(kind) * 10 + (label ? 5 : 0)]);
      };

      const factoryOps = ops.filter((o) => TYPE_TO_KIND[o.type] === 'factory_part');
      if (factoryOps.length) {
        const dates = factoryOps.flatMap((o) => [o.start, o.end]).filter((d): d is string => !!d).sort();
        await put('factory', dates[0] ?? null, dates.length ? dates[dates.length - 1] : null, factoryOps.every((o) => o.status === 'Done'), 'Phil');
      }
      // An operation Notion gave its own name (Tesoriero's "Doors installed") becomes an extra named step.
      const seen = new Set<StepKind>();
      for (const o of ops) {
        const kind = TYPE_TO_KIND[o.type];
        if (!kind || kind === 'factory_part') continue;
        const label = o.name ? (kind === 'install' ? 'Install painted doors' : o.name) : seen.has(kind) ? `${o.type} (second)` : '';
        if (label) log(`  ${t.client_name}: "${label}" kept as an extra step`);
        else seen.add(kind);
        await put(kind, o.start, o.end, o.status === 'Done', o.owner, label);
      }
      await syncStepSet(db, jobId);
      log(`${t.job_number ?? '------'}  ${t.client_name} · ${t.suburb}: ${ops.length} operations`);
    }

    for (const o of snap.operations.filter((x) => x.type === 'Factory / non-job' && x.start)) {
      await db.query(`insert into blocked_days (day, scope, reason) values ($1, 'factory', 'Factory internal (from Notion)') on conflict do nothing`, [o.start]);
    }

    for (const r of snap.rework) {
      const j = snap.jobs.find((x) => x.key === r.job)!;
      const t = parseTitle(j.title);
      await db.query(
        `insert into rework (job_id, note, raised_at) select id, $2, $3 from jobs where client_name = $1`,
        [t.client_name, r.note, `${r.raised_on}T01:00:00Z`]);
      log(`Rework: ${t.client_name}: ${r.note}`);
    }
  });
  log(`Imported ${snap.jobs.length} jobs from the Notion snapshot of ${snap.read_on}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  importNotion()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
}

