// The overdue and needs-a-decision items, shared by Attention and the job screen.
import { html, Html } from '../web/html.js';
import { addDays, daysBetween, fmtShort, Iso } from '../domain/dates.js';
import { KINDS } from '../domain/steps.js';
import { Decision, JobRow, lastDate, StepRow, stepLabel } from '../domain/checks.js';
import { can, Person } from '../web/auth.js';

export interface StoredDecision {
  key: string;
  fingerprint: string;
  note: string;
  decided_at: string;
  decided_by_name: string | null;
}

export interface ItemContext {
  person: Person;
  today: Iso;
  jobById: Map<number, JobRow>;
  /** Where the form sends people back to. */
  back: string;
}

/** One overdue step: who, how late, Done, New date. */
export function overdueItem(s: StepRow, c: ItemContext, showJob = true): Html {
  const j = c.jobById.get(s.job_id)!;
  const due = lastDate(s)!;
  const late = daysBetween(due, c.today);
  return html`<div class="item" id="o-${s.id}">
    <div class="what"><div>${showJob ? html`<a href="/jobs/${j.id}#s-${s.id}" style="color:inherit">${j.client_name}</a> · ` : ''}${stepLabel(s)}</div>
      <div class="muted small">${s.owner || KINDS[s.kind].owner} · was due ${fmtShort(due)}</div></div>
    <span class="late">${late} ${late === 1 ? 'day' : 'days'} late</span>
    ${can(c.person, 'doer') ? html`<form method="post" action="/steps/${s.id}/done"><input type="hidden" name="done" value="1"><input type="hidden" name="back" value="${c.back}"><button class="btn" type="submit">Done</button></form>` : ''}
    ${can(c.person, 'editor') ? html`<details class="pop" style="display:contents"><summary class="btn">New date</summary>
      <form class="popbody" method="get" action="/jobs/${j.id}/reschedule" style="flex-basis:100%">
        <input type="hidden" name="step" value="${s.id}">
        <div class="inline"><label class="f" for="nd-${s.id}">Move to<input type="date" id="nd-${s.id}" name="start" value="${addDays(c.today, 1)}" min="${c.today}" required></label>
        <button class="btn primary" type="submit" style="align-self:flex-end">Next</button></div>
        <span class="muted small">Next shows what happens to the rest of the job before anything saves.</span>
      </form></details>` : ''}
  </div>`;
}

export const tick = html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;color:var(--meas)"><path d="M5 12l5 5L20 7"></path></svg>`;

export function decisionFields(x: Decision): Html {
  return html`<div class="fixgrid">${x.fields.map((f) => {
    if (f.kind === 'site_start') {
      return html`<label class="f">Site start<input type="date" name="site_start_${x.jobId}" value="${f.start ?? ''}"></label>`;
    }
    if (f.range) {
      return html`<label class="f">${f.label} from<input type="date" name="start_${f.stepId}" value="${f.start ?? ''}"></label>
        <label class="f">${f.label} to<input type="date" name="end_${f.stepId}" value="${f.end ?? ''}"></label>`;
    }
    return html`<label class="f">${f.label}<input type="date" name="start_${f.stepId}" value="${f.start ?? ''}"></label>`;
  })}</div>`;
}

/** One thing to decide: the fact, the ask, OK as is, Change dates. */
export function decisionItem(x: Decision, c: ItemContext, showJob = true): Html {
  const editor = can(c.person, 'editor');
  return html`<div class="item stack">
    ${showJob ? html`<div style="font-weight:600">${x.jobId ? html`<a href="/jobs/${x.jobId}" style="color:inherit">${x.title}</a>` : x.title}</div>` : ''}
    <div>${x.fact}</div>
    <div class="ask">${x.ask}</div>
    ${editor ? html`<div class="acts">
      <form method="post" action="/decisions/ok"><input type="hidden" name="key" value="${x.key}"><input type="hidden" name="fingerprint" value="${x.fingerprint}"><input type="hidden" name="note" value="${x.okText}"><input type="hidden" name="back" value="${c.back}"><button class="btn" type="submit">OK as is</button></form>
      ${x.fields.length ? html`<details class="pop" style="display:contents"><summary class="btn">Change dates</summary>
        <form class="popbody" method="post" action="/decisions/fix"><input type="hidden" name="back" value="${c.back}">
          ${decisionFields(x)}
          <div class="acts"><button class="btn primary" type="submit">Save</button></div></form></details>`
        : x.jobId && showJob ? html`<a class="btn" href="/jobs/${x.jobId}">Open the job</a>` : ''}
    </div>` : ''}
  </div>`;
}

/** A decision someone has already OK'd, with Undo. */
export function decidedItem(x: Decision, s: StoredDecision, c: ItemContext): Html {
  const editor = can(c.person, 'editor');
  return html`<div class="item" style="gap:8px">${tick}<span style="flex:1 1 180px;min-width:0"><strong>${x.title}</strong> · ${s.note}${s.decided_by_name ? html` <span class="muted small">(${s.decided_by_name})</span>` : ''}</span>
    ${editor ? html`<form method="post" action="/decisions/undo"><input type="hidden" name="key" value="${x.key}"><input type="hidden" name="back" value="${c.back}"><button class="btn small" type="submit">Undo</button></form>` : ''}</div>`;
}
