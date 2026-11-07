// Load (George, 7 Nov 2026): six weeks of hours booked against hours available, per area and
// per day. Jobman's capacity chart. Capacity itself is set in Settings.
import { html, Html } from '../web/html.js';
import { addDays, fmtShort, Iso } from '../domain/dates.js';
import { DayLoad, JobRow, LabourCentre } from '../domain/checks.js';

export function loadPage(d: { from: Iso; today: Iso; rows: { centre: LabourCentre; days: DayLoad[] }[]; jobs: JobRow[]; hoursPerDay: number; saturdays?: boolean }): Html {
  const names = new Map(d.jobs.map((j) => [j.id, j.client_name]));
  const per = d.saturdays ? 6 : 5;
  const dows = d.saturdays ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const weeks = Array.from({ length: Math.ceil((d.rows[0]?.days.length ?? 0) / per) }, (_, i) => i);
  const cell = (x: DayLoad) => {
    const over = x.booked > x.available;
    const pct = x.available ? Math.min(100, Math.round((x.booked / x.available) * 100)) : x.booked ? 100 : 0;
    const title = `${fmtShort(x.day)}: ${x.booked} h booked, ${x.available} h available${x.closed ? ` (${x.closed})` : ''}${x.jobIds.length ? `: ${x.jobIds.map((id) => names.get(id)).join(', ')}` : ''}`;
    return html`<td class="ld${over ? ' over' : ''}${x.day === d.today ? ' today' : ''}${x.closed ? ' closed' : ''}" title="${title}">
      <div class="ldbar" aria-hidden="true"><i style="width:${pct}%"></i></div>
      <span class="num">${x.booked}<span class="muted">/${x.available}</span></span>
      ${x.jobIds.length ? html`<span class="ldjobs">${x.jobIds.map((id) => (names.get(id) ?? '').split(' ')[0]).join(', ')}</span>` : x.closed ? html`<span class="ldjobs muted">${x.closed}</span>` : ''}
    </td>`;
  };
  return html`<p class="muted">Hours booked against hours available, each working day for six weeks. A kitchen's factory or install day counts as ${d.hoursPerDay} h; a rework task counts its hours. Red is over. Change the hours, or add leave and shutdowns, under <a href="/settings#capacity">Settings → Capacity</a>.</p>
  ${d.rows.map((r) => html`<section class="panel" style="gap:6px">
    <h2>${r.centre.label}</h2>
    <div class="tl-box" tabindex="0"><table class="loadt">
      <thead><tr><th>Week</th>${dows.map((n) => html`<th>${n}</th>`)}<th class="num">Week</th></tr></thead>
      <tbody>${weeks.map((w) => {
        const days = r.days.slice(w * per, w * per + per);
        const booked = Math.round(days.reduce((a, x) => a + x.booked, 0) * 10) / 10;
        const avail = Math.round(days.reduce((a, x) => a + x.available, 0) * 10) / 10;
        return html`<tr><td class="ldwk"><strong>${fmtShort(addDays(d.from, w * 7)).slice(4)}</strong></td>${days.map(cell)}<td class="num ldw${booked > avail ? ' over' : ''}"><strong>${booked}</strong> / ${avail} h</td></tr>`;
      })}</tbody>
    </table></div>
  </section>`)}
  ${!d.rows.length ? html`<p>No areas set up yet. Add them in Settings.</p>` : ''}`;
}
