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
    <p class="muted">Pick the job type and the one date you know. The hub fills every other date from the template, all provisional. You or Christine can change any of them.</p>
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
      <div class="tbl"><table><thead><tr><th>Month</th><th>Cause</th><th class="num">Count</th><th class="num">Extra hours</th><th class="num">Extra material</th></tr></thead><tbody>${tallyRows}</tbody></table></div></section>
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
    <div class="tbl"><table><thead><tr><th>Responsible</th><th class="num">This month</th><th class="num">6 months</th><th class="num">Extra hours</th><th class="num">Extra material</th></tr></thead>
      <tbody>${rows.length ? rows.map(([who, e]) => html`<tr><td>${who}</td><td class="num">${e.month}</td><td class="num">${e.count}</td><td class="num">${e.hours.toFixed(1)}</td><td class="num">$${e.cost.toFixed(0)}</td></tr>`) : html`<tr><td colspan="5" class="muted">No rework in the last six months.</td></tr>`}</tbody></table></div>
  </section>`;
}

// ---------- More, and Find a job (George, 7 Nov 2026) ----------

export function morePage(d: { person: Person; waiting: number }): Html {
  const editor = can(d.person, 'editor');
  const link = (href: string, title: string, sub: string, badge?: number) => html`<a class="tile" href="${href}"><span>${title}${badge ? html` <span class="badge" aria-label="${badge} waiting">${badge}</span>` : ''}</span><small>${sub}</small></a>`;
  return html`<div class="tiles more">
    ${link('/rework', 'Rework', 'Raise it, date it, the monthly tally')}
    ${link('/load', 'Load', 'Hours booked against hours available, six weeks')}
    ${link('/stock', 'Stock', 'What is on hand, what jobs need, what to order')}
    ${editor ? link('/tv', 'Factory TV', 'The factory\'s week for a screen on the wall') : ''}
    ${link('/suggestions', 'Suggestions', 'What the Buildertrend bot found', d.waiting)}
    ${editor ? link('/jobs/new', 'New job', 'One date, every other date proposed') : ''}
    ${editor ? link('/settings', 'Settings', 'Capacities, job types, blocked days, people') : ''}
    ${link('/export.xlsx', 'Spreadsheet', 'Download jobs, steps and rework')}
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

// ---------- Settings ----------

export function settingsPage(d: {
  settings: { key: string; value: number; label: string }[];
  blocked: { id: number; day: Iso; scope: string; reason: string }[];
  people: { id: number; name: string; email: string; role: string; active: boolean; is_owner: boolean; areas: string[]; email_digest: boolean; can_stock: boolean }[];
  /** The factory TV link key ('' until one is made) and the address to show. */
  tvKey: string;
  appUrl: string;
  today: Iso;
  templates: Template[];
  viewerIsOwner: boolean;
  /** The one-line message shown on My day and the board. */
  message: string;
  cap: CapacityInput;
  issueTypes: IssueType[];
  runs: { day: Iso; kind: string; sent: number; ran_at: string }[];
  preview: boolean;
  nudgeTo: string | null;
  /** Suggestions email and, for owners, API tokens (views/suggestions.ts). */
  extra?: Html;
}): Html {
  const upcoming = d.blocked.filter((b) => b.day >= d.today);
  return html`
  <section class="panel"><div class="row"><h2>Spreadsheet</h2><a class="btn" href="/export.xlsx">Download jobs, steps and rework (.xlsx)</a></div></section>

  <section class="panel" id="message"><h2>Message on My day and the board</h2>
    <form method="post" action="/settings/message" class="inline">
      <input name="message" value="${d.message}" maxlength="200" placeholder="e.g. Factory clean-out Friday afternoon" aria-label="Message" style="flex:1 1 300px">
      <button class="btn primary" type="submit">Save</button>
    </form>
    <span class="muted small">One line everyone sees at the top of My day and the board. Leave it empty to show nothing.</span></section>

  <section class="panel" id="capacity"><h2>Capacity, in hours a day</h2>
    <p class="muted small">Jobman's labour centre. A kitchen's factory or install day counts as the hours below ("Hours in a factory or install day"); a rework task counts its own hours. The hub warns when a week's bookings pass the hours available, and <a href="/load">Load</a> shows the next six weeks day by day.</p>
    ${d.cap.centres.map((c) => html`<form method="post" action="/settings/centres/${c.key}" class="inline" style="padding-top:8px;border-top:1px solid var(--line)">
      <strong style="flex:1 1 120px">${c.label}</strong>
      ${(['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((k) => html`<label class="f" style="width:72px">${k.charAt(0).toUpperCase() + k.slice(1)}<input name="${k}" inputmode="decimal" value="${c[k]}" required pattern="[0-9]+([.][0-9])?"></label>`)}
      <span class="muted small">= ${Math.round((c.mon + c.tue + c.wed + c.thu + c.fri) * 10) / 10} h a week</span>
      <button class="btn small" type="submit">Save</button></form>`)}
    <h3 style="margin-top:12px">Leave, shutdowns and extra hands</h3>
    <p class="muted small">A period with different hours a day in one area: 0 for a shutdown, less for someone on leave, more for an extra pair of hands. Public holidays and blocked days are already 0.</p>
    <form method="post" action="/settings/adjustments" class="fixgrid">
      <label class="f">Area<select name="centre">${d.cap.centres.map((c) => html`<option value="${c.key}">${c.label}</option>`)}</select></label>
      <label class="f">From<input type="date" name="from" required></label>
      <label class="f">To (optional)<input type="date" name="to"></label>
      <label class="f">Hours a day<input name="hours" inputmode="decimal" required pattern="[0-9]+([.][0-9])?" placeholder="e.g. 8"></label>
      <label class="f">Reason<input name="reason" required placeholder="e.g. Phil on leave"></label>
      <button class="btn primary" type="submit" style="align-self:end">Add</button>
    </form>
    ${d.cap.adjustments.length ? html`<div class="tbl"><table><thead><tr><th>Area</th><th>From</th><th>To</th><th class="num">Hours a day</th><th>Reason</th><th></th></tr></thead><tbody>
      ${d.cap.adjustments.filter((a) => a.to_day >= d.today).map((a) => html`<tr><td>${d.cap.centres.find((c) => c.key === a.centre)?.label ?? a.centre}</td><td>${fmtShort(a.from_day)}</td><td>${fmtShort(a.to_day)}</td><td class="num">${a.hours}</td><td>${a.reason}</td>
        <td><form method="post" action="/settings/adjustments/${a.id}/delete"><button class="btn small danger" type="submit">Remove</button></form></td></tr>`)}
    </tbody></table></div>` : ''}
  </section>

  <section class="panel" id="flags"><h2>Flagged problems: who looks after what</h2>
    <p class="muted small">Anyone who can tick can flag a problem from My day or a step. The flag goes by email to the person here and to the Editors, and sits on Attention until it's marked fixed.</p>
    <div class="tbl"><table><thead><tr><th>Problem</th><th>Looked after by</th><th>In the list</th><th></th></tr></thead><tbody>
      ${d.issueTypes.map((t) => html`<tr><td colspan="4" style="padding:0;border:0"><form method="post" action="/settings/flag-types/${t.key}" style="display:grid;grid-template-columns:minmax(160px,1.2fr) minmax(160px,1fr) 100px auto;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);align-items:center;min-width:560px">
        <strong>${t.label}</strong>
        <select name="responsible" aria-label="Looked after by"><option value="">Editors only</option>${d.people.filter((p) => p.active && p.role !== 'viewer').map((p) => html`<option value="${p.id}"${t.responsible === p.id ? html` selected` : ''}>${p.name}</option>`)}</select>
        <label class="checkline" style="font-weight:400"><input type="checkbox" name="active" value="1"${t.active ? html` checked` : ''}> Yes</label>
        <button class="btn small" type="submit">Save</button></form></td></tr>`)}
    </tbody></table></div></section>

  <section class="panel" id="emails"><h2>Emails</h2>
    <p class="muted small">Every weekday at 7 am Sydney time the hub emails whoever owns a step that went overdue the day before, and on Mondays everyone gets their week. A flag emails the person who looks after it and the Editors as it's raised; Materials in, ticked, emails the factory. Untick "Emails" on a person below to leave them out.${d.preview && d.nudgeTo ? html` <strong>On this preview copy every one of these goes to ${d.nudgeTo} instead of the person.</strong>` : ''}</p>
    <div class="acts"><a class="btn" href="/settings/emails">See what today's run would send</a></div>
    ${d.runs.length ? html`<div class="tbl"><table><thead><tr><th>Day</th><th class="num">Sent</th><th>Ran at</th></tr></thead><tbody>${d.runs.map((r) => html`<tr><td>${fmtShort(r.day)}</td><td class="num">${r.sent}</td><td>${new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false, day: '2-digit', month: 'short' }).format(new Date(r.ran_at))}</td></tr>`)}</tbody></table></div>` : html`<p class="muted small">No runs yet.</p>`}
  </section>

  <section class="panel"><h2>Default durations and limits</h2>
    <form method="post" action="/settings/values" class="stack">
      <div class="formgrid">${d.settings.map((s) => html`<label class="f">${s.label}<input type="number" name="${s.key}" value="${s.value}" min="0" max="200" required></label>`)}</div>
      <div class="acts"><button class="btn primary" type="submit">Save settings</button></div>
      <span class="muted small">Changes apply to new proposals and warnings from now on. Dates already on jobs don't move.</span>
    </form></section>

  <section class="panel"><h2>Job types</h2>
    <p class="muted small">A new job's dates come from its job type. Changes apply to new jobs only; dates already in the hub don't move.</p>
    ${d.templates.map((t) => html`<form method="post" action="/settings/templates/${t.key}" class="stack" style="padding-top:10px;border-top:1px solid var(--line)">
      <div class="formgrid">
        <label class="f wide">Name<input name="name" value="${t.name}" required></label>
        <label class="f">Door finish<select name="door_finish"><option value="melamine"${t.door_finish === 'melamine' ? html` selected` : ''}>Melamine</option><option value="polyurethane"${t.door_finish === 'polyurethane' ? html` selected` : ''}>Polyurethane</option></select></label>
        <label class="f">Factory days<input type="number" name="factory_days" min="1" max="30" value="${t.factory_days}" required></label>
        <label class="f">Install days<input type="number" name="install_days" min="1" max="30" value="${t.install_days}" required></label>
        <label class="f">Install starts, weeks after site start<input type="number" name="install_weeks" min="1" max="52" value="${t.install_weeks}" required></label>
        <label class="checkline"><input type="checkbox" name="has_painting" value="1"${t.has_painting ? html` checked` : ''}> Painting</label>
        <label class="checkline"><input type="checkbox" name="has_stone" value="1"${t.has_stone ? html` checked` : ''}> Stone</label>
      </div>
      <div class="acts"><button class="btn" type="submit">Save ${t.name}</button></div>
    </form>`)}
  </section>

  <section class="panel"><h2>Blocked days</h2>
    <p class="muted small">Every step skips "Everyone" days (public holidays, Christmas shutdown). Factory steps also skip "Factory only" days (clean-out, stocktake). NSW public holidays to 2028 are loaded; check them each year.</p>
    <form method="post" action="/settings/blocked" class="fixgrid">
      <label class="f">From<input type="date" name="from" required></label>
      <label class="f">To (optional)<input type="date" name="to"></label>
      <label class="f">Applies to<select name="scope"><option value="factory">Factory only</option><option value="all">Everyone</option></select></label>
      <label class="f">Reason<input name="reason" required placeholder="e.g. Factory clean-out"></label>
      <button class="btn primary" type="submit" style="align-self:end">Add</button>
    </form>
    <div class="tbl"><table><thead><tr><th>Date</th><th>Applies to</th><th>Reason</th><th></th></tr></thead><tbody>
      ${upcoming.map((b) => html`<tr><td>${fmtShort(b.day)} ${b.day.slice(0, 4)}</td><td>${b.scope === 'all' ? 'Everyone' : 'Factory only'}</td><td>${b.reason}</td>
        <td><form method="post" action="/settings/blocked/${b.id}/delete"><button class="btn small danger" type="submit">Remove</button></form></td></tr>`)}
    </tbody></table></div></section>

  <section class="panel" id="tv"><h2>Factory TV</h2>
    <p class="muted small">The factory's week in big type for a screen on the wall: materials in, the factory (cut, painting, delivery) and installs, this week and next, refreshing every two minutes. It opens with a link instead of a sign-in, so keep the link to the factory. Making a new link stops the old one.</p>
    ${d.tvKey ? html`<p><a href="/tv?k=${d.tvKey}" target="_blank" rel="noopener"><code>${d.appUrl}/tv?k=${d.tvKey}</code></a></p>` : html`<p class="muted">No link yet.</p>`}
    <form method="post" action="/settings/tv" class="acts"><button class="btn${d.tvKey ? '' : ' primary'}" type="submit">${d.tvKey ? 'Make a new link' : 'Make the link'}</button><a class="btn" href="/tv" target="_blank" rel="noopener">See it (signed in)</a></form>
  </section>

  <section class="panel"><h2>People</h2>
    <p class="muted small">Only these addresses can sign in. Editors change anything; Doers tick steps and raise rework; Viewers look. Switch someone off rather than deleting them, so the history keeps their name.${d.viewerIsOwner ? ' Owners (you see this column because you are one) also see who was responsible for each rework; only an owner can make someone an owner.' : ''} Areas are the board rows a person works in: their steps make up My day.</p>
    <div class="tbl"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Can sign in</th>${d.viewerIsOwner ? html`<th>Owner</th>` : ''}<th>Emails</th><th title="May change stock: items, counts, the order list">Stock</th><th></th></tr></thead><tbody>
      ${d.people.map((p) => {
        const locked = p.is_owner && !d.viewerIsOwner;
        const cols = d.viewerIsOwner ? 'minmax(120px,1fr) minmax(180px,1.5fr) 120px 110px 90px 90px 80px auto' : 'minmax(120px,1fr) minmax(180px,1.5fr) 120px 110px 90px 80px auto';
        const dis = locked ? html` disabled` : '';
        return html`<tr><td colspan="${d.viewerIsOwner ? 8 : 7}" style="padding:0;border:0"><form method="post" action="/settings/people/${p.id}" style="display:grid;grid-template-columns:${cols};gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);align-items:center;min-width:${d.viewerIsOwner ? 910 : 810}px">
        <input name="name" value="${p.name}" required aria-label="Name"${dis}><input name="email" type="email" value="${p.email}" required aria-label="Email"${dis}>
        <select name="role" aria-label="Role"${dis}>${['editor', 'doer', 'viewer'].map((r) => html`<option value="${r}"${p.role === r ? html` selected` : ''}>${cap(r)}</option>`)}</select>
        <label class="checkline" style="font-weight:400"><input type="checkbox" name="active" value="1"${p.active ? html` checked` : ''}${dis}> Yes</label>
        ${d.viewerIsOwner ? html`<label class="checkline" style="font-weight:400" title="Owners see who was responsible for each rework"><input type="checkbox" name="is_owner" value="1"${p.is_owner ? html` checked` : ''}> Yes</label>` : ''}
        <label class="checkline" style="font-weight:400" title="Nudges and flags by email"><input type="checkbox" name="email_digest" value="1"${p.email_digest ? html` checked` : ''}${dis}> Yes</label>
        <label class="checkline" style="font-weight:400" title="May change stock: items, counts, the order list, whatever their role"><input type="checkbox" name="can_stock" value="1"${p.can_stock ? html` checked` : ''}${dis}> Yes</label>
        ${locked ? html`<span class="muted small">Only an owner can change this person.</span>` : html`<button class="btn small" type="submit">Save</button>`}
        <div class="areas" style="grid-column:1 / -1"><span class="muted small">Areas:</span>${PEOPLE_AREAS.map((a) => html`<label class="checkline small" style="min-height:28px;font-weight:400"><input type="checkbox" name="areas" value="${a.area}"${p.areas.includes(a.area) ? html` checked` : ''}${dis}> ${a.label}</label>`)}</div></form></td></tr>`;
      })}
    </tbody></table></div>
    <form method="post" action="/settings/people" class="fixgrid">
      <label class="f">Name<input name="name" required></label>
      <label class="f">Email<input name="email" type="email" required></label>
      <label class="f">Role<select name="role"><option value="viewer">Viewer</option><option value="doer">Doer</option><option value="editor">Editor</option></select></label>
      ${d.viewerIsOwner ? html`<label class="checkline"><input type="checkbox" name="is_owner" value="1"> Owner</label>` : ''}
      <label class="checkline" title="May change stock whatever their role"><input type="checkbox" name="can_stock" value="1"> Stock</label>
      <div class="areas" style="grid-column:1 / -1"><span class="muted small">Areas:</span>${PEOPLE_AREAS.map((a) => html`<label class="checkline small" style="min-height:28px;font-weight:400"><input type="checkbox" name="areas" value="${a.area}"> ${a.label}</label>`)}</div>
      <button class="btn primary" type="submit" style="align-self:end">Add person</button>
    </form></section>
  ${d.extra ?? ''}`;
}
