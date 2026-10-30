import { html, Html } from '../web/html.js';
import { fmtLong, fmtRange, fmtShort, Iso, sydneyDate } from '../domain/dates.js';
import { KINDS, ProposedStep } from '../domain/steps.js';
import { CapacityWarning } from '../domain/checks.js';
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
  error?: string;
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
    <section class="panel" id="proposal" aria-live="polite">${proposalBlock(d.proposal, d.clashes, d.siteStartWorkedOut)}</section>
  </div>`;
}

export function proposalBlock(proposal: ProposedStep[] | null, clashes: CapacityWarning[], siteStartWorkedOut: string | null = null): Html {
  if (!proposal) return html`<h2>Proposed dates</h2><p class="muted">Fill in the site start, or pick another date to work from and fill that in, then tap Show proposed dates.</p>`;
  return html`<h2>Proposed dates</h2>
    ${siteStartWorkedOut ? html`<p class="small">Site start worked out as <strong>${fmtShort(siteStartWorkedOut)}</strong>. Type the real one if you know it.</p>` : ''}
    ${clashes.length ? html`<div class="notice bad">${clashes.map((c) => html`<div>${c.decision.title}: ${c.decision.fact}</div>`)}</div>` : html`<p class="muted small">No capacity clashes with jobs already booked.</p>`}
    <div>${proposal.map((p) => html`<div class="kv"><span>${KINDS[p.kind].label}</span><strong>${fmtRange(p.start_date, p.end_date)}</strong></div>`)}</div>`;
}

// ---------- Rework ----------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function reworkPage(d: { person: Person; rework: (ReworkFull & { client_name: string; suburb: string })[]; jobs: { id: number; client_name: string; suburb: string }[]; today: Iso; responsible: Map<number, Responsible>; peopleNames: string[] }): Html {
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
  ${can(d.person, 'doer') ? html`<section class="panel"><h2>Raise rework</h2><p class="muted small">Pick the job, pick a cause, one line on what happened. Christine dates the steps.</p>${raiseForm(null, '/rework', d.jobs, d.person, d.peopleNames)}</section>` : ''}
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

// ---------- Settings ----------

export function settingsPage(d: {
  settings: { key: string; value: number; label: string }[];
  blocked: { id: number; day: Iso; scope: string; reason: string }[];
  people: { id: number; name: string; email: string; role: string; active: boolean; is_owner: boolean }[];
  today: Iso;
  templates: Template[];
  viewerIsOwner: boolean;
}): Html {
  const upcoming = d.blocked.filter((b) => b.day >= d.today);
  return html`
  <section class="panel"><div class="row"><h2>Spreadsheet</h2><a class="btn" href="/export.xlsx">Download jobs, steps and rework (.xlsx)</a></div></section>

  <section class="panel"><h2>Capacities and default durations</h2>
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

  <section class="panel"><h2>People</h2>
    <p class="muted small">Only these addresses can sign in. Editors change anything; Doers tick steps and raise rework; Viewers look. Switch someone off rather than deleting them, so the history keeps their name.${d.viewerIsOwner ? ' Owners (you see this column because you are one) also see who was responsible for each rework; only an owner can make someone an owner.' : ''}</p>
    <div class="tbl"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Can sign in</th>${d.viewerIsOwner ? html`<th>Owner</th>` : ''}<th></th></tr></thead><tbody>
      ${d.people.map((p) => {
        const locked = p.is_owner && !d.viewerIsOwner;
        const cols = d.viewerIsOwner ? 'minmax(120px,1fr) minmax(180px,1.5fr) 120px 110px 90px auto' : 'minmax(120px,1fr) minmax(180px,1.5fr) 120px 110px auto';
        const dis = locked ? html` disabled` : '';
        return html`<tr><td colspan="${d.viewerIsOwner ? 6 : 5}" style="padding:0;border:0"><form method="post" action="/settings/people/${p.id}" style="display:grid;grid-template-columns:${cols};gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);align-items:center;min-width:${d.viewerIsOwner ? 740 : 640}px">
        <input name="name" value="${p.name}" required aria-label="Name"${dis}><input name="email" type="email" value="${p.email}" required aria-label="Email"${dis}>
        <select name="role" aria-label="Role"${dis}>${['editor', 'doer', 'viewer'].map((r) => html`<option value="${r}"${p.role === r ? html` selected` : ''}>${cap(r)}</option>`)}</select>
        <label class="checkline" style="font-weight:400"><input type="checkbox" name="active" value="1"${p.active ? html` checked` : ''}${dis}> Yes</label>
        ${d.viewerIsOwner ? html`<label class="checkline" style="font-weight:400" title="Owners see who was responsible for each rework"><input type="checkbox" name="is_owner" value="1"${p.is_owner ? html` checked` : ''}> Yes</label>` : ''}
        ${locked ? html`<span class="muted small">Only an owner can change this person.</span>` : html`<button class="btn small" type="submit">Save</button>`}</form></td></tr>`;
      })}
    </tbody></table></div>
    <form method="post" action="/settings/people" class="fixgrid">
      <label class="f">Name<input name="name" required></label>
      <label class="f">Email<input name="email" type="email" required></label>
      <label class="f">Role<select name="role"><option value="viewer">Viewer</option><option value="doer">Doer</option><option value="editor">Editor</option></select></label>
      ${d.viewerIsOwner ? html`<label class="checkline"><input type="checkbox" name="is_owner" value="1"> Owner</label>` : ''}
      <button class="btn primary" type="submit" style="align-self:end">Add person</button>
    </form></section>`;
}
