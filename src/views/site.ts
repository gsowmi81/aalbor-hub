// The site page (George, 7 Nov 2026): what an installer sees from a job link. One job: the plans, the
// install dates, a daily log with photos, "something's missing" (a flag to Gus), and "finished from our
// side", which is their word, not the sign-off. A site manager inspects and ticks Install cabinets done.
import { html, Html } from '../web/html.js';
import { fmtLong, fmtRange, fmtShort, sydneyDate } from '../domain/dates.js';
import { jobTitle, StepRow, stepLabel } from '../domain/checks.js';
import type { FullJob, IssueRow, JobFile } from '../db/queries.js';
import type { SiteLink, SiteLog } from '../db/site.js';
import { currentFiles, fileLink } from './files.js';
import { can, Person } from '../web/auth.js';
import { previewBar } from './layout.js';

const KIND_LABEL: Record<SiteLog['kind'], string> = { log: 'Daily log', missing: 'Missing', finished: 'Finished from the installer\'s side' };

function when(ts: string): string {
  return `${fmtShort(sydneyDate(ts))} ${new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts))}`;
}

export function siteLogItem(l: SiteLog): Html {
  return html`<div class="item stack slog slog-${l.kind}" id="sl-${l.id}">
    <div class="row"><strong>${KIND_LABEL[l.kind]}${l.kind === 'missing' && l.issue_status ? html` <span class="spill ${l.issue_status === 'fixed' ? 'done' : 'over'}">${l.issue_status === 'fixed' ? 'sorted' : l.issue_status === 'looking' ? 'being looked at' : 'open'}</span>` : ''}</strong><span class="muted small">${when(l.at)} · ${l.person_name}</span></div>
    ${l.note ? html`<div>${l.note}</div>` : ''}
    ${l.photo_ids.length ? html`<div class="photos">${l.photo_ids.map((pid) => html`<a href="/site/logs/${l.id}/photos/${pid}" target="_blank" rel="noopener"><img src="/site/logs/${l.id}/photos/${pid}" alt="Site photo" loading="lazy"></a>`)}</div>` : ''}
  </div>`;
}

export interface SiteView {
  person: Person;
  job: FullJob;
  steps: StepRow[];
  files: JobFile[];
  logs: SiteLog[];
  issues: IssueRow[];
  today: string;
  flash?: string | null;
}

/** The installer's page: its own document, no tabs, nothing but this job. */
export function sitePage(d: SiteView): Html {
  const install = d.steps.filter((s) => s.kind === 'install' && !s.label);
  const site = d.steps.filter((s) => ['install', 'stone_measure', 'stone_install'].includes(s.kind) && !s.done_at);
  const main = install[0];
  const finished = main?.site_finished_at;
  const signedOff = main?.done_at;
  const plans = currentFiles(d.files);
  const openMissing = d.issues.filter((i) => i.type_key === 'missing_on_site' && i.status !== 'fixed').length;
  return html`<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${jobTitle(d.job)} · Site</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap">
<link rel="stylesheet" href="/static/hub.css"><script src="/static/hub.js" defer></script></head>
<body>${previewBar()}<div class="wrap site">
  <header class="top"><div style="display:flex;flex-direction:column;gap:4px;min-width:0"><div class="eyebrow">Aalbor Kitchens · Site</div><h1>${jobTitle(d.job)}</h1>
    <div class="muted">${d.job.job_number ? `Job ${d.job.job_number} · ` : ''}${d.job.scope || ''}</div></div>
    <div class="topright"><div class="who">${d.person.name}<form method="post" action="/logout"><button class="linkbtn" type="submit">Sign out</button></form></div></div></header>
  <main id="main">
  ${d.flash ? (d.flash.startsWith('!') ? html`<div class="notice bad" role="alert">${d.flash.slice(1)}</div>` : html`<div class="notice ok" role="status">${d.flash}</div>`) : ''}
  <div class="job" style="max-width:640px">
    ${signedOff ? html`<div class="next" style="background:var(--done-bg);color:var(--done-fg)"><span class="eyebrow">Signed off</span><b>Install signed off ${fmtLong(sydneyDate(signedOff))}</b><span>Thanks. Nothing more to do here.</span></div>`
      : finished ? html`<div class="next"><span class="eyebrow">Waiting on the site manager</span><b>Finished from your side ${fmtLong(sydneyDate(finished))}</b><span>A site manager inspects and signs it off. Keep logging anything that changes.</span></div>`
      : main ? html`<div class="next"><span class="eyebrow">Install</span><b>${main.start_date ? fmtRange(main.start_date, main.end_date) : 'Date to be set'}</b><span>${d.job.suburb}${site.length > 1 ? ` · then ${site.slice(1).map((s) => `${stepLabel(s)}${s.start_date ? ` ${fmtShort(s.start_date)}` : ''}`).join(', ')}` : ''}</span></div>` : ''}
    ${plans.length || d.job.drawings_url ? html`<section class="panel"><h2>Plans</h2><div class="pills">${plans.map((f) => fileLink(f, 'pill link'))}${d.job.drawings_url ? html`<a class="pill link" href="${d.job.drawings_url}" target="_blank" rel="noopener">Drawings folder ↗</a>` : ''}</div>
      <span class="muted small">Production plans are the ones to build from. Contract plans are what the client signed.</span></section>` : ''}
    ${can(d.person, 'doer') && !signedOff ? html`
    <section class="panel"><h2>Today's log</h2>
      <form method="post" action="/site/log" enctype="multipart/form-data" data-photos class="stack">
        <label class="f">What happened today<textarea name="note" rows="3" required maxlength="1000" placeholder="e.g. Base cabinets in, kickboards tomorrow. Stone templater booked Thursday."></textarea></label>
        <label class="f">Photos (up to 4)<input type="file" name="photo" accept="image/*" capture="environment" multiple></label>
        <div class="acts"><button class="btn primary" type="submit">Add to the log</button></div>
      </form></section>
    <section class="panel"><h2>Something missing or wrong?</h2>
      <p class="muted small">Goes straight to the office and the site manager as a flag, with your photos. ${openMissing ? `${openMissing} still open.` : ''}</p>
      <form method="post" action="/site/missing" enctype="multipart/form-data" data-photos class="stack">
        <label class="f">What's missing<input name="note" required maxlength="300" placeholder="e.g. No handles for the pantry; 2 kickboard lengths short"></label>
        <label class="f">Photos (up to 4)<input type="file" name="photo" accept="image/*" capture="environment" multiple></label>
        <div class="acts"><button class="btn" type="submit">Send it</button></div>
      </form></section>
    ${main && !finished ? html`<section class="panel"><h2>Finished from your side?</h2>
      <p class="muted small">Tap this when the install is done as far as you're concerned. It isn't the sign-off: a site manager inspects and ticks it off. Add the finished photos here.</p>
      <form method="post" action="/site/finished" enctype="multipart/form-data" data-photos class="stack">
        <label class="f">Anything to hand over<input name="note" maxlength="500" placeholder="e.g. All done; one door needs adjusting after the stone goes in"></label>
        <label class="f">Finished photos (up to 4)<input type="file" name="photo" accept="image/*" capture="environment" multiple></label>
        <div class="acts"><button class="btn primary" type="submit">Finished from our side</button></div>
      </form></section>` : ''}` : ''}
    <section class="panel" id="log"><div class="row"><h2>The log</h2><span class="muted small">${d.logs.length || 'Nothing yet'}</span></div>
      ${d.logs.map(siteLogItem)}
    </section>
  </div></main></div></body></html>`;
}

/** The Site section on the job (George, 7 Nov 2026): the log, and for Editors the installer links. */
export function siteSection(d: { jobId: number; person: Person; logs: SiteLog[]; links: SiteLink[]; appUrl: string; installers: { id: number; name: string }[]; install?: StepRow }): Html {
  const editor = can(d.person, 'editor');
  const live = d.links.filter((l) => !l.revoked_at);
  return html`<section class="panel" id="site" style="gap:8px">
    <div class="row"><h2>Site</h2><span class="muted small">${d.logs.length ? `${d.logs.length} ${d.logs.length === 1 ? 'entry' : 'entries'}` : 'No log yet'}</span></div>
    ${d.install?.site_finished_at && !d.install.done_at ? html`<div class="notice">The installer says the install is finished (${fmtLong(sydneyDate(d.install.site_finished_at))}). A site manager inspects and ticks Install cabinets done under Steps.</div>` : ''}
    ${editor ? html`<div class="stack" style="gap:6px"><strong>Installer links</strong>
      <span class="muted small">A link opens this job's site page on the installer's phone: plans, a daily log with photos, what's missing, and "finished from our side". No sign-in to the rest of the hub. Stop a link when the crew changes.</span>
      ${live.length ? live.map((l) => html`<div class="item"><div class="what"><div>${l.person_name}</div><div class="muted small"><code style="font-size:12px;word-break:break-all">${d.appUrl}/site/go/${l.token}</code></div><div class="muted small">Made ${fmtShort(sydneyDate(l.created_at))}${l.created_by_name ? ` by ${l.created_by_name}` : ''}${l.last_used_at ? ` · last opened ${fmtShort(sydneyDate(l.last_used_at))}` : ' · not opened yet'}</div></div>
        <form method="post" action="/site-links/${l.id}/revoke"><input type="hidden" name="back" value="/jobs/${d.jobId}#site"><button class="btn small danger" type="submit">Stop</button></form></div>`) : ''}
      <details class="pop"><summary class="btn small">Make a link for an installer</summary>
        <form class="popbody" method="post" action="/jobs/${d.jobId}/site-links"><input type="hidden" name="back" value="/jobs/${d.jobId}#site">
          <label class="f">Installer<input name="name" list="installers" required maxlength="60" placeholder="e.g. Mick (ABC Installs)"><datalist id="installers">${d.installers.map((i) => html`<option value="${i.name}">`)}</datalist></label>
          <span class="muted small">Their name goes on every log entry and flag. The same name on another job reuses the same installer.</span>
          <div class="acts"><button class="btn primary" type="submit">Make the link</button></div>
        </form></details></div>` : ''}
    ${d.logs.length ? d.logs.map(siteLogItem) : ''}
  </section>`;
}
