// My day (George, 7 Nov 2026): the steps for the person signed in, this week, with one Done
// button each. Jobman's agenda screen without the clock. Doers land here.
// With ?job=, one job's open steps for whoever scanned its job sheet (R12).
import { guide } from './guide.js';
import { html, Html } from '../web/html.js';
import { addDays, fmtRange, fmtShort, Iso, mondayOf, sydneyDate } from '../domain/dates.js';
import { KINDS, PEOPLE_AREAS, rowOf } from '../domain/steps.js';
import { jobTitle, lastDate, StepRow, stepLabel } from '../domain/checks.js';
import type { FullJob, IssueRow, IssueType, JobFile } from '../db/queries.js';
import { fileLink } from './files.js';
import { can, Person } from '../web/auth.js';
import { flagForm, issueItem } from './issues.js';
import { asksOnDone, installDoneForm, installSummary } from './install.js';

export interface MyDayData {
  person: Person;
  today: Iso;
  jobs: FullJob[];
  steps: StepRow[];
  message: string;
  types: IssueType[];
  /** Open flags this person raised or looks after. */
  issues: IssueRow[];
  /** Install photos by step, for the job view. */
  stepPhotos?: Map<number, number[]>;
  /** The current file of each class on every job (George, 7 Nov 2026). */
  files?: Map<number, JobFile[]>;
  /** The step just ticked from this screen, for the Undo line (George, 7 Nov 2026). */
  undo?: StepRow;
  /** Saturdays are working days (Settings → Capacity): "later this week" runs to Saturday. */
  saturdays?: boolean;
}

/** Is this step one of mine: in an area I work in, or with my name on it. */
export function isMine(s: StepRow, p: Person): boolean {
  const first = p.name.split(' ')[0].toLowerCase();
  if (s.owner && s.owner.toLowerCase() === first) return true;
  if (s.owner && !p.areas.includes(rowOf(s))) return s.owner.toLowerCase() === first;
  return p.areas.includes(rowOf(s));
}

function stepRow(s: StepRow, j: FullJob, d: MyDayData, back: string, late: boolean, showJob: boolean): Html {
  const over = !!s.start_date && lastDate(s)! < d.today;
  const canTick = can(d.person, 'doer') && !s.done_at;
  const done = asksOnDone(s)
    ? installDoneForm(s, back, html`Done`, 'pop install me-install')
    : html`<form method="post" action="/steps/${s.id}/done"><input type="hidden" name="done" value="1"><input type="hidden" name="back" value="${back}"><button class="btn primary" type="submit" aria-label="${stepLabel(s)} for ${j.client_name}: done">Done</button></form>`;
  return html`<div class="me-row lane-${rowOf(s)}${s.kind === 'rework' ? ' rw' : ''}${s.done_at ? ' done' : ''}" id="c-${s.id}">
    <div class="me-what">
      ${showJob ? html`<a class="me-job" href="/jobs/${j.id}#s-${s.id}">${jobTitle(j)}</a>` : ''}
      <div class="me-step">${s.kind === 'rework' ? html`<span style="color:var(--rw);font-weight:700">Rework · </span>` : ''}${stepLabel(s)}${s.owner && s.owner !== KINDS[s.kind].owner ? html` <span class="muted small">· ${s.owner}</span>` : ''}</div>
      <div class="muted small">${s.start_date ? fmtRange(s.start_date, s.end_date) : 'No date yet'}${s.done_at ? ' · done' : over ? html` · <span class="nodate">${late ? 'overdue' : 'running late'}</span>` : ''}${s.start_date && !s.confirmed && !s.done_at ? ' · provisional' : ''}${s.pinned ? ' · pinned' : ''}</div>
      ${showJob ? html`<div class="me-files">${(d.files?.get(j.id) ?? []).map((f) => fileLink(f))}${j.drawings_url ? html`<a class="small" href="${j.drawings_url}" target="_blank" rel="noopener">Drawings folder ↗</a>` : ''}</div>` : ''}
      ${installSummary(s, d.stepPhotos?.get(s.id) ?? [])}
    </div>
    ${canTick ? html`<div class="me-acts">${done}${flagForm({ jobId: j.id, stepId: s.id, types: d.types, back, label: 'Flag' })}</div>` : ''}
  </div>`;
}

export function myDayPage(d: MyDayData): Html {
  const jobById = new Map(d.jobs.map((j) => [j.id, j]));
  const live = new Set(d.jobs.filter((j) => j.status === 'live').map((j) => j.id));
  const mon = mondayOf(d.today);
  const fri = addDays(mon, d.saturdays ? 5 : 4);
  const nextMon = addDays(mon, 7);
  const nextFri = addDays(mon, 11);
  const mine = d.steps.filter((s) => live.has(s.job_id) && !s.done_at && s.start_date && isMine(s, d.person));
  const overdue = mine.filter((s) => lastDate(s)! < d.today).sort((a, b) => lastDate(a)!.localeCompare(lastDate(b)!));
  const todayList = mine.filter((s) => s.start_date! <= d.today && lastDate(s)! >= d.today);
  const thisWeek = mine.filter((s) => s.start_date! > d.today && s.start_date! <= fri).sort((a, b) => a.start_date!.localeCompare(b.start_date!));
  const nextWeek = mine.filter((s) => s.start_date! >= nextMon && s.start_date! <= nextFri).sort((a, b) => a.start_date!.localeCompare(b.start_date!));
  const areas = d.person.areas.map((a) => PEOPLE_AREAS.find((x) => x.area === a)?.label ?? a);

  // Installs the installer says are finished (George, 7 Nov 2026): a site manager inspects and ticks them off.
  const signOff = d.steps.filter((s) => live.has(s.job_id) && !s.done_at && s.site_finished_at && s.kind === 'install' && !s.label && (d.person.areas.includes('install') || isMine(s, d.person)))
    .sort((a, b) => String(a.site_finished_at).localeCompare(String(b.site_finished_at)));
  const row = (s: StepRow, late = false) => stepRow(s, jobById.get(s.job_id)!, d, `/me#c-${s.id}`, late, true);
  const section = (title: string, list: StepRow[], empty: string, late = false) => html`<section class="panel" style="gap:4px">
    <div class="row"><h2>${title}</h2><span class="muted small">${list.length || ''}</span></div>
    ${list.length ? list.map((s) => row(s, late)) : html`<p class="muted" style="padding:6px 0">${empty}</p>`}
  </section>`;

  return html`<div class="job" style="max-width:640px">
    ${d.undo ? html`<div class="notice ok undo" role="status"><span>Ticked ${stepLabel(d.undo)} for ${jobById.get(d.undo.job_id) ? jobTitle(jobById.get(d.undo.job_id)!) : 'the job'}.</span>
      <form method="post" action="/steps/${d.undo.id}/done" style="display:inline"><input type="hidden" name="done" value="0"><input type="hidden" name="back" value="/me"><button class="btn small" type="submit">Undo</button></form></div>` : ''}
    ${d.message ? html`<div class="me-msg" role="note">${d.message}</div>` : ''}
    ${!d.person.areas.length ? html`<div class="notice">Your areas aren't set yet, so this only shows steps with your name on them. Ask George or Christine to tick your areas in Settings → People.</div>`
      : guide('me', `${fmtShort(d.today)} · your areas: ${areas.join(', ')}. Tap Done when a step is finished; it leaves this list and the office sees it straight away.`)}
    ${signOff.length ? html`<section class="panel" style="gap:4px"><div class="row"><h2>Needs your sign-off</h2><span class="muted small">${signOff.length}</span></div>
      <p class="muted small" style="padding:0 0 4px">The installer says these are finished. Inspect, then tap Done to sign off (gaps adjusted? site clean? and your photos).</p>
      ${signOff.map((s) => html`<div class="notice" style="margin-bottom:6px;padding:6px 10px"><span class="small">Installer finished ${fmtShort(sydneyDate(s.site_finished_at!))} · <a href="/jobs/${s.job_id}#site">their log and photos</a></span></div>${row(s)}`)}</section>` : ''}
    ${overdue.length ? section('Overdue', overdue, '', true) : ''}
    ${section('Today', todayList, 'Nothing on today.')}
    ${d.issues.length ? html`<section class="panel" style="gap:4px"><div class="row"><h2>Flags for you</h2><span class="muted small">${d.issues.length}</span></div>${d.issues.slice(0, 3).map((i) => issueItem(i, d.person, '/me'))}${d.issues.length > 3 ? html`<a class="btn small" href="/attention#flags">And ${d.issues.length - 3} more on Attention</a>` : ''}</section>` : ''}
    ${section('Later this week', thisWeek, 'Nothing more this week.')}
    ${section('Next week', nextWeek, 'Nothing yet next week.')}
  </div>`;
}

/** One job on My day: every open step, whoever's it is, for the phone that scanned the job sheet. */
export function jobDayPage(d: MyDayData, job: FullJob): Html {
  const steps = d.steps.filter((s) => s.job_id === job.id);
  const open = steps.filter((s) => !s.done_at);
  const done = steps.filter((s) => s.done_at);
  const back = `/me?job=${job.id}`;
  return html`<div class="job" style="max-width:640px">
    <div style="display:flex;flex-direction:column;gap:4px">
      <div class="eyebrow">Job ${job.job_number ?? '(no number)'} · from the job sheet</div>
      <h2 style="font-size:22px">${jobTitle(job)}</h2>
      <div class="muted small">Every open step on this job, in order. Tap Done on the one you've finished. <a href="/me">Back to My day</a> · <a href="/jobs/${job.id}">The whole job</a></div>
      ${(d.files?.get(job.id) ?? []).length || job.drawings_url ? html`<div class="me-files">${(d.files?.get(job.id) ?? []).map((f) => fileLink(f, 'btn small'))}${job.drawings_url ? html`<a class="btn small" href="${job.drawings_url}" target="_blank" rel="noopener">Drawings folder ↗</a>` : ''}</div>` : ''}
    </div>
    ${d.issues.length ? html`<section class="panel" style="gap:4px"><div class="row"><h2>Flagged</h2><span class="muted small">${d.issues.length}</span></div>${d.issues.map((i) => issueItem(i, d.person, back))}</section>` : ''}
    <section class="panel" style="gap:4px"><div class="row"><h2>To do</h2><span class="muted small">${open.length || ''}</span></div>
      ${open.length ? open.map((s) => stepRow(s, job, d, `${back}#c-${s.id}`, false, false)) : html`<p class="muted" style="padding:6px 0">Everything on this job is ticked.</p>`}
      ${can(d.person, 'doer') ? html`<div class="acts" style="padding-top:6px">${flagForm({ jobId: job.id, types: d.types, back })}</div>` : ''}
    </section>
    ${done.length ? html`<section class="panel" style="gap:4px"><details><summary style="cursor:pointer"><h2 style="display:inline">Done</h2> <span class="muted small">${done.length}</span></summary>
      <div style="padding-top:6px">${done.map((s) => stepRow(s, job, d, `${back}#c-${s.id}`, false, false))}</div></details></section>` : ''}
  </div>`;
}
