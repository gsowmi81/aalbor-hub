// Flag a problem (George, 7 Nov 2026): Jobman's job alert. A type with someone responsible, one
// line, photos. Shown on Attention, the job and My day.
import { html, Html } from '../web/html.js';
import { fmtLong, sydneyDate } from '../domain/dates.js';
import { KINDS, StepKind } from '../domain/steps.js';
import type { IssueRow, IssueType } from '../db/queries.js';
import { can, Person } from '../web/auth.js';

/** The form, in a details box. Multipart, so photos come along; the page shrinks them first. */
export function flagForm(opts: { jobId: number; stepId?: number | null; types: IssueType[]; back: string; label?: string; open?: boolean }): Html {
  const id = `flag-${opts.jobId}-${opts.stepId ?? 'job'}`;
  return html`<details class="pop flag"${opts.open ? html` open` : ''}><summary class="btn small">${opts.label ?? 'Flag a problem'}</summary>
    <form class="popbody" method="post" action="/issues" enctype="multipart/form-data" data-photos>
      <input type="hidden" name="job_id" value="${opts.jobId}">${opts.stepId ? html`<input type="hidden" name="step_id" value="${opts.stepId}">` : ''}
      <input type="hidden" name="back" value="${opts.back}">
      <div class="fixgrid">
        <label class="f">What's wrong<select name="type" required><option value="">Pick one</option>${opts.types.filter((t) => t.active).map((t) => html`<option value="${t.key}">${t.label}${t.responsible_name ? ` (${t.responsible_name})` : ''}</option>`)}</select></label>
        <label class="f">One line<input name="note" required maxlength="300" placeholder="e.g. Short 2 sheets of Classic White" id="${id}-note"></label>
      </div>
      <label class="f">Photos (up to 4)<input type="file" name="photo" accept="image/*" capture="environment" multiple></label>
      <span class="muted small">It goes to whoever looks after that kind of problem, and to George and Christine, and shows on Attention until it's fixed.</span>
      <div class="acts"><button class="btn primary" type="submit">Send the flag</button></div>
    </form></details>`;
}

const STATUS: Record<IssueRow['status'], string> = { open: 'Open', looking: 'Looking at it', fixed: 'Fixed' };

/** Who may move a flag along: Editors, the person responsible for its type, and whoever raised it. */
export function canAct(i: IssueRow, p: Person): boolean {
  return can(p, 'editor') || i.responsible === p.id || i.raised_by === p.id;
}

export function issueItem(i: IssueRow, person: Person, back: string, showJob = true): Html {
  const act = canAct(i, person) && i.status !== 'fixed';
  const step = i.step_label || (i.step_kind ? KINDS[i.step_kind as StepKind]?.label : '');
  return html`<div class="item stack issue st-${i.status}" id="i-${i.id}">
    <div class="row" style="align-items:flex-start">
      <div><span class="spill ${i.status === 'fixed' ? 'done' : 'over'}">${STATUS[i.status]}</span> <strong>${i.type_label}</strong>${i.responsible_name ? html` <span class="muted small">· ${i.responsible_name} looks after these</span>` : ''}</div>
      <span class="muted small">${i.raised_by_name ?? 'Unknown'} · ${fmtLong(sydneyDate(i.raised_at))}</span>
    </div>
    <div>${showJob ? html`<a href="/jobs/${i.job_id}${i.step_id ? `#s-${i.step_id}` : ''}" style="color:inherit;font-weight:600">${i.client_name}${i.suburb ? ` · ${i.suburb}` : ''}</a>${step ? ` · ${step}` : ''}: ` : step ? html`<span class="muted">${step}: </span>` : ''}${i.note}</div>
    ${i.photo_ids.length ? html`<div class="photos">${i.photo_ids.map((pid) => html`<a href="/issues/${i.id}/photos/${pid}" target="_blank" rel="noopener"><img src="/issues/${i.id}/photos/${pid}" alt="Photo on the flag" loading="lazy"></a>`)}</div>` : ''}
    ${i.status === 'fixed' ? html`<div class="muted small">Fixed by ${i.closed_by_name ?? 'someone'}${i.closed_at ? ` on ${fmtLong(sydneyDate(i.closed_at))}` : ''}${i.close_note ? `: ${i.close_note}` : ''}${i.rework_id ? html` · <a href="/jobs/${i.job_id}#rework">rework raised</a>` : ''}</div>` : ''}
    ${act ? html`<div class="acts">
      ${i.status === 'open' ? html`<form method="post" action="/issues/${i.id}/status"><input type="hidden" name="status" value="looking"><input type="hidden" name="back" value="${back}"><button class="btn small" type="submit">Looking at it</button></form>` : ''}
      <details class="pop" style="display:contents"><summary class="btn small primary">Fixed</summary>
        <form class="popbody" method="post" action="/issues/${i.id}/status"><input type="hidden" name="status" value="fixed"><input type="hidden" name="back" value="${back}">
          <label class="f">What was done (optional)<input name="note" maxlength="300"></label>
          <div class="acts"><button class="btn primary small" type="submit">Mark fixed</button></div></form></details>
      ${can(person, 'editor') && !i.rework_id ? html`<a class="btn small" href="/jobs/${i.job_id}?flag=${i.id}#rework">Raise rework for this</a>` : ''}
    </div>` : ''}
  </div>`;
}

/** The job's panel: open flags, then the form. */
export function issuesPanel(d: { jobId: number; issues: IssueRow[]; person: Person; types: IssueType[]; back: string }): Html {
  const open = d.issues.filter((i) => i.status !== 'fixed');
  const fixed = d.issues.filter((i) => i.status === 'fixed').slice(0, 5);
  return html`<section class="panel" id="flags" style="gap:8px">
    <div class="row"><h2>Flagged problems</h2><span class="muted small">${open.length ? `${open.length} open` : 'None open'}</span></div>
    ${open.map((i) => issueItem(i, d.person, d.back, false))}
    ${fixed.length ? html`<details><summary class="muted small" style="cursor:pointer">${fixed.length} fixed</summary>${fixed.map((i) => issueItem(i, d.person, d.back, false))}</details>` : ''}
    ${can(d.person, 'doer') ? flagForm({ jobId: d.jobId, types: d.types, back: d.back }) : ''}
  </section>`;
}
