import express, { Request, Response } from 'express';
import { pool, withPerson, Db } from '../db/pool.js';
import { loadBlocked, loadCalendar, loadEverything, loadJob, loadJobHistory, loadJobList, loadRules, syncStepSet } from '../db/queries.js';
import { addDays, Iso, todaySydney } from '../domain/dates.js';
import { capacity, needsDecision, overdue, StepRow } from '../domain/checks.js';
import { DoorFinish, FLOW, KINDS, proposeDates, ProposalInput, shiftStep, siteStartFromJobNumber, StepKind } from '../domain/steps.js';
import { Person, readCookie, requireRole, setCookie } from './auth.js';
import { page } from '../views/layout.js';
import { comingUp, StoredDecision } from '../views/comingUp.js';
import { allJobs } from '../views/jobs.js';
import { CAUSES, jobPage } from '../views/job.js';
import { newJobPage, proposalBlock, reworkPage, settingsPage } from '../views/other.js';
import { exportWorkbook } from './export.js';
import { html } from './html.js';
import type { FullJob } from '../db/queries.js';

/** A mistake in what someone typed. Shown back to them, not logged as a fault. */
export class UserError extends Error {}

const me = (req: Request) => req.person as Person;
const today = () => todaySydney();

export function flash(res: Response, msg: string): void {
  setCookie(res, 'hub_flash', msg, 60);
}
function takeFlash(req: Request, res: Response): string | null {
  const f = readCookie(req, 'hub_flash');
  if (f) setCookie(res, 'hub_flash', '', 0);
  return f ?? null;
}
const localPath = (p: unknown): p is string => typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\');

/** Where to send someone after a form: the form's own "back" path, else the fallback. Never another site. */
export function backTo(req: Request, fallback = '/'): string {
  const b = req.body?.back;
  return localPath(b) ? b : localPath(fallback) ? fallback : '/';
}
function idParam(req: Request): number {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw new UserError('That link is broken.');
  return n;
}
function date(v: unknown, what: string): Iso | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new UserError(`${what}: that isn't a date.`);
  return s;
}
function brandOf(req: Request): string {
  const b = String(req.query.brand ?? 'all');
  return ['Aalbor', 'Origin'].includes(b) ? b : 'all';
}

async function storedDecisions(): Promise<Map<string, StoredDecision>> {
  const r = await pool.query(`select d.key, d.fingerprint, d.note, d.decided_at, p.name as decided_by_name from decisions d left join people p on p.id = d.decided_by`);
  return new Map(r.rows.map((x) => [x.key, x]));
}

async function board() {
  const [all, rules, cal, stored] = await Promise.all([loadEverything(), loadRules(), loadCalendar(), storedDecisions()]);
  const t = today();
  return { ...all, rules, cal, stored, t, decisions: needsDecision(all.jobs, all.steps, all.rework, rules, cal, t) };
}

function checkDates(start: Iso | null, end: Iso | null, label: string): Iso | null {
  if (!start && end) throw new UserError(`${label}: give a "from" date as well as a "to" date.`);
  if (start && end && end < start) throw new UserError(`${label}: the "to" date is before the "from" date.`);
  return end && end !== start ? end : null;
}

/** Set a step's dates, checking they make sense. */
async function setStepDates(db: Db, stepId: number, start: Iso | null, end: Iso | null, label: string): Promise<void> {
  await db.query('update steps set start_date = $2, end_date = $3 where id = $1', [stepId, start, checkDates(start, end, label)]);
}

function parseJobForm(body: Record<string, unknown>) {
  const s = (k: string) => String(body[k] ?? '').trim();
  const n = (k: string, dflt: number) => {
    const v = Number(s(k) || dflt);
    if (!Number.isInteger(v) || v < 1 || v > 30) throw new UserError(`${k === 'factory_days' ? 'Factory' : 'Install'} days must be a whole number from 1 to 30.`);
    return v;
  };
  const values = {
    job_number: s('job_number') || null,
    client_name: s('client_name'),
    suburb: s('suburb'),
    brand: s('brand') === 'Origin' ? 'Origin' : 'Aalbor',
    scope: s('scope'),
    door_finish: (s('door_finish') === 'polyurethane' ? 'polyurethane' : 'melamine') as DoorFinish,
    has_stone: body.has_stone === '1',
    site_start: date(body.site_start, 'Site start') ?? (s('job_number') ? siteStartFromJobNumber(s('job_number')) : null),
    factory_days: n('factory_days', 2),
    install_days: n('install_days', 3),
    status: ['live', 'on_hold', 'complete', 'cancelled'].includes(s('status')) ? s('status') : 'live',
    at_risk: body.at_risk === '1',
    notes: s('notes'),
  };
  return values;
}

export function routes(): express.Router {
  const r = express.Router();
  const editor = requireRole('editor');
  const doer = requireRole('doer');

  // ---------- Screens ----------

  r.get('/', async (req, res) => {
    const b = await board();
    const week = req.query.week === '1' ? 1 : 0;
    const body = comingUp({
      person: me(req), today: b.t, week, brand: brandOf(req), jobs: b.jobs, steps: b.steps, rework: b.rework,
      overdue: overdue(b.jobs, b.steps, b.t), decisions: b.decisions, stored: b.stored,
      capacity: capacity(b.jobs, b.steps, b.rules, b.cal, b.t), cal: b.cal,
    });
    res.send(page({ title: 'Coming up', tab: 'coming-up', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  r.get('/jobs', async (req, res) => {
    const b = await board();
    const body = allJobs({ jobs: b.jobs, steps: b.steps, decisions: b.decisions.filter((x) => b.stored.get(x.key)?.fingerprint !== x.fingerprint), today: b.t, brand: brandOf(req) });
    res.send(page({ title: 'All jobs', tab: 'jobs', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  r.get('/job', async (req, res) => {
    if (req.query.id) return res.redirect(`/jobs/${Number(req.query.id)}`);
    const b = await board();
    const live = new Set(b.jobs.filter((j) => j.status === 'live').map((j) => j.id));
    const next = b.steps.filter((s) => live.has(s.job_id) && !s.done_at && s.start_date && s.start_date >= b.t)
      .sort((a, c) => a.start_date!.localeCompare(c.start_date!))[0];
    const id = next?.job_id ?? b.jobs.find((j) => j.status === 'live')?.id ?? b.jobs[0]?.id;
    if (!id) return res.send(page({ title: 'One job', tab: 'job', person: me(req), body: html`<p>No jobs yet.</p>` }).value);
    res.redirect(`/jobs/${id}`);
  });

  r.get('/jobs/new', editor, async (req, res) => {
    const rules = await loadRules();
    const body = newJobPage({ values: { factory_days: rules.default_factory_days, install_days: rules.default_install_days, has_stone: true }, proposal: null, clashes: [] });
    res.send(page({ title: 'New job', tab: 'new', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  async function proposalFor(values: ReturnType<typeof parseJobForm>) {
    if (!values.site_start) return { proposal: null, clashes: [] };
    const [rules, cal, all] = await Promise.all([loadRules(), loadCalendar(), loadEverything()]);
    const input: ProposalInput = { ...values, site_start: values.site_start, added_on: today() };
    const proposal = proposeDates(input, rules, cal);
    // Capacity with this job added, keeping only warnings that involve it.
    const ghost = { id: -1, job_number: values.job_number, brand: values.brand, client_name: values.client_name || 'This job', suburb: values.suburb, door_finish: values.door_finish, has_stone: values.has_stone, site_start: values.site_start, factory_days: values.factory_days, install_days: values.install_days, status: 'live', at_risk: false };
    const ghostSteps: StepRow[] = proposal.map((p, i) => ({ id: -1 - i, job_id: -1, kind: p.kind, rework_id: null, label: '', start_date: p.start_date, end_date: p.end_date, confirmed: false, owner: '', done_at: null }));
    const clashes = capacity([...all.jobs, ghost], [...all.steps, ...ghostSteps], rules, cal, today()).filter((c) => c.jobIds.includes(-1));
    return { proposal, clashes };
  }

  r.post('/jobs/preview', editor, async (req, res) => {
    try {
      const values = parseJobForm(req.body);
      const { proposal, clashes } = await proposalFor(values);
      res.send(proposalBlock(proposal, clashes).value);
    } catch (err) {
      if (err instanceof UserError) return res.send(`<h2>Proposed dates</h2><p class="nodate">${err.message}</p>`);
      throw err;
    }
  });

  r.post('/jobs/new', editor, async (req, res) => {
    let values: ReturnType<typeof parseJobForm> | undefined;
    const render = async (error?: string) => {
      const { proposal, clashes } = values ? await proposalFor(values) : { proposal: null, clashes: [] };
      res.send(page({ title: 'New job', tab: 'new', person: me(req), body: newJobPage({ values: (values ?? req.body) as Partial<FullJob>, proposal, clashes, error }) }).value);
    };
    try {
      values = parseJobForm(req.body);
    } catch (err) {
      if (err instanceof UserError) return render(err.message);
      throw err;
    }
    if (req.body.action !== 'save') return render();
    if (!values.client_name) return render('Add the client name.');
    if (!values.site_start) return render('Add the site start. It comes from the job number when there is one.');
    if (values.job_number && (await pool.query('select 1 from jobs where job_number = $1', [values.job_number])).rowCount) {
      return render(`Job ${values.job_number} is already in the hub.`);
    }
    const v = values;
    const { proposal } = await proposalFor(v);
    const id = await withPerson(me(req).id, async (db) => {
      const job = await db.query(
        `insert into jobs (job_number, brand, client_name, suburb, scope, door_finish, has_stone, site_start, factory_days, install_days, notes, added_on)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [v.job_number, v.brand, v.client_name, v.suburb, v.scope, v.door_finish, v.has_stone, v.site_start, v.factory_days, v.install_days, v.notes, today()]);
      const jobId = job.rows[0].id as number;
      for (const p of proposal ?? []) {
        await db.query(`insert into steps (job_id, kind, start_date, end_date, owner, sort, confirmed) values ($1,$2,$3,$4,$5,$6,false)`,
          [jobId, p.kind, p.start_date, p.end_date, KINDS[p.kind].owner, FLOW.indexOf(p.kind) * 10]);
      }
      await syncStepSet(db, jobId);
      return jobId;
    });
    flash(res, `${v.client_name} added. Every date is provisional until you confirm it.`);
    res.redirect(`/jobs/${id}`);
  });

  r.get('/jobs/:id', async (req, res) => {
    const id = idParam(req);
    const data = await loadJob(id);
    if (!data) return res.status(404).send(page({ title: 'Not found', tab: 'job', person: me(req), body: html`<p>That job isn't in the hub. <a href="/jobs">All jobs</a></p>` }).value);
    const [list, history, b] = await Promise.all([loadJobList(), loadJobHistory(id), board()]);
    const decisions = b.decisions.filter((x) => x.jobId === id && b.stored.get(x.key)?.fingerprint !== x.fingerprint);
    const body = jobPage({ person: me(req), today: b.t, ...data, list, history, decisions });
    res.send(page({ title: 'One job', tab: 'job', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  // ---------- Job changes (Editors) ----------

  r.post('/jobs/:id/details', editor, async (req, res) => {
    const id = idParam(req);
    const v = parseJobForm(req.body);
    if (!v.client_name) throw new UserError('Add the client name.');
    await withPerson(me(req).id, async (db) => {
      await db.query(
        `update jobs set job_number=$2, brand=$3, client_name=$4, suburb=$5, scope=$6, door_finish=$7, has_stone=$8, site_start=$9,
           factory_days=$10, install_days=$11, status=$12, at_risk=$13, notes=$14 where id=$1`,
        [id, v.job_number, v.brand, v.client_name, v.suburb, v.scope, v.door_finish, v.has_stone, v.site_start, v.factory_days, v.install_days, v.status, v.at_risk, v.notes]);
      await syncStepSet(db, id);
    });
    flash(res, 'Job details saved.');
    res.redirect(`/jobs/${id}`);
  });

  r.post('/jobs/:id/dates', editor, async (req, res) => {
    const id = idParam(req);
    const steps = (await pool.query(`select id, kind, label from steps where job_id = $1 and kind <> 'rework'`, [id])).rows as { id: number; kind: StepKind; label: string }[];
    const confirmAll = req.body.confirm_all === '1';
    await withPerson(me(req).id, async (db) => {
      for (const s of steps) {
        if (!(`start_${s.id}` in req.body)) continue;
        const label = s.label || KINDS[s.kind].label;
        const start = date(req.body[`start_${s.id}`], label);
        const end = checkDates(start, date(req.body[`end_${s.id}`], label), label);
        const confirmed = !!start && (confirmAll || req.body[`confirmed_${s.id}`] === '1');
        // One update per step, so the history shows one line per change.
        await db.query('update steps set start_date = $2, end_date = $3, confirmed = $4 where id = $1', [s.id, start, end, confirmed]);
      }
    });
    flash(res, confirmAll ? 'Dates saved and confirmed.' : 'Dates saved.');
    res.redirect(`/jobs/${id}`);
  });

  r.post('/jobs/:id/shift', editor, async (req, res) => {
    const id = idParam(req);
    const n = Number(req.body.n);
    if (![-1, 1, 5].includes(n)) throw new UserError('Pick −1 day, +1 day or +1 week.');
    const cal = await loadCalendar();
    const steps = (await pool.query(`select id, kind, start_date, end_date from steps where job_id = $1 and done_at is null and start_date is not null`, [id])).rows;
    await withPerson(me(req).id, async (db) => {
      for (const s of steps) {
        const moved = shiftStep(s, n, cal);
        await db.query('update steps set start_date = $2, end_date = $3 where id = $1', [s.id, moved.start_date, moved.end_date]);
      }
    });
    flash(res, `Moved ${steps.length} steps ${n < 0 ? 'back 1 working day' : n === 1 ? 'on 1 working day' : 'on 1 week'}.`);
    res.redirect(`/jobs/${id}`);
  });

  r.post('/jobs/:id/repropose', editor, async (req, res) => {
    const id = idParam(req);
    const job = (await pool.query('select * from jobs where id = $1', [id])).rows[0];
    if (!job?.site_start) throw new UserError('Set the site start first.');
    const [rules, cal] = await Promise.all([loadRules(), loadCalendar()]);
    const proposal = proposeDates({ ...job, added_on: job.added_on }, rules, cal);
    let changed = 0;
    await withPerson(me(req).id, async (db) => {
      for (const p of proposal) {
        const u = await db.query(
          `update steps set start_date = $3, end_date = $4 where job_id = $1 and kind = $2 and done_at is null and not confirmed
             and (start_date is distinct from $3 or end_date is distinct from $4)`,
          [id, p.kind, p.start_date, p.end_date]);
        changed += u.rowCount ?? 0;
      }
    });
    flash(res, changed ? `${changed} provisional dates worked out again.` : 'Nothing to change: every open step is confirmed or already matches.');
    res.redirect(`/jobs/${id}`);
  });

  // ---------- Steps ----------

  r.post('/steps/:id/done', doer, async (req, res) => {
    const id = idParam(req);
    const done = req.body.done === '1';
    await withPerson(me(req).id, (db) => db.query(`update steps set done_at = ${done ? 'coalesce(done_at, now())' : 'null'} where id = $1`, [id]));
    res.redirect(backTo(req));
  });

  r.post('/steps/:id/move', editor, async (req, res) => {
    const id = idParam(req);
    const to = date(req.body.date, 'New date');
    if (!to) throw new UserError('Pick the new date.');
    const s = (await pool.query('select id, kind, start_date, end_date, label from steps where id = $1', [id])).rows[0];
    if (!s) throw new UserError('That step has gone.');
    const cal = await loadCalendar();
    const scope = KINDS[s.kind as StepKind].scope;
    let end: Iso | null = null;
    if (s.end_date && s.start_date) {
      const len = cal.workingDaysBetween(cal.onOrAfter(s.start_date, scope), s.end_date, scope);
      end = cal.addWorkingDays(cal.onOrAfter(to, scope), len, scope);
    }
    await withPerson(me(req).id, (db) => setStepDates(db, id, to, end, s.label || KINDS[s.kind as StepKind].label));
    flash(res, 'New date saved.');
    res.redirect(backTo(req));
  });

  // ---------- Needs a decision (Editors) ----------

  r.post('/decisions/ok', editor, async (req, res) => {
    const key = String(req.body.key ?? '');
    await withPerson(me(req).id, (db) => db.query(
      `insert into decisions (key, fingerprint, decided_by, note) values ($1, $2, $3, $4)
       on conflict (key) do update set fingerprint = excluded.fingerprint, decided_by = excluded.decided_by, decided_at = now(), note = excluded.note`,
      [key, String(req.body.fingerprint ?? ''), me(req).id, String(req.body.note ?? 'OK as is')]));
    res.redirect(backTo(req));
  });

  r.post('/decisions/undo', editor, async (req, res) => {
    await withPerson(me(req).id, (db) => db.query('delete from decisions where key = $1', [String(req.body.key ?? '')]));
    res.redirect(backTo(req));
  });

  r.post('/decisions/fix', editor, async (req, res) => {
    const ids = new Set<number>();
    for (const k of Object.keys(req.body)) {
      const m = k.match(/^(?:start|end)_(\d+)$/);
      if (m) ids.add(Number(m[1]));
    }
    const steps = ids.size ? (await pool.query('select id, kind, label, start_date, end_date from steps where id = any($1)', [[...ids]])).rows : [];
    let changed = 0;
    await withPerson(me(req).id, async (db) => {
      for (const s of steps) {
        const label = s.label || KINDS[s.kind as StepKind].label;
        const start = date(req.body[`start_${s.id}`], label);
        const end = `end_${s.id}` in req.body ? date(req.body[`end_${s.id}`], label) : s.end_date;
        if (start === s.start_date && end === s.end_date) continue;
        await setStepDates(db, s.id, start, end, label);
        changed++;
      }
      for (const k of Object.keys(req.body)) {
        const m = k.match(/^site_start_(\d+)$/);
        const v = m && date(req.body[k], 'Site start');
        if (m && v) {
          await db.query('update jobs set site_start = $2 where id = $1', [Number(m[1]), v]);
          changed++;
        }
      }
    });
    flash(res, changed ? 'Dates changed.' : '!Nothing changed. Pick at least one new date, or use OK as is.');
    res.redirect(backTo(req));
  });

  // ---------- Rework ----------

  r.get('/rework', async (req, res) => {
    const rows = (await pool.query(
      `select r.*, p.name as raised_by_name, j.client_name, j.suburb from rework r join jobs j on j.id = r.job_id
       left join people p on p.id = r.raised_by order by r.raised_at desc`)).rows;
    const jobs = (await pool.query(`select id, client_name, suburb from jobs where status = 'live' order by client_name`)).rows;
    const body = reworkPage({ person: me(req), rework: rows, jobs, today: today() });
    res.send(page({ title: 'Rework', tab: 'rework', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  r.post('/rework', doer, async (req, res) => {
    const jobId = Number(req.body.job_id);
    const cause = String(req.body.cause ?? '');
    const note = String(req.body.note ?? '').trim();
    if (!jobId) throw new UserError('Pick the job.');
    if (!(CAUSES as readonly string[]).includes(cause)) throw new UserError('Pick a cause.');
    if (!note) throw new UserError('Add one line on what happened.');
    await withPerson(me(req).id, (db) => db.query('insert into rework (job_id, cause, note) values ($1, $2, $3)', [jobId, cause, note.slice(0, 200)]));
    flash(res, 'Rework raised. It shows in Needs a decision until Christine dates it.');
    res.redirect(backTo(req, '/rework'));
  });

  r.post('/rework/:id/steps', editor, async (req, res) => {
    const id = idParam(req);
    const rw = (await pool.query('select job_id from rework where id = $1', [id])).rows[0];
    if (!rw) throw new UserError('That rework has gone.');
    const label = String(req.body.label ?? '').trim();
    if (!label) throw new UserError('Say what the step is.');
    const start = date(req.body.start, label);
    const end = date(req.body.end, label);
    await withPerson(me(req).id, async (db) => {
      const s = await db.query(`insert into steps (job_id, kind, rework_id, label, owner, sort, confirmed) values ($1, 'rework', $2, $3, $4, 200, true) returning id`,
        [rw.job_id, id, label, String(req.body.owner ?? '').trim()]);
      await setStepDates(db, s.rows[0].id, start, end, label);
    });
    flash(res, 'Rework step added.');
    res.redirect(backTo(req));
  });

  r.post('/rework/:id/close', editor, async (req, res) => {
    const id = idParam(req);
    const hours = Number(req.body.extra_hours);
    const cost = Number(req.body.extra_material_cost);
    const cause = String(req.body.cause ?? '');
    if (!Number.isFinite(hours) || hours < 0 || !Number.isFinite(cost) || cost < 0) throw new UserError('Enter rough extra hours and extra material dollars (0 is fine).');
    if (!(CAUSES as readonly string[]).includes(cause)) throw new UserError('Pick a cause.');
    await withPerson(me(req).id, (db) => db.query(
      'update rework set closed_on = $2, extra_hours = $3, extra_material_cost = $4, cause = $5 where id = $1', [id, today(), hours, cost, cause]));
    flash(res, 'Rework closed.');
    res.redirect(backTo(req));
  });

  // ---------- Settings (Editors) ----------

  r.get('/settings', editor, async (req, res) => {
    const [settings, blocked, people] = await Promise.all([
      pool.query('select key, value, label from settings order by sort'),
      loadBlocked(),
      pool.query('select id, name, email, role, active from people order by active desc, role, name'),
    ]);
    const body = settingsPage({ settings: settings.rows, blocked, people: people.rows, today: today() });
    res.send(page({ title: 'Settings', tab: 'settings', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  r.post('/settings/values', editor, async (req, res) => {
    const keys = (await pool.query('select key, label from settings')).rows;
    await withPerson(me(req).id, async (db) => {
      for (const k of keys) {
        if (!(k.key in req.body)) continue;
        const v = Number(req.body[k.key]);
        if (!Number.isInteger(v) || v < 0 || v > 200) throw new UserError(`${k.label}: use a whole number.`);
        await db.query('update settings set value = $2 where key = $1 and value <> $2', [k.key, v]);
      }
    });
    flash(res, 'Settings saved.');
    res.redirect('/settings');
  });

  r.post('/settings/blocked', editor, async (req, res) => {
    const from = date(req.body.from, 'From');
    const to = date(req.body.to, 'To') ?? from;
    const scope = req.body.scope === 'all' ? 'all' : 'factory';
    const reason = String(req.body.reason ?? '').trim();
    if (!from || !to || to < from) throw new UserError('Check the dates.');
    if (!reason) throw new UserError('Add a reason.');
    let n = 0;
    await withPerson(me(req).id, async (db) => {
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const r2 = await db.query('insert into blocked_days (day, scope, reason) values ($1, $2, $3) on conflict (day, scope) do nothing', [d, scope, reason]);
        n += r2.rowCount ?? 0;
        if (n > 70) throw new UserError('That is more than 70 working days. Add it in shorter runs.');
      }
    });
    flash(res, `${n} blocked ${n === 1 ? 'day' : 'days'} added. Dates already on jobs don't move; Needs a decision will flag any that land on them.`);
    res.redirect('/settings');
  });

  r.post('/settings/blocked/:id/delete', editor, async (req, res) => {
    await withPerson(me(req).id, (db) => db.query('delete from blocked_days where id = $1', [idParam(req)]));
    flash(res, 'Blocked day removed.');
    res.redirect('/settings');
  });

  const roleOf = (v: unknown) => (['editor', 'doer', 'viewer'].includes(String(v)) ? String(v) : 'viewer');
  const emailOf = (v: unknown) => {
    const e = String(v ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new UserError('That email address looks wrong.');
    return e;
  };

  r.post('/settings/people', editor, async (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (!name) throw new UserError('Add a name.');
    const email = emailOf(req.body.email);
    if ((await pool.query('select 1 from people where email = $1', [email])).rowCount) throw new UserError(`${email} is already on the list.`);
    await withPerson(me(req).id, (db) => db.query('insert into people (name, email, role) values ($1, $2, $3)', [name, email, roleOf(req.body.role)]));
    flash(res, `${name} added. They can sign in at ${req.protocol}://${req.get('host')} with ${email}.`);
    res.redirect('/settings');
  });

  r.post('/settings/people/:id', editor, async (req, res) => {
    const id = idParam(req);
    const active = req.body.active === '1';
    const role = roleOf(req.body.role);
    if (id === me(req).id && (!active || role !== 'editor')) throw new UserError("You can't take away your own Editor access. Ask the other Editor.");
    await withPerson(me(req).id, (db) => db.query('update people set name = $2, email = $3, role = $4, active = $5 where id = $1',
      [id, String(req.body.name ?? '').trim(), emailOf(req.body.email), role, active]));
    flash(res, 'Saved.');
    res.redirect('/settings');
  });

  // ---------- Export ----------

  r.get('/export.xlsx', async (_req, res) => {
    const buf = await exportWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="aalbor-hub-${today()}.xlsx"`);
    res.send(buf);
  });

  return r;
}

