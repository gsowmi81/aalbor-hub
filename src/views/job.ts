import { html, Html } from '../web/html.js';
import { fmtLong, fmtRange, fmtShort, Iso, sydneyDate } from '../domain/dates.js';
import { BOARD_ROWS, KINDS, StepKind, FLOW, REWORK_AREAS, REWORK_CATEGORIES, REWORK_ORDER, TASK_AREAS, rowOf } from '../domain/steps.js';
import { currentStep, Decision, jobTitle, lastDate, nextUp, planRow, StepRow, stepLabel } from '../domain/checks.js';
import { canSqueeze } from './reschedule.js';
import { can, Person } from '../web/auth.js';
import type { FullJob, LogEntry, ReworkFull, Responsible } from '../db/queries.js';
import { ANCHORS, AnchorKind, Template } from '../domain/schedule.js';
import { decisionFields } from './items.js';

export const CAUSES = ['drafting', 'measure', 'factory', 'install', 'supplier', 'client change'] as const;

type Step = StepRow & { note: string };

const ROW_NAME: Record<string, string> = Object.fromEntries(BOARD_ROWS.map((r) => [r.row, `${r.label} row`]));

export interface JobPageData {
  person: Person;
  today: Iso;
  job: FullJob;
  steps: Step[];
  rework: ReworkFull[];
  list: { id: number; job_number: string | null; client_name: string; suburb: string; status: string }[];
  decisions: Decision[];
  history: LogEntry[];
  templates: Template[];
  /** Owners only: who was responsible for each rework. Empty for everyone else. */
  responsible: Map<number, Responsible>;
  peopleNames: string[];
  /** Bot suggestions waiting on this job (views/suggestions.ts). */
  suggestionsPanel?: Html;
}

const STATUS = { live: 'Live', on_hold: 'On hold', complete: 'Complete', cancelled: 'Cancelled' } as Record<string, string>;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function dateInputs(s: Step, editor: boolean, today: Iso): Html {
  const k = KINDS[s.kind];
  const over = !s.done_at && s.start_date && lastDate(s)! < today;
  const nice = s.start_date ? fmtRange(s.start_date, s.end_date) : s.done_at ? 'Done, date not recorded' : html`<span class="nodate">No date yet</span>`;
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
    <div class="nice"><span>${nice}${over ? html` · <span class="nodate">overdue</span>` : ''}${s.done_at && s.start_date ? ' · done' : ''}${!s.done_at ? html` · <a href="/jobs/${s.job_id}/reschedule?step=${s.id}">Move…</a>` : ''}</span>
      <label><input type="checkbox" name="confirmed_${s.id}" value="1"${s.confirmed ? html` checked` : ''}> Confirmed</label></div>
  </div>`;
}

/** A delete that asks once more on the page itself (the viewer can't show confirm dialogs). */
function confirmDelete(action: string, back: string, label: string, warning: string): Html {
  return html`<details class="pop"><summary class="btn small danger">${label}</summary>
    <form class="popbody" method="post" action="${action}"><input type="hidden" name="back" value="${back}">
      <span class="small">${warning}</span>
      <div class="acts"><button class="btn small danger" type="submit">Yes, delete</button></div></form></details>`;
}

function checkRow(s: Step, person: Person, back: string): Html {
  const on = !!s.done_at;
  const canTick = can(person, 'doer');
  const row = html`<span class="box" aria-hidden="true">${on ? '✓' : ''}</span><span class="l">${stepLabel(s)}</span><span class="muted small">${s.start_date ? fmtShort(lastDate(s)!) : ''} · ${s.owner || KINDS[s.kind].owner}</span>`;
  if (!canTick) return html`<button class="check${on ? ' on' : ''}" type="button" disabled aria-pressed="${on}">${row}</button>`;
  return html`<form method="post" action="/steps/${s.id}/done" id="c-${s.id}"><input type="hidden" name="done" value="${on ? '0' : '1'}"><input type="hidden" name="back" value="${back.split('#')[0]}#c-${s.id}">
    <button class="check${on ? ' on' : ''}" type="submit" aria-pressed="${on}" aria-label="${stepLabel(s)}: ${on ? 'done, tap to untick' : 'tap when done'}">${row}</button></form>`;
}

/** One step on the job timeline (George, 7 Nov 2026): tick, name, date to tap, pills, pin. */
function stepRow(s: Step, d: JobPageData, std: Step[]): Html {
  const { person, job } = d;
  const editor = can(person, 'editor');
  const on = !!s.done_at;
  const over = !on && !!s.start_date && lastDate(s)! < d.today;
  const back = `/jobs/${job.id}#c-${s.id}`;
  const cls = ['step', on ? 'done' : '', over ? 'over' : '', !on && s.start_date && !s.confirmed ? 'prov' : '', s.pinned ? 'pinned' : ''].filter(Boolean).join(' ');
  const box = html`<span class="box" aria-hidden="true">${on ? '✓' : ''}</span>`;
  const tickBtn = can(person, 'doer')
    ? html`<form method="post" action="/steps/${s.id}/done" id="c-${s.id}"><input type="hidden" name="done" value="${on ? '0' : '1'}"><input type="hidden" name="back" value="${back}">
        <button class="check" type="submit" aria-pressed="${on}" aria-label="${stepLabel(s)}: ${on ? 'done, tap to untick' : 'tap when done'}">${box}</button></form>`
    : html`<span class="check" id="c-${s.id}">${box}</span>`;
  const when = s.start_date ? fmtRange(s.start_date, s.end_date) : on ? 'Done, date not recorded' : 'No date yet';
  const pills: Html[] = [];
  if (on) pills.push(html`<span class="spill done">Done</span>`);
  else if (over) pills.push(html`<span class="spill over">Overdue</span>`);
  if (!on && s.start_date) pills.push(s.confirmed ? html`<span class="spill">Confirmed</span>` : html`<span class="spill prov">Provisional</span>`);
  if (s.pinned) pills.push(html`<span class="spill pin" title="Pinned: nothing moves it">📌 Pinned</span>`);
  const movable = editor && !on;
  const dateEl = movable
    ? html`<a class="datebtn" href="/jobs/${job.id}/reschedule?step=${s.id}" ${dragAttrs(s, job, std)} data-date="${s.start_date ?? ''}" data-range="${KINDS[s.kind].range ? '1' : '0'}" title="Move this date">${when}</a>`
    : html`<span class="datetxt">${when}</span>`;
  const pin = editor && !on && s.start_date
    ? html`<form method="post" action="/steps/${s.id}/pin" class="pinform"><input type="hidden" name="pinned" value="${s.pinned ? '0' : '1'}"><input type="hidden" name="back" value="/jobs/${job.id}#s-${s.id}"><button class="linkbtn small" type="submit">${s.pinned ? 'Unpin' : 'Pin'}</button></form>`
    : '';
  return html`<div class="${cls}" id="s-${s.id}">${tickBtn}
    <div class="st-main"><div class="st-top"><strong>${stepLabel(s)}</strong><span class="muted small">${s.owner || KINDS[s.kind].owner}</span></div>
      <div class="st-when">${dateEl}${pills}${pin}</div></div>
  </div>`;
}

/** The data the move box needs: the same as a board card's. */
function dragAttrs(s: Step, job: FullJob, std: Step[]): Html {
  const squeeze = canSqueeze(planRow(s), std.map(planRow));
  return html`data-step="${s.id}" data-job="${job.id}" data-label="${stepLabel(s)}"${squeeze ? html` data-squeeze="1"` : ''}`;
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
  const stage = currentStep(std);

  const pills: Html[] = [];
  if (job.status !== 'live') pills.push(html`<span class="pill">${STATUS[job.status]}</span>`);
  if (job.at_risk) pills.push(html`<span class="pill warn">At risk</span>`);
  pills.push(html`<span class="pill">${job.door_finish === 'polyurethane' ? 'Polyurethane' : 'Melamine'}</span>`);
  pills.push(html`<span class="pill">${job.has_painting ? 'Painting' : 'No painting'}</span>`);
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

  ${d.suggestionsPanel ?? ''}
  <div style="display:flex;flex-direction:column;gap:6px">
    <div class="eyebrow">Job ${job.job_number ?? '(no number)'} · site start ${job.site_start ? fmtLong(job.site_start) : 'not set'}</div>
    <h2 style="font-size:24px">${jobTitle(job)}</h2>
    ${job.scope ? html`<p class="muted">${job.scope}</p>` : ''}
    <div class="pills">${pills}${job.drawings_url ? html`<a class="pill link" href="${job.drawings_url}" target="_blank" rel="noopener">Drawings ↗</a>` : ''}</div>
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

  <section class="panel" style="gap:2px" id="steps">
    <div class="row"><h2>Steps</h2><span class="muted small">${doneCount} of ${std.length} done · ${stage ? `at ${stepLabel(stage)}` : 'complete'}</span></div>
    <div class="bar" aria-hidden="true"><i style="width:${std.length ? Math.round((doneCount / std.length) * 100) : 0}%"></i></div>
    <p class="muted small" style="padding-bottom:4px">${can(person, 'doer') ? 'Tick a step when it is done. ' : ''}${editor ? 'Tap a date to move it; the rest of the job can follow. Pin a promised date so nothing moves it.' : 'Faded means provisional.'}</p>
    ${std.map((s) => stepRow(s, d, std))}
    ${editor ? html`<details class="pop" style="margin-top:8px"><summary class="btn small">Edit all dates</summary>
      <form class="popbody" method="post" action="/jobs/${job.id}/dates">
        <span class="muted small">Change several dates at once. Tick Confirmed once a date matches Buildertrend. A single change with later steps goes to the Reschedule screen first.</span>
        ${std.map((s) => dateInputs(s, true, d.today))}
        <div class="acts" style="padding-top:12px;border-top:1px solid var(--line)"><button class="btn primary" type="submit">Save dates</button>
          <button class="btn" type="submit" name="confirm_all" value="1">Save and confirm all</button></div></form></details>
    <details class="pop"><summary class="btn small">Move the whole job</summary>
      <div class="popbody">
        <strong>Job slipped? Move every date at once</strong>
        <div class="shift">
          ${[[-1, '−1 day'], [1, '+1 day'], [5, '+1 week']].map(([n, l]) => html`<form method="post" action="/jobs/${job.id}/shift"><input type="hidden" name="n" value="${n}"><button class="btn" type="submit">${l}</button></form>`)}
        </div>
        <span class="muted small">Working days. Moves every step not yet done, skipping weekends, public holidays and blocked days. Pinned dates and rework keep their own dates.</span>
        <form method="post" action="/jobs/${job.id}/repropose"><button class="btn small" type="submit">Work out the provisional dates again from site start</button></form>
        <span class="muted small">Only changes steps that are neither done, confirmed nor pinned.</span>
      </div></details>` : ''}
  </section>

  ${editor ? tasksPanel(d, std.filter((s) => s.label)) : ''}
  ${reworkPanel(d, rw)}
  ${editor ? detailsPanel(job, d.templates) : html`<section class="panel"><h2>Notes</h2><p>${job.notes || 'No notes.'}</p></section>`}
  ${historyPanel(d.history, d.steps)}
</div>`;
}

/** Tasks for this job only (George, 6 Nov 2026): a name, an area, who does it and when. */
function tasksPanel(d: JobPageData, tasks: Step[]): Html {
  const back = `/jobs/${d.job.id}#tasks`;
  const areaSelect = (current: StepKind | null) => html`<select name="area" required>${current ? '' : html`<option value="">Pick an area</option>`}${TASK_AREAS.map((a) => html`<option value="${a.kind}"${current === a.kind ? html` selected` : ''}>${a.label}</option>`)}</select>`;
  const areaName = (k: StepKind) => TASK_AREAS.find((a) => a.kind === k)?.label ?? KINDS[k].label;
  return html`<section class="panel" id="tasks" style="gap:8px">
    <div class="row"><h2>Tasks for this job only</h2><span class="muted small">${tasks.length || 'None'}</span></div>
    <p class="muted small">Extra work just this job needs. It shows in its area's row on the board and moves with that area's step: Production with Production drawings, Factory with Cut, edge and assemble, Site with Install cabinets.</p>
    ${tasks.map((t) => html`<div class="item stack">
      <div><strong>${t.label}</strong> <span class="muted small">· ${areaName(t.kind)} · ${t.owner || KINDS[t.kind].owner} · ${t.start_date ? fmtRange(t.start_date, t.end_date) : 'no date yet'}${t.done_at ? ' · done' : ''}</span></div>
      <div class="acts">
        ${!t.done_at ? html`<a class="btn small" href="/jobs/${d.job.id}/reschedule?step=${t.id}">Move…</a>` : ''}
        <details class="pop"><summary class="btn small">Edit</summary>
          <form class="popbody" method="post" action="/steps/${t.id}/edit"><input type="hidden" name="back" value="${back}">
            <div class="fixgrid"><label class="f">Name<input name="label" required maxlength="80" value="${t.label}"></label>
            <label class="f">Area${areaSelect(t.kind)}</label>
            <label class="f">Who<input name="owner" maxlength="40" value="${t.owner}"></label></div>
            <div class="acts"><button class="btn primary" type="submit">Save</button></div></form></details>
        ${confirmDelete(`/steps/${t.id}/delete`, back, 'Delete', `Delete "${t.label}" from this job?`)}
      </div></div>`)}
    <details class="pop"${tasks.length ? '' : html` open`}><summary class="btn small">Add a task</summary>
      <form class="popbody" method="post" action="/jobs/${d.job.id}/tasks">
        <div class="fixgrid"><label class="f">What<input name="label" required maxlength="80" placeholder="e.g. Install painted doors"></label>
        <label class="f">Area${areaSelect(null)}</label>
        <label class="f">Who (blank for the usual)<input name="owner" maxlength="40" placeholder="e.g. Phil"></label>
        <label class="f">From<input type="date" name="start"></label><label class="f">To<input type="date" name="end"></label></div>
        <div class="acts"><button class="btn primary" type="submit">Add task</button></div></form></details>
  </section>`;
}

/** Which category (board row) a rework item sits in: required, so every item is filed (George, 6 Nov 2026). */
function reworkCategorySelect(current: StepKind | null | undefined): Html {
  return html`<select name="area" required>${current ? '' : html`<option value="">Pick a category</option>`}${REWORK_CATEGORIES.map((c) => html`<option value="${c.kind}"${current === c.kind ? html` selected` : ''}>${c.label}</option>`)}</select>`;
}

function reworkPanel(d: JobPageData, rwSteps: Step[]): Html {
  const editor = can(d.person, 'editor');
  const back = `/jobs/${d.job.id}#rework`;
  return html`<section class="panel lane-rework" id="rework" style="gap:8px">
    <div class="row"><h2 style="color:var(--rw)">Rework</h2><span class="muted small">${d.rework.filter((r) => !r.closed_on).length} open</span></div>
    ${!d.rework.length ? html`<p class="muted">No rework on this job.</p>` : ''}
    ${d.rework.map((r) => {
      const steps = rwSteps.filter((s) => s.rework_id === r.id);
      const undated = steps.filter((s) => (REWORK_ORDER as StepKind[]).includes(s.rework_area as StepKind) && !s.start_date && !s.done_at);
      return html`<div class="item stack">
        <div><strong>${r.cause ? cap(r.cause) : 'Cause not recorded'}</strong> · ${r.note}</div>
        <div class="muted small">Raised by ${r.raised_by_name ?? 'unknown'} on ${fmtLong(sydneyDate(r.raised_at))}${r.closed_on ? ` · closed ${fmtLong(r.closed_on)} · ${r.extra_hours ?? 0} extra hours · $${(r.extra_material_cost ?? 0).toFixed(2)} extra material` : ''}</div>
        ${editor ? html`<details class="pop"><summary class="btn small">Edit</summary>
          <form class="popbody" method="post" action="/rework/${r.id}/edit"><input type="hidden" name="back" value="${back}">
            <div class="fixgrid"><label class="f">Cause<select name="cause" required>${CAUSES.map((c) => html`<option value="${c}"${r.cause === c ? html` selected` : ''}>${cap(c)}</option>`)}</select></label>
            <label class="f">What happened<input name="note" required maxlength="200" value="${r.note}"></label></div>
            <div class="acts"><button class="btn primary" type="submit">Save</button></div></form></details>` : ''}
        ${steps.map((s) => html`${checkRow(s, d.person, back)}
          <div class="muted small" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-end">
            <span>${ROW_NAME[rowOf(s)] ?? ''}${s.hours ? ` · ${s.hours} h` : ''}${s.start_date ? '' : ' · no date yet'}</span>
            ${editor && !s.done_at && s.start_date ? html`<a class="btn small" href="/jobs/${d.job.id}/reschedule?step=${s.id}">Move…</a>` : ''}
            ${editor ? html`<details class="pop"><summary class="btn small">Edit</summary>
              <form class="popbody" method="post" action="/steps/${s.id}/edit"><input type="hidden" name="back" value="${back}">
                <div class="fixgrid"><label class="f">Name<input name="label" required maxlength="80" value="${stepLabel(s)}"></label>
                <label class="f">Who<input name="owner" maxlength="40" value="${s.owner}"></label>
                <label class="f">Category${reworkCategorySelect(s.rework_area)}</label>
                <label class="f">Hours (factory or install only)<input name="hours" inputmode="decimal" pattern="[0-9]+([.][0-9])?" value="${s.hours ?? ''}"></label></div>
                <div class="acts"><button class="btn primary" type="submit">Save</button></div></form></details>
              ${confirmDelete(`/steps/${s.id}/delete`, back, 'Remove', `Remove "${stepLabel(s)}" from this rework?`)}` : ''}
          </div>`)}
        ${steps.length ? '' : html`<span class="nodate small">No tasks yet</span>`}
        ${editor && !r.closed_on && undated.length ? html`<form class="inline" method="post" action="/rework/${r.id}/date"><input type="hidden" name="back" value="${back}">
            <label class="f" for="rwd-${r.id}">Date ${undated.length === 1 ? 'the task' : `the ${undated.length} tasks`} from<input type="date" id="rwd-${r.id}" name="start" required></label>
            <button class="btn primary" type="submit" style="align-self:flex-end">Set dates</button></form>` : ''}
        ${editor && !r.closed_on ? html`<details class="pop"><summary class="btn small">Add a rework item</summary>
          <form class="popbody" method="post" action="/rework/${r.id}/steps"><input type="hidden" name="back" value="${back}">
            <div class="fixgrid"><label class="f">What<input name="label" required maxlength="80" placeholder="e.g. Reorder 2 white boards"></label>
            <label class="f">Category${reworkCategorySelect(null)}</label>
            <label class="f">Hours (factory or install only)<input name="hours" inputmode="decimal" pattern="[0-9]+([.][0-9])?"></label>
            <label class="f">From<input type="date" name="start" required></label><label class="f">To<input type="date" name="end"></label></div>
            <span class="muted small">It shows in red in that category's row on the board, and goes to whoever usually does that step.</span>
            <div class="acts"><button class="btn primary" type="submit">Add item</button></div></form></details>
          <details class="pop"><summary class="btn small">Close this rework</summary>
          <form class="popbody" method="post" action="/rework/${r.id}/close"><input type="hidden" name="back" value="${back}">
            <div class="fixgrid"><label class="f">Cause<select name="cause" required>${CAUSES.map((c) => html`<option value="${c}"${r.cause === c ? html` selected` : ''}>${cap(c)}</option>`)}</select></label>
            <label class="f">Extra hours<input name="extra_hours" inputmode="decimal" required pattern="[0-9]+([.][0-9])?"></label>
            <label class="f">Extra material $<input name="extra_material_cost" inputmode="decimal" required pattern="[0-9]+([.][0-9]{1,2})?"></label></div>
            <div class="acts"><button class="btn primary" type="submit">Close rework</button></div></form></details>` : ''}
        ${d.person.is_owner ? responsibleBlock(r.id, d.responsible.get(r.id), back, d.peopleNames) : ''}
        ${editor ? confirmDelete(`/rework/${r.id}/delete`, back, 'Delete this rework', `Delete this rework and its ${steps.length} ${steps.length === 1 ? 'task' : 'tasks'}? Use this for rework raised by mistake. The change log keeps a record.`) : ''}
      </div>`;
    })}
    ${can(d.person, 'doer') ? raiseForm(d.job.id, back, undefined, d.person, d.peopleNames) : ''}
  </section>`;
}

/** People who don't sign in but can be responsible for a rework. */
const OTHERS = ['Installer', 'Lunastone', 'Supplier', 'Client'];

function peopleList(id: string, names: string[]): Html {
  return html`<datalist id="${id}">${[...names, ...OTHERS].map((n) => html`<option value="${n}"></option>`)}</datalist>`;
}

/** Owners only (George and Gus): who was responsible. Never rendered for anyone else. */
export function responsibleBlock(reworkId: number, r: Responsible | undefined, back: string, names: string[]): Html {
  const listId = `people-${reworkId}`;
  return html`<div class="owners small">
    <span class="tag">Owners only</span>
    ${r ? html`<strong>Responsible: ${r.responsible}</strong>${r.note ? ` · ${r.note}` : ''} <span class="muted">(set by ${r.set_by_name ?? 'an owner'})</span>` : html`<span class="muted">No one recorded as responsible.</span>`}
    <details class="pop"><summary class="btn small">${r ? 'Change' : 'Record who was responsible'}</summary>
      <form class="popbody" method="post" action="/rework/${reworkId}/responsible"><input type="hidden" name="back" value="${back}">
        <div class="fixgrid"><label class="f">Responsible<input name="responsible" list="${listId}" value="${r?.responsible ?? ''}" maxlength="80" placeholder="Pick or type a name"></label>
        <label class="f">Note<input name="responsible_note" value="${r?.note ?? ''}" maxlength="200"></label></div>
        ${peopleList(listId, names)}
        <span class="muted small">Only you and the other owner can see this. Leave the name empty and save to clear it.</span>
        <div class="acts"><button class="btn primary" type="submit">Save</button></div>
      </form></details>
  </div>`;
}

export function raiseForm(jobId: number | null, back: string, jobs?: { id: number; job_number?: string | null; client_name: string; suburb: string }[], person?: Person, names: string[] = []): Html {
  const editor = !!person && can(person, 'editor');
  const key = jobId ?? 'any';
  return html`<details class="pop"${jobId ? '' : html` open`}><summary class="btn">Raise rework</summary>
    <form class="popbody" method="post" action="/rework"><input type="hidden" name="back" value="${back}">
      ${jobId ? html`<input type="hidden" name="job_id" value="${jobId}">`
        : html`<label class="f">Job<select name="job_id" required><option value="">Pick a job</option>${(jobs ?? []).map((j) => html`<option value="${j.id}">${[j.job_number, j.client_name, j.suburb].filter(Boolean).join(' · ')}</option>`)}</select></label>`}
      <label class="f">Cause<select name="cause" required><option value="">Pick a cause</option>${CAUSES.map((c) => html`<option value="${c}">${cap(c)}</option>`)}</select></label>
      <label class="f">What happened (one line)<input name="note" required maxlength="200" placeholder="e.g. Sink cabinet must be rebuilt"></label>
      <fieldset class="stack rwtasks">
        <legend>What needs doing</legend>
        ${REWORK_AREAS.map((a) => html`<div class="rwtask"><label class="checkline"><input type="checkbox" name="task_${a.kind}" value="1"> ${a.label}</label>
          ${a.hours ? html`<label class="f hrs">Hours needed<input name="hours_${a.kind}" inputmode="decimal" pattern="[0-9]+([.][0-9])?" placeholder="e.g. 3" aria-label="${a.label}: hours needed"></label>` : ''}</div>`)}
        <span class="muted small">Each task shows in red in its row on the board: drawings with Production drawings, factory work and delivery with Factory, install with Install cabinets. Factory work and install need their hours, for the factory and install loads.</span>
      </fieldset>
      ${editor ? html`<label class="f">Starts (leave blank to date it later)<input type="date" name="start"></label>
        <span class="muted small">With a start date, the hub works out the rest in order: drawings, factory work the next working day, delivery the working day after, install the same day as delivery.</span>`
        : html`<span class="muted small">Christine dates the tasks.</span>`}
      ${person?.is_owner ? html`<div class="owners stack"><span class="tag">Owners only</span>
        <label class="f">Responsible<input name="responsible" list="people-new-${key}" maxlength="80" placeholder="Pick or type a name (optional)"></label>
        <label class="f">Note<input name="responsible_note" maxlength="200"></label>
        ${peopleList(`people-new-${key}`, names)}</div>` : ''}
      <div class="acts"><button class="btn primary" type="submit">Raise it</button></div>
    </form></details>`;
}

export function jobFields(j: Partial<FullJob> & { template?: string | null }, opts: { forNew?: boolean; templates?: Template[]; anchor?: AnchorKind; anchorDate?: string | null } = {}): Html {
  const v = (x: unknown) => (x === null || x === undefined ? '' : String(x));
  const templates = opts.templates ?? [];
  return html`<div class="formgrid">
    ${templates.length ? html`<label class="f wide">Job type<select name="template" data-template>
      ${opts.forNew ? '' : html`<option value="">Not set</option>`}
      ${templates.map((t) => html`<option value="${t.key}"${j.template === t.key ? html` selected` : ''} data-door="${t.door_finish}" data-painting="${t.has_painting ? '1' : '0'}" data-stone="${t.has_stone ? '1' : '0'}" data-factory="${t.factory_days}" data-install="${t.install_days}">${t.name}</option>`)}
      </select></label>` : ''}
    ${opts.forNew ? html`<label class="f">Work the dates out from<select name="anchor" data-anchor>
        ${ANCHORS.map((a) => html`<option value="${a.kind}"${(opts.anchor ?? 'site_start') === a.kind ? html` selected` : ''}>${a.label}</option>`)}
      </select></label>
      <label class="f">That date (not needed for Site start)<input type="date" name="anchor_date" value="${v(opts.anchorDate)}" data-anchordate></label>` : ''}
    <label class="f">Job number (Buildertrend)<input name="job_number" value="${v(j.job_number)}" inputmode="numeric" placeholder="e.g. 270201"${opts.forNew ? html` data-jobnumber` : ''}></label>
    <label class="f">Site start${opts.forNew ? ' (from the job number, or worked out)' : ''}<input type="date" name="site_start" value="${v(j.site_start)}"${opts.forNew ? html` data-sitestart` : ''}></label>
    <label class="f">Client name<input name="client_name" required value="${v(j.client_name)}"></label>
    <label class="f">Suburb<input name="suburb" value="${v(j.suburb)}"></label>
    <label class="f">Brand<select name="brand">${['Aalbor', 'Origin'].map((b) => html`<option${j.brand === b ? html` selected` : ''}>${b}</option>`)}</select></label>
    <label class="f">Door finish<select name="door_finish">
      <option value="melamine"${j.door_finish !== 'polyurethane' ? html` selected` : ''}>Melamine</option>
      <option value="polyurethane"${j.door_finish === 'polyurethane' ? html` selected` : ''}>Polyurethane</option></select></label>
    <label class="f">Factory days<input name="factory_days" type="number" min="1" max="30" required value="${v(j.factory_days ?? 2)}"></label>
    <label class="f">Install days<input name="install_days" type="number" min="1" max="30" required value="${v(j.install_days ?? 3)}"></label>
    <label class="checkline"><input type="checkbox" name="has_painting" value="1"${j.has_painting ? html` checked` : ''} data-painting> Painting needed (adds Doors to painting and Doors back)</label>
    <label class="checkline"><input type="checkbox" name="has_stone" value="1"${j.has_stone !== false ? html` checked` : ''}> Stone benchtops</label>
    ${opts.forNew ? '' : html`<label class="f">Status<select name="status">${Object.entries(STATUS).map(([k, l]) => html`<option value="${k}"${j.status === k ? html` selected` : ''}>${l}</option>`)}</select></label>
    <label class="checkline"><input type="checkbox" name="at_risk" value="1"${j.at_risk ? html` checked` : ''}> At risk</label>`}
    <label class="f wide">Drawings link (a Dropbox, OneDrive or Buildertrend folder)<input name="drawings_url" type="url" inputmode="url" value="${v(j.drawings_url)}" placeholder="https://…"></label>
    <label class="f wide">Rooms and scope<textarea name="scope">${v(j.scope)}</textarea></label>
    <label class="f wide">Notes<textarea name="notes">${v(j.notes)}</textarea></label>
    <p class="muted small wide">No phone numbers, emails or street addresses here. They stay in Buildertrend.</p>
  </div>`;
}

function detailsPanel(job: FullJob, templates: Template[]): Html {
  return html`<section class="panel"><details><summary style="cursor:pointer"><h2 style="display:inline">Job details</h2> <span class="muted small">Tap to edit</span></summary>
    <form method="post" action="/jobs/${job.id}/details" class="stack" style="padding-top:12px">
      ${jobFields(job, { templates })}
      <div class="acts"><button class="btn primary" type="submit">Save details</button></div>
      <span class="muted small">Ticking or unticking Painting or Stone adds or removes those steps. Steps already ticked done are kept.</span>
    </form>
    <div style="padding-top:16px;margin-top:12px;border-top:1px solid var(--line)">
      ${confirmDelete(`/jobs/${job.id}/delete`, '/jobs', 'Delete this job', `Delete ${job.client_name} and every date and rework on it? Use this only for a job added by mistake; for a finished or lost job, set Status instead. The change log keeps a record.`)}
    </div></details></section>`;
}

const FIELD_NAMES: Record<string, string> = {
  start_date: 'from', end_date: 'to', confirmed: 'confirmed', done_at: 'done', owner: 'owner', note: 'note', label: 'name',
  job_number: 'job number', template: 'job type', client_name: 'client', suburb: 'suburb', scope: 'scope', door_finish: 'door finish', has_painting: 'painting', has_stone: 'stone',
  site_start: 'site start', factory_days: 'factory days', install_days: 'install days', status: 'status', at_risk: 'at risk',
  rework_area: 'row', hours: 'hours',
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
    <div class="hist" style="padding-top:8px">${history.length ? history.map((e) => html`<div><time>${when(e.changed_at)}</time> · <strong>${e.person_name}</strong> · ${describe(e, stepName)}${e.suggestion_id ? html` <a class="muted small" href="/suggestions?status=all&amp;id=${e.suggestion_id}#s-${e.suggestion_id}">(suggestion #${e.suggestion_id})</a>` : ''}</div>`) : html`<div>No changes yet.</div>`}</div>
  </details></section>`;
}

/** Kinds the "Change dates" boxes and the dates form can set. */
export function isStepKind(k: string): k is StepKind {
  return k in KINDS;
}
