// Pipeline (George, 7 Nov 2026): every live job as a row, the stages as columns, one coloured
// cell each. Jobman's progress chart. Answers "where is every job" in one look.
import { html, Html } from '../web/html.js';
import { addDays, fmtShort, Iso, mondayOf } from '../domain/dates.js';
import { currentStage, jobTitle, JobRow, ReworkRow, STAGES, stageCells, StageState, StepRow } from '../domain/checks.js';
import { brandSeg } from './comingUp.js';

const STATE_LABEL: Record<StageState, string> = { done: 'Done', overdue: 'Overdue', now: 'This week', later: 'Later', undated: 'No date', skipped: 'Not recorded', na: 'Not on this job' };

export function pipelinePage(d: { jobs: JobRow[]; steps: StepRow[]; rework: ReworkRow[]; today: Iso; brand: string; ready?: Map<number, { state: string; expected: string | null; factoryDate: string | null }> }): Html {
  const mon = mondayOf(d.today);
  const sun = addDays(mon, 6);
  const live = d.jobs.filter((j) => j.status === 'live' && (d.brand === 'all' || j.brand === d.brand));
  const byJob = new Map<number, StepRow[]>();
  for (const s of d.steps) (byJob.get(s.job_id) ?? byJob.set(s.job_id, []).get(s.job_id)!).push(s);
  const openRework = new Map<number, number>();
  for (const r of d.rework) if (!r.closed_on) openRework.set(r.job_id, (openRework.get(r.job_id) ?? 0) + 1);
  const rows = live.map((j) => {
    const steps = byJob.get(j.id) ?? [];
    const cells = stageCells(steps, mon, sun, d.today);
    const install = steps.find((s) => s.kind === 'install' && !s.label)?.start_date ?? '9999';
    return { j, cells, current: currentStage(cells), install, rework: openRework.get(j.id) ?? 0 };
  }).sort((a, b) => a.install.localeCompare(b.install) || a.j.client_name.localeCompare(b.j.client_name));
  const atStage = (key: string) => rows.filter((r) => r.current?.key === key).length;
  const undated = rows.filter((r) => r.cells.every((c) => c.state === 'na' || c.state === 'skipped' || !c.step?.start_date)).length;

  return html`<div class="row"><div class="muted">Every live job, one row each, soonest install first. The dark outline is the stage the job is at: the first one not ticked done. Tap a cell to open that step.</div>${brandSeg('/pipeline', d.brand)}</div>
  <div class="legend">
    ${(['done', 'now', 'later', 'overdue', 'undated', 'skipped', 'na'] as StageState[]).map((s) => html`<span><i class="pc st-${s}"></i>${STATE_LABEL[s]}</span>`)}
    <span><i class="pc st-later" style="outline:2px solid var(--fg);outline-offset:-2px"></i>Current stage</span>
    <span><i class="pc rdy-short" style="position:relative"><i class="rdy"></i></i>Materials short</span><span><i class="pc rdy-ready" style="position:relative"><i class="rdy"></i></i>Materials ready</span>
  </div>
  <div class="tl-box"><table class="pipe">
    <thead><tr><th class="pj">Job</th>${STAGES.map((st) => html`<th title="${st.label}">${st.short}<span class="muted small" style="display:block;font-weight:400">${atStage(st.key) || ''}</span></th>`)}<th>Rework</th></tr></thead>
    <tbody>${rows.map((r) => html`<tr>
      <td class="pj"><div class="n"><span class="no">${r.j.job_number ?? '—'}</span><a href="/jobs/${r.j.id}">${r.j.client_name}</a>${r.j.at_risk ? html`<span class="risk">at risk</span>` : ''}</div>
        <div class="note">${r.j.suburb}${r.current ? ` · ${STAGES.find((s) => s.key === r.current!.key)!.label}` : ' · Complete'}</div></td>
      ${r.cells.map((c) => {
        const cur = r.current?.key === c.key;
        const when = c.step?.start_date ? fmtShort(c.step.start_date).slice(4) : c.state === 'na' ? '' : c.state === 'done' ? '✓' : c.state === 'skipped' ? '–' : '?';
        const title = `${STAGES.find((s) => s.key === c.key)!.label}: ${STATE_LABEL[c.state]}${c.step?.start_date ? `, ${fmtShort(c.step.start_date)}` : ''}${c.pinned ? ', pinned' : ''}`;
        const rd = c.key === 'materials' ? d.ready?.get(r.j.id) : undefined;
        const late = rd?.state === 'waiting' && rd.expected && rd.factoryDate && rd.expected > rd.factoryDate;
        const rdCls = rd && rd.state !== 'none' ? ` rdy-${late ? 'short' : rd.state}` : '';
        const rdTitle = rd && rd.state !== 'none' ? `. Materials ${rd.state === 'ready' ? 'ready' : late ? 'on order for after the factory date' : rd.state === 'waiting' ? 'on order' : 'short'}` : '';
        const inner = html`${when}${c.pinned ? html` <span aria-label="pinned">📌</span>` : ''}${rdCls ? html`<i class="rdy" aria-hidden="true"></i>` : ''}`;
        return html`<td class="pc st-${c.state}${cur ? ' cur' : ''}${rdCls}" title="${title}${rdTitle}">${c.step ? html`<a href="/jobs/${r.j.id}#s-${c.step.id}" aria-label="${title}${rdTitle}">${inner}</a>` : inner}</td>`;
      })}
      <td class="pc ${r.rework ? 'st-overdue' : 'st-na'}">${r.rework ? html`<a href="/jobs/${r.j.id}#rework">${r.rework} open</a>` : ''}</td>
    </tr>`)}
    ${!rows.length ? html`<tr><td colspan="${STAGES.length + 2}" class="muted">No live jobs.</td></tr>` : ''}</tbody>
  </table></div>
  ${undated ? html`<p class="muted small">${undated} ${undated === 1 ? 'job has' : 'jobs have'} no dates at all.</p>` : ''}`;
}

export { jobTitle };
