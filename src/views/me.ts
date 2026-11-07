// My day (George, 7 Nov 2026): the steps for the person signed in, this week, with one Done
// button each. Jobman's agenda screen without the clock. Doers land here.
import { html, Html } from '../web/html.js';
import { addDays, fmtRange, fmtShort, Iso, mondayOf } from '../domain/dates.js';
import { KINDS, PEOPLE_AREAS, rowOf } from '../domain/steps.js';
import { jobTitle, lastDate, StepRow, stepLabel } from '../domain/checks.js';
import type { FullJob } from '../db/queries.js';
import { can, Person } from '../web/auth.js';

export interface MyDayData {
  person: Person;
  today: Iso;
  jobs: FullJob[];
  steps: StepRow[];
  message: string;
}

/** Is this step one of mine: in an area I work in, or with my name on it. */
export function isMine(s: StepRow, p: Person): boolean {
  const first = p.name.split(' ')[0].toLowerCase();
  if (s.owner && s.owner.toLowerCase() === first) return true;
  if (s.owner && !p.areas.includes(rowOf(s))) return s.owner.toLowerCase() === first;
  return p.areas.includes(rowOf(s));
}

export function myDayPage(d: MyDayData): Html {
  const jobById = new Map(d.jobs.map((j) => [j.id, j]));
  const live = new Set(d.jobs.filter((j) => j.status === 'live').map((j) => j.id));
  const mon = mondayOf(d.today);
  const fri = addDays(mon, 4);
  const nextMon = addDays(mon, 7);
  const nextFri = addDays(mon, 11);
  const mine = d.steps.filter((s) => live.has(s.job_id) && !s.done_at && s.start_date && isMine(s, d.person));
  const overdue = mine.filter((s) => lastDate(s)! < d.today).sort((a, b) => lastDate(a)!.localeCompare(lastDate(b)!));
  const todayList = mine.filter((s) => s.start_date! <= d.today && lastDate(s)! >= d.today);
  const thisWeek = mine.filter((s) => s.start_date! > d.today && s.start_date! <= fri).sort((a, b) => a.start_date!.localeCompare(b.start_date!));
  const nextWeek = mine.filter((s) => s.start_date! >= nextMon && s.start_date! <= nextFri).sort((a, b) => a.start_date!.localeCompare(b.start_date!));
  const canTick = can(d.person, 'doer');
  const areas = d.person.areas.map((a) => PEOPLE_AREAS.find((x) => x.area === a)?.label ?? a);

  const row = (s: StepRow, late = false) => {
    const j = jobById.get(s.job_id)!;
    const over = lastDate(s)! < d.today;
    return html`<div class="me-row lane-${rowOf(s)}${s.kind === 'rework' ? ' rw' : ''}" id="c-${s.id}">
      <div class="me-what">
        <a class="me-job" href="/jobs/${j.id}#s-${s.id}">${jobTitle(j)}</a>
        <div class="me-step">${s.kind === 'rework' ? html`<span style="color:var(--rw);font-weight:700">Rework · </span>` : ''}${stepLabel(s)}${s.owner && s.owner !== KINDS[s.kind].owner ? html` <span class="muted small">· ${s.owner}</span>` : ''}</div>
        <div class="muted small">${fmtRange(s.start_date, s.end_date)}${over ? html` · <span class="nodate">${late ? 'overdue' : 'running late'}</span>` : ''}${s.confirmed ? '' : ' · provisional'}${s.pinned ? ' · pinned' : ''}</div>
        ${j.drawings_url ? html`<a class="small" href="${j.drawings_url}" target="_blank" rel="noopener">Drawings ↗</a>` : ''}
      </div>
      ${canTick ? html`<form method="post" action="/steps/${s.id}/done"><input type="hidden" name="done" value="1"><input type="hidden" name="back" value="/me#c-${s.id}"><button class="btn primary" type="submit" aria-label="${stepLabel(s)} for ${j.client_name}: done">Done</button></form>` : ''}
    </div>`;
  };
  const section = (title: string, list: StepRow[], empty: string, late = false) => html`<section class="panel" style="gap:4px">
    <div class="row"><h2>${title}</h2><span class="muted small">${list.length || ''}</span></div>
    ${list.length ? list.map((s) => row(s, late)) : html`<p class="muted" style="padding:6px 0">${empty}</p>`}
  </section>`;

  return html`<div class="job" style="max-width:640px">
    ${d.message ? html`<div class="me-msg" role="note">${d.message}</div>` : ''}
    ${!d.person.areas.length ? html`<div class="notice">Your areas aren't set yet, so this only shows steps with your name on them. Ask George or Christine to tick your areas in Settings → People.</div>`
      : html`<p class="muted small">${fmtShort(d.today)} · your areas: ${areas.join(', ')}. Tap Done when a step is finished; it leaves this list and the office sees it straight away.</p>`}
    ${overdue.length ? section('Overdue', overdue, '', true) : ''}
    ${section('Today', todayList, 'Nothing on today.')}
    ${section('Later this week', thisWeek, 'Nothing more this week.')}
    ${section('Next week', nextWeek, 'Nothing yet next week.')}
  </div>`;
}
