// Materials on a job (George, 7 Nov 2026; R15, R16, R19, R20): what the job needs, where each
// line is coming from, picking when the factory starts, and ready or short at the top.
import { html, Html } from '../web/html.js';
import { fmtShort, Iso } from '../domain/dates.js';
import { Readiness, StockItem } from '../domain/stock.js';
import type { JobMaterialRow, OrderRow } from '../db/stock.js';
import { can, Person } from '../web/auth.js';
import { canStock, n } from './stock.js';

export interface MaterialsView {
  jobId: number;
  person: Person;
  lines: JobMaterialRow[];
  orders: OrderRow[];
  items: StockItem[];
  readiness: Readiness;
  factoryDate: Iso | null;
  onHand: Map<number, number>;
  allocated: Map<number, number>;
}

export function readinessPill(r: Readiness, factoryDate: Iso | null): Html {
  if (r.state === 'none') return html`<span class="spill">No materials loaded</span>`;
  if (r.state === 'ready') return html`<span class="spill done">Ready to cut</span>`;
  if (r.state === 'waiting') return html`<span class="spill prov">On order${r.expected ? `, expected ${fmtShort(r.expected)}` : ''}${r.expected && factoryDate && r.expected > factoryDate ? ' · after the factory date' : ''}</span>`;
  return html`<span class="spill over">Short</span>`;
}

export function materialsPanel(d: MaterialsView): Html {
  const stock = canStock(d.person);
  const floor = can(d.person, 'doer');
  const back = `/jobs/${d.jobId}#materials`;
  const lineState = new Map(d.readiness.lines.map((l) => [l.material.id, l]));
  const toPick = d.lines.filter((m) => m.allocated > m.picked);
  return html`<section class="panel" id="materials" style="gap:8px">
    <div class="row"><h2>Materials</h2><span>${readinessPill(d.readiness, d.factoryDate)}</span></div>
    <p class="muted small">From the Cabinet Vision cut list or typed. Source takes stock on hand first, then stock on order, and lists the rest to order by the factory date less the supplier's lead time. Picking takes it off the shelf.</p>
    ${d.lines.length ? html`<div class="tbl" tabindex="0"><table class="mats"><thead><tr><th>Item</th><th class="num">Needs</th><th class="num">From stock</th><th class="num">Picked</th><th>Where it stands</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${d.lines.map((m) => {
        const st = lineState.get(m.id);
        const free = (d.onHand.get(m.item_id) ?? 0) - (d.allocated.get(m.item_id) ?? 0);
        const mine = d.orders.filter((o) => o.job_id === d.jobId && o.item_id === m.item_id && (o.status === 'listed' || o.status === 'ordered'));
        const stand = st?.state === 'ready' ? html`<span class="spill done">${m.picked >= m.qty ? 'picked' : 'on hand'}</span>`
          : st?.state === 'on_order' ? html`<span class="spill prov">${mine.some((o) => o.status === 'ordered') ? `ordered${st.expected ? `, in ${fmtShort(st.expected)}` : ''}` : 'on the order list'}</span>`
          : html`<span class="spill over">short ${n(st?.short ?? m.qty)}</span>`;
        return html`<tr id="m-${m.id}"><td><a href="/stock/items/${m.item_id}">${m.name}</a><div class="muted small">${[m.code, m.unit, m.nested ? 'from the nested file' : 'estimated'].filter(Boolean).join(' · ')}${m.note ? ` · ${m.note}` : ''}</div></td>
          <td class="num"><strong>${n(m.qty)}</strong></td><td class="num">${n(m.allocated)}<div class="muted small">${n(free + Math.max(0, m.allocated - m.picked))} free</div></td><td class="num">${n(m.picked)}</td><td>${stand}</td>
          <td>${stock ? html`<form method="post" action="/jobs/${d.jobId}/materials/${m.id}/delete"><input type="hidden" name="back" value="${back}"><button class="linkbtn small danger" type="submit" aria-label="Remove ${m.name}">Remove</button></form>` : ''}</td></tr>`;
      })}
    </tbody></table></div>
    ${stock ? html`<form method="post" action="/jobs/${d.jobId}/materials/source" class="acts"><input type="hidden" name="back" value="${back}">
      <button class="btn primary" type="submit">Source: stock first, then on order, else list it</button>
      <label class="checkline small"><input type="checkbox" name="hold" value="1" checked> Leave stock that nearer jobs need</label></form>` : ''}
    ${floor && toPick.length ? html`<details class="pop"><summary class="btn small">Pick for the factory (${toPick.length})</summary>
      <form class="popbody" method="post" action="/jobs/${d.jobId}/materials/pick"><input type="hidden" name="back" value="${back}">
        <p class="muted small">Tick what has left the shelf for this job. It comes off stock as a picked move with your name.</p>
        ${toPick.map((m) => html`<label class="checkline"><input type="checkbox" name="pick" value="${m.id}" checked> ${m.name}: ${n(m.allocated - m.picked)} ${m.unit}</label>`)}
        <div class="acts"><button class="btn primary" type="submit">Picked</button></div></form></details>` : ''}`
    : html`<p class="muted">Nothing loaded yet.</p>`}
    ${stock ? html`<div class="inline">
      <details class="pop"><summary class="btn small">Add a line</summary>
        <form class="popbody" method="post" action="/jobs/${d.jobId}/materials"><input type="hidden" name="back" value="${back}">
          <div class="fixgrid"><label class="f">Item<input name="item" list="matitems" required placeholder="type to find"><datalist id="matitems">${d.items.filter((i) => i.active).map((i) => html`<option value="${i.name}${i.code ? ` [${i.code}]` : ''}">`)}</datalist></label>
          <label class="f">Quantity<input name="qty" type="number" step="0.01" min="0.01" required></label><label class="f">Note<input name="note" maxlength="120"></label></div>
          <div class="acts"><button class="btn primary" type="submit">Add</button></div></form></details>
      <details class="pop"><summary class="btn small">Load the Cabinet Vision cut list</summary>
        <form class="popbody" method="post" action="/jobs/${d.jobId}/materials/upload" enctype="multipart/form-data" data-files><input type="hidden" name="back" value="${back}">
          <p class="muted small">A CSV or tab file: the code in the first column, the quantity in the last number column; a header row is fine. Codes the hub doesn't know are shown for a one-time match and remembered. Same code again replaces the line.</p>
          <label class="f">File<input type="file" name="file" accept=".csv,.txt,.tsv,text/csv,text/plain" required></label>
          <label class="checkline"><input type="checkbox" name="nested" value="1"> From the nested file (sheet counts are right)</label>
          <div class="acts"><button class="btn primary" type="submit">Load</button></div></form></details>
    </div>` : ''}
  </section>`;
}

/** Codes the cut list had that the hub doesn't know: match each to an item once, or skip it. */
export function matchPage(d: { jobId: number; unknown: { code: string; qty: number }[]; items: StockItem[]; nested: boolean; known: number }): Html {
  return html`<section class="panel" style="gap:8px"><h2>${d.unknown.length} ${d.unknown.length === 1 ? 'code' : 'codes'} the hub doesn't know</h2>
    <p class="muted small">${d.known ? `${d.known} ${d.known === 1 ? 'line' : 'lines'} matched and loaded already. ` : ''}Pick the item each code means; the hub remembers it for next time. Leave one blank to skip it.</p>
    <form method="post" action="/jobs/${d.jobId}/materials/match"><input type="hidden" name="nested" value="${d.nested ? '1' : '0'}">
      <div class="tbl" tabindex="0"><table><thead><tr><th>Code on the cut list</th><th class="num">Qty</th><th>Is</th></tr></thead><tbody>
        ${d.unknown.map((u, i) => html`<tr><td class="mono">${u.code}<input type="hidden" name="code_${i}" value="${u.code}"><input type="hidden" name="qty_${i}" value="${u.qty}"></td><td class="num">${n(u.qty)}</td>
          <td><input name="item_${i}" list="matitems" placeholder="type to find, or leave blank" style="width:100%"></td></tr>`)}
      </tbody></table></div>
      <datalist id="matitems">${d.items.filter((i) => i.active).map((i) => html`<option value="${i.name}${i.code ? ` [${i.code}]` : ''}">`)}</datalist>
      <div class="acts"><button class="btn primary" type="submit">Save the matches</button><a class="btn" href="/jobs/${d.jobId}#materials">Skip them all</a></div>
    </form></section>`;
}
