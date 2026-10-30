import { html, Html } from '../web/html.js';
import { addDays, Calendar, daysBetween, fmtShort, Iso, mondayOf, sydneyDate } from '../domain/dates.js';
import { BOARD_ROWS, BoardRow, KINDS } from '../domain/steps.js';
import { CapacityWarning, Decision, jobTitle, JobRow, lastDate, ReworkRow, StepRow, stepLabel } from '../domain/checks.js';
import { can, Person } from '../web/auth.js';

export interface StoredDecision {
  key: string;
  fingerprint: string;
  note: string;
  decided_at: string;
  decided_by_name: string | null;
}

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

function chip(s: StepRow, job: JobRow, opts: { prefix?: string; suffix?: string; style?: string; today: Iso }): Html {
  const label = `${opts.prefix ?? ''}${stepLabel(s)}${opts.suffix ?? ''}`;
  const over = !s.done_at && lastDate(s)! < opts.today;
  const cls = ['chip', `lane-${KINDS[s.kind].row}`, s.confirmed ? '' : 'prov', s.done_at ? 'done' : ''].filter(Boolean).join(' ');
  return html`<a class="${cls}" href="/jobs/${job.id}"${opts.style ? html` style="${opts.style}"` : ''} title="${s.confirmed ? 'Confirmed' : 'Provisional'}${s.done_at ? ', done' : ''}">
    <strong>${jobTitle(job)}</strong><span>${label}</span><span>${s.owner || KINDS[s.kind].owner}${over ? html` · <span class="flag">Overdue</span>` : ''}${s.done_at ? ' · Done' : ''}</span></a>`;
}

function reworkCard(r: ReworkRow, job: JobRow, span: boolean): Html {
  return html`<a class="chip lane-rework" href="/jobs/${job.id}#rework"${span ? html` style="grid-column:1 / 6"` : ''}>
    <strong>${jobTitle(job)}</strong><span>${r.note}</span>
    <span style="color:var(--rw);font-weight:600">${r.raised_by_name ? `Raised by ${r.raised_by_name}` : 'Raised'} ${fmtShort(sydneyDate(r.raised_at))} · no dates yet</span></a>`;
}

export function comingUp(d: ComingUpData): Html {
  const jobById = new Map(d.jobs.map((j) => [j.id, j]));
  const liveJobs = d.jobs.filter((j) => j.status === 'live' && (d.brand === 'all' || j.brand === d.brand));
  const live = new Set(liveJobs.map((j) => j.id));
  const mon = addDays(mondayOf(d.today), d.week * 7);
  const fri = addDays(mon, 4);
  const sun = addDays(mon, 6);
  const inWeek = d.steps.filter((s) => s.start_date && live.has(s.job_id) && s.start_date <= sun && lastDate(s)! >= mon);
  const col = (x: Iso) => Math.min(Math.max(daysBetween(mon, x), 0), 4);
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
    const n = new Set(inWeek.filter((s) => rows.includes(KINDS[s.kind].row)).map((s) => s.job_id)).size;
    return html`<div class="lane-${lane}" title="${full}" aria-label="${full}: ${n}"><strong>${n}</strong><span>${short}</span></div>`;
  });

  const pending = d.decisions.filter((x) => d.stored.get(x.key)?.fingerprint !== x.fingerprint);
  const decided = d.decisions.filter((x) => d.stored.get(x.key)?.fingerprint === x.fingerprint);
  const weekLabel = d.week === 0 ? 'This week' : 'Next week';
  const q = `&brand=${d.brand}`;

  // Capacity flags for the row labels.
  const capFor = (row: BoardRow): Html[] => d.capacity
    .filter((c) => (row === 'factory' && c.row === 'factory' && c.period === mon)
      || (row === 'install' && c.row === 'install' && c.period === mon)
      || (row === 'measure' && c.row === 'measure' && c.period >= mon && c.period <= fri))
    .map((c) => html`<span class="tag warn" title="${c.decision.fact}">${c.row === 'measure' ? `${fmtShort(c.period).slice(0, 3)}: ${c.booked} of ${c.limit}` : `${c.booked} of ${c.limit} days`}</span>`);

  // Week board, wide screens.
  let board = html`<div></div>${DOW.map((name, i) => {
    const day = addDays(mon, i);
    return html`<div class="dh${day === d.today ? ' today' : ''}"><b>${day === d.today ? 'Today' : name}</b> ${fmtShort(day).slice(4)}</div>`;
  })}`;
  for (const r of BOARD_ROWS) {
    const items = inWeek.filter((s) => KINDS[s.kind].row === r.row).sort((a, b) => a.start_date!.localeCompare(b.start_date!));
    const chips = items.map((s) => {
      const f = s.start_date!;
      const t = lastDate(s)!;
      const weekend = f > fri ? ` (${fmtShort(f).slice(0, 3)})` : '';
      return chip(s, jobById.get(s.job_id)!, {
        today: d.today,
        prefix: f < mon ? '← ' : '',
        suffix: (t > fri ? ' →' : '') + weekend,
        style: `grid-column:${col(f) + 1} / ${col(t) + 2}`,
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
      ${BOARD_ROWS.map((r) => list.filter((s) => KINDS[s.kind].row === r.row).map((s) => {
        const t = lastDate(s)!;
        const suffix = (t > day ? ` (to ${fmtShort(t)})` : '') + (s.start_date! < mon ? ', continuing' : '') + (s.start_date! > fri ? ` (${fmtShort(s.start_date!)})` : '');
        return html`<div class="lane-${r.row}" style="display:flex;flex-direction:column;gap:3px"><span class="lanelabel">${r.label}</span>${chip(s, jobById.get(s.job_id)!, { today: d.today, suffix })}</div>`;
      }))}
    </div></div>`;
  });
  const agenda = html`${undatedRework.length ? html`<div class="lane-rework" style="display:flex;flex-direction:column;gap:3px"><h3>Rework, not yet dated</h3>${undatedRework.map((x) => reworkCard(x, jobById.get(x.job_id)!, false))}</div>` : ''}${agendaDays}`;

  return html`
  <div class="tiles">
    <a class="tile over" href="#overdue"><b>${d.overdue.length}</b><span>Overdue</span><small>Date passed, not ticked</small></a>
    <div class="tile"><div class="sum">${sum}</div><span>${weekLabel}</span><small>Jobs in each step</small></div>
    <a class="tile warn" href="#attention"><b>${pending.length}</b><span>Needs a decision</span><small>${[...new Set(pending.map((x) => x.title.split(' · ')[0]))].slice(0, 4).join(', ') || 'Nothing to decide'}</small></a>
    <a class="tile" href="/jobs"><b>${liveJobs.length}</b><span>Live jobs</span><small>Across all steps</small></a>
  </div>

  <section class="panel" aria-labelledby="weektitle">
    <div class="row">
      <h2 id="weektitle">${weekLabel} · ${fmtShort(mon)} to ${fmtShort(fri)}</h2>
      <div class="inline">
        ${brandSeg('/', d.brand, `&week=${d.week}`)}
        <div class="seg" role="group" aria-label="Week">
          <a href="/?week=0${q}"${d.week === 0 ? html` aria-current="true"` : ''}>This week</a>
          <a href="/?week=1${q}"${d.week === 1 ? html` aria-current="true"` : ''}>Next week</a>
        </div>
      </div>
    </div>
    ${legend()}
    <div class="board">${board}</div>
    <div class="agenda">${agenda}</div>
  </section>

  <div class="two">
    <section class="panel" id="overdue">
      <div class="row"><h2>Overdue</h2><span class="muted small">Tick it or give it a new date</span></div>
      <div>${overdueList(d)}</div>
    </section>
    <section class="panel" id="attention">
      <div class="row"><h2>Needs a date or a decision</h2><span class="muted small">${pending.length ? `${pending.length} to decide` : ''}</span></div>
      <div class="muted small">Decide each one here: keep it as it is, or change the dates. Your choice updates the job.</div>
      <div>${decisionList(d, pending, decided)}</div>
    </section>
  </div>`;
}

function overdueList(d: ComingUpData): Html {
  if (!d.overdue.length) return html`<div style="padding:10px 0;font-weight:600">Nothing overdue.</div>`;
  const jobById = new Map(d.jobs.map((j) => [j.id, j]));
  const back = `/?week=${d.week}&brand=${d.brand}#overdue`;
  return html`${d.overdue.map((s) => {
    const j = jobById.get(s.job_id)!;
    const due = lastDate(s)!;
    const late = daysBetween(due, d.today);
    return html`<div class="item">
      <div class="what"><div><a href="/jobs/${j.id}" style="color:inherit">${j.client_name}</a> · ${stepLabel(s)}</div>
        <div class="muted small">${s.owner || KINDS[s.kind].owner} · was due ${fmtShort(due)}</div></div>
      <span class="late">${late} ${late === 1 ? 'day' : 'days'} late</span>
      ${can(d.person, 'doer') ? html`<form method="post" action="/steps/${s.id}/done"><input type="hidden" name="done" value="1"><input type="hidden" name="back" value="${back}"><button class="btn" type="submit">Done</button></form>` : ''}
      ${can(d.person, 'editor') ? html`<details class="pop" style="display:contents"><summary class="btn">New date</summary>
        <form class="popbody" method="get" action="/jobs/${j.id}/reschedule" style="flex-basis:100%">
          <input type="hidden" name="step" value="${s.id}">
          <div class="inline"><label class="f" for="nd-${s.id}">Move to<input type="date" id="nd-${s.id}" name="start" value="${addDays(d.today, 1)}" min="${d.today}" required></label>
          <button class="btn primary" type="submit" style="align-self:flex-end">Next</button></div>
          <span class="muted small">Next shows what happens to the rest of the job before anything saves.</span>
        </form></details>` : ''}
    </div>`;
  })}`;
}

const tick = html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;color:var(--meas)"><path d="M5 12l5 5L20 7"></path></svg>`;

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

function decisionList(d: ComingUpData, pending: Decision[], decided: Decision[]): Html {
  const editor = can(d.person, 'editor');
  const back = `/?week=${d.week}&brand=${d.brand}#attention`;
  const items = pending.map((x) => html`<div class="item stack">
    <div style="font-weight:600">${x.jobId ? html`<a href="/jobs/${x.jobId}" style="color:inherit">${x.title}</a>` : x.title}</div>
    <div>${x.fact}</div>
    <div class="ask">${x.ask}</div>
    ${editor ? html`<div class="acts">
      <form method="post" action="/decisions/ok"><input type="hidden" name="key" value="${x.key}"><input type="hidden" name="fingerprint" value="${x.fingerprint}"><input type="hidden" name="note" value="${x.okText}"><input type="hidden" name="back" value="${back}"><button class="btn" type="submit">OK as is</button></form>
      ${x.fields.length ? html`<details class="pop" style="display:contents"><summary class="btn">Change dates</summary>
        <form class="popbody" method="post" action="/decisions/fix"><input type="hidden" name="back" value="${back}">
          ${decisionFields(x)}
          <div class="acts"><button class="btn primary" type="submit">Save</button></div></form></details>`
        : x.jobId ? html`<a class="btn" href="/jobs/${x.jobId}">Open the job</a>` : ''}
    </div>` : ''}
  </div>`);
  const done = decided.map((x) => {
    const s = d.stored.get(x.key)!;
    return html`<div class="item" style="gap:8px">${tick}<span style="flex:1 1 180px;min-width:0"><strong>${x.title}</strong> · ${s.note}${s.decided_by_name ? html` <span class="muted small">(${s.decided_by_name})</span>` : ''}</span>
      ${editor ? html`<form method="post" action="/decisions/undo"><input type="hidden" name="key" value="${x.key}"><input type="hidden" name="back" value="${back}"><button class="btn small" type="submit">Undo</button></form>` : ''}</div>`;
  });
  if (!pending.length && !decided.length) return html`<div style="padding:10px 0;font-weight:600">All decided.</div>`;
  return html`${items}${!pending.length ? html`<div style="padding:10px 0;font-weight:600">All decided.</div>` : ''}${done}`;
}
