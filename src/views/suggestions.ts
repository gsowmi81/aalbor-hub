// The Suggestions screen, and the small "Pending suggestions" panels on Coming up and One job.
import { html, Html } from '../web/html.js';
import { fmtLong, fmtShort, Iso, sydneyDate } from '../domain/dates.js';
import { KINDS } from '../domain/steps.js';
import { PRIORITIES, STATUS_LABEL, STATUSES, showValue, Suggestion } from '../db/suggestions.js';

const PRIORITY_LABEL = { urgent: 'Urgent', normal: 'Normal', info: 'For info' } as const;
const TYPE_LABEL = { update_date: 'Date', update_status: 'Status', tick_confirmed: 'Confirmed', add_job: 'Add job', note: 'Note' } as const;

export function age(ts: string, now = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(ts).getTime()) / 60000));
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

const TEMPLATE_NAME: Record<string, string> = { kitchen_poly: 'Kitchen, polyurethane painted doors', kitchen_melamine: 'Kitchen, melamine doors' };

const showDate = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtLong(v as Iso) : v);

/** "Install cabinets, start" / "Job status" / "Add job". */
export function whatLabel(s: Suggestion): string {
  if (s.type === 'add_job') return 'Add job';
  if (s.type === 'note') return s.stage_key ? `Note on ${KINDS[s.stage_key].label}` : 'Note';
  if (!s.stage_key) return 'Job status';
  const stage = KINDS[s.stage_key].label;
  if (s.type === 'update_date') return `${stage}, ${s.field === 'end_date' ? 'end' : 'start'}`;
  if (s.type === 'tick_confirmed') return `${stage}, confirmed`;
  return `${stage}, done`;
}

function change(s: Suggestion): Html {
  if (s.type === 'note') return html`<span>${s.proposed_value ?? ''}</span>`;
  if (s.type === 'add_job') {
    const p = s.payload;
    if (!p) return html``;
    const stages = Object.entries(p.stages ?? {}).filter(([, d]) => d?.start_date)
      .map(([k, d]) => `${KINDS[k as keyof typeof KINDS]?.label ?? k} ${fmtShort(d!.start_date!)}${d!.end_date && d!.end_date !== d!.start_date ? ` to ${fmtShort(d!.end_date)}` : ''}`);
    return html`<span><strong>${p.client_name}</strong>${p.suburb ? `, ${p.suburb}` : ''}${p.template || p.door_finish ? ` · ${TEMPLATE_NAME[p.template ?? ''] ?? p.template ?? (p.door_finish === 'polyurethane' ? 'Polyurethane doors' : 'Melamine doors')}` : ''}${p.site_start ? ` · site start ${fmtShort(p.site_start)}` : ''}</span>
      <span class="muted small">${stages.length ? stages.join(' · ') : 'No stage dates: every step starts as No date.'}</span>`;
  }
  const cur = showValue(s, s.current_value), pro = showValue(s, s.proposed_value);
  return html`<span><span class="muted">${s.type === 'update_date' ? showDate(s.current_value) ?? cur : cur}</span> → <strong>${s.type === 'update_date' ? showDate(s.proposed_value) ?? pro : pro}</strong></span>`;
}

function priorityTag(s: Suggestion): Html {
  return s.priority === 'urgent' ? html`<span class="pill over">Urgent</span>` : s.priority === 'info' ? html`<span class="tag">For info</span>` : html``;
}

function row(s: Suggestion, editor: boolean, select = true): Html {
  const pending = s.status === 'pending';
  const decided = !pending ? html`<div class="small"><span class="pill${s.status === 'failed' ? ' over' : s.status === 'accepted' ? '' : ' warn'}">${STATUS_LABEL[s.status]}</span>
      ${s.decided_by_name ? html` by ${s.decided_by_name}` : s.decided_by_token ? html` by the bot (${s.decided_by_token_name ?? 'API'})` : ''}${s.decided_at ? html` · ${fmtLong(sydneyDate(s.decided_at))}` : ''}
      ${s.failure ? html` · ${s.failure}` : ''}${s.decision_note ? html` · “${s.decision_note}”` : ''}
      ${s.superseded_by ? html` · by #${s.superseded_by}` : ''}</div>` : '';
  return html`<div class="item stack sugg" id="s-${s.id}">
    <div class="inline" style="align-items:flex-start;gap:10px;flex-wrap:nowrap">
      ${editor && pending && select ? html`<input type="checkbox" name="ids" value="${s.id}" aria-label="Select suggestion ${s.id}" style="width:22px;height:22px;margin-top:2px;flex:none">` : ''}
      <div style="flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:3px">
        <div><strong>${whatLabel(s)}</strong> ${priorityTag(s)}</div>
        ${change(s)}
        ${s.reason ? html`<span class="muted small">${s.reason}</span>` : ''}
        <span class="muted small">#${s.id} · ${s.source} · ${age(s.created_at)}</span>
        ${decided}
      </div>
    </div>
    ${editor && pending ? html`<div class="inline" style="gap:6px">
      <input type="text" name="note_${s.id}" placeholder="Note (optional)" aria-label="Note for suggestion ${s.id}" style="flex:1 1 160px;min-width:0">
      <button class="btn small primary" type="submit" name="act" value="accept:${s.id}">Accept</button>
      <button class="btn small" type="submit" name="act" value="decline:${s.id}">Decline</button>
      <button class="btn small" type="submit" name="act" value="bt_wrong:${s.id}">Buildertrend is wrong</button>
    </div>` : ''}
  </div>`;
}

function groupByJob(list: Suggestion[]): { key: string; title: string; jobId: number | null; items: Suggestion[] }[] {
  const groups = new Map<string, { key: string; title: string; jobId: number | null; items: Suggestion[]; rank: number }>();
  for (const s of list) {
    const key = s.job_number ?? `no-job`;
    const g = groups.get(key) ?? { key, title: s.job_number ? `${s.job_number}${s.client_name ? ` · ${s.client_name}` : s.payload?.client_name ? ` · ${s.payload.client_name} (new)` : ''}` : 'Not about one job', jobId: s.job_id, items: [], rank: 9 };
    g.items.push(s);
    g.rank = Math.min(g.rank, PRIORITIES.indexOf(s.priority));
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
}

/** The rows inside one form, so the bulk buttons and each row's buttons post together. */
function form(list: Suggestion[], editor: boolean, back: string, bulk: boolean): Html {
  const pendingN = list.filter((s) => s.status === 'pending').length;
  return html`<form method="post" action="/suggestions/act" class="stack" style="gap:12px">
    <input type="hidden" name="back" value="${back}">
    ${editor ? html`<button type="submit" name="act" value="none" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px">Enter</button>` : ''}
    ${editor && bulk && pendingN > 1 ? html`<div class="inline" style="gap:6px">
      <span class="muted small">Tick the ones you want, then:</span>
      <button class="btn small primary" type="submit" name="act" value="accept-selected">Accept selected</button>
      <button class="btn small" type="submit" name="act" value="decline-selected">Decline selected</button>
    </div>` : ''}
    ${groupByJob(list).map((g) => html`<section class="panel" style="gap:2px">
      <div class="row"><h2>${g.jobId ? html`<a href="/jobs/${g.jobId}" style="color:inherit">${g.title}</a>` : g.title}</h2><span class="muted small">${g.items.length} ${g.items.length === 1 ? 'suggestion' : 'suggestions'}</span></div>
      ${g.items.map((s) => row(s, editor))}
    </section>`)}
  </form>`;
}

export interface SuggestionsPageData {
  list: Suggestion[];
  editor: boolean;
  filter: { status: string; priority: string; job: string; date: string; batch: string };
  pending: number;
}

export function suggestionsPage(d: SuggestionsPageData): Html {
  const f = d.filter;
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const back = `/suggestions${qs ? `?${qs}` : ''}`;
  const opt = (value: string, label: string, current: string) => html`<option value="${value}"${value === current ? html` selected` : ''}>${label}</option>`;
  return html`
  <p class="muted">The bot compares the hub with Buildertrend each weekday and suggests changes here. Nothing changes until ${d.editor ? 'you accept' : 'an Editor accepts'}.
    Accepting a date also ticks it Confirmed. If the hub has changed since the bot looked, the suggestion is marked “Couldn't apply” and nothing changes.</p>
  <form method="get" action="/suggestions" class="panel" style="gap:10px">
    <div class="inline" style="gap:10px;align-items:flex-end">
      <label class="f">Status<select name="status">${opt('pending', 'Waiting', f.status)}${STATUSES.filter((s) => s !== 'pending').map((s) => opt(s, STATUS_LABEL[s], f.status))}${opt('all', 'All', f.status)}</select></label>
      <label class="f">Priority<select name="priority">${opt('', 'Any', f.priority)}${PRIORITIES.map((p) => opt(p, PRIORITY_LABEL[p], f.priority))}</select></label>
      <label class="f">Job number<input type="text" name="job" value="${f.job}" style="width:9em"></label>
      <label class="f">Sent on<input type="date" name="date" value="${f.date}"></label>
      ${f.batch ? html`<input type="hidden" name="batch" value="${f.batch}">` : ''}
      <button class="btn" type="submit">Show</button>
      ${qs && qs !== 'status=pending' ? html`<a class="btn" href="/suggestions">Clear</a>` : ''}
    </div>
    ${f.batch ? html`<span class="muted small">Only batch ${f.batch}. <a href="/suggestions">Show all waiting</a></span>` : ''}
  </form>
  ${d.editor && d.pending ? html`<details class="pop"><summary class="btn small">Supersede all ${d.pending} waiting</summary>
    <form class="popbody" method="post" action="/suggestions/supersede-pending">
      <span class="small">Marks every waiting suggestion “Replaced by a newer one”, for when the bot is about to post a fresh rebuild. Nothing in any job changes, and accepted, declined and the rest stay as they are.</span>
      <label class="f">Why (shown on each one)<input name="reason" maxlength="300" placeholder="e.g. Schedules rewritten, fresh rebuild coming"></label>
      <div class="acts"><button class="btn small danger" type="submit">Yes, supersede ${d.pending}</button></div></form></details>` : ''}
  ${d.list.length ? form(d.list, d.editor, back, true) : html`<section class="panel"><strong>${f.status === 'pending' && !f.job && !f.priority && !f.date && !f.batch ? 'Nothing waiting. The bot will add more after its next look at Buildertrend.' : 'No suggestions match.'}</strong></section>`}`;
}

/** Coming up: how many are waiting, the urgent ones first. */
export function pendingPanel(list: Suggestion[]): Html {
  if (!list.length) return html``;
  const urgent = list.filter((s) => s.priority === 'urgent').length;
  return html`<section class="panel" id="suggestions" style="gap:2px">
    <div class="row"><h2>Pending suggestions</h2><a class="btn small" href="/suggestions">Review ${list.length}</a></div>
    <div class="muted small" style="padding-bottom:4px">From the bot's Buildertrend check${urgent ? html`; <strong>${urgent} urgent</strong>` : ''}.</div>
    ${list.slice(0, 6).map((s) => html`<div class="item"><div class="what"><div>${s.job_id ? html`<a href="/jobs/${s.job_id}#suggestions" style="color:inherit">${s.job_number}${s.client_name ? ` · ${s.client_name}` : ''}</a>` : s.job_number ?? 'Note'} · ${whatLabel(s)} ${priorityTag(s)}</div>
      <div class="small">${change(s)}</div></div></div>`)}
    ${list.length > 6 ? html`<div class="item"><a href="/suggestions">${list.length - 6} more</a></div>` : ''}
  </section>`;
}

/** One job: its waiting suggestions, with the same buttons as the Suggestions screen. */
export function jobPanel(list: Suggestion[], editor: boolean, jobId: number): Html {
  if (!list.length) return html``;
  return html`<section class="panel" id="suggestions" style="gap:6px">
    <div class="row"><h2>Pending suggestions</h2><a class="small" href="/suggestions?job=${encodeURIComponent(list[0].job_number ?? '')}">All for this job</a></div>
    <div class="muted small">From the bot's Buildertrend check. Accepting a date also ticks it Confirmed.</div>
    <form method="post" action="/suggestions/act" class="stack" style="gap:0">
      <input type="hidden" name="back" value="/jobs/${jobId}#suggestions">
      ${editor ? html`<button type="submit" name="act" value="none" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px">Enter</button>` : ''}
      ${list.map((s) => row(s, editor, false))}
    </form>
  </section>`;
}

export interface TokenRow { id: number; name: string; created_at: string; created_by_name: string | null; last_used_at: string | null; revoked_at: string | null }
export interface CallRow { at: string; method: string; path: string; status: number; items: number | null; token_name: string | null }

const when = (t: string) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t));

/** Settings: the suggestions email (Editors) and API tokens (owners only). */
export function suggestionSettings(d: { email: string; isOwner: boolean; tokens: TokenRow[]; calls: CallRow[]; newToken?: { name: string; token: string } }): Html {
  const shown = d.newToken ? html`<div class="notice ok" role="status" style="display:flex;flex-direction:column;gap:6px">
      <span>New API token for ${d.newToken.name}. Copy it now: the hub keeps only a scrambled copy and can't show it again.</span>
      <input type="text" readonly value="${d.newToken.token}" aria-label="The new API token" style="font-family:var(--mono);font-size:14px" onclick="this.select()">
      <span class="small" style="font-weight:400">Store it where the bot keeps its secrets (not in a chat or email). Send it as the header <code>Authorization: Bearer &lt;token&gt;</code>.</span>
    </div>` : '';
  return html`
  <section class="panel" id="suggestions-email"><h2>Suggestions email</h2>
    <p class="muted small">When the bot sends a batch with anything urgent or normal in it, one email goes to this address. Batches that are only “for info” send nothing.</p>
    <form method="post" action="/settings/suggestions-email" class="fixgrid">
      <label class="f">Email new suggestions to<input type="email" name="email" value="${d.email}" required></label>
      <button class="btn primary" type="submit" style="align-self:end">Save</button>
    </form>
  </section>
  ${d.isOwner ? html`<section class="panel" id="api-tokens"><h2>API tokens</h2>
    ${shown}
    <p class="muted small">A token lets a bot add and read suggestions and read jobs. It can't change anything in the hub. Only owners see this. Revoke a token the moment it might have leaked, then make a new one.</p>
    <form method="post" action="/settings/tokens" class="fixgrid">
      <label class="f">Name (who uses it)<input name="name" required placeholder="e.g. Grokbot"></label>
      <button class="btn primary" type="submit" style="align-self:end">Make a token</button>
    </form>
    <div class="tbl"><table><thead><tr><th>Name</th><th>Made</th><th>Last used</th><th></th></tr></thead><tbody>
      ${d.tokens.length ? d.tokens.map((t) => html`<tr><td>${t.name}</td><td>${when(t.created_at)}${t.created_by_name ? ` by ${t.created_by_name}` : ''}</td><td>${t.last_used_at ? when(t.last_used_at) : 'Never'}</td>
        <td>${t.revoked_at ? html`<span class="muted small">Revoked ${when(t.revoked_at)}</span>` : html`<form method="post" action="/settings/tokens/${t.id}/revoke"><button class="btn small danger" type="submit">Revoke</button></form>`}</td></tr>`)
        : html`<tr><td colspan="4" class="muted">No tokens yet.</td></tr>`}
    </tbody></table></div>
    <details><summary style="cursor:pointer"><strong>Recent API calls</strong> <span class="muted small">last ${d.calls.length}</span></summary>
      <div class="tbl"><table><thead><tr><th>When</th><th>Token</th><th>Call</th><th>Result</th><th>Items</th></tr></thead><tbody>
        ${d.calls.map((c) => html`<tr><td>${when(c.at)}</td><td>${c.token_name ?? html`<span class="muted">none</span>`}</td><td><code>${c.method} ${c.path}</code></td><td>${c.status}</td><td>${c.items ?? ''}</td></tr>`)}
      </tbody></table></div></details>
  </section>` : ''}`;
}
