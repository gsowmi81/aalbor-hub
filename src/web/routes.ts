import express, { Request, Response } from 'express';
import { pool, withPerson, Db } from '../db/pool.js';
import { JOB_NUMBER_ORDER, loadBlocked, loadCalendar, loadEverything, loadJob, loadJobHistory, loadJobList, loadPlanRows, loadResponsible, loadRules, loadTemplates, syncStepSet, templateFor } from '../db/queries.js';
import { AnchorKind, ANCHORS, applyChanges, Mode, PlanRow, proposeFromAnchor, proposeRework, reschedule, violations } from '../domain/schedule.js';
import { canSqueeze, reschedulePage } from '../views/reschedule.js';
import { addDays, fmtLong, Iso, todaySydney } from '../domain/dates.js';
import { capacity, needsDecision, overdue, StepRow } from '../domain/checks.js';
import { DoorFinish, FLOW, isReworkCategory, KINDS, takesHours, proposeDates, ProposalInput, REWORK_AREAS, REWORK_ORDER, ReworkArea, shiftStep, siteStartFromJobNumber, StepKind, TASK_AREAS } from '../domain/steps.js';
import type { Calendar } from '../domain/dates.js';
import { Person, readCookie, requireRole, setCookie } from './auth.js';
import { page } from '../views/layout.js';
import { comingUp, StoredDecision } from '../views/comingUp.js';
import { allJobs } from '../views/jobs.js';
import { CAUSES, jobPage } from '../views/job.js';
import { newJobPage, proposalBlock, reworkPage, settingsPage } from '../views/other.js';
import { exportWorkbook } from './export.js';
import { checkDates, createJob, setStepDates, setStepDone, UserError } from '../db/edits.js';
import { html } from './html.js';
import { applyOrder, decide, loadSuggestions, PRIORITIES, STATUSES, Action, Outcome } from '../db/suggestions.js';
import { jobPanel, pendingPanel, suggestionSettings, suggestionsPage } from '../views/suggestions.js';
import { hashToken, newToken } from './api.js';
import type { FullJob } from '../db/queries.js';

export { UserError };

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
/** Hours a rework task needs: a positive number, to one decimal place. */
function hoursOf(v: unknown, what: string, required: boolean): number | null {
  const t = String(v ?? '').trim();
  if (!t) {
    if (required) throw new UserError(`${what}: say how many hours it needs.`);
    return null;
  }
  const n = Number(t);
  if (!/^\d+([.]\d)?$/.test(t) || !(n > 0) || n > 500) throw new UserError(`${what}: hours must be a number like 3 or 1.5.`);
  return n;
}

/** Where a dragged or picked step lands: a date, a whole number of working-day columns (wd), or a calendar day to settle (snap). */
function targetStart(src: Record<string, unknown>, moved: PlanRow, cal: Calendar): Iso {
  const scope = KINDS[moved.kind === 'rework' && moved.rework_area ? moved.rework_area : moved.kind].scope;
  let start = date(src.start, 'New date') ?? moved.start_date ?? today();
  // A drag on the timeline lands on calendar days; settle it on a working day for that step.
  if (src.snap === '1') start = cal.onOrAfter(start, scope);
  // A drag on the Coming up board moves by whole day columns, which are working days.
  const wd = Number(src.wd);
  if (src.wd !== undefined && src.wd !== '' && Number.isInteger(wd) && wd !== 0 && moved.start_date) {
    start = cal.addWorkingDays(cal.onOrAfter(moved.start_date, scope), Math.max(-60, Math.min(60, wd)), scope);
  }
  return start;
}

const clashKey = (v: { pred: { id: number }; succ: { id: number } }) => `${v.pred.id}>${v.succ.id}`;

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
    has_painting: body.has_painting === '1',
    site_start: date(body.site_start, 'Site start') ?? (s('job_number') ? siteStartFromJobNumber(s('job_number')) : null),
    factory_days: n('factory_days', 2),
    install_days: n('install_days', 3),
    status: ['live', 'on_hold', 'complete', 'cancelled'].includes(s('status')) ? s('status') : 'live',
    at_risk: body.at_risk === '1',
    notes: s('notes'),
    template: s('template') || null,
    anchor: (ANCHORS.some((a) => a.kind === s('anchor')) ? s('anchor') : 'site_start') as AnchorKind,
    anchor_date: date(body.anchor_date, 'The date to work from'),
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
      suggestionsPanel: pendingPanel(await loadSuggestions({ status: 'pending' })),
    });
    res.send(page({ title: 'Coming up', tab: 'coming-up', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  r.get('/jobs', async (req, res) => {
    const b = await board();
    const body = allJobs({ jobs: b.jobs, steps: b.steps, decisions: b.decisions.filter((x) => b.stored.get(x.key)?.fingerprint !== x.fingerprint), today: b.t, brand: brandOf(req), canMove: me(req).role === 'editor' });
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
    const templates = await loadTemplates();
    const t = templates[0];
    const values = t ? { template: t.key, door_finish: t.door_finish, has_painting: t.has_painting, has_stone: t.has_stone, factory_days: t.factory_days, install_days: t.install_days } : { has_stone: true };
    const body = newJobPage({ values, templates, anchor: 'site_start', anchorDate: null, proposal: null, siteStartWorkedOut: null, clashes: [] });
    res.send(page({ title: 'New job', tab: 'new', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  /** Dates for a new job from its template and the one date given (George, 30 Oct 2026). */
  async function proposalFor(values: ReturnType<typeof parseJobForm>) {
    const givenSite = values.site_start;
    const anchor: AnchorKind = values.anchor !== 'site_start' && values.anchor_date ? values.anchor : 'site_start';
    const anchorDate = anchor === 'site_start' ? values.site_start : values.anchor_date;
    if (!anchorDate) return { proposal: null, clashes: [], site_start: null, workedOut: false };
    const [rules, cal, all, tpl] = await Promise.all([loadRules(), loadCalendar(), loadEverything(), templateFor(values)]);
    const t = (await loadTemplates()).find((x) => x.key === values.template) ?? tpl;
    const planned = proposeFromAnchor({ ...values, added_on: today(), install_weeks: t.install_weeks }, anchor, anchorDate, rules, cal);
    const proposal = planned.steps;
    values = { ...values, site_start: planned.site_start };
    // Capacity with this job added, keeping only warnings that involve it.
    const ghost = { id: -1, job_number: values.job_number, brand: values.brand, client_name: values.client_name || 'This job', suburb: values.suburb, door_finish: values.door_finish, has_painting: values.has_painting, has_stone: values.has_stone, site_start: values.site_start, factory_days: values.factory_days, install_days: values.install_days, status: 'live', at_risk: false };
    const ghostSteps: StepRow[] = proposal.map((p, i) => ({ id: -1 - i, job_id: -1, kind: p.kind, rework_id: null, label: '', start_date: p.start_date, end_date: p.end_date, confirmed: false, owner: '', done_at: null }));
    const clashes = capacity([...all.jobs, ghost], [...all.steps, ...ghostSteps], rules, cal, today()).filter((c) => c.jobIds.includes(-1));
    return { proposal, clashes, site_start: planned.site_start, workedOut: !givenSite || planned.site_start !== givenSite };
  }

  r.post('/jobs/preview', editor, async (req, res) => {
    try {
      const values = parseJobForm(req.body);
      const { proposal, clashes, site_start, workedOut } = await proposalFor(values);
      res.send(proposalBlock(proposal, clashes, workedOut ? site_start : null).value);
    } catch (err) {
      if (err instanceof UserError) return res.send(`<h2>Proposed dates</h2><p class="nodate">${err.message}</p>`);
      throw err;
    }
  });

  r.post('/jobs/new', editor, async (req, res) => {
    let values: ReturnType<typeof parseJobForm> | undefined;
    const templates = await loadTemplates();
    const render = async (error?: string) => {
      const p = values ? await proposalFor(values) : { proposal: null, clashes: [], site_start: null, workedOut: false };
      res.send(page({ title: 'New job', tab: 'new', person: me(req), body: newJobPage({
        values: (values ?? req.body) as Partial<FullJob>, templates, anchor: values?.anchor ?? 'site_start', anchorDate: values?.anchor_date ?? null,
        proposal: p.proposal, siteStartWorkedOut: p.workedOut ? p.site_start : null, clashes: p.clashes, error }) }).value);
    };
    try {
      values = parseJobForm(req.body);
    } catch (err) {
      if (err instanceof UserError) return render(err.message);
      throw err;
    }
    if (req.body.action !== 'save') return render();
    if (!values.client_name) return render('Add the client name.');
    if (!values.site_start && !(values.anchor !== 'site_start' && values.anchor_date)) {
      return render('Add the site start (it comes from the job number), or pick another date to work from and fill it in.');
    }
    if (values.template && !templates.some((t) => t.key === values!.template)) values.template = null;
    if (values.job_number && (await pool.query('select 1 from jobs where job_number = $1', [values.job_number])).rowCount) {
      return render(`Job ${values.job_number} is already in the hub.`);
    }
    const { proposal, site_start } = await proposalFor(values);
    const v = { ...values, site_start: values.site_start ?? site_start };
    const id = await withPerson(me(req).id, (db) => createJob(db, v, proposal ?? [], today()));
    flash(res, `${v.client_name} added. Every date is provisional until you confirm it.`);
    res.redirect(`/jobs/${id}`);
  });

  r.get('/jobs/:id', async (req, res) => {
    const id = idParam(req);
    const data = await loadJob(id);
    if (!data) return res.status(404).send(page({ title: 'Not found', tab: 'job', person: me(req), body: html`<p>That job isn't in the hub. <a href="/jobs">All jobs</a></p>` }).value);
    const [list, history, b] = await Promise.all([loadJobList(), loadJobHistory(id), board()]);
    const decisions = b.decisions.filter((x) => x.jobId === id && b.stored.get(x.key)?.fingerprint !== x.fingerprint);
    const [templates, responsible, people] = await Promise.all([
      loadTemplates(),
      me(req).is_owner ? loadResponsible(me(req).id) : Promise.resolve(new Map()),
      pool.query('select name from people where active order by name'),
    ]);
    const suggestionsPanel = jobPanel(await loadSuggestions({ status: 'pending', jobId: id }), me(req).role === 'editor', id);
    const body = jobPage({ person: me(req), today: b.t, ...data, list, history, decisions, templates, responsible, peopleNames: people.rows.map((p) => p.name), suggestionsPanel });
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
           factory_days=$10, install_days=$11, status=$12, at_risk=$13, notes=$14, has_painting=$15, template=$16 where id=$1`,
        [id, v.job_number, v.brand, v.client_name, v.suburb, v.scope, v.door_finish, v.has_stone, v.site_start, v.factory_days, v.install_days, v.status, v.at_risk, v.notes, v.has_painting,
          (await loadTemplates()).some((t) => t.key === v.template) ? v.template : null]);
      await syncStepSet(db, id);
    });
    flash(res, 'Job details saved.');
    res.redirect(`/jobs/${id}`);
  });

  r.post('/jobs/:id/dates', editor, async (req, res) => {
    const id = idParam(req);
    const steps = (await pool.query(`select id, kind, label from steps where job_id = $1 and kind <> 'rework'`, [id])).rows as { id: number; kind: StepKind; label: string }[];
    const confirmAll = req.body.confirm_all === '1';

    // One date changed on a step that other steps wait for: save any Confirmed ticks, then go
    // to the Reschedule screen so the rest of the job can follow (George, 30 Oct 2026).
    const rows = await loadPlanRows(id);
    const dateChanged = rows.filter((r) => `start_${r.id}` in req.body && !r.done).filter((r) => {
      const start = date(req.body[`start_${r.id}`], r.label || KINDS[r.kind].label);
      const endRaw = date(req.body[`end_${r.id}`], r.label || KINDS[r.kind].label);
      const end = endRaw && endRaw !== start ? endRaw : null;
      return start !== r.start_date || end !== r.end_date;
    });
    if (!confirmAll && dateChanged.length === 1 && dateChanged[0].start_date) {
      const m = dateChanged[0];
      const start = date(req.body[`start_${m.id}`], 'New date');
      const cal = await loadCalendar();
      if (start && reschedule(rows, m.id, start, null, 'shift', cal).length > 1) {
        await withPerson(me(req).id, async (db) => {
          for (const r of rows) {
            if (r.id === m.id || !(`start_${r.id}` in req.body) || !r.start_date) continue;
            await db.query('update steps set confirmed = $2 where id = $1 and confirmed <> $2', [r.id, req.body[`confirmed_${r.id}`] === '1']);
          }
        });
        const end = date(req.body[`end_${m.id}`], 'New date');
        return res.redirect(`/jobs/${id}/reschedule?step=${m.id}&start=${start}${end && end !== start ? `&end=${end}` : ''}`);
      }
    }

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

  // ---------- Reschedule: one step moves, the rest of the job follows (George, 30 Oct 2026) ----------

  async function rescheduleContext(req: Request) {
    const id = idParam(req);
    const job = (await pool.query('select * from jobs where id = $1', [id])).rows[0];
    if (!job) throw new UserError("That job isn't in the hub.");
    const [rows, cal] = await Promise.all([loadPlanRows(id), loadCalendar()]);
    const src = req.method === 'GET' ? req.query : req.body;
    const moved = rows.find((r) => r.id === Number(src.step));
    if (!moved) throw new UserError('Pick the step to move.');
    if (moved.done) throw new UserError(`${moved.label || KINDS[moved.kind].label} is ticked done. Untick it first if it needs a new date.`);
    let mode: Mode = ['shift', 'squeeze', 'only'].includes(String(src.mode)) ? (String(src.mode) as Mode) : 'shift';
    if (mode === 'squeeze' && !canSqueeze(moved, rows)) mode = 'shift';
    return { id, job, rows, cal, moved, mode };
  }

  r.get('/jobs/:id/reschedule', editor, async (req, res) => {
    const { job, rows, cal, moved, mode } = await rescheduleContext(req);
    const newStart = targetStart(req.query as Record<string, unknown>, moved, cal);
    const newEnd = date(req.query.end, 'To');
    const next = applyChanges(rows, reschedule(rows, moved.id, newStart, newEnd, mode, cal)) as typeof rows;
    const body = reschedulePage({ job, rows, next, moved, newStart, newEnd, mode, violations: violations(next, cal), cal });
    res.send(page({ title: 'Reschedule', tab: 'job', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  r.post('/jobs/:id/reschedule', editor, async (req, res) => {
    const { id, job, rows, cal, moved, mode } = await rescheduleContext(req);
    const submitted = rows.map((r) => {
      if (r.done || !(`start_${r.id}` in req.body)) return r;
      const lbl = r.label || KINDS[r.kind].label;
      const start = date(req.body[`start_${r.id}`], lbl);
      return { ...r, start_date: start, end_date: checkDates(start, date(req.body[`end_${r.id}`], lbl), lbl) };
    });
    const v = violations(submitted, cal);
    const hard = v.filter((x) => x.dep.hard);
    const m = submitted.find((r) => r.id === moved.id)!;
    if (req.body.recheck === '1' || (hard.length && req.body.override !== '1')) {
      const body = reschedulePage({ job, rows, next: submitted, moved, newStart: m.start_date ?? moved.start_date ?? today(), newEnd: m.end_date, mode, violations: v, cal,
        error: req.body.recheck === '1' ? undefined : 'Some dates now clash. Check them, or Move anyway.' });
      return res.send(page({ title: 'Reschedule', tab: 'job', person: me(req), body }).value);
    }
    const changed = submitted.filter((r) => {
      const b = rows.find((x) => x.id === r.id)!;
      return b.start_date !== r.start_date || b.end_date !== r.end_date;
    });
    // Moved dates are confirmed: someone chose them (George, 6 Nov 2026). A tick box leaves them provisional.
    const confirmed = req.body.provisional !== '1';
    await saveMoves(me(req).id, id, changed, confirmed);
    flash(res, `${changed.length} ${changed.length === 1 ? 'date' : 'dates'} changed, ${confirmed ? 'confirmed' : 'left provisional'}.${hard.length ? ' Saved with a clash, so it shows in Needs a decision.' : ''}`);
    res.redirect(`/jobs/${id}`);
  });

  async function saveMoves(personId: number, jobId: number, changed: { id: number; start_date: Iso | null; end_date: Iso | null }[], confirmed: boolean) {
    await withPerson(personId, async (db) => {
      for (const r of changed) {
        await db.query('update steps set start_date = $2, end_date = $3, confirmed = ($5 and $2::date is not null) where id = $1 and job_id = $4 and done_at is null',
          [r.id, r.start_date, r.end_date, jobId, confirmed]);
      }
    });
  }

  // A drag on Coming up or All jobs, answered in the small box on the page (George, 6 Nov 2026):
  // saves at once, confirmed. A move that makes a new clash goes to the full Reschedule screen instead.
  r.post('/jobs/:id/reschedule/quick', editor, async (req, res) => {
    const { id, rows, cal, moved, mode } = await rescheduleContext(req);
    const newStart = targetStart(req.body, moved, cal);
    const changes = reschedule(rows, moved.id, newStart, null, mode, cal);
    const next = applyChanges(rows, changes);
    const before = new Set(violations(rows, cal).filter((v) => v.dep.hard).map(clashKey));
    const fresh = violations(next, cal).filter((v) => v.dep.hard && !before.has(clashKey(v)));
    if (fresh.length) {
      flash(res, '!That move puts a step before something it waits for. Check the dates below, or Move anyway.');
      return res.redirect(`/jobs/${id}/reschedule?step=${moved.id}&start=${newStart}&mode=${mode}`);
    }
    const changed = changes.filter((c) => {
      const b = rows.find((x) => x.id === c.id)!;
      return b.start_date !== c.start_date || b.end_date !== c.end_date;
    });
    await saveMoves(me(req).id, id, changed, true);
    const label = moved.label || KINDS[moved.kind].label;
    flash(res, changed.length ? `${label} moved. ${changed.length} ${changed.length === 1 ? 'date' : 'dates'} changed and confirmed.` : 'Nothing moved.');
    res.redirect(backTo(req, `/jobs/${id}`));
  });

  r.post('/jobs/:id/shift', editor, async (req, res) => {
    const id = idParam(req);
    const n = Number(req.body.n);
    if (![-1, 1, 5].includes(n)) throw new UserError('Pick −1 day, +1 day or +1 week.');
    const cal = await loadCalendar();
    // Rework keeps its own dates: the main job moving never moves it.
    const steps = (await pool.query(`select id, kind, start_date, end_date from steps where job_id = $1 and kind <> 'rework' and done_at is null and start_date is not null`, [id])).rows;
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
    const proposal = proposeDates({ ...job, added_on: job.added_on, install_weeks: (await templateFor(job)).install_weeks }, rules, cal);
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
    await withPerson(me(req).id, (db) => setStepDone(db, id, done));
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
    const jobs = (await pool.query(`select id, job_number, client_name, suburb from jobs where status = 'live' order by ${JOB_NUMBER_ORDER}`)).rows;
    const [responsible, people] = await Promise.all([
      me(req).is_owner ? loadResponsible(me(req).id) : Promise.resolve(new Map()),
      pool.query('select name from people where active order by name'),
    ]);
    const body = reworkPage({ person: me(req), rework: rows, jobs, today: today(), responsible, peopleNames: people.rows.map((p) => p.name) });
    res.send(page({ title: 'Rework', tab: 'rework', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  r.post('/rework', doer, async (req, res) => {
    const jobId = Number(req.body.job_id);
    const cause = String(req.body.cause ?? '');
    const note = String(req.body.note ?? '').trim();
    if (!jobId) throw new UserError('Pick the job.');
    if (!(CAUSES as readonly string[]).includes(cause)) throw new UserError('Pick a cause.');
    if (!note) throw new UserError('Add one line on what happened.');
    const responsible = String(req.body.responsible ?? '').trim();
    // Rework is a mini job (George, 6 Nov 2026): pick its tasks; factory and install say their hours.
    const areas = REWORK_ORDER.filter((a) => req.body[`task_${a}`] === '1');
    const hours: Partial<Record<ReworkArea, number | null>> = {};
    for (const a of REWORK_AREAS) if (a.hours && areas.includes(a.kind)) hours[a.kind] = hoursOf(req.body[`hours_${a.kind}`], a.label, true);
    // Only Editors date it; Doers' tasks wait for Christine.
    const start = me(req).role === 'editor' ? date(req.body.start, 'Start') : null;
    const [rules, cal] = await Promise.all([loadRules(), loadCalendar()]);
    const plan = new Map((start ? proposeRework(areas, start, hours, rules, cal) : []).map((p) => [p.area, p]));
    await withPerson(me(req).id, async (db) => {
      const id = (await db.query('insert into rework (job_id, cause, note) values ($1, $2, $3) returning id', [jobId, cause, note.slice(0, 200)])).rows[0].id;
      for (const [i, a] of REWORK_AREAS.filter((x) => areas.includes(x.kind)).entries()) {
        const p = plan.get(a.kind);
        await db.query(
          `insert into steps (job_id, kind, rework_id, rework_area, label, owner, hours, sort, start_date, end_date, confirmed)
           values ($1, 'rework', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [jobId, id, a.kind, a.task, KINDS[a.kind].owner, hours[a.kind] ?? null, 200 + i, p?.start_date ?? null, p?.end_date ?? null, !!p]);
      }
      // Owners only. The database refuses this for anyone else (row-level security).
      if (responsible && me(req).is_owner) {
        await db.query('insert into rework_responsible (rework_id, responsible, note, set_by) values ($1, $2, $3, $4)',
          [id, responsible.slice(0, 80), String(req.body.responsible_note ?? '').trim().slice(0, 200), me(req).id]);
      }
    });
    const n = areas.length;
    flash(res, `Rework raised${n ? ` with ${n} ${n === 1 ? 'task' : 'tasks'}` : ''}.${start && n ? ` Dates worked out from ${fmtLong(start)} and confirmed.` : ' It shows in Needs a decision until Christine dates it.'}`);
    res.redirect(backTo(req, '/rework'));
  });

  // Owners only (George and Gus): who was responsible. Postgres refuses everyone else.
  r.post('/rework/:id/responsible', async (req, res) => {
    if (!me(req).is_owner) throw new UserError('Only owners can record who was responsible.');
    const id = idParam(req);
    const who = String(req.body.responsible ?? '').trim().slice(0, 80);
    const note = String(req.body.responsible_note ?? '').trim().slice(0, 200);
    await withPerson(me(req).id, async (db) => {
      if (!who) return db.query('delete from rework_responsible where rework_id = $1', [id]);
      return db.query(
        `insert into rework_responsible (rework_id, responsible, note, set_by) values ($1, $2, $3, $4)
         on conflict (rework_id) do update set responsible = excluded.responsible, note = excluded.note, set_by = excluded.set_by, set_at = now()`,
        [id, who, note, me(req).id]);
    });
    flash(res, who ? 'Responsible saved. Only owners can see it.' : 'Responsible cleared.');
    res.redirect(backTo(req, '/rework'));
  });

  r.post('/rework/:id/steps', editor, async (req, res) => {
    const id = idParam(req);
    const rw = (await pool.query('select job_id from rework where id = $1', [id])).rows[0];
    if (!rw) throw new UserError('That rework has gone.');
    const label = String(req.body.label ?? '').trim();
    if (!label) throw new UserError('Say what the step is.');
    // A category, not a name (George, 6 Nov 2026): it sets the row and who usually does it.
    if (!isReworkCategory(req.body.area)) throw new UserError(`${label}: pick the category it sits in.`);
    const area: StepKind = req.body.area;
    const hours = takesHours(area) ? hoursOf(req.body.hours, label, false) : null;
    const start = date(req.body.start, label);
    const end = date(req.body.end, label);
    await withPerson(me(req).id, async (db) => {
      const s = await db.query(`insert into steps (job_id, kind, rework_id, rework_area, label, owner, hours, sort, confirmed) values ($1, 'rework', $2, $3, $4, $5, $6, $7, true) returning id`,
        [rw.job_id, id, area, label.slice(0, 80), KINDS[area].owner, hours, 200 + FLOW.indexOf(area)]);
      await setStepDates(db, s.rows[0].id, start, end, label);
    });
    flash(res, 'Rework step added.');
    res.redirect(backTo(req));
  });

  // Date a rework's undated tasks from one start date, in the rework's order.
  r.post('/rework/:id/date', editor, async (req, res) => {
    const id = idParam(req);
    const start = date(req.body.start, 'Start');
    if (!start) throw new UserError('Pick the day the rework starts.');
    const tasks = (await pool.query(
      `select id, rework_area, hours from steps where rework_id = $1 and rework_area = any($2) and start_date is null and done_at is null`, [id, REWORK_ORDER])).rows as { id: number; rework_area: ReworkArea; hours: number | null }[];
    if (!tasks.length) throw new UserError('Every task on this rework already has a date. Use Move… to change one.');
    const [rules, cal] = await Promise.all([loadRules(), loadCalendar()]);
    const hours = Object.fromEntries(tasks.map((t) => [t.rework_area, t.hours]));
    const plan = new Map(proposeRework(tasks.map((t) => t.rework_area), start, hours, rules, cal).map((p) => [p.area, p]));
    await withPerson(me(req).id, async (db) => {
      for (const t of tasks) {
        const p = plan.get(t.rework_area)!;
        await db.query('update steps set start_date = $2, end_date = $3, confirmed = true where id = $1', [t.id, p.start_date, p.end_date]);
      }
    });
    flash(res, `${tasks.length} rework ${tasks.length === 1 ? 'task' : 'tasks'} dated and confirmed.`);
    res.redirect(backTo(req));
  });

  // Edit a rework: its cause and what happened (George, 6 Nov 2026).
  r.post('/rework/:id/edit', editor, async (req, res) => {
    const id = idParam(req);
    const cause = String(req.body.cause ?? '');
    const note = String(req.body.note ?? '').trim();
    if (!(CAUSES as readonly string[]).includes(cause)) throw new UserError('Pick a cause.');
    if (!note) throw new UserError('Add one line on what happened.');
    await withPerson(me(req).id, (db) => db.query('update rework set cause = $2, note = $3 where id = $1', [id, cause, note.slice(0, 200)]));
    flash(res, 'Rework saved.');
    res.redirect(backTo(req));
  });

  // Edit a rework task or a task added to one job: name, who, and its row. Dates move by dragging or Move….
  r.post('/steps/:id/edit', editor, async (req, res) => {
    const id = idParam(req);
    const s = (await pool.query('select id, job_id, kind, label, rework_id from steps where id = $1', [id])).rows[0];
    if (!s) throw new UserError('That step has gone.');
    if (s.kind !== 'rework' && !s.label) throw new UserError("Standard steps keep their names. Only rework tasks and added tasks can be edited.");
    const label = String(req.body.label ?? '').trim().slice(0, 80);
    if (!label) throw new UserError('Give the task a name.');
    const owner = String(req.body.owner ?? '').trim().slice(0, 40);
    await withPerson(me(req).id, async (db) => {
      if (s.kind === 'rework') {
        if (!isReworkCategory(req.body.area)) throw new UserError(`${label}: pick the category it sits in.`);
        const area: StepKind = req.body.area;
        const hours = takesHours(area) ? hoursOf(req.body.hours, label, false) : null;
        await db.query('update steps set label = $2, owner = $3, rework_area = $4, hours = $5 where id = $1', [id, label, owner, area, hours]);
      } else {
        const kind = TASK_AREAS.some((a) => a.kind === req.body.area) ? String(req.body.area) : s.kind;
        await db.query('update steps set label = $2, owner = $3, kind = $4, sort = $5 where id = $1', [id, label, owner, kind, FLOW.indexOf(kind as StepKind) * 10 + 5]);
      }
    });
    flash(res, `${label} saved.`);
    res.redirect(backTo(req, `/jobs/${s.job_id}`));
  });

  // Add a task to one job only, in an area (George, 6 Nov 2026). It travels with that area's step.
  r.post('/jobs/:id/tasks', editor, async (req, res) => {
    const id = idParam(req);
    const label = String(req.body.label ?? '').trim().slice(0, 80);
    if (!label) throw new UserError('Give the task a name.');
    const area = TASK_AREAS.find((a) => a.kind === req.body.area);
    if (!area) throw new UserError('Pick where the task goes: Production, Factory or Site.');
    const start = date(req.body.start, label);
    const end = checkDates(start, date(req.body.end, label), label);
    const owner = String(req.body.owner ?? '').trim().slice(0, 40) || KINDS[area.kind].owner;
    await withPerson(me(req).id, (db) => db.query(
      `insert into steps (job_id, kind, label, owner, sort, start_date, end_date, confirmed) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, area.kind, label, owner, FLOW.indexOf(area.kind) * 10 + 5, start, end, !!start]));
    flash(res, `${label} added to this job.`);
    res.redirect(`/jobs/${id}#tasks`);
  });

  // ---------- Deleting things added by mistake (Editors) ----------

  r.post('/rework/:id/delete', editor, async (req, res) => {
    const id = idParam(req);
    const rw = (await pool.query('select job_id from rework where id = $1', [id])).rows[0];
    if (!rw) throw new UserError('That rework has already gone.');
    await withPerson(me(req).id, (db) => db.query('delete from rework where id = $1', [id]));
    flash(res, 'Rework deleted.');
    res.redirect(backTo(req, `/jobs/${rw.job_id}#rework`));
  });

  r.post('/steps/:id/delete', editor, async (req, res) => {
    const id = idParam(req);
    const s = (await pool.query('select job_id, kind, label from steps where id = $1', [id])).rows[0];
    if (!s) throw new UserError('That step has already gone.');
    if (s.kind !== 'rework' && !s.label) {
      throw new UserError("Standard steps can't be deleted. Clear their dates instead, or untick Painting or Stone on the job.");
    }
    await withPerson(me(req).id, (db) => db.query('delete from steps where id = $1', [id]));
    flash(res, 'Step removed.');
    res.redirect(backTo(req, `/jobs/${s.job_id}`));
  });

  r.post('/jobs/:id/delete', editor, async (req, res) => {
    const id = idParam(req);
    const job = (await pool.query('select client_name from jobs where id = $1', [id])).rows[0];
    if (!job) throw new UserError('That job has already gone.');
    await withPerson(me(req).id, (db) => db.query('delete from jobs where id = $1', [id]));
    flash(res, `${job.client_name} deleted. The change log keeps a record of it.`);
    res.redirect('/jobs');
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

  // ---------- Suggestions from the bot ----------

  r.get('/suggestions', async (req, res) => {
    const q = (k: string) => String(req.query[k] ?? '').trim();
    const status = (STATUSES as readonly string[]).includes(q('status')) || q('status') === 'all' ? q('status') : 'pending';
    const priority = (PRIORITIES as readonly string[]).includes(q('priority')) ? q('priority') : '';
    const dateQ = /^\d{4}-\d{2}-\d{2}$/.test(q('date')) ? q('date') : '';
    const id = Number(q('id')) || undefined;
    const batch = q('batch').slice(0, 100);
    const filter = { status: batch || id ? (q('status') ? status : 'all') : status, priority, job: q('job').slice(0, 40), date: dateQ, batch };
    let list = await loadSuggestions({ id, status: filter.status, priority, job: filter.job || undefined, batchDate: dateQ || undefined });
    if (batch) list = list.filter((s) => s.batch_id === batch);
    const body = suggestionsPage({ list, editor: me(req).role === 'editor', filter, pending: me(req).pending_suggestions ?? 0 });
    res.send(page({ title: 'Suggestions', tab: 'suggestions', person: me(req), flash: takeFlash(req, res), body,
      sub: 'Changes the bot found in Buildertrend. Nothing changes until an Editor accepts.' }).value);
  });

  r.post('/suggestions/act', editor, async (req, res) => {
    const act = String(req.body.act ?? '');
    const back = backTo(req, '/suggestions');
    const m = /^(accept|decline|bt_wrong):(\d+)$/.exec(act);
    let todo: { id: number; action: Action }[] = [];
    if (m) todo = [{ id: Number(m[2]), action: m[1] as Action }];
    else if (act === 'accept-selected' || act === 'decline-selected') {
      const raw = req.body.ids;
      const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) throw new UserError('Tick at least one suggestion first.');
      const rows = (await loadSuggestions({ status: 'pending', limit: 2000 })).filter((s) => ids.includes(s.id)).sort(applyOrder);
      todo = rows.map((s) => ({ id: s.id, action: act === 'accept-selected' ? 'accept' : 'decline' }));
    } else {
      throw new UserError('Pick Accept, Decline or Buildertrend is wrong.');
    }
    const outcomes: Outcome[] = [];
    for (const t of todo) outcomes.push(await decide(me(req).id, t.id, t.action, String(req.body[`note_${t.id}`] ?? '').trim()));
    const failed = outcomes.filter((o) => o.result === 'failed' || o.result === 'skipped');
    const ok = outcomes.length - failed.length;
    if (outcomes.length === 1) flash(res, failed.length ? `!${failed[0].message}` : outcomes[0].message);
    else flash(res, `${failed.length ? '!' : ''}${ok} done.${failed.length ? ` ${failed.length} couldn't be applied: ${failed.map((f) => `#${f.id} ${f.message}`).join(' ')}` : ''}`);
    res.redirect(back);
  });

  // ---------- Settings (Editors) ----------

  async function settingsBody(req: Request, newTok?: { name: string; token: string }) {
    const [settings, blocked, people, email, tokens, calls] = await Promise.all([
      pool.query('select key, value, label from settings order by sort'),
      loadBlocked(),
      pool.query('select id, name, email, role, active, is_owner from people order by active desc, role, name'),
      pool.query(`select value from app_settings where key = 'suggestions_email'`),
      me(req).is_owner ? pool.query(`select t.id, t.name, t.created_at, p.name as created_by_name, t.last_used_at, t.revoked_at from api_tokens t left join people p on p.id = t.created_by order by t.revoked_at nulls first, t.id desc`) : null,
      me(req).is_owner ? pool.query(`select c.at, c.method, c.path, c.status, c.items, t.name as token_name from api_calls c left join api_tokens t on t.id = c.token_id order by c.id desc limit 30`) : null,
    ]);
    const extra = suggestionSettings({ email: email.rows[0]?.value ?? '', isOwner: me(req).is_owner, tokens: tokens?.rows ?? [], calls: calls?.rows ?? [], newToken: newTok });
    return settingsPage({ settings: settings.rows, blocked, people: people.rows, today: today(), templates: await loadTemplates(), viewerIsOwner: me(req).is_owner, extra });
  }

  r.get('/settings', editor, async (req, res) => {
    const body = await settingsBody(req);
    res.send(page({ title: 'Settings', tab: 'settings', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  r.post('/settings/suggestions-email', editor, async (req, res) => {
    const e = String(req.body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new UserError('That email address looks wrong.');
    await withPerson(me(req).id, (db) => db.query(`update app_settings set value = $1 where key = 'suggestions_email'`, [e]));
    flash(res, `Suggestions emails now go to ${e}.`);
    res.redirect('/settings#suggestions-email');
  });

  const owner = (req: Request) => {
    if (!me(req).is_owner) throw new UserError('Only an owner can manage API tokens.');
  };

  r.post('/settings/tokens', editor, async (req, res) => {
    owner(req);
    const name = String(req.body.name ?? '').trim().slice(0, 60);
    if (!name) throw new UserError('Give the token a name, e.g. Grokbot.');
    const token = newToken();
    await withPerson(me(req).id, (db) => db.query('insert into api_tokens (name, token_hash) values ($1, $2)', [name, hashToken(token)]));
    // Shown once, on this page only: not in a cookie, a redirect or the log.
    res.setHeader('Cache-Control', 'no-store');
    const body = await settingsBody(req, { name, token });
    res.send(page({ title: 'Settings', tab: 'settings', person: me(req), body }).value);
  });

  r.post('/settings/tokens/:id/revoke', editor, async (req, res) => {
    owner(req);
    await withPerson(me(req).id, (db) => db.query('update api_tokens set revoked_at = now() where id = $1 and revoked_at is null', [idParam(req)]));
    flash(res, 'Token revoked. Anything still using it now gets "revoked".');
    res.redirect('/settings#api-tokens');
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

  r.post('/settings/templates/:key', editor, async (req, res) => {
    const key = String(req.params.key);
    const n = (k: string, lo: number, hi: number, what: string) => {
      const v = Number(req.body[k]);
      if (!Number.isInteger(v) || v < lo || v > hi) throw new UserError(`${what}: use a whole number from ${lo} to ${hi}.`);
      return v;
    };
    const name = String(req.body.name ?? '').trim();
    if (!name) throw new UserError('Give the job type a name.');
    await withPerson(me(req).id, (db) => db.query(
      `update job_templates set name = $2, door_finish = $3, has_painting = $4, has_stone = $5, factory_days = $6, install_days = $7, install_weeks = $8 where key = $1`,
      [key, name, req.body.door_finish === 'polyurethane' ? 'polyurethane' : 'melamine', req.body.has_painting === '1', req.body.has_stone === '1',
        n('factory_days', 1, 30, 'Factory days'), n('install_days', 1, 30, 'Install days'), n('install_weeks', 1, 52, 'Install weeks after site start')]));
    flash(res, `${name} saved. New jobs use it from now on; jobs already in the hub don't change.`);
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
    await withPerson(me(req).id, (db) => db.query('insert into people (name, email, role, is_owner) values ($1, $2, $3, $4)',
      [name, email, roleOf(req.body.role), me(req).is_owner && req.body.is_owner === '1']));
    flash(res, `${name} added. They can sign in at ${req.protocol}://${req.get('host')} with ${email}.`);
    res.redirect('/settings');
  });

  r.post('/settings/people/:id', editor, async (req, res) => {
    const id = idParam(req);
    const active = req.body.active === '1';
    const role = roleOf(req.body.role);
    if (id === me(req).id && (!active || role !== 'editor')) throw new UserError("You can't take away your own Editor access. Ask the other Editor.");
    const current = (await pool.query('select is_owner from people where id = $1', [id])).rows[0];
    if (!current) throw new UserError('That person has gone.');
    // Only owners see or change the Owner tick; for anyone else it stays as it was.
    const isOwner = me(req).is_owner ? req.body.is_owner === '1' : current.is_owner;
    if (id === me(req).id && me(req).is_owner && !isOwner) throw new UserError("You can't take away your own Owner access. Ask the other owner.");
    await withPerson(me(req).id, (db) => db.query('update people set name = $2, email = $3, role = $4, active = $5, is_owner = $6 where id = $1',
      [id, String(req.body.name ?? '').trim(), emailOf(req.body.email), role, active, isOwner]));
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

