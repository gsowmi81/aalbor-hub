import { html, Html, raw } from '../web/html.js';
import { addDays, daysBetween, fmtShort, Iso, mondayOf } from '../domain/dates.js';
import { KINDS, StepKind } from '../domain/steps.js';
import { Decision, jobTitle, JobRow, lastDate, StepRow, stepLabel } from '../domain/checks.js';
import { brandSeg } from './comingUp.js';

const WEEKS = 8;
const N = WEEKS * 7;
/** Bottom lane holds the site end of the job, so markers don't sit on top of each other. */
const BOTTOM: StepKind[] = ['delivery', 'install', 'stone_measure', 'stone_install', 'rework'];
const SHOWN: StepKind[] = ['contract_drafting', 'check_measure', 'production_drawings', 'materials_in', 'factory', 'doors_to_painting', 'doors_back', 'delivery', 'install', 'stone_measure', 'stone_install', 'rework'];

const pct = (d: number) => `${((d / N) * 100).toFixed(3)}%`;

export function allJobs(d: { jobs: JobRow[]; steps: StepRow[]; decisions: Decision[]; today: Iso; brand: string; canMove: boolean }): Html {
  const start = addDays(mondayOf(d.today), -7);
  const end = addDays(start, N - 1);
  const live = d.jobs.filter((j) => j.status === 'live' && (d.brand === 'all' || j.brand === d.brand));
  const byJob = new Map<number, StepRow[]>();
  for (const s of d.steps) (byJob.get(s.job_id) ?? byJob.set(s.job_id, []).get(s.job_id)!).push(s);
  const installOf = (j: JobRow) => byJob.get(j.id)?.find((s) => s.kind === 'install')?.start_date ?? '9999';
  live.sort((a, b) => installOf(a).localeCompare(installOf(b)) || a.client_name.localeCompare(b.client_name));
  const firstIssue = new Map<number, string>();
  for (const x of d.decisions) if (x.jobId && !firstIssue.has(x.jobId)) firstIssue.set(x.jobId, x.fact);

  let bg = '';
  for (let w = 0; w < WEEKS; w++) bg += `<div class="we" style="left:${pct(w * 7 + 5)};width:${pct(2)}"></div><div class="gl" style="left:${pct(w * 7)}"></div>`;
  bg += `<div class="now" style="left:${pct(daysBetween(start, d.today) + 0.5)}"></div>`;

  const head = html`<div class="tl-row tl-head"><div class="tl-lab"><span class="eyebrow">Job</span></div><div class="tl-track">
    ${Array.from({ length: WEEKS }, (_, w) => html`<div class="wk" style="left:${pct(w * 7)};width:${pct(7)}">w/c ${fmtShort(addDays(start, w * 7)).slice(4)}</div>`)}
  </div></div>`;

  const rows = live.map((j) => {
    const marks = (byJob.get(j.id) ?? []).filter((s) => SHOWN.includes(s.kind) && s.start_date).map((s) => {
      const f = s.start_date!;
      const t = lastDate(s)!;
      if (t < start || f > end) return '';
      const cf = f < start ? start : f;
      const ct = t > end ? end : t;
      const over = !s.done_at && t < d.today;
      let lab = KINDS[s.kind].code;
      if (t > end) lab += ' →';
      if (f < start) lab = '← ' + lab;
      if (over) lab = '! ' + lab;
      const cls = ['mk', over ? 'over' : s.done_at ? 'done' : s.confirmed ? '' : 'prov'].filter(Boolean).join(' ');
      const top = BOTTOM.includes(s.kind) ? 25 : 5;
      const z = s.kind === 'stone_measure' || s.kind === 'stone_install' || s.kind === 'delivery' ? 3 : 2;
      const title = `${stepLabel(s)} ${fmtShort(f)}${s.end_date ? ` to ${fmtShort(s.end_date)}` : ''}${s.confirmed ? '' : ' (provisional)'}${s.done_at ? ', done' : ''}`;
      // Editors drag a bar to move it (mouse), or tap it (phone): both open the Reschedule screen.
      const movable = d.canMove && !s.done_at && s.kind !== 'rework';
      const drag = movable
        ? html` data-step="${s.id}" data-job="${s.job_id}" data-start="${f}" tabindex="0" role="button" aria-label="Move ${stepLabel(s)}, ${title}"`
        : '';
      return html`<div class="${cls}${movable ? ' drag' : ''}" title="${title}${movable ? '. Drag to move, or tap.' : ''}" style="top:${top}px;left:${pct(daysBetween(start, cf))};width:${pct(daysBetween(cf, ct) + 1)};background:var(--m-${KINDS[s.kind].code.toLowerCase()});z-index:${z}"${drag}>${lab}</div>`;
    });
    const issue = firstIssue.get(j.id);
    const none = !(byJob.get(j.id) ?? []).some((s) => s.start_date);
    return html`<div class="tl-row"><div class="tl-lab">
        <div class="n"><span class="no">${j.job_number ?? '—'}</span><a href="/jobs/${j.id}">${j.client_name}</a>${j.at_risk ? html`<span class="risk">at risk</span>` : ''}</div>
        <div class="note${issue ? ' warn' : ''}" title="${issue ?? j.suburb}">${issue ?? j.suburb}</div>
      </div><div class="tl-track">${raw(bg)}${marks}${none ? html`<div class="muted" style="position:absolute;left:8px;top:14px;font-size:13px;z-index:2">No dates</div>` : ''}</div></div>`;
  });

  const legend = html`<div class="legend">
    ${SHOWN.map((k) =>
      html`<span><i class="mk" style="background:var(--m-${KINDS[k].code.toLowerCase()})">${KINDS[k].code}</i>${KINDS[k].label}</span>`)}
    <span><i class="mk prov" style="background:var(--m-in)">IN</i>Provisional</span>
    <span><i class="mk over">!</i>Overdue</span><span><i class="mk done">IN</i>Done</span>
  </div>`;

  return html`<div class="row"><div class="muted">Every live job from ${fmtShort(start)} to ${fmtShort(end)}, sorted by install. Tap a job name to open it. Orange means a date has passed and nobody ticked it. Scroll sideways on a phone.${d.canMove ? ' Drag a bar to move it, or tap it to pick a date; the next screen shows what happens to the rest of the job before anything saves.' : ''}</div>${brandSeg('/jobs', d.brand)}</div>
  ${legend}
  <div class="tl-box"><div class="tl" data-days="${N}">${head}${rows}</div></div>`;
}
