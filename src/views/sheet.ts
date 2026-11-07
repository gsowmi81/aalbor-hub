// The job sheet (George, 7 Nov 2026; R12): one printable page for the trolley, with a QR code
// that opens the job on My day, so the factory ticks from the trolley rather than from a list.
// A standalone document, not the hub's layout: it is for paper.
import qrcode from 'qrcode-generator';
import { html, Html, raw } from "../web/html.js";
import { fmtLong, fmtRange } from '../domain/dates.js';
import { KINDS, StepKind } from '../domain/steps.js';
import { jobTitle, StepRow, stepLabel } from '../domain/checks.js';
import type { FullJob } from '../db/queries.js';

export function qrSvg(text: string): Html {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  return raw(qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }));
}

export function jobSheet(job: FullJob, steps: StepRow[], url: string, printedBy: string, printedOn: string): Html {
  const std = steps.filter((s) => s.kind !== 'rework' && !s.label);
  const finish = [job.door_finish === 'polyurethane' ? 'Polyurethane doors' : 'Melamine doors', job.has_painting ? 'Painting' : 'No painting', job.has_stone ? 'Stone' : 'No stone'];
  const row = (s: StepRow) => html`<tr><td>${stepLabel(s)}</td><td>${s.start_date ? fmtRange(s.start_date, s.end_date) : '—'}</td><td>${s.owner || KINDS[s.kind as StepKind].owner}</td><td class="tick">${s.done_at ? '✓' : ''}</td></tr>`;
  return html`<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job sheet ${job.job_number ?? ''} · ${jobTitle(job)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font: 14px/1.4 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #14171C; margin: 0; padding: 20px; max-width: 800px; }
  .top { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 3px solid #14171C; padding-bottom: 12px; }
  .eyebrow { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #555; }
  h1 { font-size: 34px; margin: 2px 0 4px; line-height: 1.1; }
  .num { font: 700 44px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing: .02em; }
  .qr { width: 150px; flex: none; text-align: center; font-size: 11px; color: #555; }
  .qr svg { width: 150px; height: 150px; display: block; margin-bottom: 4px; }
  .pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
  .pill { border: 1.5px solid #14171C; border-radius: 999px; padding: 2px 10px; font-weight: 600; font-size: 13px; }
  .scope { font-size: 15px; margin: 8px 0 14px; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #555; border-bottom: 1px solid #14171C; padding: 4px 6px; }
  td { padding: 7px 6px; border-bottom: 1px solid #ccc; vertical-align: top; }
  td.tick { width: 48px; font-size: 20px; text-align: center; border: 1px solid #14171C; border-bottom: 1px solid #14171C; }
  .foot { display: flex; justify-content: space-between; margin-top: 18px; font-size: 12px; color: #555; }
  .notes { margin-top: 14px; border: 1px dashed #999; border-radius: 8px; min-height: 90px; padding: 8px; font-size: 12px; color: #777; }
  .print { position: fixed; right: 16px; bottom: 16px; padding: 12px 18px; font: 600 15px inherit; background: #14171C; color: #fff; border: 0; border-radius: 10px; cursor: pointer; }
  @media print { .print { display: none; } body { padding: 0; } }
</style></head><body>
<div class="top">
  <div>
    <div class="eyebrow">Aalbor Kitchens · job sheet</div>
    <div class="num">${job.job_number ?? '—'}</div>
    <h1>${jobTitle(job)}</h1>
    <div class="eyebrow">${job.brand} · site start ${job.site_start ? fmtLong(job.site_start) : 'not set'}</div>
  </div>
  <div class="qr">${qrSvg(url)}Scan to tick steps on your phone</div>
</div>
<div class="pills">${finish.map((f) => html`<span class="pill">${f}</span>`)}<span class="pill">Factory ${job.factory_days} ${job.factory_days === 1 ? 'day' : 'days'}</span><span class="pill">Install ${job.install_days} ${job.install_days === 1 ? 'day' : 'days'}</span></div>
${job.scope ? html`<div class="scope">${job.scope}</div>` : ''}
<table><thead><tr><th>Step</th><th>When</th><th>Who</th><th>Done</th></tr></thead><tbody>${std.map(row)}</tbody></table>
<div class="notes">Notes on the floor</div>
<div class="foot"><span>Printed by ${printedBy}, ${fmtLong(printedOn)}</span><span>${url}</span></div>
<button class="print" onclick="window.print()">Print</button>
</body></html>`;
}
