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
import { comingUp } from '../views/comingUp.js';
import type { StoredDecision } from '../views/items.js';
import { attentionPage } from '../views/attention.js';
import { pipelinePage } from '../views/pipeline.js';
import { jobDayPage, myDayPage } from '../views/me.js';
import { jobSheet } from '../views/sheet.js';
import { asksOnDone } from '../views/install.js';
import { loadStepPhotos, loadCurrentFiles, loadJobFiles } from '../db/queries.js';
import { FILE_KINDS } from '../views/files.js';
import { FILE_LIMITS } from './upload.js';
import { newTvKey } from './tv.js';
import { readinessByJob, stockRoutes } from './stock.js';
import { loadItems, loadMaterials, loadOnHand, loadOrders, stockContext } from '../db/stock.js';
import { allocatedByItem, readiness } from '../domain/stock.js';
import { weekHours } from '../domain/checks.js';
import { mondayOf } from '../domain/dates.js';
import type { Landing } from '../views/other.js';
import { morePage, findPage } from '../views/other.js';
import { appSetting, findJobs, loadCapacity, loadIssue, loadIssues, loadIssueTypes } from '../db/queries.js';
import { loadByDay } from '../domain/checks.js';
import { loadPage } from '../views/load.js';
import { issueItem } from '../views/issues.js';
import { readMultipart } from './upload.js';
import { dailyNudges, deliverAll, flagNudges, lastRuns, materialsInNudges, runDaily } from './nudges.js';
import { checkUrl } from '../db/edits.js';
import { PEOPLE_AREAS } from '../domain/steps.js';
import { allJobs } from '../views/jobs.js';
import { CAUSES, jobPage } from '../views/job.js';
import { newJobPage, proposalBlock, reworkPage, settingsPage } from '../views/other.js';
import { exportWorkbook } from './export.js';
import { checkDates, createJob, setStepDates, setStepDone, UserError } from '../db/edits.js';
import { html } from './html.js';
import { applyOrder, decide, loadSuggestions, PRIORITIES, STATUSES, Action, Outcome, supersedePending } from '../db/suggestions.js';
import { jobPanel, pendingPanel, suggestionSettings, suggestionsPage } from '../views/suggestions.js';
import { hashToken, newToken } from './api.js';
import type { FullJob } from '../db/queries.js';
import { config } from '../config.js';

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
  const [all, rules, cal, stored, cap, issues, ready] = await Promise.all([loadEverything(), loadRules(), loadCalendar(), storedDecisions(), loadCapacity(), loadIssues({ open: true }), readinessByJob()]);
  const t = today();
  return { ...all, rules, cal, stored, cap, issues, ready, t, decisions: needsDecision(all.jobs, all.steps, all.rework, rules, cal, t, cap) };
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
    drawings_url: checkUrl(body.drawings_url, 'Drawings link'),
    anchor: (ANCHORS.some((a) => a.kind === s('anchor')) ? s('anchor') : 'site_start') as AnchorKind,
    anchor_date: date(body.anchor_date, 'The date to work from'),
  };
  return values;
}

export function routes(): express.Router {
  const r = express.Router();
  const editor = requireRole('editor');
  const doer = requireRole('doer');
  r.use(stockRoutes());

  // ---------- Screens ----------

  // Doers land on My day; everyone else on the Board (George, 7 Nov 2026).
  r.get('/', (req, res, next) => (me(req).role === 'doer' ? res.redirect('/me') : next()));

  async function boardPage(req: Request, res: Response) {
    const b = await board();
    const week = req.query.week === '1' ? 1 : 0;
    const body = comingUp({
      person: me(req), today: b.t, week, brand: brandOf(req), jobs: b.jobs, steps: b.steps, rework: b.rework,
      overdue: overdue(b.jobs, b.steps, b.t), decisions: b.decisions, stored: b.stored,
      capacity: capacity(b.jobs, b.steps, b.rules, b.cal, b.t, b.cap), cal: b.cal,
      suggestionsPanel: pendingPanel(await loadSuggestions({ status: 'pending' })),
      message: await appSetting('board_message'),
    });
    res.send(page({ title: 'Board', tab: 'board', person: me(req), flash: takeFlash(req, res), body, attention: attentionCount(b) }).value);
  }
  r.get('/', boardPage);
  r.get('/board', boardPage);

  /** Overdue steps plus decisions still open: the count on the Attention tab. */
  /** Jobs that can't cut (R20): short, or waiting on an order due after the factory date. */
  function shortJobs(ready: Awaited<ReturnType<typeof readinessByJob>>) {
    return [...ready].filter(([, r]) => r.state === 'short' || (r.state === 'waiting' && r.expected && r.factoryDate && r.expected > r.factoryDate))
      .map(([jobId, r]) => ({ jobId, ...r }));
  }
  function attentionCount(b: Awaited<ReturnType<typeof board>>): number {
    return overdue(b.jobs, b.steps, b.t).length + b.decisions.filter((x) => b.stored.get(x.key)?.fingerprint !== x.fingerprint).length + b.issues.length + shortJobs(b.ready).length;
  }

  r.get('/attention', async (req, res) => {
    const b = await board();
    const body = attentionPage({ person: me(req), today: b.t, jobs: b.jobs, steps: b.steps, overdue: overdue(b.jobs, b.steps, b.t), decisions: b.decisions, stored: b.stored, issues: b.issues, short: shortJobs(b.ready) });
    res.send(page({ title: 'Attention', tab: 'attention', person: me(req), flash: takeFlash(req, res), body, attention: attentionCount(b) }).value);
  });

  r.get('/pipeline', async (req, res) => {
    const b = await board();
    const body = pipelinePage({ jobs: b.jobs, steps: b.steps, rework: b.rework, today: b.t, brand: brandOf(req), ready: b.ready });
    res.send(page({ title: 'Pipeline', tab: 'pipeline', person: me(req), flash: takeFlash(req, res), body, attention: attentionCount(b) }).value);
  });

  r.get('/me', async (req, res) => {
    const [all, message, types, issues] = await Promise.all([loadEverything(), appSetting('board_message'), loadIssueTypes(), loadIssues({ open: true })]);
    const jobId = Number(req.query.job) || null;
    const job = jobId ? all.jobs.find((j) => j.id === jobId) : undefined;
    if (jobId && !job) throw new UserError("That job isn't in the hub.");
    if (job) {
      // From the job sheet's QR code (George, 7 Nov 2026): this job's open steps, whoever's they are.
      const body = jobDayPage({ person: me(req), today: today(), jobs: all.jobs, steps: all.steps, message, types, issues: issues.filter((i) => i.job_id === job.id), stepPhotos: await loadStepPhotos(job.id), files: await loadCurrentFiles() }, job);
      return res.send(page({ title: 'My day', tab: 'me', person: me(req), flash: takeFlash(req, res), body, sub: me(req).name }).value);
    }
    const body = myDayPage({ person: me(req), today: today(), jobs: all.jobs, steps: all.steps, message, types, issues: issues.filter((i) => i.responsible === me(req).id || i.raised_by === me(req).id), files: await loadCurrentFiles() });
    res.send(page({ title: 'My day', tab: 'me', person: me(req), flash: takeFlash(req, res), body, sub: me(req).name }).value);
  });

  r.get('/load', async (req, res) => {
    const b = await board();
    const from = addDays(b.t, -((new Date(`${b.t}T00:00:00Z`).getUTCDay() + 6) % 7));
    const body = loadPage({ from, today: b.t, rows: loadByDay(b.jobs, b.steps, b.rules, b.cal, b.cap, from, 6), jobs: b.jobs, hoursPerDay: b.rules.hours_per_day });
    res.send(page({ title: 'Load', tab: 'more', person: me(req), flash: takeFlash(req, res), body, attention: attentionCount(b), sub: 'Hours booked against hours available, the next six weeks' }).value);
  });

  r.get('/more', async (req, res) => {
    const body = morePage({ person: me(req), waiting: me(req).pending_suggestions ?? 0 });
    res.send(page({ title: 'More', tab: 'more', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  // The header search: one match opens the job, more than one lists them (George, 7 Nov 2026).
  r.get('/find', async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 80);
    const jobs = q ? await findJobs(q) : [];
    if (jobs.length === 1) return res.redirect(`/jobs/${jobs[0].id}`);
    const exact = jobs.filter((j) => j.job_number === q);
    if (exact.length === 1) return res.redirect(`/jobs/${exact[0].id}`);
    res.send(page({ title: 'Find a job', tab: 'jobs', person: me(req), body: findPage({ q, jobs }) }).value);
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
    const [rules, cal, all, tpl, cap] = await Promise.all([loadRules(), loadCalendar(), loadEverything(), templateFor(values), loadCapacity()]);
    const t = (await loadTemplates()).find((x) => x.key === values.template) ?? tpl;
    const planned = proposeFromAnchor({ ...values, added_on: today(), install_weeks: t.install_weeks }, anchor, anchorDate, rules, cal);
    const proposal = planned.steps;
    values = { ...values, site_start: planned.site_start };
    // Capacity with this job added, keeping only warnings that involve it.
    const ghost = { id: -1, job_number: values.job_number, brand: values.brand, client_name: values.client_name || 'This job', suburb: values.suburb, door_finish: values.door_finish, has_painting: values.has_painting, has_stone: values.has_stone, site_start: values.site_start, factory_days: values.factory_days, install_days: values.install_days, status: 'live', at_risk: false };
    const ghostSteps: StepRow[] = proposal.map((p, i) => ({ id: -1 - i, job_id: -1, kind: p.kind, rework_id: null, label: '', start_date: p.start_date, end_date: p.end_date, confirmed: false, owner: '', done_at: null }));
    const clashes = capacity([...all.jobs, ghost], [...all.steps, ...ghostSteps], rules, cal, today(), cap).filter((c) => c.jobIds.includes(-1));
    // Where it lands (R7): the factory and install weeks with their load before and after this job,
    // and, when it clashes, the first later start whose weeks have room.
    const weeksFor = (steps: StepRow[]): Landing['weeks'] => (['factory', 'install'] as const).flatMap((kind) => {
      const s = steps.find((x) => x.kind === kind && x.start_date);
      if (!s) return [];
      const monday = mondayOf(s.start_date!);
      const before = weekHours(kind, all.jobs, all.steps, rules, cal, cap, monday);
      const after = weekHours(kind, [...all.jobs, ghost], [...all.steps, ...steps], rules, cal, cap, monday);
      return [{ kind, label: cap.centres.find((c) => c.key === kind)?.label ?? KINDS[kind].label, monday, before: before.booked, after: after.booked, available: after.available }];
    });
    const landing: Landing = { weeks: weeksFor(ghostSteps), nextWithRoom: null };
    if (clashes.length) {
      for (let k = 1; k <= 12 && !landing.nextWithRoom; k++) {
        const date = addDays(anchorDate, 7 * k);
        const alt = proposeFromAnchor({ ...values, site_start: anchor === 'site_start' ? date : null, added_on: today(), install_weeks: t.install_weeks }, anchor, date, rules, cal);
        const altSteps: StepRow[] = alt.steps.map((p, i) => ({ id: -1 - i, job_id: -1, kind: p.kind, rework_id: null, label: '', start_date: p.start_date, end_date: p.end_date, confirmed: false, owner: '', done_at: null }));
        const altGhost = { ...ghost, site_start: alt.site_start };
        const altClash = capacity([...all.jobs, altGhost], [...all.steps, ...altSteps], rules, cal, today(), cap).some((c) => c.jobIds.includes(-1));
        const weeks = weeksFor(altSteps);
        if (!altClash && weeks.every((w) => w.after <= w.available)) landing.nextWithRoom = { date, weeks };
      }
    }
    return { proposal, clashes, site_start: planned.site_start, workedOut: !givenSite || planned.site_start !== givenSite, landing };
  }

  r.post('/jobs/preview', editor, async (req, res) => {
    try {
      const values = parseJobForm(req.body);
      const { proposal, clashes, site_start, workedOut, landing } = await proposalFor(values);
      res.send(proposalBlock(proposal, clashes, workedOut ? site_start : null, landing ?? null).value);
    } catch (err) {
      if (err instanceof UserError) return res.send(`<h2>Proposed dates</h2><p class="nodate">${err.message}</p>`);
      throw err;
    }
  });

  r.post('/jobs/new', editor, async (req, res) => {
    let values: ReturnType<typeof parseJobForm> | undefined;
    const templates = await loadTemplates();
    const render = async (error?: string) => {
      const p = values ? await proposalFor(values) : { proposal: null, clashes: [], site_start: null, workedOut: false, landing: null };
      res.send(page({ title: 'New job', tab: 'new', person: me(req), body: newJobPage({
        values: (values ?? req.body) as Partial<FullJob>, templates, anchor: values?.anchor ?? 'site_start', anchorDate: values?.anchor_date ?? null,
        proposal: p.proposal, siteStartWorkedOut: p.workedOut ? p.site_start : null, clashes: p.clashes, landing: p.landing ?? null, error }) }).value);
    };
    try {
      values = parseJobForm(req.body);
    } catch (err) {
      if (err instanceof UserError) return render(err.message);
      throw err;
    }
    // "Use the next week with room" (R7): move the date worked from, and show the new proposal.
    const useWeek = date(req.body.use_week, 'The week to use');
    if (useWeek) {
      if (values.anchor === 'site_start' || !values.anchor_date) values.site_start = useWeek; else values.anchor_date = useWeek;
      return render();
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
    const [issues, issueTypes] = await Promise.all([loadIssues({ jobId: id }), loadIssueTypes()]);
    const flagId = Number(req.query.flag) || null;
    const fromFlag = flagId ? issues.find((i) => i.id === flagId) : undefined;
    // Materials (R15 to R20): this job's lines, every live job's allocations (for what is free), open orders, the catalogue.
    const [materials, allMaterials, orders, stockItems, onHand] = await Promise.all([loadMaterials(id), loadMaterials(), loadOrders({ open: true }), loadItems({ activeOnly: true }), loadOnHand()]);
    const factoryDate = data.steps.find((s) => s.kind === 'factory' && !s.label)?.start_date ?? null;
    const body = jobPage({ person: me(req), today: b.t, ...data, list, history, decisions, templates, responsible, peopleNames: people.rows.map((p) => p.name), suggestionsPanel,
      issues, issueTypes, fromFlag: fromFlag ? { id: fromFlag.id, note: fromFlag.note } : null,
      materials: { jobId: id, person: me(req), lines: materials, orders, items: stockItems, readiness: readiness(materials, orders, id), factoryDate, onHand, allocated: allocatedByItem(allMaterials) } });
    res.send(page({ title: 'One job', tab: 'job', person: me(req), flash: takeFlash(req, res), body, attention: attentionCount(b) }).value);
  });

  // The job sheet (George, 7 Nov 2026; R12): one printable page with a QR code that opens the job on My day.
  r.get('/jobs/:id/sheet', async (req, res) => {
    const id = idParam(req);
    const data = await loadJob(id);
    if (!data) throw new UserError("That job isn't in the hub.");
    res.send(jobSheet(data.job, data.steps, `${config.appUrl}/me?job=${id}`, me(req).name, today(), data.files).value);
  });

  // ---------- Files on a job (George, 7 Nov 2026): Editors add and remove, everyone opens ----------

  r.post('/jobs/:id/files', editor, async (req, res) => {
    const jobId = idParam(req);
    const { fields, files } = await readMultipart(req, FILE_LIMITS);
    const back = localPath(fields.back) ? fields.back : `/jobs/${jobId}#files`;
    const kind = String(fields.kind ?? '');
    if (!FILE_KINDS.some((k) => k.key === kind)) throw new UserError('Say what the file is: contract plans, production plans or other.');
    const note = String(fields.note ?? '').trim().slice(0, 120);
    if (!(await pool.query('select 1 from jobs where id = $1', [jobId])).rowCount) throw new UserError("That job isn't in the hub.");
    const f = files[0];
    if (!f) throw new UserError('Choose the file.');
    const name = (f.name || 'file').replace(/[\\/]/g, '_').slice(0, 160);
    const version = await withPerson(me(req).id, async (db) => {
      const v = (await db.query('select coalesce(max(version), 0) + 1 as v from job_files where job_id = $1 and kind = $2', [jobId, kind])).rows[0].v as number;
      const id = (await db.query('insert into job_files (job_id, kind, version, name, content_type, size, note) values ($1, $2, $3, $4, $5, $6, $7) returning id',
        [jobId, kind, v, name, f.contentType, f.bytes.length, note])).rows[0].id;
      await db.query('insert into job_file_blobs (file_id, bytes) values ($1, $2)', [id, f.bytes]);
      return v;
    });
    const label = FILE_KINDS.find((k) => k.key === kind)!.label;
    flash(res, `${label} v${version} added${version > 1 ? `; v${version - 1} is now superseded` : ''}.`);
    res.redirect(back);
  });

  r.get('/jobs/:id/files/:fid', async (req, res) => {
    const f = (await pool.query('select f.name, f.content_type, b.bytes from job_files f join job_file_blobs b on b.file_id = f.id where f.id = $1 and f.job_id = $2', [Number(req.params.fid), idParam(req)])).rows[0];
    if (!f) return res.status(404).send('No such file.');
    const inline = f.content_type === 'application/pdf' || f.content_type.startsWith('image/');
    res.setHeader('Content-Type', f.content_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${String(f.name).replace(/["\r\n]/g, '_')}"`);
    res.send(f.bytes);
  });

  r.post('/jobs/:id/files/:fid/delete', editor, async (req, res) => {
    const jobId = idParam(req);
    const r2 = await withPerson(me(req).id, (db) => db.query('delete from job_files where id = $1 and job_id = $2 returning kind, version', [Number(req.params.fid), jobId]));
    if (!r2.rowCount) throw new UserError('That file has already gone.');
    flash(res, `${FILE_KINDS.find((k) => k.key === r2.rows[0].kind)?.label ?? 'File'} v${r2.rows[0].version} removed.`);
    res.redirect(backTo(req, `/jobs/${jobId}#files`));
  });

  r.get('/steps/:id/photos/:pid', async (req, res) => {
    const ph = (await pool.query('select content_type, bytes from step_photos where id = $1 and step_id = $2', [Number(req.params.pid), idParam(req)])).rows[0];
    if (!ph) return res.status(404).send('No such photo.');
    res.setHeader('Content-Type', ph.content_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', 'inline');
    res.send(ph.bytes);
  });

  // ---------- Flag a problem (Doers and Editors; George, 7 Nov 2026) ----------

  r.post('/issues', doer, async (req, res) => {
    const { fields, files } = await readMultipart(req);
    const jobId = Number(fields.job_id);
    const stepId = Number(fields.step_id) || null;
    const note = String(fields.note ?? '').trim().slice(0, 300);
    const type = String(fields.type ?? '');
    const back = localPath(fields.back) ? fields.back : `/jobs/${jobId}#flags`;
    if (!jobId || !(await pool.query('select 1 from jobs where id = $1', [jobId])).rowCount) throw new UserError("That job isn't in the hub.");
    if (!(await loadIssueTypes()).some((t) => t.key === type && t.active)) throw new UserError("Pick what's wrong.");
    if (!note) throw new UserError('Add one line on the problem.');
    const id = await withPerson(me(req).id, async (db) => {
      const r2 = await db.query('insert into issues (job_id, step_id, type_key, note) values ($1, $2, $3, $4) returning id', [jobId, stepId, type, note]);
      for (const f of files) await db.query('insert into issue_photos (issue_id, content_type, bytes, size) values ($1, $2, $3, $4)', [r2.rows[0].id, f.contentType, f.bytes, f.bytes.length]);
      return r2.rows[0].id as number;
    });
    const issue = await loadIssue(id);
    const sent = issue ? await deliverAll(await flagNudges(issue)) : 0;
    flash(res, `Flag sent${issue?.responsible_name ? ` to ${issue.responsible_name}` : ''}${sent ? ` (${sent} ${sent === 1 ? 'email' : 'emails'})` : ''}. It stays on Attention until it's fixed.`);
    res.redirect(back);
  });

  r.post('/issues/:id/status', doer, async (req, res) => {
    const id = idParam(req);
    const status = ['open', 'looking', 'fixed'].includes(String(req.body.status)) ? String(req.body.status) : 'open';
    const note = String(req.body.note ?? '').trim().slice(0, 300);
    const i = await loadIssue(id);
    if (!i) throw new UserError('That flag has gone.');
    // Postgres checks the same thing; this is the clear page.
    if (me(req).role !== 'editor' && i.responsible !== me(req).id && i.raised_by !== me(req).id) throw new UserError('Only the person responsible, whoever raised it, or an Editor can change a flag.');
    await withPerson(me(req).id, (db) => db.query('update issues set status = $2, close_note = case when $2 = $3 then $4 else close_note end where id = $1', [id, status, 'fixed', note]));
    flash(res, status === 'fixed' ? 'Flag marked fixed.' : status === 'looking' ? "Marked as being looked at." : 'Flag reopened.');
    res.redirect(backTo(req, '/attention'));
  });

  r.get('/issues/:id/photos/:pid', async (req, res) => {
    const id = idParam(req);
    const pid = Number(req.params.pid);
    const ph = (await pool.query('select content_type, bytes from issue_photos where id = $1 and issue_id = $2', [pid, id])).rows[0];
    if (!ph) return res.status(404).send('No such photo.');
    res.setHeader('Content-Type', ph.content_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', 'inline');
    res.send(ph.bytes);
  });

  // ---------- Job changes (Editors) ----------

  r.post('/jobs/:id/details', editor, async (req, res) => {
    const id = idParam(req);
    const v = parseJobForm(req.body);
    if (!v.client_name) throw new UserError('Add the client name.');
    await withPerson(me(req).id, async (db) => {
      await db.query(
        `update jobs set job_number=$2, brand=$3, client_name=$4, suburb=$5, scope=$6, door_finish=$7, has_stone=$8, site_start=$9,
           factory_days=$10, install_days=$11, status=$12, at_risk=$13, notes=$14, has_painting=$15, template=$16, drawings_url=$17 where id=$1`,
        [id, v.job_number, v.brand, v.client_name, v.suburb, v.scope, v.door_finish, v.has_stone, v.site_start, v.factory_days, v.install_days, v.status, v.at_risk, v.notes, v.has_painting,
          (await loadTemplates()).some((t) => t.key === v.template) ? v.template : null, v.drawings_url]);
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
    // Pinned dates are promises: the buttons leave them alone too (George, 7 Nov 2026).
    const steps = (await pool.query(`select id, kind, start_date, end_date from steps where job_id = $1 and kind <> 'rework' and done_at is null and not pinned and start_date is not null`, [id])).rows;
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
          `update steps set start_date = $3, end_date = $4 where job_id = $1 and kind = $2 and done_at is null and not confirmed and not pinned
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
    const { fields, files } = req.is('multipart/form-data') ? await readMultipart(req) : { fields: req.body as Record<string, string>, files: [] };
    if (req.is('multipart/form-data')) req.body = fields;
    const done = fields.done === '1';
    const s = (await pool.query(`select s.id, s.job_id, s.kind, s.rework_id, s.rework_area, s.label, s.start_date, s.end_date, s.confirmed, s.owner, s.done_at, s.pinned, s.hours,
      j.client_name, j.suburb from steps s join jobs j on j.id = s.job_id where s.id = $1`, [id])).rows[0];
    if (!s) throw new UserError('That step has gone.');
    // Install cabinets (George, 7 Nov 2026; R13): gaps adjusted? site left clean? and up to three photos.
    const yn = (v: unknown) => (v === '1' ? true : v === '0' ? false : null);
    const answers = asksOnDone(s) ? { gaps_adjusted: yn(fields.gaps), site_clean: yn(fields.clean) } : undefined;
    await withPerson(me(req).id, async (db) => {
      await setStepDone(db, id, done, answers);
      if (done && answers) {
        for (const f of files.slice(0, 3)) {
          await db.query('insert into step_photos (step_id, content_type, bytes, size) values ($1, $2, $3, $4)', [id, f.contentType, f.bytes, f.bytes.length]);
        }
      }
    });
    // Materials in, ticked: the factory hears straight away (George, 7 Nov 2026).
    if (done && !s.done_at && s.kind === 'materials_in' && !s.label) {
      await deliverAll(await materialsInNudges(s, { id: s.job_id, client_name: s.client_name, suburb: s.suburb }));
    }
    res.redirect(backTo(req));
  });

  // Pin a date (George, 7 Nov 2026): a promise. Shift, squeeze, drags and the job buttons leave it alone.
  r.post('/steps/:id/pin', editor, async (req, res) => {
    const id = idParam(req);
    const pinned = req.body.pinned === '1';
    const s = (await pool.query('select kind, label, start_date from steps where id = $1', [id])).rows[0];
    if (!s) throw new UserError('That step has gone.');
    if (pinned && !s.start_date) throw new UserError('Give it a date first, then pin it.');
    // Pinning also confirms: a promised date is one someone set on purpose.
    await withPerson(me(req).id, (db) => db.query('update steps set pinned = $2, confirmed = (confirmed or $2) where id = $1', [id, pinned]));
    flash(res, pinned ? `${s.label || KINDS[s.kind as StepKind].label} pinned. Nothing moves it until it's unpinned.` : `${s.label || KINDS[s.kind as StepKind].label} unpinned.`);
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
    const flagId = Number(req.body.flag_id) || null;
    await withPerson(me(req).id, async (db) => {
      const id = (await db.query('insert into rework (job_id, cause, note) values ($1, $2, $3) returning id', [jobId, cause, note.slice(0, 200)])).rows[0].id;
      // Raised from a flag (George, 7 Nov 2026): the flag is answered by the rework.
      if (flagId) await db.query(`update issues set rework_id = $2, status = 'fixed', close_note = 'Rework raised' where id = $1 and job_id = $3 and status <> 'fixed'`, [flagId, id, jobId]);
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

  // Clear every waiting suggestion before the bot's fresh rebuild (George, 6 Nov 2026). Editors only.
  r.post('/suggestions/supersede-pending', editor, async (req, res) => {
    const note = String(req.body.reason ?? '').trim() || `Cleared by ${me(req).name} before a fresh rebuild`;
    const ids = await withPerson(me(req).id, (db) => supersedePending(db, note));
    flash(res, ids.length ? `${ids.length} waiting ${ids.length === 1 ? 'suggestion' : 'suggestions'} marked superseded. Accepted, declined and the rest are unchanged.` : 'Nothing was waiting.');
    res.redirect('/suggestions');
  });

  // ---------- Settings (Editors) ----------

  async function settingsBody(req: Request, newTok?: { name: string; token: string }) {
    const [settings, blocked, people, email, tokens, calls, cap, issueTypes, runs] = await Promise.all([
      pool.query('select key, value, label from settings order by sort'),
      loadBlocked(),
      pool.query('select id, name, email, role, active, is_owner, areas, email_digest, can_stock from people order by active desc, role, name'),
      pool.query(`select value from app_settings where key = 'suggestions_email'`),
      me(req).is_owner ? pool.query(`select t.id, t.name, t.created_at, p.name as created_by_name, t.last_used_at, t.revoked_at from api_tokens t left join people p on p.id = t.created_by order by t.revoked_at nulls first, t.id desc`) : null,
      me(req).is_owner ? pool.query(`select c.at, c.method, c.path, c.status, c.items, t.name as token_name from api_calls c left join api_tokens t on t.id = c.token_id order by c.id desc limit 30`) : null,
      loadCapacity(),
      loadIssueTypes(),
      lastRuns(8),
    ]);
    const extra = suggestionSettings({ email: email.rows[0]?.value ?? '', isOwner: me(req).is_owner, tokens: tokens?.rows ?? [], calls: calls?.rows ?? [], newToken: newTok });
    return settingsPage({ settings: settings.rows, blocked, people: people.rows, today: today(), templates: await loadTemplates(), viewerIsOwner: me(req).is_owner, extra, message: await appSetting('board_message'),
      cap, issueTypes, runs, preview: config.preview, nudgeTo: config.preview ? await appSetting('suggestions_email') : null, tvKey: await appSetting('tv_token'), appUrl: config.appUrl });
  }

  r.get('/settings', editor, async (req, res) => {
    const body = await settingsBody(req);
    res.send(page({ title: 'Settings', tab: 'settings', person: me(req), flash: takeFlash(req, res), body }).value);
  });

  // Capacity in hours per area (George, 7 Nov 2026).
  const hoursOf2 = (v: unknown, what: string) => {
    const n = Number(String(v ?? '').trim());
    if (!Number.isFinite(n) || n < 0 || n > 200) throw new UserError(`${what}: hours must be a number from 0 to 200.`);
    return Math.round(n * 10) / 10;
  };
  r.post('/settings/centres/:key', editor, async (req, res) => {
    const key = String(req.params.key);
    const cap = await loadCapacity();
    const c = cap.centres.find((x) => x.key === key);
    if (!c) throw new UserError('No such area.');
    const h = (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((d) => hoursOf2(req.body[d], `${c.label} ${d}`));
    await withPerson(me(req).id, (db) => db.query('update labour_centres set mon = $2, tue = $3, wed = $4, thu = $5, fri = $6 where key = $1', [key, ...h]));
    flash(res, `${c.label}: ${h.reduce((a, b) => a + b, 0)} hours a week. Warnings use it from now on.`);
    res.redirect('/settings#capacity');
  });
  r.post('/settings/adjustments', editor, async (req, res) => {
    const cap = await loadCapacity();
    const centre = String(req.body.centre ?? '');
    if (!cap.centres.some((c) => c.key === centre)) throw new UserError('Pick the area.');
    const from = date(req.body.from, 'From');
    const to = date(req.body.to, 'To') ?? from;
    if (!from || !to || to < from) throw new UserError('Check the dates.');
    const hours = hoursOf2(req.body.hours, 'Hours a day');
    const reason = String(req.body.reason ?? '').trim().slice(0, 120);
    if (!reason) throw new UserError('Add a reason, e.g. Phil on leave.');
    await withPerson(me(req).id, (db) => db.query('insert into capacity_adjustments (centre, from_day, to_day, hours, reason) values ($1, $2, $3, $4, $5)', [centre, from, to, hours, reason]));
    flash(res, `${reason}: ${hours} h a day from ${fmtLong(from)} to ${fmtLong(to)}.`);
    res.redirect('/settings#capacity');
  });
  r.post('/settings/adjustments/:id/delete', editor, async (req, res) => {
    await withPerson(me(req).id, (db) => db.query('delete from capacity_adjustments where id = $1', [idParam(req)]));
    flash(res, 'Adjustment removed.');
    res.redirect('/settings#capacity');
  });

  // Who looks after each kind of flagged problem.
  r.post('/settings/flag-types/:key', editor, async (req, res) => {
    const key = String(req.params.key);
    const who = Number(req.body.responsible) || null;
    if (who && !(await pool.query('select 1 from people where id = $1 and active', [who])).rowCount) throw new UserError('Pick a person on the list.');
    const r2 = await withPerson(me(req).id, (db) => db.query('update issue_types set responsible = $2, active = $3 where key = $1 returning label', [key, who, req.body.active === '1']));
    if (!r2.rowCount) throw new UserError('No such flag type.');
    flash(res, `${r2.rows[0].label} saved.`);
    res.redirect('/settings#flags');
  });

  // Emails: what today's run would send, and send it now.
  r.get('/settings/emails', editor, async (req, res) => {
    const list = await dailyNudges(today());
    const to = config.preview ? await appSetting('suggestions_email') : null;
    const body = html`<section class="panel"><div class="row"><h2>What the 7 am run would send today</h2><span class="muted small">${list.length} ${list.length === 1 ? 'email' : 'emails'}${to ? html` · on the preview every one goes to ${to}` : ''}</span></div>
      ${list.length ? list.map((n) => html`<div class="item stack"><div><strong>${n.subject}</strong> <span class="muted small">to ${n.to.name} (${n.to.email})</span></div><div class="small">${n.lines.map((l) => html`<div>${l}</div>`)}</div></div>`) : html`<p class="muted">Nothing to send today: no one has a step that went overdue${new Date(`${today()}T00:00:00Z`).getUTCDay() === 1 ? ' and no one has steps this week' : ''}.</p>`}
      <div class="acts"><form method="post" action="/settings/emails/run"><button class="btn primary" type="submit">Send these now</button></form><a class="btn" href="/settings#emails">Back to Settings</a></div></section>`;
    res.send(page({ title: 'Emails', tab: 'settings', person: me(req), flash: takeFlash(req, res), body }).value);
  });
  r.post('/settings/emails/run', editor, async (_req, res) => {
    const n = await runDaily(today(), true);
    flash(res, `${n ?? 0} ${n === 1 ? 'email' : 'emails'} sent.`);
    res.redirect('/settings#emails');
  });

  // The factory TV link (George, 7 Nov 2026): a new key stops the old link.
  r.post('/settings/tv', editor, async (req, res) => {
    await withPerson(me(req).id, (db) => db.query(`update app_settings set value = $1 where key = 'tv_token'`, [newTvKey()]));
    flash(res, 'Factory TV link made. Open it on the factory screen; the old link no longer works.');
    res.redirect('/settings#tv');
  });

  r.post('/settings/message', editor, async (req, res) => {
    const m = String(req.body.message ?? '').trim().slice(0, 200);
    await withPerson(me(req).id, (db) => db.query(`update app_settings set value = $1 where key = 'board_message'`, [m]));
    flash(res, m ? 'Message saved. It shows on My day and the board.' : 'Message cleared.');
    res.redirect('/settings#message');
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
  /** The areas ticked on a person form: only known board rows, in board order. */
  const areasOf = (v: unknown): string[] => {
    const picked = new Set((Array.isArray(v) ? v : v ? [v] : []).map(String));
    return PEOPLE_AREAS.filter((a) => picked.has(a.area)).map((a) => a.area);
  };
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
    await withPerson(me(req).id, (db) => db.query('insert into people (name, email, role, is_owner, areas, email_digest, can_stock) values ($1, $2, $3, $4, $5, $6, $7)',
      [name, email, roleOf(req.body.role), me(req).is_owner && req.body.is_owner === '1', areasOf(req.body.areas), req.body.email_digest !== '0', req.body.can_stock === '1']));
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
    await withPerson(me(req).id, (db) => db.query('update people set name = $2, email = $3, role = $4, active = $5, is_owner = $6, areas = $7, email_digest = $8, can_stock = $9 where id = $1',
      [id, String(req.body.name ?? '').trim(), emailOf(req.body.email), role, active, isOwner, areasOf(req.body.areas), req.body.email_digest === '1', req.body.can_stock === '1']));
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

