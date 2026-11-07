// Stock screens (George, 7 Nov 2026): what is on hand, what jobs need by week, the order list,
// Phil's Friday count, offcuts, bin labels. No prices.
import { html, Html } from '../web/html.js';
import { fmtLong, fmtShort, Iso, sydneyDate } from '../domain/dates.js';
import { DemandRow, KIND_LABEL, StockItem } from '../domain/stock.js';
import type { Readiness } from '../domain/stock.js';
import type { OffcutRow, OrderRow, StockMoveRow } from '../db/stock.js';
import { can, Person } from '../web/auth.js';
import { qrSvg } from './sheet.js';
import { jobTitle, JobRow } from '../domain/checks.js';

export const n = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ''));

/** Editors and anyone with the Stock tick change stock; Doers do the floor's bit; Viewers look. */
export function canStock(p: Person): boolean {
  return can(p, 'editor') || p.can_stock;
}

export function stockNav(current: 'home' | 'items' | 'orders' | 'count' | 'offcuts', counts: { orders?: number; low?: number } = {}): Html {
  const tab = (key: string, href: string, label: string, badge?: number) => html`<a href="${href}"${current === key ? html` aria-current="true"` : ''}>${label}${badge ? html` <span class="badge" aria-label="${badge}">${badge}</span>` : ''}</a>`;
  return html`<nav class="subtabs" aria-label="Stock"><div class="seg">${tab('home', '/stock', 'Need and supply')}${tab('items', '/stock/items', 'Items')}${tab('orders', '/stock/orders', 'Order list', counts.orders)}${tab('count', '/stock/count', 'Count')}${tab('offcuts', '/stock/offcuts', 'Offcuts')}</div></nav>`;
}

// ---------- Need and supply (R17), low stock (R20), jobs short (R20) ----------

export function stockHome(d: { person: Person; rows: DemandRow[]; mondays: Iso[]; jobs: Map<number, JobRow>; short: { job: JobRow; factoryDate: Iso | null; r: Readiness }[]; waiting: number; lowCount: number; listedGaps: number }): Html {
  const stock = canStock(d.person);
  const gaps = d.rows.filter((r) => r.gap > 0);
  const low = d.rows.filter((r) => r.low && r.gap <= 0);
  const rest = d.rows.filter((r) => r.gap <= 0 && !r.low && r.needed > 0);
  const row = (r: DemandRow) => html`<tr class="${r.gap > 0 ? 'gap' : r.low ? 'low' : ''}">
    <td><a href="/stock/items/${r.item.id}">${r.item.name}</a><div class="muted small">${[r.item.code, r.item.unit, r.item.supplier].filter(Boolean).join(' · ')}</div></td>
    ${r.weeks.map((w) => html`<td class="num${w.qty ? '' : ' muted'}" title="${w.jobIds.map((id) => d.jobs.get(id)?.client_name ?? id).join(', ')}">${w.qty ? n(w.qty) : '·'}</td>`)}
    <td class="num">${n(r.onHand)}</td><td class="num muted">${r.allocated ? n(r.allocated) : '·'}</td><td class="num"><strong>${n(r.available)}</strong></td>
    <td class="num">${r.onOrder ? html`${n(r.onOrder)}<div class="muted small">${r.expected ? fmtShort(r.expected) : 'no date'}</div>` : '·'}</td>
    <td class="num">${r.gap > 0 ? html`<strong class="nodate">${n(r.gap)}</strong>` : r.low ? html`<span class="tag warn">low</span>` : html`<span class="muted">ok</span>`}</td>
    <td>${r.gap > 0 && r.orderBy ? html`<strong>${fmtShort(r.orderBy)}</strong>` : ''}${r.gap > 0 && r.orderBy && r.orderBy < d.mondays[0] ? html` <span class="nodate small">late</span>` : ''}</td>
  </tr>`;
  const table = (rows: DemandRow[]) => html`<div class="tl-box" tabindex="0"><table class="demand">
    <thead><tr><th>Item</th>${d.mondays.map((m) => html`<th class="num">${fmtShort(m).slice(4)}</th>`)}<th class="num">On hand</th><th class="num">Spoken for</th><th class="num">Free</th><th class="num">On order</th><th class="num">Gap</th><th>Order by</th></tr></thead>
    <tbody>${rows.map(row)}</tbody></table></div>`;
  return html`${stockNav('home', { orders: d.waiting, low: d.lowCount })}
  <div class="tiles">
    <a class="tile${gaps.length ? ' over' : ''}" href="#gaps"><b>${gaps.length}</b><span>Short</span><small>Lines the next six weeks need and you don't have</small></a>
    <a class="tile${low.length ? ' warn' : ''}" href="#low"><b>${low.length}</b><span>Running low</span><small>Standing lines at or under minimum</small></a>
    <a class="tile${d.short.length ? ' over' : ''}" href="#jobs"><b>${d.short.length}</b><span>Jobs short</span><small>Can't cut yet</small></a>
    <a class="tile" href="/stock/orders"><b>${d.waiting}</b><span>To order</span><small>On the order list</small></a>
  </div>
  <section class="panel" id="gaps"><div class="row"><h2>Need against supply, six weeks by factory date</h2><span class="muted small">Needed each week, what is free (on hand less what jobs have spoken for), what is coming, and by when to order the gap.</span></div>
    ${gaps.length ? html`${table(gaps)}
      ${stock ? html`<form method="post" action="/stock/orders/from-gaps" class="acts"><button class="btn primary" type="submit">Put the ${gaps.length} ${gaps.length === 1 ? 'gap' : 'gaps'} on the order list</button><span class="muted small">${d.listedGaps ? `${d.listedGaps} already listed.` : ''} Each becomes a line for stock with its order-by date.</span></form>` : ''}` : html`<p class="muted">Nothing short. Every line jobs need in the next six weeks is on hand or on order.</p>`}
  </section>
  <section class="panel" id="low"><div class="row"><h2>Running low</h2><span class="muted small">Standing lines at or under their minimum with nothing on order.</span></div>
    ${low.length ? html`<div class="tbl" tabindex="0"><table><thead><tr><th>Item</th><th>Bin</th><th class="num">Free</th><th class="num">Minimum</th><th class="num">Reorder</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${low.map((r) => html`<tr><td><a href="/stock/items/${r.item.id}">${r.item.name}</a><div class="muted small">${r.item.supplier}</div></td><td>${r.item.bin}</td><td class="num">${n(r.available)}</td><td class="num">${n(r.item.minimum ?? 0)}</td><td class="num">${r.item.reorder_qty ? n(r.item.reorder_qty) : '·'}</td>
        <td>${stock || can(d.person, 'doer') ? html`<form method="post" action="/stock/orders"><input type="hidden" name="item_id" value="${r.item.id}"><input type="hidden" name="qty" value="${n(r.item.reorder_qty || Math.max(1, (r.item.minimum ?? 0) * 2 - r.available))}"><input type="hidden" name="reason" value="low"><input type="hidden" name="back" value="/stock#low"><button class="btn small" type="submit">List it</button></form>` : ''}</td></tr>`)}
    </tbody></table></div>` : html`<p class="muted">Nothing running low${d.rows.some((r) => r.item.standing && r.item.minimum == null) ? '. Standing lines without a minimum are not checked: set one on the item.' : '.'}</p>`}
  </section>
  <section class="panel" id="jobs"><div class="row"><h2>Jobs short for the factory</h2><span class="muted small">A job is ready when every material line is on hand (spoken for) or picked.</span></div>
    ${d.short.length ? d.short.map((s) => html`<div class="item"><div class="what"><div><a href="/jobs/${s.job.id}#materials" style="color:inherit">${jobTitle(s.job)}</a> · factory ${s.factoryDate ? fmtShort(s.factoryDate) : 'not dated'}</div>
      <div class="muted small">${s.r.lines.filter((l) => l.state !== 'ready').map((l) => `${(l.material as { name?: string }).name ?? 'item'}: ${l.state === 'short' ? `short ${n(l.short)}` : `on order${l.expected ? `, expected ${fmtShort(l.expected)}` : ''}`}`).join(' · ')}</div></div>
      <a class="btn small" href="/jobs/${s.job.id}#materials">Open</a></div>`) : html`<p class="muted">No live job with materials loaded is short.</p>`}
  </section>
  ${rest.length ? html`<section class="panel"><details><summary style="cursor:pointer"><h2 style="display:inline">Covered</h2> <span class="muted small">${rest.length} lines jobs need that are on hand or on order</span></summary><div style="padding-top:8px">${table(rest)}</div></details></section>` : ''}`;
}

// ---------- Items (R14) ----------

export interface ItemsView {
  person: Person; items: StockItem[]; onHand: Map<number, number>; allocated: Map<number, number>; onOrder: Map<number, { qty: number; expected: Iso | null }>;
  q: string; kind: string; standing: boolean; waiting: number;
}

const KINDS = Object.entries(KIND_LABEL) as [StockItem['kind'], string][];
const UNITS = ['sheet', 'roll', 'length', 'box', 'carton', 'pcs', 'packet', 'pack', 'set', 'bag', 'reel', 'pail', 'bottle', 'unit', 'each', 'metre'];

export function itemsPage(d: ItemsView): Html {
  const stock = canStock(d.person);
  const q = d.q.toLowerCase();
  const list = d.items.filter((i) => (!q || `${i.name} ${i.code} ${i.category} ${i.supplier} ${i.bin}`.toLowerCase().includes(q)) && (!d.kind || i.kind === d.kind) && (!d.standing || i.standing));
  const groups = [...new Set(list.map((i) => i.category))];
  return html`${stockNav('items', { orders: d.waiting })}
  <section class="panel">
    <form method="get" action="/stock/items" class="inline" data-plain>
      <input type="search" name="q" value="${d.q}" placeholder="Name, code, supplier or bin" aria-label="Find an item" style="flex:1 1 220px">
      <select name="kind" aria-label="Kind"><option value="">Every kind</option>${KINDS.map(([k, l]) => html`<option value="${k}"${d.kind === k ? html` selected` : ''}>${l}</option>`)}</select>
      <label class="checkline"><input type="checkbox" name="standing" value="1"${d.standing ? html` checked` : ''}> Standing only</label>
      <button class="btn" type="submit">Show</button>
      <a class="btn small" href="/stock/labels" target="_blank" rel="noopener">Bin labels ↗</a>
    </form>
    <p class="muted small">${list.length} of ${d.items.length} items. Standing lines are always stocked: on the Friday count and the running-low rule. A line can only flag low when it has a minimum. On hand is the ledger's sum, never typed.</p>
    <div class="tbl" tabindex="0"><table class="items"><thead><tr><th>Item</th><th>Code</th><th>Unit</th><th>Supplier</th><th class="num">On hand</th><th class="num">Free</th><th class="num">On order</th><th class="num">Min</th><th>Bin</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${groups.map((g) => html`<tr class="grp"><td colspan="10">${g || 'Uncategorised'}</td></tr>${list.filter((i) => i.category === g).map((i) => {
        const oh = d.onHand.get(i.id) ?? 0; const free = oh - (d.allocated.get(i.id) ?? 0); const oo = d.onOrder.get(i.id);
        const low = i.standing && i.minimum != null && free <= i.minimum;
        return html`<tr class="${i.active ? '' : 'off'}"><td><a href="/stock/items/${i.id}">${i.name}</a>${i.standing ? html` <span class="spill">standing</span>` : ''}${i.needs_check ? html` <span class="spill prov" title="Recount at the next walk">check</span>` : ''}${i.use_down ? html` <span class="spill" title="Use on legacy jobs, never reorder">use down</span>` : ''}${!i.active ? html` <span class="spill">off</span>` : ''}</td>
          <td class="mono small">${i.code}</td><td>${i.unit}</td><td>${i.supplier}</td><td class="num">${n(oh)}</td><td class="num${low ? ' nodate' : ''}"><strong>${n(free)}</strong></td><td class="num">${oo ? html`${n(oo.qty)}<div class="muted small">${oo.expected ? fmtShort(oo.expected) : ''}</div>` : '·'}</td><td class="num">${i.minimum != null ? n(i.minimum) : '·'}</td><td>${i.bin}</td>
          <td><a class="btn small" href="/stock/items/${i.id}">Open</a></td></tr>`;
      })}`)}
      ${!list.length ? html`<tr><td colspan="10" class="muted">Nothing matches.</td></tr>` : ''}
    </tbody></table></div>
  </section>
  ${stock ? html`<section class="panel"><details class="pop"><summary class="btn small">Add an item</summary>${itemForm(null, '/stock/items')}</details>
    <details class="pop"><summary class="btn small">Import or update from a spreadsheet</summary>
      <form class="popbody" method="post" action="/stock/items/import" enctype="multipart/form-data" data-files>
        <p class="muted small">A CSV with a header row. Columns it knows: <code>name</code> (required), <code>code</code>, <code>category</code>, <code>kind</code> (board, edging, hardware, consumable, other), <code>unit</code>, <code>supplier</code>, <code>lead_days</code>, <code>minimum</code>, <code>reorder_qty</code>, <code>bin</code>, <code>standing</code> (yes/no), <code>image_url</code>, <code>notes</code>. A row whose code or name matches an item updates it; otherwise it is added. Counts are not imported: use Count.</p>
        <label class="f">File<input type="file" name="file" accept=".csv,text/csv" required></label>
        <div class="acts"><button class="btn primary" type="submit">Import</button></div></form></details></section>` : ''}`;
}

export function itemForm(i: StockItem | null, action: string): Html {
  const v = (k: keyof StockItem) => (i ? String(i[k] ?? '') : '');
  return html`<form class="popbody" method="post" action="${action}">
    <div class="fixgrid">
      <label class="f">Name<input name="name" required maxlength="120" value="${v('name')}"></label>
      <label class="f">Code (Cabinet Vision or supplier)<input name="code" maxlength="60" value="${v('code')}" placeholder="what the cut list says"></label>
      <label class="f">Kind<select name="kind">${KINDS.map(([k, l]) => html`<option value="${k}"${(i?.kind ?? 'hardware') === k ? html` selected` : ''}>${l}</option>`)}</select></label>
      <label class="f">Category (grouping)<input name="category" maxlength="60" value="${v('category')}" placeholder="e.g. Boards – full sheets"></label>
      <label class="f">Unit<input name="unit" list="units" maxlength="20" value="${i?.unit ?? 'each'}"><datalist id="units">${UNITS.map((u) => html`<option value="${u}">`)}</datalist></label>
      <label class="f">Supplier<input name="supplier" maxlength="60" value="${v('supplier')}"></label>
      <label class="f">Lead time, working days<input name="lead_days" type="number" min="0" max="120" value="${i?.lead_days ?? 5}"></label>
      <label class="f">Bin or shelf<input name="bin" maxlength="40" value="${v('bin')}"></label>
      <label class="f">Minimum (standing lines)<input name="minimum" type="number" step="0.01" min="0" value="${i?.minimum ?? ''}"></label>
      <label class="f">Reorder quantity<input name="reorder_qty" type="number" step="0.01" min="0" value="${i?.reorder_qty ?? ''}"></label>
      <label class="f wide">Picture link (the supplier's page, so the right thing arrives)<input name="image_url" type="url" value="${v('image_url')}" placeholder="https://…"></label>
      <label class="f wide">Notes<input name="notes" maxlength="300" value="${v('notes')}"></label>
    </div>
    <div class="inline">
      <label class="checkline"><input type="checkbox" name="standing" value="1"${i?.standing ? html` checked` : ''}> Standing: always stocked, counted on Fridays</label>
      <label class="checkline"><input type="checkbox" name="needs_check" value="1"${i?.needs_check ? html` checked` : ''}> Recount at the next walk</label>
      <label class="checkline"><input type="checkbox" name="use_down" value="1"${i?.use_down ? html` checked` : ''}> Use down, never reorder</label>
      <label class="checkline"><input type="checkbox" name="active" value="1"${!i || i.active ? html` checked` : ''}> Active</label>
    </div>
    <div class="acts"><button class="btn primary" type="submit">${i ? 'Save' : 'Add the item'}</button></div>
  </form>`;
}

export interface ItemView {
  person: Person; item: StockItem; onHand: number; allocated: number; moves: StockMoveRow[]; orders: OrderRow[]; offcuts: OffcutRow[]; aliases: string[];
  needs: { job: JobRow; qty: number; picked: number; factoryDate: Iso | null }[]; waiting: number; appUrl: string;
}

export function itemPage(d: ItemView): Html {
  const i = d.item;
  const stock = canStock(d.person);
  const floor = can(d.person, 'doer');
  const back = `/stock/items/${i.id}`;
  const MOVE: Record<string, string> = { opening: 'Opening balance', received: 'Received', picked: 'Picked', counted: 'Counted', adjusted: 'Adjusted', offcut: 'Offcut' };
  return html`${stockNav('items', { orders: d.waiting })}
  <div class="job">
  <div style="display:flex;flex-direction:column;gap:4px">
    <div class="eyebrow">${i.category || KIND_LABEL[i.kind]}${i.code ? ` · ${i.code}` : ''}</div>
    <h2 style="font-size:24px">${i.name}</h2>
    <div class="pills"><span class="pill">${KIND_LABEL[i.kind]}</span><span class="pill">${i.unit}</span>${i.supplier ? html`<span class="pill">${i.supplier} · ${i.lead_days} days</span>` : ''}${i.standing ? html`<span class="pill">Standing</span>` : ''}${i.bin ? html`<span class="pill">Bin ${i.bin}</span>` : ''}${i.image_url ? html`<a class="pill link" href="${i.image_url}" target="_blank" rel="noopener">Picture ↗</a>` : ''}<a class="pill link" href="/stock/labels?item=${i.id}" target="_blank" rel="noopener">Bin label ↗</a></div>
  </div>
  <div class="tiles">
    <div class="tile"><b>${n(d.onHand)}</b><span>On hand</span><small>${i.unit}, from the ledger</small></div>
    <div class="tile"><b>${n(d.allocated)}</b><span>Spoken for</span><small>Allocated to jobs, not yet picked</small></div>
    <div class="tile${i.standing && i.minimum != null && d.onHand - d.allocated <= i.minimum ? ' warn' : ''}"><b>${n(d.onHand - d.allocated)}</b><span>Free</span><small>${i.minimum != null ? `Minimum ${n(i.minimum)}` : 'No minimum set'}</small></div>
    <div class="tile"><b>${n(d.orders.filter((o) => o.status !== 'received' && o.status !== 'cancelled').reduce((a, o) => a + o.qty - o.received_qty, 0))}</b><span>On order</span><small>${d.orders.filter((o) => o.status === 'ordered').map((o) => o.expected ? fmtShort(o.expected) : 'no date')[0] ?? 'Nothing coming'}</small></div>
  </div>
  ${floor ? html`<section class="panel" style="gap:8px"><h2>Move stock</h2>
    <div class="fixgrid">
      <form method="post" action="/stock/items/${i.id}/count" class="stack"><input type="hidden" name="back" value="${back}"><label class="f">Counted on the shelf<input name="counted" type="number" step="0.01" min="0" required placeholder="${n(d.onHand)}"></label><button class="btn" type="submit">Record the count</button><span class="muted small">The difference is logged as a count move.</span></form>
      <form method="post" action="/stock/items/${i.id}/move" class="stack"><input type="hidden" name="back" value="${back}"><label class="f">Received, or taken (minus)<input name="qty" type="number" step="0.01" required placeholder="e.g. 12 or -2"></label><label class="f">Why<input name="reason" required maxlength="120" placeholder="e.g. Polytec delivery, damaged sheet"></label><button class="btn" type="submit">Record it</button></form>
    </div></section>` : ''}
  ${d.needs.length ? html`<section class="panel"><h2>Jobs that need it</h2><div class="tbl" tabindex="0"><table><thead><tr><th>Job</th><th>Factory</th><th class="num">Needs</th><th class="num">Picked</th></tr></thead><tbody>
    ${d.needs.map((x) => html`<tr><td><a href="/jobs/${x.job.id}#materials">${jobTitle(x.job)}</a></td><td>${x.factoryDate ? fmtShort(x.factoryDate) : 'not dated'}</td><td class="num">${n(x.qty)}</td><td class="num">${n(x.picked)}</td></tr>`)}</tbody></table></div></section>` : ''}
  ${d.orders.length ? html`<section class="panel"><h2>Orders</h2><div class="tbl" tabindex="0"><table><thead><tr><th>Listed</th><th class="num">Qty</th><th>For</th><th>Status</th><th>Expected</th><th class="num">Received</th></tr></thead><tbody>
    ${d.orders.map((o) => html`<tr><td>${fmtShort(sydneyDate(o.listed_at))}</td><td class="num">${n(o.qty)}</td><td>${o.client_name ?? 'stock'}</td><td>${o.status}${o.ordered_on ? ` ${fmtShort(o.ordered_on)}` : ''}</td><td>${o.expected ? fmtShort(o.expected) : ''}</td><td class="num">${n(o.received_qty)}</td></tr>`)}</tbody></table></div><a class="small" href="/stock/orders">The order list</a></section>` : ''}
  ${i.kind === 'board' || d.offcuts.length ? html`<section class="panel"><div class="row"><h2>Offcuts</h2><span class="muted small">Over half a sheet, by size and where it is.</span></div>
    ${d.offcuts.length ? d.offcuts.map((o) => html`<div class="item"><div class="what"><div>${o.length_mm} × ${o.width_mm} mm${o.location ? ` · ${o.location}` : ''}${o.used_at ? ' · used' : ''}</div><div class="muted small">${o.note ? `${o.note} · ` : ''}logged by ${o.logged_by_name ?? 'unknown'}, ${fmtShort(sydneyDate(o.logged_at))}</div></div>${!o.used_at && floor ? html`<form method="post" action="/stock/offcuts/${o.id}/used"><input type="hidden" name="back" value="${back}"><button class="btn small" type="submit">Used</button></form>` : ''}</div>`) : html`<p class="muted small">None logged.</p>`}
    ${floor ? offcutForm(i.id, back) : ''}</section>` : ''}
  <section class="panel"><div class="row"><h2>Ledger</h2><span class="muted small">Newest first. Never edited; a mistake gets a correcting move.</span></div>
    <div class="tbl" tabindex="0"><table><thead><tr><th>When</th><th>What</th><th class="num">Qty</th><th>Why</th><th>Who</th></tr></thead><tbody>
      ${d.moves.map((m) => html`<tr><td>${fmtShort(sydneyDate(m.moved_at))}</td><td>${MOVE[m.kind] ?? m.kind}${m.client_name ? ` · ${m.client_name}` : ''}</td><td class="num${m.qty < 0 ? ' nodate' : ''}">${m.qty > 0 ? '+' : ''}${n(m.qty)}</td><td class="small">${m.reason}</td><td class="small">${m.moved_by_name ?? 'System'}</td></tr>`)}
      ${!d.moves.length ? html`<tr><td colspan="5" class="muted">No moves yet: on hand is 0 until something is counted or received.</td></tr>` : ''}
    </tbody></table></div></section>
  ${stock ? html`<section class="panel"><details class="pop"><summary class="btn small">Edit the item</summary>${itemForm(i, `/stock/items/${i.id}`)}</details>
    <details class="pop"><summary class="btn small">Other codes for it${d.aliases.length ? ` (${d.aliases.length})` : ''}</summary><div class="popbody">
      <p class="muted small">A cut list or supplier may call it something else. ${d.aliases.length ? `Known: ${d.aliases.join(', ')}.` : 'None yet.'}</p>
      <form method="post" action="/stock/items/${i.id}/alias" class="inline"><input name="alias" required maxlength="60" placeholder="e.g. CWM-2415"><button class="btn small" type="submit">Add</button></form></div></details></section>` : ''}
  </div>`;
}

export function offcutForm(itemId: number | null, back: string, boards: StockItem[] = []): Html {
  return html`<details class="pop"><summary class="btn small">Log an offcut</summary>
    <form class="popbody" method="post" action="/stock/offcuts"><input type="hidden" name="back" value="${back}">
      <div class="fixgrid">
        ${itemId ? html`<input type="hidden" name="item_id" value="${itemId}">` : html`<label class="f">Colour (board)<select name="item_id" required><option value="">Pick one</option>${boards.map((b) => html`<option value="${b.id}">${b.name}</option>`)}</select></label>`}
        <label class="f">Length, mm<input name="length_mm" type="number" min="100" max="4000" required></label>
        <label class="f">Width, mm<input name="width_mm" type="number" min="100" max="2500" required></label>
        <label class="f">Where<input name="location" maxlength="60" placeholder="e.g. Offcut rack, bay 2"></label>
        <label class="f">Note<input name="note" maxlength="120"></label>
      </div>
      <div class="acts"><button class="btn primary" type="submit">Log it</button></div></form></details>`;
}

// ---------- Order list (R18) ----------

export function ordersPage(d: { person: Person; orders: OrderRow[]; items: StockItem[]; jobs: JobRow[]; today: Iso; waiting: number; showDone: boolean }): Html {
  const stock = canStock(d.person);
  const floor = can(d.person, 'doer');
  const open = d.orders.filter((o) => o.status === 'listed' || o.status === 'ordered');
  const done = d.orders.filter((o) => o.status === 'received' || o.status === 'cancelled');
  const suppliers = [...new Set(open.map((o) => o.supplier || 'No supplier set'))].sort();
  const REASON: Record<string, string> = { shortfall: 'short for jobs', low: 'running low', job: 'for the job', manual: 'added by hand' };
  const line = (o: OrderRow) => html`<tr class="${o.status === 'ordered' ? 'ordered' : ''}${o.order_by && o.order_by < d.today && o.status === 'listed' ? ' late' : ''}" id="o-${o.id}">
    <td><a href="/stock/items/${o.item_id}">${o.name}</a><div class="muted small">${[o.code, o.unit].filter(Boolean).join(' · ')}</div></td>
    <td class="num"><strong>${n(o.qty - o.received_qty)}</strong>${o.received_qty ? html`<div class="muted small">of ${n(o.qty)}</div>` : ''}</td>
    <td>${o.client_name ? html`<a href="/jobs/${o.job_id}#materials">${o.client_name}</a>` : 'Stock'}<div class="muted small">${REASON[o.reason]}${o.note ? ` · ${o.note}` : ''}</div></td>
    <td>${o.order_by ? html`<strong class="${o.order_by < d.today && o.status === 'listed' ? 'nodate' : ''}">${fmtShort(o.order_by)}</strong>` : html`<span class="muted">—</span>`}</td>
    <td>${o.status === 'ordered' ? html`Ordered ${o.ordered_on ? fmtShort(o.ordered_on) : ''}<div class="muted small">expected ${o.expected ? fmtShort(o.expected) : 'no date'}</div>` : html`<span class="muted">Listed ${fmtShort(sydneyDate(o.listed_at))}${o.listed_by_name ? ` by ${o.listed_by_name.split(' ')[0]}` : ''}</span>`}</td>
    <td class="acts-cell">
      ${o.status === 'listed' && stock ? html`<details class="pop"><summary class="btn small primary">Ordered</summary><form class="popbody" method="post" action="/stock/orders/${o.id}/ordered"><label class="f">Expected in<input type="date" name="expected" required value="${o.order_by ?? ''}"></label><label class="f">Note<input name="note" maxlength="120" value="${o.note}"></label><div class="acts"><button class="btn primary" type="submit">Mark ordered</button></div></form></details>` : ''}
      ${o.status === 'ordered' && floor ? html`<details class="pop"><summary class="btn small primary">In</summary><form class="popbody" method="post" action="/stock/orders/${o.id}/received"><label class="f">How many came<input type="number" step="0.01" min="0.01" name="qty" required value="${n(o.qty - o.received_qty)}"></label><div class="acts"><button class="btn primary" type="submit">Received</button></div><span class="muted small">Less than the lot keeps the rest on order.</span></form></details>` : ''}
      ${stock ? html`<form method="post" action="/stock/orders/${o.id}/cancel"><button class="linkbtn small danger" type="submit">Drop</button></form>` : ''}
    </td></tr>`;
  return html`${stockNav('orders', { orders: d.waiting })}
  <section class="panel"><div class="row"><h2>Order list</h2><span class="muted small">Grouped by supplier. Angela marks each line Ordered with the expected date; the factory ticks In when it arrives. No order numbers, no prices.</span></div>
    ${open.length ? suppliers.map((s) => html`<h3 class="supplier">${s} <span class="muted small">${open.filter((o) => (o.supplier || 'No supplier set') === s).length}</span></h3>
      <div class="tbl" tabindex="0"><table class="orders"><thead><tr><th>Item</th><th class="num">Qty</th><th>For</th><th>Order by</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${open.filter((o) => (o.supplier || 'No supplier set') === s).map(line)}</tbody></table></div>`) : html`<p class="muted">Nothing to order.</p>`}
  </section>
  ${stock ? html`<section class="panel"><details class="pop"><summary class="btn small">Add a line</summary>
    <form class="popbody" method="post" action="/stock/orders"><input type="hidden" name="reason" value="manual"><input type="hidden" name="back" value="/stock/orders">
      <div class="fixgrid">
        <label class="f">Item<input name="item" list="allitems" required placeholder="type to find"><datalist id="allitems">${d.items.filter((i) => i.active).map((i) => html`<option value="${i.name}${i.code ? ` [${i.code}]` : ''}">`)}</datalist></label>
        <label class="f">Quantity<input name="qty" type="number" step="0.01" min="0.01" required></label>
        <label class="f">For<select name="job_id"><option value="">Stock</option>${d.jobs.filter((j) => j.status === 'live').map((j) => html`<option value="${j.id}">${jobTitle(j)}</option>`)}</select></label>
        <label class="f">Order by<input type="date" name="order_by"></label>
        <label class="f wide">Note<input name="note" maxlength="120"></label>
      </div><div class="acts"><button class="btn primary" type="submit">Add to the list</button></div></form></details></section>` : ''}
  <section class="panel"><details${d.showDone ? html` open` : ''}><summary style="cursor:pointer"><h2 style="display:inline">Received and dropped</h2> <span class="muted small">the last ${done.length}</span></summary>
    <div class="tbl" tabindex="0" style="padding-top:8px"><table><thead><tr><th>Item</th><th class="num">Qty</th><th>For</th><th>What happened</th></tr></thead><tbody>
      ${done.map((o) => html`<tr><td>${o.name}</td><td class="num">${n(o.received_qty || o.qty)}</td><td>${o.client_name ?? 'Stock'}</td><td>${o.status === 'received' ? `In ${o.received_on ? fmtShort(o.received_on) : ''}` : 'Dropped'}</td></tr>`)}
      ${!done.length ? html`<tr><td colspan="4" class="muted">Nothing yet.</td></tr>` : ''}
    </tbody></table></div></details></section>`;
}

// ---------- Count (R19) ----------

export function countPage(d: { person: Person; items: StockItem[]; onHand: Map<number, number>; last: Map<number, { at: string; by: string | null }>; all: boolean; waiting: number }): Html {
  const list = d.items.filter((i) => i.active && (d.all || i.standing));
  const groups = [...new Set(list.map((i) => i.category))];
  return html`${stockNav('count', { orders: d.waiting })}
  <section class="panel">
    <div class="row"><h2>${d.all ? 'Stocktake: every active item' : "Friday count: the standing lines"}</h2><div class="seg" role="group"><a href="/stock/count"${!d.all ? html` aria-current="true"` : ''}>Standing</a><a href="/stock/count?all=1"${d.all ? html` aria-current="true"` : ''}>Everything</a></div></div>
    <p class="muted small">Type what is on the shelf. Leave a box empty to skip it. Each difference is logged as a count move with your name; the last count shows beside each line.</p>
    <form method="post" action="/stock/count"${d.all ? html`<input type="hidden" name="all" value="1">` : ''}>
      <div class="tbl" tabindex="0"><table class="count"><thead><tr><th>Item</th><th>Bin</th><th>Last count</th><th class="num">Hub says</th><th class="num">On the shelf</th></tr></thead><tbody>
        ${groups.map((g) => html`<tr class="grp"><td colspan="5">${g || 'Uncategorised'}</td></tr>${list.filter((i) => i.category === g).map((i) => {
          const last = d.last.get(i.id);
          return html`<tr${i.needs_check ? html` class="check"` : ''}><td>${i.name}${i.needs_check ? html` <span class="spill prov">check</span>` : ''}<div class="muted small">${[i.code, i.unit].filter(Boolean).join(' · ')}</div></td><td>${i.bin}</td><td class="small muted">${last ? `${fmtShort(sydneyDate(last.at))}${last.by ? `, ${last.by.split(' ')[0]}` : ''}` : 'never'}</td><td class="num">${n(d.onHand.get(i.id) ?? 0)}</td><td class="num"><input type="number" step="0.01" min="0" name="c_${i.id}" inputmode="decimal" style="width:90px" aria-label="${i.name} counted"></td></tr>`;
        })}`)}
      </tbody></table></div>
      <div class="acts" style="position:sticky;bottom:0;background:var(--surface);padding:10px 0"><button class="btn primary" type="submit">Save the count</button><span class="muted small">${list.length} lines</span></div>
    </form>
  </section>`;
}

// ---------- Offcuts (R19) ----------

export function offcutsPage(d: { person: Person; offcuts: OffcutRow[]; boards: StockItem[]; waiting: number }): Html {
  const floor = can(d.person, 'doer');
  const open = d.offcuts.filter((o) => !o.used_at);
  return html`${stockNav('offcuts', { orders: d.waiting })}
  <section class="panel"><div class="row"><h2>Offcuts</h2><span class="muted small">Pieces over half a sheet of colours we don't keep. Check here before cutting a fresh sheet; they show on Need and supply when the colour is next needed.</span></div>
    ${open.length ? html`<div class="tbl" tabindex="0"><table><thead><tr><th>Colour</th><th>Size</th><th>Where</th><th>Logged</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
      ${open.map((o) => html`<tr><td><a href="/stock/items/${o.item_id}">${o.name}</a></td><td>${o.length_mm} × ${o.width_mm} mm</td><td>${o.location}${o.note ? html`<div class="muted small">${o.note}</div>` : ''}</td><td class="small">${fmtShort(sydneyDate(o.logged_at))}${o.logged_by_name ? `, ${o.logged_by_name.split(' ')[0]}` : ''}</td>
        <td>${floor ? html`<form method="post" action="/stock/offcuts/${o.id}/used"><input type="hidden" name="back" value="/stock/offcuts"><button class="btn small" type="submit">Used</button></form>` : ''}</td></tr>`)}
    </tbody></table></div>` : html`<p class="muted">None on the rack.</p>`}
    ${floor ? offcutForm(null, '/stock/offcuts', d.boards) : ''}
  </section>`;
}

// ---------- Bin labels and the bin page (R20) ----------

export function labelsPage(items: StockItem[], appUrl: string): Html {
  return html`<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bin labels</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { font: 13px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #14171C; margin: 0; padding: 12px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8mm; }
  .label { border: 1.5px solid #14171C; border-radius: 8px; padding: 8px 10px; display: flex; gap: 10px; align-items: center; break-inside: avoid; height: 42mm; }
  .label svg { width: 32mm; height: 32mm; flex: none; }
  .label b { display: block; font-size: 17px; line-height: 1.15; }
  .label .bin { font: 700 22px ui-monospace, Menlo, monospace; }
  .label small { display: block; color: #555; margin-top: 3px; }
  .print { position: fixed; right: 16px; bottom: 16px; padding: 12px 18px; font: 600 15px inherit; background: #14171C; color: #fff; border: 0; border-radius: 10px; cursor: pointer; }
  @media print { .print { display: none; } body { padding: 0; } }
</style></head><body>
<div class="grid">${items.map((i) => html`<div class="label">${qrSvg(`${appUrl}/stock/bin/${i.id}`)}<div><span class="bin">${i.bin || ''}</span><b>${i.name}</b><small>${[i.code, i.unit, i.supplier].filter(Boolean).join(' · ')}${i.minimum != null ? ` · min ${n(i.minimum)}` : ''}</small><small>Scan when it's running low</small></div></div>`)}</div>
<button class="print" onclick="window.print()">Print</button>
</body></html>`;
}

export function binPage(d: { person: Person; item: StockItem; onHand: number; allocated: number; open: OrderRow[]; flash?: string | null }): Html {
  const i = d.item;
  return html`<div class="job" style="max-width:520px">
    <div class="eyebrow">${i.bin ? `Bin ${i.bin} · ` : ''}${i.category}</div>
    <h2 style="font-size:26px">${i.name}</h2>
    <p class="muted">${n(d.onHand - d.allocated)} ${i.unit} free${i.minimum != null ? ` · minimum ${n(i.minimum)}` : ''}</p>
    ${d.open.length ? html`<div class="notice">Already on the list: ${d.open.map((o) => `${n(o.qty - o.received_qty)} ${o.status === 'ordered' ? `ordered${o.expected ? `, expected ${fmtShort(o.expected)}` : ''}` : 'listed'}`).join('; ')}. No need to flag it again.</div>` : ''}
    ${can(d.person, 'doer') ? html`<form method="post" action="/stock/bin/${i.id}/low" class="stack"><input type="hidden" name="back" value="/stock/bin/${i.id}">
      <button class="btn primary" type="submit" style="font-size:20px;padding:18px">Running low</button>
      <span class="muted small">Puts ${i.reorder_qty ? `${n(i.reorder_qty)} ${i.unit}` : 'it'} on the order list with your name and the time.</span></form>` : html`<p class="muted">Sign in as a Doer or Editor to flag it.</p>`}
    <p><a href="/stock/items/${i.id}">The item</a> · <a href="/stock">Stock</a></p>
  </div>`;
}
