import { guide } from './guide.js';
import { html, Html } from '../web/html.js';
import { addDays, Calendar, daysBetween, fmtShort, Iso, mondayOf, sydneyDate } from '../domain/dates.js';
import { BOARD_ROWS, BoardRow, KINDS, rowOf } from '../domain/steps.js';
import { CapacityWarning, Decision, jobTitle, JobRow, lastDate, planRow, ReworkRow, StepRow, stepLabel } from '../domain/checks.js';
import { canSqueeze } from './reschedule.js';
import { can, Person } from '../web/auth.js';

import { StoredDecision } from './items.js';
export type { StoredDecision };

export interface ComingUpData {
  person: Person;
  today: Iso;
  week: number;
  brand: string;
  jobs: JobRow[];
  steps: StepRow[];
  rework: ReworkRow[];
  overdue: StepRow[];
  decisions: Decision[];
  stored: Map<string, StoredDecision>;
  capacity: CapacityWarning[];
  cal: Calendar;
  suggestionsPanel?: Html;
  /** One line from the office (Settings), shown above the board (George, 7 Nov 2026). */
  message?: string;
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

export function legend(): Html {
  return html`<div class="legend">
    ${BOARD_ROWS.map((r) => html`<span><i class="sw lane-${r.row}"></i>${r.label}</span>`)}
    <span><i class="sw prov"></i>Provisional date</span>
  </div>`;
}

export function brandSeg(base: string, brand: string, extra = ''): Html {
  const opts = [['all', 'All'], ['Aalbor', 'Aalbor'], ['Origin', 'Origin']];
  return html`<div class="seg" role="group" aria-label="Brand">${opts.map(([v, l]) =>
    html`<a href="${base}?brand=${v}${extra}"${brand === v ? html` aria-current="true"` : ''}>${l}</a>`)}</div>`;
}

/**
 * What the drag box needs to know about a card: its name, and whether "Keep the install date"
 * applies (only when install comes after it and has a date).
 */
export function dragData(s: StepRow, job: JobRow, jobSteps: StepRow[]): Html {
  const squeeze = canSqueeze(planRow(s), jobSteps.map(planRow));
  return html` data-step="${s.id}" data-job="${job.id}" data-label="${jobTitle(job)} · ${stepLabel(s)}" data-was="${s.start_date ?? ''}"${squeeze ? html` data-squeeze="1"` : ''}`;
}

function chip(s: StepRow, job: JobRow, opts: { prefix?: string; suffix?: string; style?: string; today: Iso; movable?: boolean; jobSteps?: StepRow[] }): Html {
  const label = `${opts.prefix ?? ''}${stepLabel(s)}${opts.suffix ?? ''}`;
  const over = !s.done_at && lastDate(s)! < opts.today;
  // Editors drag a card sideways to another day (George, 31 Oct 2026); a tap still opens the job.
  const movable = !!opts.movable && !s.done_at && !!s.start_date;
  // Rework tasks sit in their category's row, drawn red (George, 6 Nov 2026).
  const rw = s.kind === 'rework';
  const cls = ['chip', `lane-${rowOf(s)}`, rw ? 'rw' : '', s.confirmed ? '' : 'prov', s.done_at ? 'done' : '', movable ? 'drag' : ''].filter(Boolean).join(' ');
  const drag = movable ? html`${dragData(s, job, opts.jobSteps ?? [])} draggable="false"` : '';
  return html`<a class="${cls}" href="/jobs/${job.id}${rw ? '#rework' : ''}"${opts.style ? html` style="${opts.style}"` : ''}${drag} title="${rw ? 'Rework. ' : ''}${s.confirmed ? 'Confirmed' : 'Provisional'}${s.done_at ? ', done' : ''}${movable ? '. Drag sideways to move it to another day.' : ''}">
    <strong>${jobTitle(job)}</strong><span>${label}</span><span>${s.owner || KINDS[s.kind].owner}${over ? html` · <span class="flag">Overdue</span>` : ''}${s.done_at ? ' · Done' : ''}</span></a>`;
}

function reworkCard(r: ReworkRow, job: JobRow, span: boolean): Html {
  return html`<a class="chip lane-rework" href="/jobs/${job.id}#rework"${span ? html` style="grid-column:1 / 6"` : ''}>
    <strong>${jobTitle(job)}</strong><span>${r.note}</span>
    <span style="color:var(--rw);font-weight:600">${r.raised_by_name ? `Raised by ${r.raised_by_name}` : 'Raised'} ${fmtShort(sydneyDate(r.raised_at))} · no dates yet</span></a>`;
}

export function comingUp(d: ComingUpData): Html {
  const jobById = new Map(d.jobs.map((j) => [j.id, j]));
  const editor = can(d.person, 'editor');
  const liveJobs = d.jobs.filter((j) => j.status === 'live' && (d.brand === 'all' || j.brand === d.brand));
  const live = new Set(liveJobs.map((j) => j.id));
  const mon = addDays(mondayOf(d.today), d.week * 7);
  const fri = addDays(mon, 4);
  const sun = addDays(mon, 6);
  const inWeek = d.steps.filter((s) => s.start_date && live.has(s.job_id) && s.start_date <= sun && lastDate(s)! >= mon);
  const col = (x: Iso) => Math.min(Math.max(daysBetween(mon, x), 0), 4);
  const byJob = new Map<number, StepRow[]>();
  for (const s of d.steps) (byJob.get(s.job_id) ?? byJob.set(s.job_id, []).get(s.job_id)!).push(s);
  const undatedRework = d.rework.filter((r) => !r.closed_on && live.has(r.job_id) && !d.steps.some((s) => s.rework_id === r.id && s.start_date));

  // Summary tile: jobs in each step this week.
  const groups: [string, BoardRow, BoardRow[], string][] = [
    ['Draft', 'drawings', ['contract', 'drawings'], 'Drafting (contract and production)'],
    ['Measure', 'measure', ['measure'], 'Check measure'],
    ['Factory', 'factory', ['factory'], 'Factory'],
    ['Install', 'install', ['install'], 'Install cabinets'],
    ['Stone', 'stone', ['stone'], 'Stone'],
  ];
  const sum = groups.map(([short, lane, rows, full]) => {
    const n = new Set(inWeek.filter((s) => rows.includes(rowOf(s))).map((s) => s.job_id)).size;
    return html`<div class="lane-${lane}" title="${full}" aria-label="${full}: ${n}"><strong>${n}</strong><span>${short}</span></div>`;
  });

  const pending = d.decisions.filter((x) => d.stored.get(x.key)?.fingerprint !== x.fingerprint);
  const weekLabel = d.week === 0 ? 'This week' : 'Next week';
  const q = `&brand=${d.brand}`;

  // Capacity flags for the row labels.
  const capFor = (row: BoardRow): Html[] => d.capacity
    .filter((c) => (row === 'factory' && c.row === 'factory' && c.period === mon)
      || (row === 'install' && c.row === 'install' && c.period === mon)
      || (row === 'measure' && c.row === 'measure' && c.period >= mon && c.period <= fri))
    .map((c) => html`<a class="tag warn" href="/load" title="${c.decision.fact}" style="text-decoration:none">${c.row === 'measure' ? `${fmtShort(c.period).slice(0, 3)}: ${c.booked} of ${c.limit}` : `${c.booked} booked of ${c.limit} days`}</a>`);

  // Week board, wide screens.
  let board = html`<div></div>${DOW.map((name, i) => {
    const day = addDays(mon, i);
    return html`<div class="dh${day === d.today ? ' today' : ''}"><b>${day === d.today ? 'Today' : name}</b> ${fmtShort(day).slice(4)}</div>`;
  })}<div class="daylines" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>`;
  for (const r of BOARD_ROWS) {
    const items = inWeek.filter((s) => rowOf(s) === r.row).sort((a, b) => a.start_date!.localeCompare(b.start_date!) || Number(a.kind === 'rework') - Number(b.kind === 'rework'));
    const chips = items.map((s) => {
      const f = s.start_date!;
      const t = lastDate(s)!;
      const weekend = f > fri ? ` (${fmtShort(f).slice(0, 3)})` : '';
      return chip(s, jobById.get(s.job_id)!, {
        today: d.today,
        prefix: f < mon ? '← ' : '',
        suffix: (t > fri ? ' →' : '') + weekend,
        style: `grid-column:${col(f) + 1} / ${col(t) + 2}`,
        movable: editor,
        jobSteps: byJob.get(s.job_id),
      });
    });
    const extra = r.row === 'rework' ? undatedRework.map((x) => reworkCard(x, jobById.get(x.job_id)!, true)) : [];
    board = html`${board}<div class="lh lane-${r.row}">${r.label}${capFor(r.row)}</div><div class="lc">${chips}${extra}${!chips.length && !extra.length ? html`<div class="muted" style="grid-column:1 / 6;font-size:13px;padding-top:8px">Nothing booked</div>` : ''}</div>`;
  }

  // Day list, phones.
  const agendaDays = DOW.map((_, i) => {
    const day = addDays(mon, i);
    const list = inWeek.filter((s) => addDays(mon, col(s.start_date!)) === day);
    const caps = d.capacity.filter((c) => (c.row === 'measure' ? c.period === day : c.period === mon && i === 0));
    return html`<div><h3>${fmtShort(day)}${day === d.today ? html` <span class="today-pill">Today</span>` : ''}</h3><div class="list">
      ${caps.map((c) => html`<span class="tag warn">${c.decision.title}: ${c.booked} of ${c.limit}</span>`)}
      ${!list.length ? html`<div class="muted small">Nothing starts</div>` : ''}
      ${BOARD_ROWS.map((r) => list.filter((s) => rowOf(s) === r.row).map((s) => {
        const t = lastDate(s)!;
        const suffix = (t > day ? ` (to ${fmtShort(t)})` : '') + (s.start_date! < mon ? ', continuing' : '') + (s.start_date! > fri ? ` (${fmtShort(s.start_date!)})` : '');
        return html`<div class="lane-${r.row}" style="display:flex;flex-direction:column;gap:3px"><span class="lanelabel">${r.label}</span>${chip(s, jobById.get(s.job_id)!, { today: d.today, suffix })}${editor && !s.done_at ? html`<a class="small" href="/jobs/${s.job_id}/reschedule?step=${s.id}" style="align-self:flex-end">Move…</a>` : ''}</div>`;
      }))}
    </div></div>`;
  });
  const agenda = html`${agendaDays}${undatedRework.length ? html`<div class="lane-rework" style="display:flex;flex-direction:column;gap:3px"><h3>Rework, not yet dated</h3>${undatedRework.map((x) => reworkCard(x, jobById.get(x.job_id)!, false))}</div>` : ''}`;

  return html`
  ${d.message ? html`<div class="me-msg" role="note">${d.message}</div>` : ''}
  <div class="tiles">
    <a class="tile over" href="/attention"><b>${d.overdue.length}</b><span>Overdue</span><small>Date passed, not ticked</small></a>
    <div class="tile"><div class="sum">${sum}</div><span>${weekLabel}</span><small>Jobs in each step</small></div>
    <a class="tile warn" href="/attention"><b>${pending.length}</b><span>To decide</span><small>${[...new Set(pending.map((x) => x.title.split(' · ')[0]))].slice(0, 4).join(', ') || 'Nothing to decide'}</small></a>
    <a class="tile" href="/jobs"><b>${liveJobs.length}</b><span>Live jobs</span><small>Across all steps</small></a>
  </div>

  <section class="panel" aria-labelledby="weektitle">
    <div class="row">
      <h2 id="weektitle">${weekLabel} · ${fmtShort(mon)} to ${fmtShort(fri)}</h2>
      <div class="inline">
        ${brandSeg('/board', d.brand, `&week=${d.week}`)}
        <div class="seg" role="group" aria-label="Week">
          <a href="/board?week=0${q}"${d.week === 0 ? html` aria-current="true"` : ''}>This week</a>
          <a href="/board?week=1${q}"${d.week === 1 ? html` aria-current="true"` : ''}>Next week</a>
        </div>
      </div>
    </div>
    <details class="key"><summary>Key to the colours</summary>${legend()}</details>
    ${guide('board', editor ? "Drag a card sideways to move it to another day. You'll be asked what happens to the rest of the job, then it saves, confirmed. Red cards are rework." : 'Red cards are rework.', 'muted small board-hint')}
    <div class="board"${editor ? html` data-dragdays` : ''}>${board}</div>
    <div class="agenda">${agenda}</div>
  </section>

  ${d.suggestionsPanel ?? ''}`;
}
