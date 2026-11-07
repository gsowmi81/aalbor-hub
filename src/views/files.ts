// Files on a job (George, 7 Nov 2026): the plans themselves, attached to the job, each classed so
// whoever opens one knows what it is for, with a version per class so the latest is unmistakable.
import { html, Html } from '../web/html.js';
import { fmtLong, sydneyDate } from '../domain/dates.js';
import type { JobFile } from '../db/queries.js';
import { can, Person } from '../web/auth.js';

export const FILE_KINDS = [
  { key: 'contract_plans', label: 'Contract plans', short: 'Contract', hint: 'What the client signed at contract. Not for production.' },
  { key: 'production_plans', label: 'Production plans', short: 'Production', hint: 'Signed off by the client and ready for production. The factory works from these.' },
  { key: 'other', label: 'Other', short: 'Other', hint: 'Anything else: site photos, a stone template, a supplier quote.' },
] as const;
export type FileKind = (typeof FILE_KINDS)[number]['key'];

export function fileKindLabel(kind: string): string {
  return FILE_KINDS.find((k) => k.key === kind)?.label ?? kind;
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The latest version of each class: what My day, the sheet and the job's pills link to. */
export function currentFiles(files: JobFile[]): JobFile[] {
  const out: JobFile[] = [];
  for (const k of FILE_KINDS) {
    const latest = files.filter((f) => f.kind === k.key).sort((a, b) => b.version - a.version)[0];
    if (latest) out.push(latest);
  }
  return out;
}

export function fileLink(f: JobFile, cls = 'small'): Html {
  return html`<a class="${cls}" href="/jobs/${f.job_id}/files/${f.id}" target="_blank" rel="noopener" title="${f.name}, ${fmtSize(f.size)}, added ${fmtLong(sydneyDate(f.added_at))}">${fileKindLabel(f.kind)} v${f.version} ↗</a>`;
}

/** A delete that asks once more on the page itself. */
function confirmDelete(action: string, back: string, warning: string): Html {
  return html`<details class="pop"><summary class="linkbtn small danger">Remove</summary>
    <form class="popbody" method="post" action="${action}"><input type="hidden" name="back" value="${back}">
      <span class="small">${warning}</span>
      <div class="acts"><button class="btn small danger" type="submit">Yes, remove</button></div></form></details>`;
}

function fileRow(f: JobFile, current: boolean, editor: boolean, back: string): Html {
  return html`<div class="file${current ? ' cur' : ' old'}" id="f-${f.id}">
    <div class="file-main">
      <div><a href="/jobs/${f.job_id}/files/${f.id}" target="_blank" rel="noopener"><strong>${f.name}</strong></a> <span class="spill${current ? ' done' : ''}">v${f.version}${current ? ' · current' : ' · superseded'}</span></div>
      <div class="muted small">${f.note ? html`${f.note} · ` : ''}${fmtSize(f.size)} · added by ${f.added_by_name ?? 'unknown'}, ${fmtLong(sydneyDate(f.added_at))}</div>
    </div>
    ${editor ? confirmDelete(`/jobs/${f.job_id}/files/${f.id}/delete`, back, current ? 'Removing the current version makes the one before it current again. The removal is in the history.' : 'It stays in the history as removed.') : ''}
  </div>`;
}

export function filesPanel(opts: { jobId: number; files: JobFile[]; person: Person; back: string }): Html {
  const editor = can(opts.person, 'editor');
  const groups = FILE_KINDS.map((k) => ({ kind: k, files: opts.files.filter((f) => f.kind === k.key).sort((a, b) => b.version - a.version) }));
  return html`<section class="panel" id="files" style="gap:8px">
    <div class="row"><h2>Files</h2><span class="muted small">${opts.files.length ? `${opts.files.length} ${opts.files.length === 1 ? 'file' : 'files'}` : 'None yet'}</span></div>
    <p class="muted small">Each file is classed so you know what it's for. A new file of the same class becomes the current version; the earlier ones stay here as superseded.</p>
    ${groups.map((g) => html`<div class="file-group">
      <div class="file-head"><strong>${g.kind.label}</strong><span class="muted small">${g.kind.hint}</span></div>
      ${g.files.length ? html`${fileRow(g.files[0], true, editor, opts.back)}
        ${g.files.length > 1 ? html`<details class="file-old"><summary class="small muted" style="cursor:pointer">Earlier versions (${g.files.length - 1})</summary>${g.files.slice(1).map((f) => fileRow(f, false, editor, opts.back))}</details>` : ''}`
        : html`<div class="muted small file-none">None.</div>`}
    </div>`)}
    ${editor ? html`<details class="pop" id="addfile"><summary class="btn small">Add a file</summary>
      <form class="popbody" method="post" action="/jobs/${opts.jobId}/files" enctype="multipart/form-data" data-files>
        <input type="hidden" name="back" value="${opts.back}">
        <div class="fixgrid">
          <label class="f">What is it<select name="kind" required><option value="">Pick one</option>${FILE_KINDS.map((k) => html`<option value="${k.key}">${k.label}</option>`)}</select></label>
          <label class="f">Note (optional)<input name="note" maxlength="120" placeholder="e.g. Rev C, after check measure"></label>
        </div>
        <label class="f">File (PDF, image or drawing, up to 25 MB)<input type="file" name="file" required></label>
        <span class="muted small">Production plans are the ones the client has signed off. If a newer set comes in, add it as Production plans again and it becomes v2; the old one stays as superseded.</span>
        <div class="acts"><button class="btn primary" type="submit">Add the file</button></div>
      </form></details>` : ''}
  </section>`;
}
