import { html, Html } from '../web/html.js';
import { Calendar, fmtRange, fmtShort, Iso } from '../domain/dates.js';
import { FLOW, KINDS } from '../domain/steps.js';
import { descendants, Mode, PlanRow, Violation } from '../domain/schedule.js';
import { jobTitle, JobRow } from '../domain/checks.js';

export interface RescheduleData {
  job: JobRow;
  rows: (PlanRow & { owner: string })[];
  /** The plan as it would be after saving. */
  next: (PlanRow & { owner: string })[];
  moved: PlanRow;
  newStart: Iso;
  newEnd: Iso | null;
  mode: Mode;
  violations: Violation[];
  cal: Calendar;
  error?: string;
}

const label = (r: PlanRow) => r.label || KINDS[r.kind].label;
const order = (r: PlanRow) => (r.kind === 'rework' ? 999 : FLOW.indexOf(r.kind) * 2 + (r.label ? 1 : 0));

/** Can this move keep the install date? Only when install comes after the moved step. */
export function canSqueeze(moved: PlanRow, rows: PlanRow[]): boolean {
  return !moved.label && moved.kind !== 'rework' && descendants(moved.kind).has('install')
    && rows.some((r) => r.kind === 'install' && !r.label && r.start_date && !r.done);
}

export function reschedulePage(d: RescheduleData): Html {
  const k = KINDS[d.moved.kind];
  const squeezeOk = canSqueeze(d.moved, d.rows);
  const install = d.rows.find((r) => r.kind === 'install' && !r.label);
  const before = new Map(d.rows.map((r) => [r.id, r]));
  const hard = d.violations.filter((v) => v.dep.hard);
  const soft = d.violations.filter((v) => !v.dep.hard);
  const problem = new Map<number, string>();
  for (const v of d.violations) {
    problem.set(v.succ.id, `${v.dep.hard ? "Can't" : 'Normally doesn\'t'} start before ${fmtShort(v.earliest)}: waits for ${label(v.pred)}`);
  }
  const base = `/jobs/${d.job.id}/reschedule`;
  const modes: [Mode, string, string][] = [
    ['shift', 'Move everything after it', 'Every later step moves by the same number of working days.'],
    ['squeeze', 'Keep the install date', install?.start_date ? `Install stays on ${fmtShort(install.start_date)}; the steps in between use up their spare days first.` : 'Needs an install date.'],
    ['only', 'Only this step', 'Nothing else moves. Any clash goes to Needs a decision.'],
  ];
  const rows = [...d.next].sort((a, b) => order(a) - order(b));
  const changedCount = rows.filter((r) => {
    const b = before.get(r.id)!;
    return b.start_date !== r.start_date || b.end_date !== r.end_date;
  }).length;

  return html`<div class="job">
    <p><a href="/jobs/${d.job.id}">← ${jobTitle(d.job)}</a></p>
    ${d.error ? html`<div class="notice bad">${d.error}</div>` : ''}

    <form method="get" action="${base}" class="panel">
      <input type="hidden" name="step" value="${d.moved.id}">
      <h2>Move ${label(d.moved)}</h2>
      <p class="muted small">Now ${fmtRange(before.get(d.moved.id)!.start_date, before.get(d.moved.id)!.end_date)}. Pick the new date, then choose what happens to the rest of the job.</p>
      <div class="fixgrid">
        <label class="f">${k.range ? 'From' : 'New date'}<input type="date" name="start" value="${d.newStart}" required></label>
        ${k.range ? html`<label class="f">To (blank keeps its length)<input type="date" name="end" value="${d.newEnd ?? ''}"></label>` : ''}
      </div>
      <fieldset class="stack" style="border:0;padding:0;margin:0">
        <legend class="small" style="font-weight:600;margin-bottom:4px">The rest of the job</legend>
        ${modes.map(([m, t, sub]) => {
          const disabled = m === 'squeeze' && !squeezeOk;
          return html`<label class="checkline" style="align-items:flex-start;font-weight:400${disabled ? ';opacity:.5' : ''}">
            <input type="radio" name="mode" value="${m}"${d.mode === m ? html` checked` : ''}${disabled ? html` disabled` : ''} style="margin-top:3px">
            <span><strong>${t}</strong>${m === 'shift' ? ' (suggested)' : ''}<br><span class="muted small">${disabled ? 'Install doesn\'t come after this step, or has no date.' : sub}</span></span></label>`;
        })}
      </fieldset>
      <div class="acts"><button class="btn" type="submit">Work it out</button></div>
    </form>

    <form method="post" action="${base}" class="panel" style="gap:2px">
      <input type="hidden" name="step" value="${d.moved.id}">
      <input type="hidden" name="mode" value="${d.mode}">
      <div class="row"><h2>New dates</h2><span class="muted small">${changedCount} ${changedCount === 1 ? 'step changes' : 'steps change'}</span></div>
      <p class="muted small" style="padding-bottom:6px">Change any date below before saving. Dates that move become provisional, so they can be checked against Buildertrend.</p>
      ${rows.map((r) => {
        const b = before.get(r.id)!;
        const changed = b.start_date !== r.start_date || b.end_date !== r.end_date;
        const why = problem.get(r.id);
        const isHard = hard.some((v) => v.succ.id === r.id);
        if (r.done) {
          return html`<div class="field"><div class="ftop"><strong>${label(r)}</strong><span class="muted small">Done</span></div>
            <div class="nice"><span>${fmtRange(r.start_date, r.end_date)}</span></div></div>`;
        }
        return html`<div class="field"${isHard ? html` style="border-left:3px solid var(--over);padding-left:8px"` : ''}>
          <div class="ftop"><label for="r-${r.id}">${label(r)}</label><span class="muted small">${r.owner || KINDS[r.kind].owner}</span></div>
          ${KINDS[r.kind].range
            ? html`<div class="pair"><input id="r-${r.id}" type="date" name="start_${r.id}" value="${r.start_date ?? ''}" aria-label="${label(r)} from"><input type="date" name="end_${r.id}" value="${r.end_date ?? ''}" aria-label="${label(r)} to"></div>`
            : html`<input id="r-${r.id}" type="date" name="start_${r.id}" value="${r.start_date ?? ''}">`}
          <div class="nice"><span>${changed ? html`<strong>${fmtRange(b.start_date, b.end_date)} → ${fmtRange(r.start_date, r.end_date)}</strong>` : 'Unchanged'}${changed && b.confirmed ? ' · was confirmed, becomes provisional' : ''}</span></div>
          ${why ? html`<div class="small" style="color:${isHard ? 'var(--over)' : 'var(--warn-fg)'};font-weight:600">${why}</div>` : ''}
        </div>`;
      })}
      <div style="display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:1px solid var(--line)">
        ${hard.length ? html`<div class="notice bad">${hard.length} ${hard.length === 1 ? 'step is' : 'steps are'} before something ${hard.length === 1 ? 'it waits' : 'they wait'} for. Change ${hard.length === 1 ? 'it' : 'them'} above, or Move anyway: the job will show in Needs a decision until it's fixed or OK'd.</div>` : ''}
        ${soft.length && !hard.length ? html`<p class="small" style="color:var(--warn-fg)">Materials are ordered before drawings are signed off. That's allowed.</p>` : ''}
        <div class="acts">
          ${hard.length
            ? html`<button class="btn danger" type="submit" name="override" value="1">Move anyway</button>`
            : html`<button class="btn primary" type="submit">Save ${changedCount} ${changedCount === 1 ? 'change' : 'changes'}</button>`}
          <button class="btn" type="submit" name="recheck" value="1">Check my changes</button>
          <a class="btn" href="/jobs/${d.job.id}">Cancel</a>
        </div>
      </div>
    </form>
  </div>`;
}
