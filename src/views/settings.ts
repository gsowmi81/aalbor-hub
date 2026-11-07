// Settings as pages (George, 7 Nov 2026; redesign C): a menu with one line of status per page,
// then short pages. People are cards. Only Editors come here; they come to fix the things that
// make the other screens wrong (areas, minimums, flag types), so each page is quick.
import { html, Html } from '../web/html.js';
import { fmtShort, Iso } from '../domain/dates.js';
import { PEOPLE_AREAS } from '../domain/steps.js';
import type { CapacityInput } from '../domain/checks.js';
import type { IssueType } from '../db/queries.js';
import type { Template } from '../domain/schedule.js';

export const SETTINGS_PAGES = [
  { key: 'people', label: 'People', sub: 'Who can sign in, their role, areas and switches' },
  { key: 'capacity', label: 'Capacity', sub: 'Hours a day per area; leave and shutdowns' },
  { key: 'job-types', label: 'Job types', sub: 'What a new job gets by default' },
  { key: 'durations', label: 'Durations and limits', sub: 'The working-day rules behind proposed dates' },
  { key: 'blocked-days', label: 'Blocked days', sub: 'Public holidays, shutdowns, clean-outs' },
  { key: 'flag-types', label: 'Flagged problems', sub: 'Who looks after each kind of problem' },
  { key: 'emails', label: 'Emails', sub: 'The 7 am run, and what it would send today' },
  { key: 'message', label: 'Message', sub: 'One line at the top of My day and the Board' },
  { key: 'tv', label: 'Factory TV', sub: 'The link for the screen on the wall' },
  { key: 'bot', label: 'Buildertrend bot', sub: 'Where suggestions are emailed; API tokens' },
] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number]['key'];

export interface SettingsData {
  settings: { key: string; value: number; label: string }[];
  blocked: { id: number; day: Iso; scope: string; reason: string }[];
  people: { id: number; name: string; email: string; role: string; active: boolean; is_owner: boolean; areas: string[]; email_digest: boolean; can_stock: boolean }[];
  tvKey: string;
  appUrl: string;
  today: Iso;
  templates: Template[];
  viewerIsOwner: boolean;
  message: string;
  cap: CapacityInput;
  issueTypes: IssueType[];
  runs: { day: Iso; kind: string; sent: number; ran_at: string }[];
  preview: boolean;
  nudgeTo: string | null;
  /** Suggestions email and, for owners, API tokens (views/suggestions.ts). */
  extra?: Html;
  /** The emails page: what the 7 am run would send today. */
  todaysNudges?: { subject: string; to: { name: string; email: string }; lines: string[] }[];
  /** How many tokens are live, for the menu line (owners). */
  liveTokens?: number;
  /** Installers who sign in only by a job link (George, 7 Nov 2026). */
  installers?: { id: number; name: string; active: boolean; jobs: string[] }[];
  /** Saturdays are working days (the switch on the Capacity page). */
  saturdays?: boolean;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ROLE: Record<string, string> = { editor: 'Editor', doer: 'Doer', viewer: 'Viewer' };

/** One line of status per page: what an Editor needs to know before opening it. */
export function settingsStatus(d: SettingsData): Record<SettingsPage, string> {
  const active = d.people.filter((p) => p.active);
  const noAreas = active.filter((p) => p.role !== 'viewer' && !p.areas.length).length;
  const upcoming = d.blocked.filter((b) => b.day >= d.today);
  const nobody = d.issueTypes.filter((t) => t.active && !t.responsible).length;
  const week = (c: CapacityInput['centres'][number]) => Math.round((c.mon + c.tue + c.wed + c.thu + c.fri + (d.saturdays ? c.sat : 0)) * 10) / 10;
  const lastRun = d.runs[0];
  return {
    people: `${active.length} can sign in${noAreas ? ` · ${noAreas} with no areas set` : ''}`,
    capacity: `${d.saturdays ? 'Saturdays on · ' : ''}${d.cap.centres.map((c) => `${c.label} ${week(c)} h a week`).join(' · ')}${d.cap.adjustments.filter((a) => a.to_day >= d.today).length ? ` · ${d.cap.adjustments.filter((a) => a.to_day >= d.today).length} adjustment(s) ahead` : ''}`,
    'job-types': d.templates.map((t) => t.name).join(' · ') || 'None',
    durations: `${d.settings.filter((s) => s.key !== 'saturday_working').length} rules`,
    'blocked-days': `${upcoming.length} days ahead${upcoming[0] ? `, next ${fmtShort(upcoming[0].day)}` : ''}`,
    'flag-types': `${d.issueTypes.filter((t) => t.active).length} kinds${nobody ? ` · ${nobody} with no one responsible` : ''}`,
    emails: lastRun ? `Last run ${fmtShort(lastRun.day)}, ${lastRun.sent} sent` : 'No runs yet',
    message: d.message ? `"${d.message.slice(0, 60)}${d.message.length > 60 ? '…' : ''}"` : 'Nothing shown',
    tv: d.tvKey ? 'Link made' : 'No link yet',
    bot: `${d.liveTokens != null ? `${d.liveTokens} live token(s) · ` : ''}suggestions by email`,
  };
}

export function settingsMenu(d: SettingsData): Html {
  const status = settingsStatus(d);
  const warn = (k: SettingsPage) => (k === 'people' && status.people.includes('no areas')) || (k === 'flag-types' && status['flag-types'].includes('no one')) || (k === 'tv' && !d.tvKey);
  return html`<div class="tiles more smenu">
    ${SETTINGS_PAGES.map((p) => html`<a class="tile${warn(p.key) ? ' warn' : ''}" href="/settings/${p.key}"><span>${p.label}</span><small>${p.sub}</small><em>${status[p.key]}</em></a>`)}
    <a class="tile" href="/export.xlsx"><span>Spreadsheet</span><small>Download jobs, steps and rework (.xlsx)</small><em>Every job, every date</em></a>
  </div>`;
}

export function settingsNav(current: SettingsPage): Html {
  return html`<nav class="subtabs" aria-label="Settings"><div class="seg"><a href="/settings">All settings</a>${SETTINGS_PAGES.map((p) => html`<a href="/settings/${p.key}"${p.key === current ? html` aria-current="true"` : ''}>${p.label}</a>`)}</div></nav>`;
}

export function settingsPageBody(pageKey: SettingsPage, d: SettingsData): Html {
  const body = PAGES[pageKey](d);
  return html`${settingsNav(pageKey)}${body}`;
}

const PAGES: Record<SettingsPage, (d: SettingsData) => Html> = {
  message: (d) => html`<section class="panel" id="message"><h2>Message on My day and the Board</h2>
    <form method="post" action="/settings/message" class="inline">
      <input name="message" value="${d.message}" maxlength="200" placeholder="e.g. Factory clean-out Friday afternoon" aria-label="Message" style="flex:1 1 300px">
      <button class="btn primary" type="submit">Save</button>
    </form>
    <span class="muted small">One line everyone sees at the top of My day and the Board. Leave it empty to show nothing.</span></section>`,

  capacity: (d) => html`<section class="panel" id="saturday"><h2>Saturdays</h2>
    <form method="post" action="/settings/saturday" class="inline">
      <label class="checkline"><input type="checkbox" name="saturday" value="1"${d.saturdays ? html` checked` : ''}> Saturdays are working days</label>
      <button class="btn small" type="submit">Save</button>
    </form>
    <span class="muted small">Off: dates skip Saturdays, and one on a Saturday shows under Needs a decision. On: dates can land on Saturdays, the Board, Factory TV and Load show a Saturday column, and each crew's Saturday hours below count. Sundays are never working days.</span>
  </section>
  <section class="panel" id="capacity"><h2>Capacity, in hours a day</h2>
    <p class="muted small">A kitchen's factory or install day counts as the hours set under Durations ("Hours in a factory or install day"); a rework task counts its own hours. The hub warns when a week's bookings pass the hours available, and <a href="/load">Load</a> shows the next six weeks day by day.</p>
    ${d.cap.centres.map((c) => html`<form method="post" action="/settings/centres/${c.key}" class="inline" style="padding-top:8px;border-top:1px solid var(--line)">
      <strong style="flex:1 1 120px">${c.label}</strong>
      ${(d.saturdays ? ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const : ['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((k) => html`<label class="f" style="width:72px">${cap(k)}<input name="${k}" inputmode="decimal" value="${c[k]}" required pattern="[0-9]+([.][0-9])?"></label>`)}
      <span class="muted small">= ${Math.round((c.mon + c.tue + c.wed + c.thu + c.fri + (d.saturdays ? c.sat : 0)) * 10) / 10} h a week</span>
      <button class="btn small" type="submit">Save</button></form>`)}
  </section>
  <section class="panel"><h2>Leave, shutdowns and extra hands</h2>
    <p class="muted small">A period with different hours a day in one area: 0 for a shutdown, less for someone on leave, more for an extra pair of hands. Public holidays and blocked days are already 0.</p>
    <form method="post" action="/settings/adjustments" class="fixgrid">
      <label class="f">Area<select name="centre">${d.cap.centres.map((c) => html`<option value="${c.key}">${c.label}</option>`)}</select></label>
      <label class="f">From<input type="date" name="from" required></label>
      <label class="f">To (optional)<input type="date" name="to"></label>
      <label class="f">Hours a day<input name="hours" inputmode="decimal" required pattern="[0-9]+([.][0-9])?" placeholder="e.g. 8"></label>
      <label class="f">Reason<input name="reason" required placeholder="e.g. Phil on leave"></label>
      <button class="btn primary" type="submit" style="align-self:end">Add</button>
    </form>
    ${d.cap.adjustments.length ? html`<div class="tbl" tabindex="0"><table><thead><tr><th>Area</th><th>From</th><th>To</th><th class="num">Hours a day</th><th>Reason</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${d.cap.adjustments.filter((a) => a.to_day >= d.today).map((a) => html`<tr><td>${d.cap.centres.find((c) => c.key === a.centre)?.label ?? a.centre}</td><td>${fmtShort(a.from_day)}</td><td>${fmtShort(a.to_day)}</td><td class="num">${a.hours}</td><td>${a.reason}</td>
        <td><form method="post" action="/settings/adjustments/${a.id}/delete"><button class="btn small danger" type="submit">Remove</button></form></td></tr>`)}
    </tbody></table></div>` : html`<p class="muted small">None ahead.</p>`}
  </section>`,

  'flag-types': (d) => html`<section class="panel" id="flags"><h2>Flagged problems: who looks after what</h2>
    <p class="muted small">Anyone who can tick can flag a problem from My day or a step. The flag goes by email to the person here and to the Editors, and sits on Attention until it's marked fixed.</p>
    <div class="cards">${d.issueTypes.map((t) => html`<form method="post" action="/settings/flag-types/${t.key}" class="card-form">
      <strong>${t.label}</strong>
      <label class="f">Looked after by<select name="responsible"><option value="">Editors only</option>${d.people.filter((p) => p.active && p.role !== 'viewer').map((p) => html`<option value="${p.id}"${t.responsible === p.id ? html` selected` : ''}>${p.name}</option>`)}</select></label>
      <div class="row"><label class="checkline" style="font-weight:400"><input type="checkbox" name="active" value="1"${t.active ? html` checked` : ''}> In the list</label><button class="btn small" type="submit">Save</button></div>
    </form>`)}</div></section>`,

  emails: (d) => html`<section class="panel" id="emails"><h2>Emails</h2>
    <p class="muted small">Every weekday at 7 am Sydney time the hub emails whoever owns a step that went overdue the day before, and on Mondays everyone gets their week. A flag emails the person who looks after it and the Editors as it's raised; Materials in, ticked, emails the factory. Untick "Emails" on a person under People to leave them out.${d.preview && d.nudgeTo ? html` <strong>On this preview copy every one of these goes to ${d.nudgeTo} instead of the person.</strong>` : ''}</p>
    ${d.runs.length ? html`<div class="tbl" tabindex="0"><table><thead><tr><th>Day</th><th class="num">Sent</th><th>Ran at</th></tr></thead><tbody>${d.runs.map((r) => html`<tr><td>${fmtShort(r.day)}</td><td class="num">${r.sent}</td><td>${new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false, day: '2-digit', month: 'short' }).format(new Date(r.ran_at))}</td></tr>`)}</tbody></table></div>` : html`<p class="muted small">No runs yet.</p>`}
  </section>
  <section class="panel"><div class="row"><h2>What the 7 am run would send today</h2><span class="muted small">${(d.todaysNudges ?? []).length} ${(d.todaysNudges ?? []).length === 1 ? 'email' : 'emails'}${d.nudgeTo ? html` · on the preview every one goes to ${d.nudgeTo}` : ''}</span></div>
    ${(d.todaysNudges ?? []).length ? (d.todaysNudges ?? []).map((n) => html`<div class="item stack"><div><strong>${n.subject}</strong> <span class="muted small">to ${n.to.name} (${n.to.email})</span></div><div class="small">${n.lines.map((l) => html`<div>${l}</div>`)}</div></div>`) : html`<p class="muted">Nothing to send today: no one has a step that went overdue.</p>`}
    <div class="acts"><form method="post" action="/settings/emails/run"><button class="btn primary" type="submit">Send these now</button></form></div></section>`,

  durations: (d) => html`<section class="panel"><h2>Durations and limits</h2>
    <form method="post" action="/settings/values" class="stack">
      <div class="formgrid">${d.settings.filter((s) => s.key !== 'saturday_working').map((s) => html`<label class="f">${s.label}<input type="number" name="${s.key}" value="${s.value}" min="0" max="200" required></label>`)}</div>
      <div class="acts"><button class="btn primary" type="submit">Save settings</button></div>
      <span class="muted small">Changes apply to new proposals and warnings from now on. Dates already on jobs don't move.</span>
    </form></section>`,

  'job-types': (d) => html`<section class="panel"><h2>Job types</h2>
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
  </section>`,

  'blocked-days': (d) => {
    const upcoming = d.blocked.filter((b) => b.day >= d.today);
    return html`<section class="panel"><h2>Blocked days</h2>
    <p class="muted small">Every step skips "Everyone" days (public holidays, Christmas shutdown). Factory steps also skip "Factory only" days (clean-out, stocktake). NSW public holidays to 2028 are loaded; check them each year.</p>
    <form method="post" action="/settings/blocked" class="fixgrid">
      <label class="f">From<input type="date" name="from" required></label>
      <label class="f">To (optional)<input type="date" name="to"></label>
      <label class="f">Applies to<select name="scope"><option value="factory">Factory only</option><option value="all">Everyone</option></select></label>
      <label class="f">Reason<input name="reason" required placeholder="e.g. Factory clean-out"></label>
      <button class="btn primary" type="submit" style="align-self:end">Add</button>
    </form>
    <div class="tbl" tabindex="0"><table><thead><tr><th>Date</th><th>Applies to</th><th>Reason</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${upcoming.map((b) => html`<tr><td>${fmtShort(b.day)} ${b.day.slice(0, 4)}</td><td>${b.scope === 'all' ? 'Everyone' : 'Factory only'}</td><td>${b.reason}</td>
        <td><form method="post" action="/settings/blocked/${b.id}/delete"><button class="btn small danger" type="submit">Remove</button></form></td></tr>`)}
    </tbody></table></div></section>`;
  },

  tv: (d) => html`<section class="panel" id="tv"><h2>Factory TV</h2>
    <p class="muted small">The factory's week in big type for a screen on the wall: materials in, the factory (cut, painting, delivery) and installs, this week and next, refreshing every two minutes. It opens with a link instead of a sign-in, so keep the link to the factory. Making a new link stops the old one.</p>
    ${d.tvKey ? html`<p><a href="/tv?k=${d.tvKey}" target="_blank" rel="noopener"><code>${d.appUrl}/tv?k=${d.tvKey}</code></a></p>` : html`<p class="muted">No link yet.</p>`}
    <form method="post" action="/settings/tv" class="acts"><button class="btn${d.tvKey ? '' : ' primary'}" type="submit">${d.tvKey ? 'Make a new link' : 'Make the link'}</button><a class="btn" href="/tv" target="_blank" rel="noopener">See it (signed in)</a></form>
  </section>`,

  bot: (d) => html`${d.extra ?? ''}`,

  people: (d) => html`<section class="panel"><h2>People</h2>
    <p class="muted small">Only these addresses can sign in. Editors change anything; Doers tick steps, raise rework, count and pick stock; Viewers look. Switch someone off rather than deleting them, so the history keeps their name. Areas are the Board rows a person works in: their steps make up My day.${d.viewerIsOwner ? ' Owners also see who was responsible for each rework; only an owner can make someone an owner.' : ''}</p>
    <div class="cards people">${d.people.map((p) => {
      const locked = p.is_owner && !d.viewerIsOwner;
      const dis = locked ? html` disabled` : '';
      const flags = [p.active ? '' : 'off', p.is_owner ? 'owner' : '', p.can_stock ? 'stock' : '', p.role !== 'viewer' && !p.areas.length && p.active ? 'no areas' : ''].filter(Boolean);
      return html`<form method="post" action="/settings/people/${p.id}" class="card-form${p.active ? '' : ' off'}">
        <div class="row"><strong>${p.name}</strong><span class="muted small">${ROLE[p.role] ?? p.role}${flags.length ? ` · ${flags.join(' · ')}` : ''}</span></div>
        <div class="fixgrid">
          <label class="f">Name<input name="name" value="${p.name}" required${dis}></label>
          <label class="f">Email<input name="email" type="email" value="${p.email}" required${dis}></label>
          <label class="f">Role<select name="role"${dis}>${['editor', 'doer', 'viewer'].map((r) => html`<option value="${r}"${p.role === r ? html` selected` : ''}>${ROLE[r]}</option>`)}</select></label>
        </div>
        <div class="switches">
          <label class="checkline"><input type="checkbox" name="active" value="1"${p.active ? html` checked` : ''}${dis}> Can sign in</label>
          <label class="checkline" title="Nudges and flags by email"><input type="checkbox" name="email_digest" value="1"${p.email_digest ? html` checked` : ''}${dis}> Gets emails</label>
          <label class="checkline" title="May change stock: items, counts, the order list, whatever their role"><input type="checkbox" name="can_stock" value="1"${p.can_stock ? html` checked` : ''}${dis}> Runs stock</label>
          ${d.viewerIsOwner ? html`<label class="checkline" title="Owners see who was responsible for each rework"><input type="checkbox" name="is_owner" value="1"${p.is_owner ? html` checked` : ''}> Owner</label>` : ''}
        </div>
        <div class="areas"><span class="muted small">Areas</span>${PEOPLE_AREAS.map((a) => html`<label class="chip-check"><input type="checkbox" name="areas" value="${a.area}"${p.areas.includes(a.area) ? html` checked` : ''}${dis}> ${a.label}</label>`)}</div>
        ${locked ? html`<span class="muted small">Only an owner can change this person.</span>` : html`<div class="acts"><button class="btn small" type="submit">Save</button></div>`}
      </form>`;
    })}</div>
  </section>
  ${d.installers?.length ? html`<section class="panel"><h2>Installers</h2>
    <p class="muted small">Installers don't sign in. They get a link to one job from that job's Site section, which opens the site page: plans, a daily log with photos, what's missing, and "finished from our side". Their name goes on what they write. Switch one off to stop every link they have.</p>
    <div class="tbl" tabindex="0"><table><thead><tr><th>Installer</th><th>Jobs with a live link</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${d.installers.map((i) => html`<tr><td>${i.name}${i.active ? '' : html` <span class="muted small">· off</span>`}</td><td>${i.jobs.join(', ') || html`<span class="muted">None</span>`}</td>
        <td><form method="post" action="/settings/installers/${i.id}"><input type="hidden" name="active" value="${i.active ? '0' : '1'}"><button class="btn small${i.active ? ' danger' : ''}" type="submit">${i.active ? 'Switch off' : 'Switch on'}</button></form></td></tr>`)}
    </tbody></table></div></section>` : ''}
  <section class="panel"><h2>Add a person</h2>
    <form method="post" action="/settings/people" class="stack">
      <div class="fixgrid">
        <label class="f">Name<input name="name" required></label>
        <label class="f">Email<input name="email" type="email" required></label>
        <label class="f">Role<select name="role"><option value="viewer">Viewer</option><option value="doer">Doer</option><option value="editor">Editor</option></select></label>
      </div>
      <div class="switches">
        ${d.viewerIsOwner ? html`<label class="checkline"><input type="checkbox" name="is_owner" value="1"> Owner</label>` : ''}
        <label class="checkline" title="May change stock whatever their role"><input type="checkbox" name="can_stock" value="1"> Runs stock</label>
      </div>
      <div class="areas"><span class="muted small">Areas</span>${PEOPLE_AREAS.map((a) => html`<label class="chip-check"><input type="checkbox" name="areas" value="${a.area}"> ${a.label}</label>`)}</div>
      <div class="acts"><button class="btn primary" type="submit">Add person</button></div>
    </form></section>`,
};
