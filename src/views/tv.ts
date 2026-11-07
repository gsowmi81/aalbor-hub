// The factory TV (George, 7 Nov 2026; R2's TV mode): the factory's week in big type, no header,
// refreshes itself. Opened with a link key from Settings, so a screen on the wall needs no sign-in.
import { html, Html } from '../web/html.js';
import { addDays, fmtShort, Iso, mondayOf } from '../domain/dates.js';
import { KINDS, rowOf, StepKind } from '../domain/steps.js';
import { jobTitle, JobRow, lastDate, StepRow, stepLabel } from '../domain/checks.js';
import { config } from '../config.js';

/** The rows the factory lives by: materials in, the factory itself (with painting and delivery), and installs going out. */
const TV_ROWS: { key: string; label: string; kinds: StepKind[]; rows: string[] }[] = [
  { key: 'in', label: 'Materials in', kinds: ['materials_in'], rows: [] },
  { key: 'factory', label: 'Factory', kinds: ['factory', 'doors_to_painting', 'doors_back', 'delivery'], rows: ['factory'] },
  { key: 'install', label: 'Install', kinds: ['install'], rows: ['install'] },
];

export interface TvData {
  today: Iso;
  jobs: JobRow[];
  steps: StepRow[];
  message: string;
  /** Minutes between refreshes. */
  every?: number;
}

export function tvPage(d: TvData): Html {
  const jobById = new Map(d.jobs.map((j) => [j.id, j]));
  const live = new Set(d.jobs.filter((j) => j.status === 'live').map((j) => j.id));
  const mon = mondayOf(d.today);
  const fri = addDays(mon, 4);
  const nextMon = addDays(mon, 7);
  const nextFri = addDays(mon, 11);
  const belongs = (s: StepRow, r: (typeof TV_ROWS)[number]) => (s.kind === 'rework' ? r.rows.includes(rowOf(s)) : r.kinds.includes(s.kind));
  const inWeek = (from: Iso, to: Iso) => d.steps.filter((s) => s.start_date && live.has(s.job_id) && s.start_date <= to && lastDate(s)! >= from);
  const week = inWeek(mon, fri);
  const next = inWeek(nextMon, nextFri);
  const overdue = d.steps.filter((s) => s.start_date && live.has(s.job_id) && !s.done_at && lastDate(s)! < d.today && TV_ROWS.some((r) => belongs(s, r)));
  const col = (x: Iso) => Math.min(Math.max(Math.round((Date.parse(x) - Date.parse(mon)) / 86400000), 0), 4);

  const card = (s: StepRow) => {
    const j = jobById.get(s.job_id)!;
    const f = s.start_date!;
    const t = lastDate(s)!;
    const over = !s.done_at && t < d.today;
    const cls = ['tvc', `lane-${rowOf(s)}`, s.kind === 'rework' ? 'rw' : '', s.done_at ? 'done' : '', over ? 'over' : '', s.confirmed ? '' : 'prov'].filter(Boolean).join(' ');
    return html`<div class="${cls}" style="grid-column:${col(f) + 1} / ${col(t) + 2}"><b>${jobTitle(j)}</b><span>${f < mon ? '← ' : ''}${stepLabel(s)}${t > fri ? ' →' : ''}${s.kind !== 'rework' && s.owner && s.owner !== KINDS[s.kind].owner ? ` · ${s.owner}` : ''}${over ? ' · OVERDUE' : s.done_at ? ' · done' : ''}</span></div>`;
  };
  const rowBlock = (r: (typeof TV_ROWS)[number]) => {
    const items = week.filter((s) => belongs(s, r)).sort((a, b) => a.start_date!.localeCompare(b.start_date!));
    return html`<div class="tvl">${r.label}</div><div class="tvg">${items.map(card)}${!items.length ? html`<div class="tvnone">Nothing this week</div>` : ''}</div>`;
  };
  const nextList = TV_ROWS.flatMap((r) => next.filter((s) => belongs(s, r)).map((s) => ({ r, s }))).sort((a, b) => a.s.start_date!.localeCompare(b.s.start_date!));

  return html`<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${(d.every ?? 2) * 60}">
<title>Factory · ${config.preview ? 'Hub preview' : 'Aalbor Hub'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap">
<style>
  :root { --bg:#111318; --fg:#E8EAED; --muted:#A4AAB5; --line:#2C313B; --over:#FF9A66; --rw:#FDA4AF; --today:#1F2937;
    --m-cd:#94A3B8; --m-cm:#5EEAD4; --m-dr:#A5B4FC; --m-mo:#BEF264; --m-mi:#A3E635; --m-f:#C4B5FD; --m-in:#7DD3FC; --m-sm:#FCD34D; --m-si:#FBBF24; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 22px/1.3 'IBM Plex Sans', system-ui, sans-serif; }
  body { padding: 24px 32px; min-height: 100vh; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 24px; margin-bottom: 12px; }
  h1 { font-size: 40px; margin: 0; letter-spacing: -.01em; }
  .sub { color: var(--muted); font-size: 22px; }
  .msg { background: #FFF8E1; color: #7A4206; border-radius: 12px; padding: 12px 18px; font-size: 26px; font-weight: 600; margin-bottom: 14px; }
  .over-count { color: var(--over); font-weight: 700; }
  .grid { display: grid; grid-template-columns: 200px repeat(5, 1fr); gap: 8px 10px; align-items: start; }
  .dh { text-align: center; font-weight: 700; font-size: 24px; padding: 8px; border-bottom: 2px solid var(--line); }
  .dh.today { background: var(--today); border-radius: 10px; border-bottom-color: transparent; }
  .tvl { font-weight: 700; font-size: 26px; padding-top: 10px; }
  .tvg { grid-column: 2 / 7; display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px 10px; min-height: 64px; padding: 6px 0 12px; border-bottom: 1px solid var(--line); }
  .tvc { background: #1A1D24; border: 2px solid var(--line); border-left: 10px solid var(--lc, #475569); border-radius: 12px; padding: 10px 14px; min-width: 0; }
  .tvc b { display: block; font-size: 26px; line-height: 1.2; }
  .tvc span { display: block; color: var(--muted); font-size: 20px; }
  .tvc.done { opacity: .45; } .tvc.done b { text-decoration: line-through; }
  .tvc.over { border-color: var(--over); } .tvc.over span { color: var(--over); font-weight: 700; }
  .tvc.rw { border-color: var(--rw); border-left-color: var(--rw); } .tvc.rw span { color: var(--rw); }
  .tvc.prov { border-style: dashed; }
  .lane-orders { --lc: var(--m-mo); } .lane-factory { --lc: var(--m-f); } .lane-install { --lc: var(--m-in); } .lane-measure { --lc: var(--m-cm); } .lane-drawings { --lc: var(--m-dr); } .lane-stone { --lc: var(--m-sm); } .lane-contract { --lc: var(--m-cd); } .lane-rework { --lc: var(--rw); }
  .tvnone { grid-column: 1 / 6; color: var(--muted); padding: 10px 0; }
  .next { margin-top: 18px; display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 6px 24px; font-size: 20px; color: var(--muted); }
  .next b { color: var(--fg); font-weight: 600; }
  footer { margin-top: 18px; color: var(--muted); font-size: 16px; display: flex; justify-content: space-between; }
</style></head><body>
<header><h1>Factory · week of ${fmtShort(mon).slice(4)}</h1><div class="sub">${fmtShort(d.today)} · ${overdue.length ? html`<span class="over-count">${overdue.length} overdue</span>` : 'nothing overdue'} · ${week.length} ${week.length === 1 ? 'job step' : 'job steps'} this week</div></header>
${d.message ? html`<div class="msg">${d.message}</div>` : ''}
<div class="grid"><div></div>${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((n, i) => { const day = addDays(mon, i); return html`<div class="dh${day === d.today ? ' today' : ''}">${day === d.today ? 'Today' : n} ${fmtShort(day).slice(4)}</div>`; })}
${TV_ROWS.map(rowBlock)}</div>
<h2 style="font-size:24px;margin:20px 0 6px">Next week</h2>
<div class="next">${nextList.length ? nextList.map(({ s }) => html`<div><b>${jobTitle(jobById.get(s.job_id)!)}</b> · ${stepLabel(s)} · ${fmtShort(s.start_date!)}</div>`) : html`<div>Nothing booked yet.</div>`}</div>
<footer><span>Materials in · Factory (cut, painting, delivery) · Install. Red cards are rework; dashed dates are provisional.</span><span>Refreshes every ${d.every ?? 2} minutes</span></footer>
</body></html>`;
}
