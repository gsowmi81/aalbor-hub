import { html, Html } from '../web/html.js';
import { fmtLong, fmtRange, fmtShort, Iso, sydneyDate } from '../domain/dates.js';
import { KINDS, StepKind, FLOW } from '../domain/steps.js';
import { Decision, jobTitle, lastDate, nextUp, StepRow, stepLabel } from '../domain/checks.js';
import { can, Person } from '../web/auth.js';
import type { FullJob, LogEntry, ReworkFull } from '../db/queries.js';
import { decisionFields } from './comingUp.js';

export const CAUSES = ['drafting', 'measure', 'factory', 'install', 'supplier', 'client change'] as const;

type Step = StepRow & { note: string };

export interface JobPageData {
  person: Person;
  today: Iso;
  job: FullJob;
  steps: Step[];
  rework: ReworkFull[];
  list: { id: number; job_number: string | null; client_name: string; suburb: string; status: string }[];
  decisions: Decision[];
  history: LogEntry[];
}

const STATUS = { live: 'Live', on_hold: 'On hold', complete: 'Complete', cancelled: 'Cancelled' } as Record<string, string>;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function dateInputs(s: Step, editor: boolean, today: Iso): Html {
  const k = KINDS[s.kind];
  const over = !s.done_at && s.start_date && lastDate(s)! < today;
  const nice = s.start_date ? fmtRange(s.start_date, s.end_date) : html`<span class="nodate">No date yet</span>`;
  const status = s.done_at ? 'Done' : s.start_date ? (s.confirmed ? 'Confirmed' : 'Provisional') : '';
  if (!editor) {
    return html`<div class="field${s.confirmed ? '' : ' isprov'}"><div class="ftop"><strong>${stepLabel(s)}</strong><span class="muted small">${s.owner || k.owner}</span></div>
      <div class="nice"><span>${nice}${over ? html` · <span class="nodate">overdue</span>` : ''}</span><span>${status}</span></div></div>`;
  }
  const id = `d-${s.id}`;
  return html`<div class="field${s.confirmed ? '' : ' isprov'}">
    <div class="ftop"><label for="${id}">${stepLabel(s)}</label><span class="muted small">${s.owner || k.owner}</span></div>
    ${k.range
      ? html`<div class="pair"><input id="${id}" type="date" name="start_${s.id}" value="${s.start_date ?? ''}" aria-label="${stepLabel(s)} from"><input type="date" name="end_${s.id}" value="${s.end_date ?? ''}" aria-label="${stepLabel(s)} to"></div>`
      : html`<input id="${id}" type="date" name="start_${s.id}" value="${s.start_date ?? ''}">`}
    <div class="nice"><span>${nice}${over ? html` · <span class="nodate">overdue</span>` : ''}${s.done_at ? ' · done' : ''}</span>
      <label><input type="checkbox" name="confirmed_${s.id}" value="1"${s.confirmed ? html` checked` : ''}> Confirmed</label></div>
  </div>`;
}

function checkRow(s: Step, person: Person, back: string): Html {
  const on = !!s.done_at;
  const canTick = can(person, 'doer');
  const row = html`<span class="box" aria-hidden="true">${on ? '✓' : ''}</span><span class="l">${stepLabel(s)}</span><span class="muted small">${s.start_date ? fmtShort(lastDate(s)!) : ''} · ${s.owner || KINDS[s.kind].owner}</span>`;
  if (!canTick) return html`<button class="check${on ? ' on' : ''}" type="button" disabled aria-pressed="${on}">${row}</button>`;
  return html`<form method="post" action="/steps/${s.id}/done"><input type="hidden" name="done" value="${on ? '0' : '1'}"><input type="hidden" name="back" value="${back}">
    <button class="check${on ? ' on' : ''}" type="submit" aria-pressed="${on}" aria-label="${stepLabel(s)}: ${on ? 'done, tap to untick' : 'tap when done'}">${row}</button></form>`;
}

export function jobPage(d: JobPageData): Html {
  const { job, person } = d;
  const editor = can(person, 'editor');
  // Standard steps in flow order, with any extra named steps (e.g. "Install painted doors") after their row's standard step.
  const order = (s: Step) => FLOW.indexOf(s.kind) * 2 + (s.label ? 1 : 0);
  const std = d.steps.filter((s) => s.kind !== 'rework').sort((a, b) => order(a) - order(b) || (a.start_date ?? '').localeCompare(b.start_date ?? ''));
  const rw = d.steps.filter((s) => s.kind === 'rework');
  const next = nextUp(d.steps);
  const back = `/jobs/${job.id}`;
  const doneCount = std.filter((s) => s.done_at).length;
  const stage = std.find((s) => !s.done_at);

  const pills: Html[] = [];
  if (job.status !== 'live') pills.push(html`<span class="pill">${STATUS[job.status]}</span>`);
  if (job.at_risk) pills.push(html`<span class="pill warn">At risk</span>`);
  pills.push(html`<span class="pill">${job.door_finish === 'polyurethane' ? 'Polyurethane' : 'Melamine'}</span>`);
  pills.push(html`<span class="pill">${job.has_stone ? 'Stone' : 'No stone'}</span>`);
  pills.push(html`<span class="pill">${job.brand}</span>`);
  for (const x of d.decisions.slice(0, 3)) pills.push(html`<span class="pill over">${x.fact}</span>`);

  return html`<div class="job">
  <form method="get" action="/job" class="stack">
    <label class="f" for="job-pick">Choose a job
      <select id="job-pick" name="id" data-autosubmit>
        ${d.list.map((j) => html`<option value="${j.id}"${j.id === job.id ? html` selected` : ''}>${[j.job_number, j.client_name, j.suburb].filter(Boolean).join(' · ')}${j.status === 'live' ? '' : ` (${STATUS[j.status]})`}</option>`)}
      </select></label>
    <noscript><button class="btn" type="submit">Open</button></noscript>
  </form>

  <div style="display:flex;flex-direction:column;gap:6px">
    <div class="eyebrow">Job ${job.job_number ?? '(no number)'} · site start ${job.site_start ? fmtLong(job.site_start) : 'not set'}</div>
    <h2 style="font-size:24px">${jobTitle(job)}</h2>
    ${job.scope ? html`<p class="muted">${job.scope}</p>` : ''}
    <div class="pills">${pills}</div>
  </div>

  <div class="next"><span class="eyebrow">Next up</span><b>${next ? stepLabel(next) : 'No dates set'}</b><span>${next ? `${fmtRange(next.start_date, next.end_date)} · ${next.owner || KINDS[next.kind].owner}` : 'Add dates below'}</span></div>

  ${d.decisions.length && editor ? html`<section class="panel" style="gap:6px"><h2>Needs a decision</h2>
    ${d.decisions.map((x) => html`<div class="item stack"><div>${x.fact}</div><div class="ask">${x.ask}</div>
      <div class="acts">
        <form method="post" action="/decisions/ok"><input type="hidden" name="key" value="${x.key}"><input type="hidden" name="fingerprint" value="${x.fingerprint}"><input type="hidden" name="note" value="${x.okText}"><input type="hidden" name="back" value="${back}"><button class="btn" type="submit">OK as is</button></form>
        ${x.fields.length ? html`<details class="pop" style="display:contents"><summary class="btn">Change dates</summary>
          <form method="post" action="/decisions/fix" class="popbody"><input type="hidden" name="back" value="${back}">${decisionFields(x)}<div class="acts"><button class="btn primary" type="submit">Save</button></div></form></details>` : ''}
      </div>
    </div>`)}</section>` : ''}

  <section class="panel" style="gap:2px">
    <div class="row"><h2>Dates</h2><span class="muted small">Faded means provisional. Tick Confirmed once it matches Buildertrend.</span></div>
    ${editor ? html`<form method="post" action="/jobs/${job.id}/dates">${std.map((s) => dateInputs(s, true, d.today))}
        <div class="acts" style="padding-top:12px;border-top:1px solid var(--line)"><button class="btn primary" type="submit">Save dates</button>
          <button class="btn" type="submit" name="confirm_all" value="1">Save and confirm all</button></div></form>`
      : std.map((s) => dateInputs(s, false, d.today))}
    ${editor ? html`<div style="display:flex;flex-direction:column;gap:8px;padding-top:12px;margin-top:12px;border-top:1px solid var(--line)">
      <strong>Job slipped? Move every date at once</strong>
      <div class="shift">
        ${[[-1, '−1 day'], [1, '+1 day'], [5, '+1 week']].map(([n, l]) => html`<form method="post" action="/jobs/${job.id}/shift"><input type="hidden" name="n" value="${n}"><button class="btn" type="submit">${l}</button></form>`)}
      </div>
      <span class="muted small">Working days. Moves every step not yet done, skipping weekends, public holidays and blocked days.</span>
      <form method="post" action="/jobs/${job.id}/repropose"><button class="btn small" type="submit">Work out the provisional dates again from site start</button></form>
      <span class="muted small">Only changes steps that are neither done nor confirmed.</span>
    </div>` : ''}
  </section>

  <section class="panel" style="gap:2px">
    <div class="row"><h2>Checklist</h2><span class="muted small">${doneCount} of ${std.length} done</span></div>
    <div class="muted small" style="padding-bottom:6px">${can(person, 'doer') ? 'Tick when done.' : 'Ticked by the team as steps are done.'}</div>
    ${std.map((s) => checkRow(s, person, back))}
    <div class="kv"><strong>Current stage</strong><span>${stage ? stepLabel(stage) : 'Complete'}</span></div>
  </section>

  ${reworkPanel(d, rw)}
  ${editor ? detailsPanel(job) : html`<section class="panel"><h2>Notes</h2><p>${job.notes || 'No notes.'}</p></section>`}
  ${historyPanel(d.history, d.steps)}
</div>`;
}

function reworkPanel(d: JobPageData, rwSteps: Step[]): Html {
  const editor = can(d.person, 'editor');
  const back = `/jobs/${d.job.id}#rework`;
  return html`<section class="panel lane-rework" id="rework" style="gap:8px">
    <div class="row"><h2 style="color:var(--rw)">Rework</h2><span class="muted small">${d.rework.filter((r) => !r.closed_on).length} open</span></div>
    ${!d.rework.length ? html`<p class="muted">No rework on this job.</p>` : ''}
    ${d.rework.map((r) => {
      const steps = rwSteps.filter((s) => s.rework_id === r.id);
      return html`<div class="item stack">
        <div><strong>${r.cause ? cap(r.cause) : 'Cause not recorded'}</strong> · ${r.note}</div>
        <div class="muted small">Raised by ${r.raised_by_name ?? 'unknown'} on ${fmtLong(sydneyDate(r.raised_at))}${r.closed_on ? ` · closed ${fmtLong(r.closed_on)} · ${r.extra_hours ?? 0} extra hours · $${(r.extra_material_cost ?? 0).toFixed(2)} extra material` : ''}</div>
        ${steps.map((s) => checkRow(s, d.person, back))}
        ${steps.length ? '' : html`<span class="nodate small">No dates yet</span>`}
        ${editor && !r.closed_on ? html`<details class="pop"><summary class="btn small">Add a dated step</summary>
          <form class="popbody" method="post" action="/rework/${r.id}/steps"><input type="hidden" name="back" value="${back}">
            <div class="fixgrid"><label class="f">What<input name="label" required placeholder="e.g. Rebuild cabinet in factory"></label>
            <label class="f">Who<input name="owner" placeholder="e.g. Phil"></label>
            <label class="f">From<input type="date" name="start" required></label><label class="f">To<input type="date" name="end"></label></div>
            <div class="acts"><button class="btn primary" type="submit">Add step</button></div></form></details>
          <details class="pop"><summary class="btn small">Close this rework</summary>
          <form class="popbody" method="post" action="/rework/${r.id}/close"><input type="hidden" name="back" value="${back}">
            <div class="fixgrid"><label class="f">Cause<select name="cause" required>${CAUSES.map((c) => html`<option value="${c}"${r.cause === c ? html` selected` : ''}>${cap(c)}</option>`)}</select></label>
            <label class="f">Extra hours<input name="extra_hours" inputmode="decimal" required pattern="[0-9]+([.][0-9])?"></label>
            <label class="f">Extra material $<input name="extra_material_cost" inputmode="decimal" required pattern="[0-9]+([.][0-9]{1,2})?"></label></div>
            <div class="acts"><button class="btn primary" type="submit">Close rework</button></div></form></details>` : ''}
      </div>`;
    })}
    ${can(d.person, 'doer') ? raiseForm(d.job.id, back) : ''}
  </section>`;
}

export function raiseForm(jobId: number | null, back: string, jobs?: { id: number; client_name: string; suburb: string }[]): Html {
  return html`<details class="pop"${jobId ? '' : html` open`}><summary class="btn">Raise rework</summary>
    <form class="popbody" method="post" action="/rework"><input type="hidden" name="back" value="${back}">
      ${jobId ? html`<input type="hidden" name="job_id" value="${jobId}">`
        : html`<label class="f">Job<select name="job_id" required><option value="">Pick a job</option>${(jobs ?? []).map((j) => html`<option value="${j.id}">${j.client_name} · ${j.suburb}</option>`)}</select></label>`}
      <label class="f">Cause<select name="cause" required><option value="">Pick a cause</option>${CAUSES.map((c) => html`<option value="${c}">${cap(c)}</option>`)}</select></label>
      <label class="f">What happened (one line)<input name="note" required maxlength="200" placeholder="e.g. Cabinet must be rebuilt: drafting, factory, painting, reinstall"></label>
      <div class="acts"><button class="btn primary" type="submit">Raise it</button></div>
    </form></details>`;
}

export function jobFields(j: Partial<FullJob>, opts: { forNew?: boolean } = {}): Html {
  const v = (x: unknown) => (x === null || x === undefined ? '' : String(x));
  return html`<div class="formgrid">
    <label class="f">Job number (Buildertrend)<input name="job_number" value="${v(j.job_number)}" inputmode="numeric" placeholder="e.g. 270201"${opts.forNew ? html` data-jobnumber` : ''}></label>
    <label class="f">Site start<input type="date" name="site_start" value="${v(j.site_start)}"${opts.forNew ? html` required data-sitestart` : ''}></label>
    <label class="f">Client name<input name="client_name" required value="${v(j.client_name)}"></label>
    <label class="f">Suburb<input name="suburb" value="${v(j.suburb)}"></label>
    <label class="f">Brand<select name="brand">${['Aalbor', 'Origin'].map((b) => html`<option${j.brand === b ? html` selected` : ''}>${b}</option>`)}</select></label>
    <label class="f">Door finish<select name="door_finish">
      <option value="melamine"${j.door_finish !== 'polyurethane' ? html` selected` : ''}>Melamine</option>
      <option value="polyurethane"${j.door_finish === 'polyurethane' ? html` selected` : ''}>Polyurethane (painted)</option></select></label>
    <label class="f">Factory days<input name="factory_days" type="number" min="1" max="30" required value="${v(j.factory_days ?? 2)}"></label>
    <label class="f">Install days<input name="install_days" type="number" min="1" max="30" required value="${v(j.install_days ?? 3)}"></label>
    <label class="checkline"><input type="checkbox" name="has_stone" value="1"${j.has_stone !== false ? html` checked` : ''}> Stone benchtops</label>
    ${opts.forNew ? '' : html`<label class="f">Status<select name="status">${Object.entries(STATUS).map(([k, l]) => html`<option value="${k}"${j.status === k ? html` selected` : ''}>${l}</option>`)}</select></label>
    <label class="checkline"><input type="checkbox" name="at_risk" value="1"${j.at_risk ? html` checked` : ''}> At risk</label>`}
    <label class="f wide">Rooms and scope<textarea name="scope">${v(j.scope)}</textarea></label>
    <label class="f wide">Notes<textarea name="notes">${v(j.notes)}</textarea></label>
    <p class="muted small wide">No phone numbers, emails or street addresses here. They stay in Buildertrend.</p>
  </div>`;
}

function detailsPanel(job: FullJob): Html {
  return html`<section class="panel"><details><summary style="cursor:pointer"><h2 style="display:inline">Job details</h2> <span class="muted small">Tap to edit</span></summary>
    <form method="post" action="/jobs/${job.id}/details" class="stack" style="padding-top:12px">
      ${jobFields(job)}
      <div class="acts"><button class="btn primary" type="submit">Save details</button></div>
      <span class="muted small">Changing door finish or stone adds or removes the painting and stone steps.</span>
    </form></details></section>`;
}

const FIELD_NAMES: Record<string, string> = {
  start_date: 'from', end_date: 'to', confirmed: 'confirmed', done_at: 'done', owner: 'owner', note: 'note', label: 'name',
  job_number: 'job number', client_name: 'client', suburb: 'suburb', scope: 'scope', door_finish: 'door finish', has_stone: 'stone',
  site_start: 'site start', factory_days: 'factory days', install_days: 'install days', status: 'status', at_risk: 'at risk',
  notes: 'notes', brand: 'brand', cause: 'cause', closed_on: 'closed', extra_hours: 'extra hours', extra_material_cost: 'extra material $',
};
const SKIP = new Set(['id', 'job_id', 'created_at', 'done_by', 'sort', 'raised_by', 'raised_at', 'rework_id', 'added_on', 'kind']);

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'blank';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtShort(s);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return 'ticked';
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

export function describe(e: LogEntry, stepName: (id: string) => string): string {
  const what = e.table_name === 'jobs' ? 'Job' : e.table_name === 'rework' ? 'Rework' : stepName(e.record_id);
  if (e.action === 'insert') return `${what} added`;
  if (e.action === 'delete') return `${what} removed`;
  const b = e.before ?? {};
  const a = e.after ?? {};
  if (e.table_name === 'steps' && b.done_at !== a.done_at && Object.keys(a).filter((k) => !SKIP.has(k) && a[k] !== b[k]).length === 1) {
    return a.done_at ? `${what} ticked done` : `${what} unticked`;
  }
  const order = Object.keys(FIELD_NAMES);
  const parts = Object.keys(a).filter((k) => !SKIP.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort((x, y) => order.indexOf(x) - order.indexOf(y))
    .map((k) => `${FIELD_NAMES[k] ?? k} ${show(b[k])} → ${show(a[k])}`);
  return parts.length ? `${what}: ${parts.join(', ')}` : `${what} updated`;
}

function historyPanel(history: LogEntry[], steps: Step[]): Html {
  const names = new Map(steps.map((s) => [String(s.id), stepLabel(s)]));
  const stepName = (id: string) => names.get(id) ?? 'A step';
  const when = (t: string) => {
    const d = new Date(t);
    const date = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: 'short', year: 'numeric' }).format(d);
    const time = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    return `${date} ${time}`;
  };
  return html`<section class="panel"><details><summary style="cursor:pointer"><h2 style="display:inline">History</h2> <span class="muted small">Every change, newest first</span></summary>
    <div class="hist" style="padding-top:8px">${history.length ? history.map((e) => html`<div><time>${when(e.changed_at)}</time> · <strong>${e.person_name}</strong> · ${describe(e, stepName)}</div>`) : html`<div>No changes yet.</div>`}</div>
  </details></section>`;
}

/** Kinds the "Change dates" boxes and the dates form can set. */
export function isStepKind(k: string): k is StepKind {
  return k in KINDS;
}
