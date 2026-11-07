import { guide } from './guide.js';
import { html, Html } from '../web/html.js';
import { fmtLong, fmtRange, fmtShort, Iso, sydneyDate } from '../domain/dates.js';
import { KINDS, PEOPLE_AREAS, ProposedStep } from '../domain/steps.js';
import { CapacityInput, CapacityWarning } from '../domain/checks.js';
import type { IssueType } from '../db/queries.js';
import type { FullJob, ReworkFull } from '../db/queries.js';
import type { AnchorKind, Template } from '../domain/schedule.js';
import { can, Person } from '../web/auth.js';
import { CAUSES, jobFields, raiseForm, responsibleBlock } from './job.js';
import type { Responsible } from '../db/queries.js';

// ---------- New job ----------

export interface NewJobView {
  values: Partial<FullJob> & { template?: string | null };
  templates: Template[];
  anchor: AnchorKind;
  anchorDate: string | null;
  proposal: ProposedStep[] | null;
  siteStartWorkedOut: string | null;
  clashes: CapacityWarning[];
  landing?: Landing | null;
  error?: string;
}

/** The factory and install weeks a proposed job lands in, with the load before and after it (R7). */
export interface Landing {
  weeks: { kind: 'factory' | 'install'; label: string; monday: Iso; before: number; after: number; available: number }[];
  /** The first later anchor date whose weeks have room, or null when none in the next twelve. */
  nextWithRoom: { date: Iso; weeks: Landing['weeks'] } | null;
}

export function newJobPage(d: NewJobView): Html {
  return html`<div class="job">
    ${guide('new-job', 'Pick the job type and the one date you know. The hub fills every other date from the template, all provisional. You or Christine can change any of them.', 'muted')}
    ${d.error ? html`<div class="notice bad">${d.error}</div>` : ''}
    <form method="post" action="/jobs/new" class="panel" id="newjob">
      ${jobFields(d.values, { forNew: true, templates: d.templates, anchor: d.anchor, anchorDate: d.anchorDate })}
      <div class="acts">
        <button class="btn" type="submit" name="action" value="preview">Show proposed dates</button>
        <button class="btn primary" type="submit" name="action" value="save">Add the job</button>
      </div>
    </form>
    <section class="panel" id="proposal" aria-live="polite">${proposalBlock(d.proposal, d.clashes, d.siteStartWorkedOut, d.landing ?? null)}</section>
  </div>`;
}

export function proposalBlock(proposal: ProposedStep[] | null, clashes: CapacityWarning[], siteStartWorkedOut: string | null = null, landing: Landing | null = null): Html {
  if (!proposal) return html`<h2>Proposed dates</h2><p class="muted">Fill in the site start, or pick another date to work from and fill that in, then tap Show proposed dates.</p>`;
  const weekLine = (w: Landing['weeks'][number]) => html`<div class="kv"><span>${w.label} week of ${fmtShort(w.monday).slice(4)}</span><strong class="${w.after > w.available ? 'nodate' : ''}">${w.before} h booked → ${w.after} h with this job, of ${w.available} h</strong></div>`;
  return html`<h2>Proposed dates</h2>
    ${siteStartWorkedOut ? html`<p class="small">Site start worked out as <strong>${fmtShort(siteStartWorkedOut)}</strong>. Type the real one if you know it.</p>` : ''}
    ${clashes.length ? html`<div class="notice bad">${clashes.map((c) => html`<div>${c.decision.title}: ${c.decision.fact}</div>`)}</div>` : html`<p class="muted small">No capacity clashes with jobs already booked.</p>`}
    ${landing ? html`<div class="landing"><div class="eyebrow">Where it lands</div>${landing.weeks.map(weekLine)}
      ${clashes.length ? landing.nextWithRoom
        ? html`<div class="acts" style="align-items:center"><button class="btn" type="submit" form="newjob" name="use_week" value="${landing.nextWithRoom.date}">Use the next week with room: ${fmtShort(landing.nextWithRoom.date)}</button>
            <span class="muted small">${landing.nextWithRoom.weeks.map((w) => `${w.label} ${w.after} of ${w.available} h`).join(' · ')}</span></div>`
        : html`<p class="muted small">No week with room in the next twelve. Add it anyway and sort it out on Attention, or add hours under Settings → Capacity.</p>` : ''}</div>` : ''}
    <div>${proposal.map((p) => html`<div class="kv"><span>${KINDS[p.kind].label}</span><strong>${fmtRange(p.start_date, p.end_date)}</strong></div>`)}</div>`;
}

// ---------- Rework ----------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function reworkPage(d: { person: Person; rework: (ReworkFull & { client_name: string; suburb: string })[]; jobs: { id: number; job_number: string | null; client_name: string; suburb: string }[]; today: Iso; responsible: Map<number, Responsible>; peopleNames: string[] }): Html {
  const open = d.rework.filter((r) => !r.closed_on);
  const closed = d.rework.filter((r) => r.closed_on).slice(0, 30);
  const months: string[] = [];
  for (let i = 0; i < 6; i++) {
    const [y, m] = d.today.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(dt.toISOString().slice(0, 7));
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = (ym: string) => `${MON[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
  const tallyRows = months.flatMap((ym) => {
    const inMonth = d.rework.filter((r) => sydneyDate(r.raised_at).slice(0, 7) === ym);
    if (!inMonth.length) return [html`<tr><td>${monthName(ym)}</td><td colspan="4" class="muted">None</td></tr>`];
    const causes = [...CAUSES, null] as (string | null)[];
    return causes.filter((c) => inMonth.some((r) => r.cause === c)).map((c, i, arr) => {
      const rs = inMonth.filter((r) => r.cause === c);
      const hours = rs.reduce((a, r) => a + (r.extra_hours ?? 0), 0);
      const cost = rs.reduce((a, r) => a + (r.extra_material_cost ?? 0), 0);
      return html`<tr><td>${i === 0 ? monthName(ym) : ''}</td><td>${c ? cap(c) : 'Not recorded'}</td><td class="num">${rs.length}</td><td class="num">${hours.toFixed(1)}</td><td class="num">$${cost.toFixed(0)}</td></tr>${i === arr.length - 1 && arr.length > 1 ? html`<tr><td></td><td><strong>Total</strong></td><td class="num"><strong>${inMonth.length}</strong></td><td class="num"><strong>${inMonth.reduce((a, r) => a + (r.extra_hours ?? 0), 0).toFixed(1)}</strong></td><td class="num"><strong>$${inMonth.reduce((a, r) => a + (r.extra_material_cost ?? 0), 0).toFixed(0)}</strong></td></tr>` : ''}`;
    });
  });

  const item = (r: ReworkFull & { client_name: string; suburb: string }) => html`<div class="item">
    <div class="what"><div><a href="/jobs/${r.job_id}#rework" style="color:inherit">${r.client_name} · ${r.suburb}</a></div>
      <div>${r.cause ? cap(r.cause) : 'Cause not recorded'} · ${r.note}</div>
      <div class="muted small">Raised by ${r.raised_by_name ?? 'unknown'} on ${fmtLong(sydneyDate(r.raised_at))}${r.closed_on ? ` · closed ${fmtLong(r.closed_on)} · ${r.extra_hours ?? 0} h · $${(r.extra_material_cost ?? 0).toFixed(2)}` : ''}</div></div>
    <a class="btn small" href="/jobs/${r.job_id}#rework">Open</a>
    ${d.person.is_owner ? html`<div style="flex-basis:100%">${responsibleBlock(r.id, d.responsible.get(r.id), '/rework', d.peopleNames)}</div>` : ''}</div>`;

  return html`
  ${can(d.person, 'doer') ? html`<section class="panel"><h2>Raise rework</h2><p class="muted small">Pick the job and the cause, one line on what happened, and tick what needs doing.</p>${raiseForm(null, '/rework', d.jobs, d.person, d.peopleNames)}</section>` : ''}
  ${d.person.is_owner ? ownersTally(d) : ''}
  <div class="two">
    <section class="panel"><div class="row"><h2>Open</h2><span class="muted small">${open.length}</span></div><div>${open.length ? open.map(item) : html`<p>No open rework.</p>`}</div></section>
    <section class="panel"><h2>Monthly tally</h2><p class="muted small">By the month rework was raised. Hours and dollars come in when it's closed.</p>
      <div class="tbl" tabindex="0"><table><thead><tr><th>Month</th><th>Cause</th><th class="num">Count</th><th class="num">Extra hours</th><th class="num">Extra material</th></tr></thead><tbody>${tallyRows}</tbody></table></div></section>
  </div>
  <section class="panel"><h2>Closed</h2><div>${closed.length ? closed.map(item) : html`<p class="muted">Nothing closed yet.</p>`}</div></section>`;
}

/** Owners only: rework by the person responsible, this month and the last six. */
function ownersTally(d: Parameters<typeof reworkPage>[0]): Html {
  const thisMonth = d.today.slice(0, 7);
  const [y, m] = d.today.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 6, 1)).toISOString().slice(0, 7);
  const by = new Map<string, { month: number; count: number; hours: number; cost: number }>();
  for (const r of d.rework) {
    const who = d.responsible.get(r.id)?.responsible ?? 'Not recorded';
    const ym = sydneyDate(r.raised_at).slice(0, 7);
    if (ym < from) continue;
    const e = by.get(who) ?? by.set(who, { month: 0, count: 0, hours: 0, cost: 0 }).get(who)!;
    e.count++;
    if (ym === thisMonth) e.month++;
    e.hours += r.extra_hours ?? 0;
    e.cost += r.extra_material_cost ?? 0;
  }
  const rows = [...by].sort((a, b) => (a[0] === 'Not recorded' ? 1 : b[0] === 'Not recorded' ? -1 : b[1].count - a[1].count));
  return html`<section class="panel owners" style="display:flex;flex-direction:column;align-items:stretch">
    <div class="row"><h2>Who was responsible</h2><span class="tag">Owners only</span></div>
    <p class="muted small">Only you and the other owner see this. The last six months, by the month rework was raised.</p>
    <div class="tbl" tabindex="0"><table><thead><tr><th>Responsible</th><th class="num">This month</th><th class="num">6 months</th><th class="num">Extra hours</th><th class="num">Extra material</th></tr></thead>
      <tbody>${rows.length ? rows.map(([who, e]) => html`<tr><td>${who}</td><td class="num">${e.month}</td><td class="num">${e.count}</td><td class="num">${e.hours.toFixed(1)}</td><td class="num">$${e.cost.toFixed(0)}</td></tr>`) : html`<tr><td colspan="5" class="muted">No rework in the last six months.</td></tr>`}</tbody></table></div>
  </section>`;
}

// ---------- More, and Find a job (George, 7 Nov 2026) ----------

export function morePage(d: { person: Person; waiting: number }): Html {
  const editor = can(d.person, 'editor');
  const doer = d.person.role === 'doer';
  const viewer = d.person.role === 'viewer';
  const link = (href: string, title: string, sub: string, badge?: number) => html`<a class="tile" href="${href}"><span>${title}${badge ? html` <span class="badge" aria-label="${badge} waiting">${badge}</span>` : ''}</span><small>${sub}</small></a>`;
  // Whatever a role's tab row leaves out is here (redesign A), then the rest.
  return html`<div class="tiles more">
    ${doer ? link('/board', 'Board', 'The whole week, every job') : ''}
    ${doer ? link('/pipeline', 'Pipeline', 'Every live job, stage by stage') : ''}
    ${doer ? link('/jobs', 'Jobs', 'Every job on one chart') : ''}
    ${doer || viewer ? link('/attention', 'Attention', 'Overdue, decisions and flags') : ''}
    ${!doer ? link('/me', 'My day', 'Your steps this week, one Done button each') : ''}
    ${link('/rework', 'Rework', 'Raise it, date it, the monthly tally')}
    ${link('/load', 'Load', 'Hours booked against hours available, six weeks')}
    ${!doer && !(viewer && d.person.can_stock) ? link('/stock', 'Stock', 'What is on hand, what jobs need, what to order') : ''}
    ${editor ? link('/tv', 'Factory TV', 'The factory\'s week for a screen on the wall') : ''}
    ${link('/suggestions', 'Suggestions', 'What the Buildertrend bot found', d.waiting)}
    ${editor ? link('/jobs/new', 'New job', 'One date, every other date proposed') : ''}
    ${editor ? link('/settings', 'Settings', 'People, capacity, job types, blocked days, emails') : ''}
    ${link('/export.xlsx', 'Spreadsheet', 'Download jobs, steps and rework')}
    ${link('/help', 'Manual', 'How the hub works, screen by screen')}
  </div>`;
}

export function findPage(d: { q: string; jobs: { id: number; job_number: string | null; client_name: string; suburb: string; status: string }[] }): Html {
  const STATUS: Record<string, string> = { live: 'Live', on_hold: 'On hold', complete: 'Complete', cancelled: 'Cancelled' };
  return html`<section class="panel">
    <form method="get" action="/find" class="inline"><input type="search" name="q" value="${d.q}" placeholder="Job number, client or suburb" aria-label="Find a job" style="flex:1 1 240px"><button class="btn primary" type="submit">Find</button></form>
    ${!d.q ? html`<p class="muted">Type part of a job number, a client's name or a suburb.</p>`
      : !d.jobs.length ? html`<p>No job matches "${d.q}".</p>`
      : html`<div>${d.jobs.map((j) => html`<div class="item"><div class="what"><div><a href="/jobs/${j.id}" style="color:inherit">${j.client_name}</a>${j.suburb ? ` · ${j.suburb}` : ''}</div><div class="muted small">${j.job_number ?? 'No number'}${j.status === 'live' ? '' : ` · ${STATUS[j.status] ?? j.status}`}</div></div><a class="btn small" href="/jobs/${j.id}">Open</a></div>`)}</div>`}
  </section>`;
}
