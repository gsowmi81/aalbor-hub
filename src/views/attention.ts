// Attention (George, 7 Nov 2026): everything overdue and every decision, grouped by job so a
// phone shows one line per job, not forty items. Was the bottom half of Coming up.
import { html, Html } from '../web/html.js';
import { fmtShort, Iso } from '../domain/dates.js';
import { Decision, jobTitle, JobRow, StepRow } from '../domain/checks.js';
import { Person } from '../web/auth.js';
import { decidedItem, decisionItem, ItemContext, overdueItem, StoredDecision } from './items.js';
import type { IssueRow } from '../db/queries.js';
import { issueItem } from './issues.js';

export interface AttentionData {
  person: Person;
  today: Iso;
  jobs: JobRow[];
  steps: StepRow[];
  overdue: StepRow[];
  decisions: Decision[];
  stored: Map<string, StoredDecision>;
  issues: IssueRow[];
}

export function attentionPage(d: AttentionData): Html {
  const jobById = new Map(d.jobs.map((j) => [j.id, j]));
  const c: ItemContext = { person: d.person, today: d.today, jobById, back: '/attention' };
  const pending = d.decisions.filter((x) => d.stored.get(x.key)?.fingerprint !== x.fingerprint);
  const decided = d.decisions.filter((x) => d.stored.get(x.key)?.fingerprint === x.fingerprint);
  const installOf = (id: number) => d.steps.find((s) => s.job_id === id && s.kind === 'install' && !s.label)?.start_date ?? '9999';

  // One group per job, soonest install first; capacity items (no job) last.
  const groups = new Map<number, { job: JobRow; overdue: StepRow[]; decisions: Decision[] }>();
  const groupFor = (id: number) => groups.get(id) ?? groups.set(id, { job: jobById.get(id)!, overdue: [], decisions: [] }).get(id)!;
  for (const s of d.overdue) groupFor(s.job_id).overdue.push(s);
  for (const x of pending) if (x.jobId) groupFor(x.jobId).decisions.push(x);
  const general = pending.filter((x) => !x.jobId);
  const ordered = [...groups.values()].sort((a, b) => installOf(a.job.id).localeCompare(installOf(b.job.id)) || a.job.client_name.localeCompare(b.job.client_name));
  const total = d.overdue.length + pending.length + d.issues.length;

  const summary = (g: { job: JobRow; overdue: StepRow[]; decisions: Decision[] }) => {
    const parts = [g.overdue.length ? `${g.overdue.length} overdue` : '', g.decisions.length ? `${g.decisions.length} to decide` : ''].filter(Boolean).join(' · ');
    const inst = installOf(g.job.id);
    return html`<summary class="att-sum"><span class="att-job"><strong>${jobTitle(g.job)}</strong><span class="muted small">${inst === '9999' ? 'No install date' : `Install ${fmtShort(inst)}`}</span></span>
      <span class="att-counts">${g.overdue.length ? html`<span class="late">${g.overdue.length} overdue</span>` : ''}${g.decisions.length ? html`<span class="tag warn">${g.decisions.length} to decide</span>` : ''}<span class="sr-only">${parts}</span></span></summary>`;
  };

  return html`
  <div class="tiles">
    <a class="tile${d.issues.length ? ' over' : ''}" href="#flags"><b>${d.issues.length}</b><span>Flagged</span><small>Problems from the floor</small></a>
    <a class="tile over" href="#jobs"><b>${d.overdue.length}</b><span>Overdue</span><small>Date passed, not ticked</small></a>
    <a class="tile warn" href="#jobs"><b>${pending.length}</b><span>To decide</span><small>${general.length ? `${general.length} about capacity` : 'Dates and clashes'}</small></a>
    <a class="tile" href="#decided"><b>${decided.length}</b><span>Decided</span><small>OK'd as is</small></a>
  </div>
  ${d.issues.length ? html`<section class="panel" id="flags" style="gap:4px"><div class="row"><h2>Flagged problems</h2><span class="muted small">Newest first. Fixed ones drop off.</span></div>${d.issues.map((i) => issueItem(i, d.person, '/attention#flags'))}</section>` : ''}
  <section class="panel" id="jobs">
    <div class="row"><h2>${total ? `${ordered.length} ${ordered.length === 1 ? 'job needs' : 'jobs need'} a look` : 'Nothing needs a look'}</h2><span class="muted small">Soonest install first. Tap a job to see its items.</span></div>
    ${ordered.map((g, i) => html`<details class="att"${i < 2 ? html` open` : ''}>${summary(g)}
      <div class="att-body">
        ${g.overdue.map((s) => overdueItem(s, c, false))}
        ${g.decisions.map((x) => decisionItem(x, c, false))}
        <div class="att-foot"><a class="btn small" href="/jobs/${g.job.id}">Open ${g.job.client_name}</a></div>
      </div></details>`)}
    ${general.length ? html`<details class="att" open><summary class="att-sum"><span class="att-job"><strong>Capacity</strong><span class="muted small">Overbooked weeks and days</span></span><span class="att-counts"><span class="tag warn">${general.length} to decide</span></span></summary>
      <div class="att-body">${general.map((x) => decisionItem(x, c, false))}</div></details>` : ''}
    ${!total ? html`<p style="font-weight:600">Nothing overdue, nothing to decide.</p>` : ''}
  </section>
  <section class="panel" id="decided">
    <details><summary style="cursor:pointer"><h2 style="display:inline">Decided</h2> <span class="muted small">${decided.length} OK'd as is. They come back if their dates change.</span></summary>
      <div style="padding-top:8px">${decided.length ? decided.map((x) => decidedItem(x, d.stored.get(x.key)!, c)) : html`<p class="muted">Nothing yet.</p>`}</div></details>
  </section>`;
}
