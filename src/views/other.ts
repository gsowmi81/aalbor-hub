import { html, Html } from '../web/html.js';
import { fmtLong, fmtRange, fmtShort, Iso, sydneyDate } from '../domain/dates.js';
import { KINDS, ProposedStep } from '../domain/steps.js';
import { CapacityWarning } from '../domain/checks.js';
import type { FullJob, ReworkFull } from '../db/queries.js';
import { can, Person } from '../web/auth.js';
import { CAUSES, jobFields, raiseForm } from './job.js';

// ---------- New job ----------

export function newJobPage(d: { values: Partial<FullJob>; proposal: ProposedStep[] | null; clashes: CapacityWarning[]; error?: string }): Html {
  return html`<div class="job">
    <p class="muted">One short form. The hub proposes every date from today and the site start, all provisional. You can change any of them on the job afterwards.</p>
    ${d.error ? html`<div class="notice bad">${d.error}</div>` : ''}
    <form method="post" action="/jobs/new" class="panel" id="newjob">
      ${jobFields(d.values, { forNew: true })}
      <div class="acts">
        <button class="btn" type="submit" name="action" value="preview">Show proposed dates</button>
        <button class="btn primary" type="submit" name="action" value="save">Add the job</button>
      </div>
    </form>
    <section class="panel" id="proposal" aria-live="polite">${proposalBlock(d.proposal, d.clashes)}</section>
  </div>`;
}

export function proposalBlock(proposal: ProposedStep[] | null, clashes: CapacityWarning[]): Html {
  if (!proposal) return html`<h2>Proposed dates</h2><p class="muted">Fill in the site start, then tap Show proposed dates.</p>`;
  return html`<h2>Proposed dates</h2>
    ${clashes.length ? html`<div class="notice bad">${clashes.map((c) => html`<div>${c.decision.title}: ${c.decision.fact}</div>`)}</div>` : html`<p class="muted small">No capacity clashes with jobs already booked.</p>`}
    <div>${proposal.map((p) => html`<div class="kv"><span>${KINDS[p.kind].label}</span><strong>${fmtRange(p.start_date, p.end_date)}</strong></div>`)}</div>`;
}

// ---------- Rework ----------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function reworkPage(d: { person: Person; rework: (ReworkFull & { client_name: string; suburb: string })[]; jobs: { id: number; client_name: string; suburb: string }[]; today: Iso }): Html {
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
    <a class="btn small" href="/jobs/${r.job_id}#rework">Open</a></div>`;

  return html`
  ${can(d.person, 'doer') ? html`<section class="panel"><h2>Raise rework</h2><p class="muted small">Pick the job, pick a cause, one line on what happened. Christine dates the steps.</p>${raiseForm(null, '/rework', d.jobs)}</section>` : ''}
  <div class="two">
    <section class="panel"><div class="row"><h2>Open</h2><span class="muted small">${open.length}</span></div><div>${open.length ? open.map(item) : html`<p>No open rework.</p>`}</div></section>
    <section class="panel"><h2>Monthly tally</h2><p class="muted small">By the month rework was raised. Hours and dollars come in when it's closed.</p>
      <div class="tbl"><table><thead><tr><th>Month</th><th>Cause</th><th class="num">Count</th><th class="num">Extra hours</th><th class="num">Extra material</th></tr></thead><tbody>${tallyRows}</tbody></table></div></section>
  </div>
  <section class="panel"><h2>Closed</h2><div>${closed.length ? closed.map(item) : html`<p class="muted">Nothing closed yet.</p>`}</div></section>`;
}

// ---------- Settings ----------

export function settingsPage(d: {
  settings: { key: string; value: number; label: string }[];
  blocked: { id: number; day: Iso; scope: string; reason: string }[];
  people: { id: number; name: string; email: string; role: string; active: boolean }[];
  today: Iso;
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
    <p class="muted small">Only these addresses can sign in. Editors change anything; Doers tick steps and raise rework; Viewers look. Switch someone off rather than deleting them, so the history keeps their name.</p>
    <div class="tbl"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Can sign in</th><th></th></tr></thead><tbody>
      ${d.people.map((p) => html`<tr><td colspan="5" style="padding:0;border:0"><form method="post" action="/settings/people/${p.id}" style="display:grid;grid-template-columns:minmax(120px,1fr) minmax(180px,1.5fr) 120px 110px auto;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);align-items:center;min-width:640px">
        <input name="name" value="${p.name}" required aria-label="Name"><input name="email" type="email" value="${p.email}" required aria-label="Email">
        <select name="role" aria-label="Role">${['editor', 'doer', 'viewer'].map((r) => html`<option value="${r}"${p.role === r ? html` selected` : ''}>${cap(r)}</option>`)}</select>
        <label class="checkline" style="font-weight:400"><input type="checkbox" name="active" value="1"${p.active ? html` checked` : ''}> Yes</label>
        <button class="btn small" type="submit">Save</button></form></td></tr>`)}
    </tbody></table></div>
    <form method="post" action="/settings/people" class="fixgrid">
      <label class="f">Name<input name="name" required></label>
      <label class="f">Email<input name="email" type="email" required></label>
      <label class="f">Role<select name="role"><option value="viewer">Viewer</option><option value="doer">Doer</option><option value="editor">Editor</option></select></label>
      <button class="btn primary" type="submit" style="align-self:end">Add person</button>
    </form></section>`;
}
