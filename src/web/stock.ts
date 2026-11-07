// Stock routes (George, 7 Nov 2026; R14 to R20). Editors and anyone with the Stock tick change
// the catalogue, source jobs and run the order list; Doers count, pick, receive, log offcuts and
// flag a bin; Viewers look. The database holds the same rules (migration 013).
import express, { NextFunction, Request, Response } from 'express';
import { pool, withPerson } from '../db/pool.js';
import { UserError } from '../db/edits.js';
import { appSetting, loadCalendar, loadEverything } from '../db/queries.js';
import { factoryDates, findItemByCode, loadAliases, loadItem, loadItems, loadLastCounts, loadMaterials, loadMoves, loadOffcuts, loadOnHand, loadOrder, loadOrders, stockContext } from '../db/stock.js';
import { allocatedByItem, demand, JobMaterial, lowStock, onOrderByItem, parseCutList, readiness, sourceJob, StockItem } from '../domain/stock.js';
import { addDays, mondayOf, todaySydney } from '../domain/dates.js';
import { page } from '../views/layout.js';
import { binPage, canStock, countPage, itemPage, itemsPage, labelsPage, offcutsPage, ordersPage, stockHome } from '../views/stock.js';
import { matchPage } from '../views/materials.js';
import { readCookie, requireRole, setCookie, Person } from './auth.js';
import { readMultipart, FILE_LIMITS } from './upload.js';
import { config } from '../config.js';
import { jobTitle } from '../domain/checks.js';

const me = (req: Request): Person => req.person!;
function takeFlash(req: Request, res: Response): string | null {
  const f = readCookie(req, 'hub_flash');
  if (f) setCookie(res, 'hub_flash', '', 0);
  return f ?? null;
}
const flash = (res: Response, msg: string) => setCookie(res, 'hub_flash', msg, 60);
const localPath = (p: unknown): p is string => typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\');
const backTo = (req: Request, fallback: string) => (localPath(req.body?.back) ? req.body.back : fallback);
const idParam = (req: Request, key = 'id'): number => {
  const n = Number(req.params[key]);
  if (!Number.isInteger(n) || n <= 0) throw new UserError('That link is broken.');
  return n;
};
const num = (v: unknown, what: string, opts: { min?: number; allowNeg?: boolean } = {}): number => {
  const n = Number(String(v ?? '').trim());
  if (!Number.isFinite(n) || (!opts.allowNeg && n < (opts.min ?? 0))) throw new UserError(`${what}: that isn't a number${opts.min ? ` of at least ${opts.min}` : ''}.`);
  if (Math.abs(n) > 1000000) throw new UserError(`${what}: that's more than a million. Check the figure.`);
  return Math.round(n * 100) / 100;
};
const dateOf = (v: unknown, what: string): string | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new UserError(`${what}: that isn't a date.`);
  return s;
};

/** A courtesy check: Editors or the Stock tick. The database refuses anyone else regardless. */
function requireStock(req: Request, res: Response, next: NextFunction): void {
  if (canStock(me(req))) return next();
  res.status(403).send(page({ title: 'Stock', tab: 'stock', person: me(req), body: pageBody('Only Editors, or someone with the Stock tick in Settings → People, can change stock.') }).value);
}
import { html } from './html.js';
const pageBody = (msg: string) => html`<section class="panel"><p>${msg}</p><p><a href="/stock">Back to Stock</a></p></section>`;

/** "Name [code]" from the pickers, or a plain name or code. */
async function itemFromText(text: string): Promise<StockItem> {
  const t = String(text ?? '').trim();
  if (!t) throw new UserError('Pick the item.');
  const m = t.match(/\[([^\]]+)\]\s*$/);
  if (m) { const i = await findItemByCode(m[1]); if (i) return i; }
  const byCode = await findItemByCode(t);
  if (byCode) return byCode;
  const items = await loadItems();
  const name = t.replace(/\s*\[[^\]]*\]\s*$/, '').toLowerCase();
  const hit = items.filter((i) => i.name.toLowerCase() === name);
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) throw new UserError(`"${t}" matches ${hit.length} items; pick it with its code.`);
  throw new UserError(`"${t}" isn't an item in the hub. Add it under Stock → Items first.`);
}

async function waitingCount(): Promise<number> {
  return Number((await pool.query(`select count(*) from orders where status = 'listed'`)).rows[0].count);
}

function itemFields(body: Record<string, unknown>) {
  const s = (k: string, max = 120) => String(body[k] ?? '').trim().slice(0, max);
  const kind = s('kind');
  if (!['board', 'edging', 'hardware', 'consumable', 'other'].includes(kind)) throw new UserError('Pick the kind.');
  const name = s('name');
  if (!name) throw new UserError('Give the item a name.');
  const url = s('image_url', 400);
  if (url && !/^https:\/\//.test(url)) throw new UserError('The picture link must start with https://');
  const optNum = (k: string) => (String(body[k] ?? '').trim() === '' ? null : num(body[k], k));
  return {
    name, code: s('code', 60), category: s('category', 60), kind, unit: s('unit', 20) || 'each', supplier: s('supplier', 60),
    lead_days: Math.round(num(body.lead_days ?? 5, 'Lead time')), minimum: optNum('minimum'), reorder_qty: optNum('reorder_qty'), bin: s('bin', 40), image_url: url,
    standing: body.standing === '1', needs_check: body.needs_check === '1', use_down: body.use_down === '1', active: body.active === '1', notes: s('notes', 300),
  };
}

export function stockRoutes(): express.Router {
  const r = express.Router();
  const doer = requireRole('doer');
  const today = () => todaySydney();

  // ---------- Need and supply ----------
  r.get('/stock', async (req, res) => {
    const [ctx, cal, all, waiting] = await Promise.all([stockContext(), loadCalendar(), loadEverything(), waitingCount()]);
    const t = today();
    const from = mondayOf(t);
    const rows = demand(ctx.items, ctx.needs, [...ctx.onHand].map(([item_id, qty]) => ({ item_id, qty })), ctx.orders, cal, from, 6);
    const jobs = new Map(all.jobs.map((j) => [j.id, j]));
    const short = all.jobs.filter((j) => j.status === 'live').map((j) => {
      const mats = ctx.materials.filter((m) => m.job_id === j.id);
      const rd = readiness(mats, ctx.orders, j.id);
      const factoryDate = ctx.dates.get(j.id) ?? null;
      return { job: j, factoryDate, r: rd };
    }).filter((x) => x.r.state === 'short' || (x.r.state === 'waiting' && x.r.expected && x.factoryDate && x.r.expected > x.factoryDate))
      .sort((a, b) => (a.factoryDate ?? '9999').localeCompare(b.factoryDate ?? '9999'));
    const listedGaps = ctx.orders.filter((o) => o.reason === 'shortfall' && !o.job_id && o.status === 'listed').length;
    const body = stockHome({ person: me(req), rows, mondays: Array.from({ length: 6 }, (_, i) => addDays(from, i * 7)), jobs, short, waiting, lowCount: rows.filter((x) => x.low).length, listedGaps });
    res.send(page({ title: 'Stock', tab: 'stock', person: me(req), flash: takeFlash(req, res), body, sub: 'What is on hand, what jobs need, what to order' }).value);
  });

  // ---------- Items ----------
  r.get('/stock/items', async (req, res) => {
    const [items, onHand, materials, orders, waiting] = await Promise.all([loadItems(), loadOnHand(), loadMaterials(), loadOrders({ open: true }), waitingCount()]);
    const oo = onOrderByItem(orders);
    const body = itemsPage({ person: me(req), items, onHand, allocated: allocatedByItem(materials), onOrder: new Map([...oo].map(([k, v]) => [k, { qty: v.qty, expected: v.expected }])),
      q: String(req.query.q ?? '').slice(0, 60), kind: String(req.query.kind ?? ''), standing: req.query.standing === '1', waiting });
    res.send(page({ title: 'Stock items', tab: 'stock', person: me(req), flash: takeFlash(req, res), body, sub: 'The catalogue' }).value);
  });

  r.post('/stock/items', requireStock, async (req, res) => {
    const f = itemFields(req.body);
    const id = await withPerson(me(req).id, async (db) => (await db.query(`insert into stock_items (name, code, category, kind, unit, supplier, lead_days, minimum, reorder_qty, bin, image_url, standing, needs_check, use_down, active, notes)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`, [f.name, f.code, f.category, f.kind, f.unit, f.supplier, f.lead_days, f.minimum, f.reorder_qty, f.bin, f.image_url, f.standing, f.needs_check, f.use_down, f.active, f.notes])).rows[0].id);
    flash(res, `${f.name} added.`);
    res.redirect(`/stock/items/${id}`);
  });

  r.post('/stock/items/import', requireStock, async (req, res) => {
    const { files } = await readMultipart(req, FILE_LIMITS);
    const f = files[0];
    if (!f) throw new UserError('Choose the file.');
    const rows = parseCsvObjects(f.bytes.toString('utf8'));
    if (!rows.length) throw new UserError('No rows found. The first row must be the column names, with at least "name".');
    let added = 0, updated = 0;
    const kinds = ['board', 'edging', 'hardware', 'consumable', 'other'];
    await withPerson(me(req).id, async (db) => {
      for (const row of rows) {
        const g = (k: string) => (row[k] ?? '').trim();
        const name = g('name');
        if (!name) continue;
        const code = g('code');
        const existing = code
          ? (await db.query('select id from stock_items where lower(code) = lower($1)', [code])).rows[0]
          : (await db.query('select id from stock_items where lower(name) = lower($1) and code = $2', [name, ''])).rows[0];
        const yes = (v: string) => /^(y|yes|true|1|✓)$/i.test(v);
        const numOrNull = (v: string) => (v === '' ? null : Number(v));
        const sets: Record<string, unknown> = { name, code };
        if (g('category')) sets.category = g('category');
        if (g('kind') && kinds.includes(g('kind').toLowerCase())) sets.kind = g('kind').toLowerCase();
        if (g('unit')) sets.unit = g('unit').toLowerCase();
        if (g('supplier')) sets.supplier = g('supplier');
        if (g('lead_days') !== '') sets.lead_days = Math.round(Number(g('lead_days')));
        if ('minimum' in row) sets.minimum = numOrNull(g('minimum'));
        if ('reorder_qty' in row) sets.reorder_qty = numOrNull(g('reorder_qty'));
        if (g('bin')) sets.bin = g('bin');
        if (g('image_url')) sets.image_url = g('image_url');
        if ('standing' in row) sets.standing = yes(g('standing'));
        if (g('notes')) sets.notes = g('notes');
        if (!sets.kind && !existing) sets.kind = 'hardware';
        const keys = Object.keys(sets);
        if (existing) {
          await db.query(`update stock_items set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [existing.id, ...keys.map((k) => sets[k])]);
          updated++;
        } else {
          await db.query(`insert into stock_items (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => sets[k]));
          added++;
        }
      }
    });
    flash(res, `${added} added, ${updated} updated.`);
    res.redirect('/stock/items');
  });

  r.get('/stock/items/:id', async (req, res) => {
    const id = idParam(req);
    const item = await loadItem(id);
    if (!item) throw new UserError("That item isn't in the hub.");
    const [onHand, materials, moves, orders, offcuts, aliases, all, dates, waiting] = await Promise.all([loadOnHand(), loadMaterials(), loadMoves(id), loadOrders({ itemId: id, limit: 40 }), loadOffcuts({ itemId: id }), loadAliases(), loadEverything(), factoryDates(), waitingCount()]);
    const jobs = new Map(all.jobs.map((j) => [j.id, j]));
    const needs = materials.filter((m) => m.item_id === id && jobs.get(m.job_id)?.status === 'live').map((m) => ({ job: jobs.get(m.job_id)!, qty: m.qty, picked: m.picked, factoryDate: dates.get(m.job_id) ?? null }));
    const body = itemPage({ person: me(req), item, onHand: onHand.get(id) ?? 0, allocated: allocatedByItem(materials).get(id) ?? 0, moves, orders, offcuts, aliases: aliases.filter((a) => a.item_id === id).map((a) => a.alias), needs, waiting, appUrl: config.appUrl });
    res.send(page({ title: item.name, tab: 'stock', person: me(req), flash: takeFlash(req, res), body, sub: 'Stock item' }).value);
  });

  r.post('/stock/items/:id', requireStock, async (req, res) => {
    const id = idParam(req);
    const f = itemFields(req.body);
    await withPerson(me(req).id, (db) => db.query(`update stock_items set name=$2, code=$3, category=$4, kind=$5, unit=$6, supplier=$7, lead_days=$8, minimum=$9, reorder_qty=$10, bin=$11, image_url=$12, standing=$13, needs_check=$14, use_down=$15, active=$16, notes=$17 where id=$1`,
      [id, f.name, f.code, f.category, f.kind, f.unit, f.supplier, f.lead_days, f.minimum, f.reorder_qty, f.bin, f.image_url, f.standing, f.needs_check, f.use_down, f.active, f.notes]));
    flash(res, `${f.name} saved.`);
    res.redirect(`/stock/items/${id}`);
  });

  r.post('/stock/items/:id/alias', requireStock, async (req, res) => {
    const id = idParam(req);
    const alias = String(req.body.alias ?? '').trim().slice(0, 60);
    if (!alias) throw new UserError('Type the code.');
    const taken = await findItemByCode(alias);
    if (taken && taken.id !== id) throw new UserError(`"${alias}" already means ${taken.name}.`);
    if (!taken) await withPerson(me(req).id, (db) => db.query('insert into code_aliases (alias, item_id) values ($1, $2) on conflict (alias) do nothing', [alias, id]));
    flash(res, `"${alias}" now means this item.`);
    res.redirect(`/stock/items/${id}`);
  });

  r.post('/stock/items/:id/count', doer, async (req, res) => {
    const id = idParam(req);
    const counted = num(req.body.counted, 'Counted');
    const onHand = (await loadOnHand()).get(id) ?? 0;
    const delta = Math.round((counted - onHand) * 100) / 100;
    await withPerson(me(req).id, async (db) => {
      if (delta !== 0) await db.query(`insert into stock_moves (item_id, kind, qty, reason) values ($1, 'counted', $2, $3)`, [id, delta, `Counted ${counted}, hub said ${onHand}`]);
      if (canStock(me(req))) await db.query('update stock_items set needs_check = false where id = $1 and needs_check', [id]);
    });
    flash(res, delta === 0 ? 'Count matches the hub.' : `Count recorded: ${delta > 0 ? '+' : ''}${delta}.`);
    res.redirect(backTo(req, `/stock/items/${id}`));
  });

  r.post('/stock/items/:id/move', doer, async (req, res) => {
    const id = idParam(req);
    const qty = num(req.body.qty, 'Quantity', { allowNeg: true });
    if (!qty) throw new UserError('Say how many.');
    const reason = String(req.body.reason ?? '').trim().slice(0, 120);
    if (!reason) throw new UserError('Say why.');
    const kind = canStock(me(req)) ? 'adjusted' : qty > 0 ? 'received' : 'picked';
    await withPerson(me(req).id, (db) => db.query(`insert into stock_moves (item_id, kind, qty, reason) values ($1, $2, $3, $4)`, [id, kind, qty, reason]));
    flash(res, `${qty > 0 ? '+' : ''}${qty} recorded.`);
    res.redirect(backTo(req, `/stock/items/${id}`));
  });

  // ---------- Order list ----------
  r.get('/stock/orders', async (req, res) => {
    const [orders, items, all, waiting] = await Promise.all([loadOrders({ limit: 400 }), loadItems({ activeOnly: true }), loadEverything(), waitingCount()]);
    const body = ordersPage({ person: me(req), orders, items, jobs: all.jobs, today: today(), waiting, showDone: req.query.done === '1' });
    res.send(page({ title: 'Order list', tab: 'stock', person: me(req), flash: takeFlash(req, res), body, sub: 'Grouped by supplier' }).value);
  });

  r.post('/stock/orders', doer, async (req, res) => {
    const reason = String(req.body.reason ?? 'manual');
    if (!['low', 'manual', 'job'].includes(reason)) throw new UserError('That reason is not one the hub knows.');
    if (reason !== 'low' && !canStock(me(req))) throw new UserError('Only Editors or the Stock tick add lines by hand; the floor flags a bin as running low.');
    const item = req.body.item_id ? await loadItem(Number(req.body.item_id)) : await itemFromText(req.body.item);
    if (!item) throw new UserError("That item isn't in the hub.");
    const qty = num(req.body.qty, 'Quantity', { min: 0.01 });
    const jobId = Number(req.body.job_id) || null;
    const existing = (await loadOrders({ open: true, itemId: item.id })).filter((o) => o.job_id === jobId);
    if (reason === 'low' && existing.length) {
      flash(res, `${item.name} is already on the list (${existing.map((o) => o.status).join(', ')}).`);
      return res.redirect(backTo(req, '/stock/orders'));
    }
    await withPerson(me(req).id, (db) => db.query(`insert into orders (item_id, qty, job_id, reason, order_by, note) values ($1, $2, $3, $4, $5, $6)`,
      [item.id, qty, jobId, reason, dateOf(req.body.order_by, 'Order by'), String(req.body.note ?? '').trim().slice(0, 120) || (reason === 'low' ? `Running low, flagged by ${me(req).name.split(' ')[0]}` : '')]));
    flash(res, `${item.name} put on the order list.`);
    res.redirect(backTo(req, '/stock/orders'));
  });

  r.post('/stock/orders/from-gaps', requireStock, async (req, res) => {
    const [ctx, cal] = await Promise.all([stockContext(), loadCalendar()]);
    const rows = demand(ctx.items, ctx.needs, [...ctx.onHand].map(([item_id, qty]) => ({ item_id, qty })), ctx.orders, cal, mondayOf(today()), 6).filter((x) => x.gap > 0);
    let n = 0;
    await withPerson(me(req).id, async (db) => {
      for (const g of rows) {
        const open = ctx.orders.find((o) => o.item_id === g.item.id && !o.job_id && o.reason === 'shortfall' && o.status === 'listed');
        if (open) await db.query('update orders set qty = $2, order_by = $3 where id = $1', [open.id, g.gap, g.orderBy]);
        else await db.query(`insert into orders (item_id, qty, job_id, reason, order_by, note) values ($1, $2, null, 'shortfall', $3, $4)`, [g.item.id, g.gap, g.orderBy, `Short for ${g.weeks.flatMap((w) => w.jobIds).length} job line(s) in the next six weeks`]);
        n++;
      }
    });
    flash(res, `${n} ${n === 1 ? 'line' : 'lines'} on the order list.`);
    res.redirect('/stock/orders');
  });

  r.post('/stock/orders/:id/ordered', requireStock, async (req, res) => {
    const id = idParam(req);
    const o = await loadOrder(id);
    if (!o || o.status !== 'listed') throw new UserError('That line is not waiting to be ordered.');
    const expected = dateOf(req.body.expected, 'Expected');
    await withPerson(me(req).id, (db) => db.query(`update orders set status = 'ordered', ordered_on = $2, expected = $3, note = $4 where id = $1`, [id, today(), expected, String(req.body.note ?? '').trim().slice(0, 120)]));
    flash(res, `${o.name} marked ordered${expected ? `, expected ${expected}` : ''}.`);
    res.redirect(`/stock/orders#o-${id}`);
  });

  r.post('/stock/orders/:id/received', doer, async (req, res) => {
    const id = idParam(req);
    const o = await loadOrder(id);
    if (!o || (o.status !== 'ordered' && o.status !== 'listed')) throw new UserError('That line is not on order.');
    const qty = num(req.body.qty, 'Quantity', { min: 0.01 });
    const total = Math.round((o.received_qty + qty) * 100) / 100;
    await withPerson(me(req).id, async (db) => {
      await db.query(`insert into stock_moves (item_id, kind, qty, job_id, order_id, reason) values ($1, 'received', $2, $3, $4, $5)`, [o.item_id, qty, o.job_id, id, `Received against the order list${o.client_name ? ` for ${o.client_name}` : ''}`]);
      await db.query(`update orders set received_qty = $2, received_on = $3, status = case when $2 >= qty then 'received' else status end where id = $1`, [id, total, today()]);
      // Stock that came in for a job is that job's: its line is now on hand.
      if (o.job_id) await db.query(`update job_materials set allocated = least(qty, allocated + $3) where job_id = $1 and item_id = $2`, [o.job_id, o.item_id, qty]);
    });
    flash(res, `${qty} ${o.unit} of ${o.name} in${total < o.qty ? `; ${Math.round((o.qty - total) * 100) / 100} still to come` : ''}.`);
    res.redirect(backTo(req, '/stock/orders'));
  });

  r.post('/stock/orders/:id/cancel', requireStock, async (req, res) => {
    const id = idParam(req);
    await withPerson(me(req).id, (db) => db.query(`update orders set status = 'cancelled' where id = $1 and status in ('listed', 'ordered')`, [id]));
    flash(res, 'Line dropped.');
    res.redirect(backTo(req, '/stock/orders'));
  });

  // ---------- Count ----------
  r.get('/stock/count', async (req, res) => {
    const [items, onHand, last, waiting] = await Promise.all([loadItems(), loadOnHand(), loadLastCounts(), waitingCount()]);
    const body = countPage({ person: me(req), items, onHand, last, all: req.query.all === '1', waiting });
    res.send(page({ title: 'Count', tab: 'stock', person: me(req), flash: takeFlash(req, res), body, sub: "Phil's Friday count" }).value);
  });

  r.post('/stock/count', doer, async (req, res) => {
    const onHand = await loadOnHand();
    const entries = Object.entries(req.body as Record<string, string>).filter(([k, v]) => k.startsWith('c_') && String(v).trim() !== '');
    let changed = 0, same = 0;
    await withPerson(me(req).id, async (db) => {
      for (const [k, v] of entries) {
        const id = Number(k.slice(2));
        const counted = num(v, 'A count');
        const delta = Math.round((counted - (onHand.get(id) ?? 0)) * 100) / 100;
        if (delta === 0) { same++; continue; }
        await db.query(`insert into stock_moves (item_id, kind, qty, reason) values ($1, 'counted', $2, $3)`, [id, delta, `Counted ${counted}, hub said ${onHand.get(id) ?? 0}`]);
        changed++;
      }
      if (canStock(me(req)) && entries.length) await db.query(`update stock_items set needs_check = false where needs_check and id = any($1::int[])`, [entries.map(([k]) => Number(k.slice(2)))]);
    });
    flash(res, `${entries.length} counted: ${changed} ${changed === 1 ? 'difference' : 'differences'} logged, ${same} matched.`);
    res.redirect(req.body.all === '1' ? '/stock/count?all=1' : '/stock/count');
  });

  // ---------- Offcuts ----------
  r.get('/stock/offcuts', async (req, res) => {
    const [offcuts, items, waiting] = await Promise.all([loadOffcuts(), loadItems({ activeOnly: true }), waitingCount()]);
    const body = offcutsPage({ person: me(req), offcuts, boards: items.filter((i) => i.kind === 'board'), waiting });
    res.send(page({ title: 'Offcuts', tab: 'stock', person: me(req), flash: takeFlash(req, res), body, sub: 'Check before cutting a fresh sheet' }).value);
  });

  r.post('/stock/offcuts', doer, async (req, res) => {
    const itemId = Number(req.body.item_id);
    const item = await loadItem(itemId);
    if (!item) throw new UserError('Pick the colour.');
    const length = Math.round(num(req.body.length_mm, 'Length', { min: 100 }));
    const width = Math.round(num(req.body.width_mm, 'Width', { min: 100 }));
    await withPerson(me(req).id, (db) => db.query('insert into offcuts (item_id, length_mm, width_mm, location, note) values ($1, $2, $3, $4, $5)', [itemId, length, width, String(req.body.location ?? '').trim().slice(0, 60), String(req.body.note ?? '').trim().slice(0, 120)]));
    flash(res, `${item.name} offcut ${length} × ${width} logged.`);
    res.redirect(backTo(req, '/stock/offcuts'));
  });

  r.post('/stock/offcuts/:id/used', doer, async (req, res) => {
    const id = idParam(req);
    await withPerson(me(req).id, (db) => db.query('update offcuts set used_at = now() where id = $1 and used_at is null', [id]));
    flash(res, 'Offcut used.');
    res.redirect(backTo(req, '/stock/offcuts'));
  });

  // ---------- Bin labels and the bin page ----------
  r.get('/stock/labels', async (req, res) => {
    const items = (await loadItems({ activeOnly: true })).filter((i) => (req.query.item ? i.id === Number(req.query.item) : i.standing));
    res.send(labelsPage(items, config.appUrl).value);
  });

  r.get('/stock/bin/:id', async (req, res) => {
    const id = idParam(req);
    const item = await loadItem(id);
    if (!item) throw new UserError("That bin's item isn't in the hub.");
    const [onHand, materials, orders] = await Promise.all([loadOnHand(), loadMaterials(), loadOrders({ open: true, itemId: id })]);
    const body = binPage({ person: me(req), item, onHand: onHand.get(id) ?? 0, allocated: allocatedByItem(materials).get(id) ?? 0, open: orders.filter((o) => !o.job_id) });
    res.send(page({ title: item.name, tab: 'stock', person: me(req), flash: takeFlash(req, res), body, sub: 'From the bin label' }).value);
  });

  r.post('/stock/bin/:id/low', doer, async (req, res) => {
    const id = idParam(req);
    const item = await loadItem(id);
    if (!item) throw new UserError("That bin's item isn't in the hub.");
    const open = (await loadOrders({ open: true, itemId: id })).filter((o) => !o.job_id);
    if (open.length) {
      flash(res, `${item.name} is already on the list. No need to flag it again.`);
      return res.redirect(`/stock/bin/${id}`);
    }
    const qty = item.reorder_qty || Math.max(1, (item.minimum ?? 1) * 2);
    await withPerson(me(req).id, (db) => db.query(`insert into orders (item_id, qty, job_id, reason, note) values ($1, $2, null, 'low', $3)`, [id, qty, `Running low, flagged by ${me(req).name.split(' ')[0]}`]));
    flash(res, `${item.name} put on the order list.`);
    res.redirect(`/stock/bin/${id}`);
  });

  // ---------- Materials on a job ----------
  r.post('/jobs/:id/materials', requireStock, async (req, res) => {
    const jobId = idParam(req);
    const item = await itemFromText(req.body.item);
    const qty = num(req.body.qty, 'Quantity', { min: 0.01 });
    await withPerson(me(req).id, (db) => db.query(`insert into job_materials (job_id, item_id, qty, note) values ($1, $2, $3, $4)
      on conflict (job_id, item_id) do update set qty = excluded.qty, note = excluded.note`, [jobId, item.id, qty, String(req.body.note ?? '').trim().slice(0, 120)]));
    flash(res, `${item.name}: ${qty} ${item.unit}.`);
    res.redirect(backTo(req, `/jobs/${jobId}#materials`));
  });

  r.post('/jobs/:id/materials/upload', requireStock, async (req, res) => {
    const jobId = idParam(req);
    const { fields, files } = await readMultipart(req, FILE_LIMITS);
    const f = files[0];
    if (!f) throw new UserError('Choose the cut list file.');
    const nested = fields.nested === '1';
    const lines = parseCutList(f.bytes.toString('utf8'));
    if (!lines.length) throw new UserError('No lines found: the hub looks for a code in the first column and a quantity in the last number column.');
    const unknown: { code: string; qty: number }[] = [];
    let known = 0;
    await withPerson(me(req).id, async (db) => {
      for (const l of lines) {
        const item = await findItemByCode(l.code);
        if (!item) { unknown.push({ code: l.code, qty: l.qty }); continue; }
        await db.query(`insert into job_materials (job_id, item_id, qty, nested, note) values ($1, $2, $3, $4, $5)
          on conflict (job_id, item_id) do update set qty = excluded.qty, nested = excluded.nested`, [jobId, item.id, l.qty, nested, `From ${f.name}`.slice(0, 120)]);
        known++;
      }
    });
    if (unknown.length) {
      const items = await loadItems({ activeOnly: true });
      return res.send(page({ title: 'Match codes', tab: 'job', person: me(req), body: matchPage({ jobId, unknown, items, nested, known }) }).value);
    }
    flash(res, `${known} ${known === 1 ? 'line' : 'lines'} loaded from ${f.name}.`);
    res.redirect(`/jobs/${jobId}#materials`);
  });

  r.post('/jobs/:id/materials/match', requireStock, async (req, res) => {
    const jobId = idParam(req);
    const nested = req.body.nested === '1';
    let n = 0, skipped = 0;
    await withPerson(me(req).id, async (db) => {
      for (let i = 0; i < 200; i++) {
        const code = String(req.body[`code_${i}`] ?? '').trim();
        if (!code) break;
        const pick = String(req.body[`item_${i}`] ?? '').trim();
        if (!pick) { skipped++; continue; }
        const item = await itemFromText(pick);
        const taken = await findItemByCode(code);
        if (!taken) await db.query('insert into code_aliases (alias, item_id) values ($1, $2) on conflict (alias) do nothing', [code, item.id]);
        await db.query(`insert into job_materials (job_id, item_id, qty, nested, note) values ($1, $2, $3, $4, $5)
          on conflict (job_id, item_id) do update set qty = excluded.qty, nested = excluded.nested`, [jobId, item.id, num(req.body[`qty_${i}`], 'Quantity', { min: 0.01 }), nested, `Cut list code ${code}`.slice(0, 120)]);
        n++;
      }
    });
    flash(res, `${n} matched and loaded${skipped ? `, ${skipped} skipped` : ''}. The hub remembers the codes.`);
    res.redirect(`/jobs/${jobId}#materials`);
  });

  r.post('/jobs/:id/materials/:mid/delete', requireStock, async (req, res) => {
    const jobId = idParam(req);
    const mid = idParam(req, 'mid');
    await withPerson(me(req).id, async (db) => {
      await db.query(`update orders set status = 'cancelled' where job_id = $1 and status = 'listed' and item_id = (select item_id from job_materials where id = $2)`, [jobId, mid]);
      await db.query('delete from job_materials where id = $1 and job_id = $2', [mid, jobId]);
    });
    flash(res, 'Line removed.');
    res.redirect(backTo(req, `/jobs/${jobId}#materials`));
  });

  r.post('/jobs/:id/materials/source', requireStock, async (req, res) => {
    const jobId = idParam(req);
    const hold = req.body.hold === '1';
    const [ctx, cal] = await Promise.all([stockContext(), loadCalendar()]);
    const mine = ctx.materials.filter((m) => m.job_id === jobId);
    if (!mine.length) throw new UserError('Load the materials first.');
    const factoryDate = ctx.dates.get(jobId) ?? null;
    const items = new Map(ctx.items.map((i) => [i.id, i]));
    const nearerNeed = new Map<number, number>();
    for (const m of ctx.materials) {
      if (m.job_id === jobId) continue;
      const d = ctx.dates.get(m.job_id) ?? null;
      const nearer = d && (!factoryDate || d < factoryDate);
      if (!nearer) continue;
      const unmet = Math.max(0, m.qty - Math.max(m.allocated, m.picked));
      if (unmet) nearerNeed.set(m.item_id, (nearerNeed.get(m.item_id) ?? 0) + unmet);
    }
    const plan = sourceJob(mine, { items, onHand: ctx.onHand, allocated: allocatedByItem(ctx.materials), onOrder: onOrderByItem(ctx.orders), nearerNeed, factoryDate, cal, holdForNearer: hold });
    const summary: string[] = [];
    await withPerson(me(req).id, async (db) => {
      for (const p of plan) {
        const m = p.material as JobMaterial;
        await db.query('update job_materials set allocated = $2 where id = $1', [m.id, Math.round((m.picked + p.allocate) * 100) / 100]);
        // Stock on order covers it: that much of the stock order becomes this job's.
        if (p.fromOrder > 0) {
          let left = p.fromOrder;
          for (const o of ctx.orders.filter((o) => o.item_id === m.item_id && !o.job_id && (o.status === 'listed' || o.status === 'ordered'))) {
            if (left <= 0) break;
            const open = o.qty - o.received_qty;
            const take = Math.min(open, left);
            if (take >= open) await db.query('update orders set job_id = $2, reason = $3 where id = $1', [o.id, jobId, 'job']);
            else {
              await db.query('update orders set qty = qty - $2 where id = $1', [o.id, take]);
              await db.query(`insert into orders (item_id, qty, job_id, reason, status, order_by, ordered_on, expected, note) values ($1, $2, $3, 'job', $4, $5, $6, $7, $8)`, [m.item_id, take, jobId, o.status, o.order_by, o.ordered_on, o.expected, `Split from a stock order`]);
            }
            left -= take;
          }
        }
        const listed = ctx.orders.find((o) => o.item_id === m.item_id && o.job_id === jobId && o.reason === 'shortfall' && o.status === 'listed');
        if (p.toOrder > 0) {
          if (listed) await db.query('update orders set qty = $2, order_by = $3 where id = $1', [listed.id, p.toOrder, p.orderBy]);
          else await db.query(`insert into orders (item_id, qty, job_id, reason, order_by, note) values ($1, $2, $3, 'shortfall', $4, $5)`, [m.item_id, p.toOrder, jobId, p.orderBy, p.nearerNeeds ? `A nearer job also needs ${p.nearerNeeds}` : '']);
        } else if (listed) await db.query(`update orders set status = 'cancelled' where id = $1`, [listed.id]);
        const name = (p.material as { name?: string }).name ?? 'item';
        summary.push(`${name}: ${p.allocate ? `${p.allocate} from stock` : ''}${p.fromOrder ? `${p.allocate ? ', ' : ''}${p.fromOrder} on order` : ''}${p.toOrder ? `${p.allocate || p.fromOrder ? ', ' : ''}${p.toOrder} to order${p.orderBy ? ` by ${p.orderBy}` : ''}` : ''}${!p.allocate && !p.fromOrder && !p.toOrder ? 'already covered' : ''}`);
      }
    });
    flash(res, `Sourced. ${summary.join(' · ')}`);
    res.redirect(backTo(req, `/jobs/${jobId}#materials`));
  });

  r.post('/jobs/:id/materials/pick', doer, async (req, res) => {
    const jobId = idParam(req);
    const picks = ([] as string[]).concat(req.body.pick ?? []).map(Number).filter(Boolean);
    const mine = (await loadMaterials(jobId)).filter((m) => picks.includes(m.id) && m.allocated > m.picked);
    const job = (await pool.query('select client_name, suburb from jobs where id = $1', [jobId])).rows[0];
    await withPerson(me(req).id, async (db) => {
      for (const m of mine) {
        const q = Math.round((m.allocated - m.picked) * 100) / 100;
        await db.query(`insert into stock_moves (item_id, kind, qty, job_id, reason) values ($1, 'picked', $2, $3, $4)`, [m.item_id, -q, jobId, `Picked for ${job ? jobTitle(job) : 'a job'}`]);
        await db.query('update job_materials set picked = allocated where id = $1', [m.id]);
      }
    });
    flash(res, `${mine.length} ${mine.length === 1 ? 'line' : 'lines'} picked.`);
    res.redirect(backTo(req, `/jobs/${jobId}#materials`));
  });

  return r;
}

/** A CSV with a header row → objects keyed by the lower-cased header. Quotes and commas inside quotes are handled. */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
      else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i] ?? `col${i}`, v])));
}

/** Where the hub thinks every live job stands on materials, for Attention and the Pipeline (R20). */
export async function readinessByJob(): Promise<Map<number, { state: 'ready' | 'short' | 'waiting' | 'none'; expected: string | null; factoryDate: string | null; short: string[] }>> {
  const ctx = await stockContext();
  const out = new Map<number, { state: 'ready' | 'short' | 'waiting' | 'none'; expected: string | null; factoryDate: string | null; short: string[] }>();
  for (const jobId of ctx.dates.keys()) {
    const mats = ctx.materials.filter((m) => m.job_id === jobId);
    const rd = readiness(mats, ctx.orders, jobId);
    out.set(jobId, { state: rd.state, expected: rd.expected, factoryDate: ctx.dates.get(jobId) ?? null, short: rd.lines.filter((l) => l.state !== 'ready').map((l) => `${(l.material as { name?: string }).name}: ${l.state === 'short' ? `short ${l.short}` : `on order${l.expected ? `, in ${l.expected}` : ''}`}`) });
  }
  return out;
}

export { lowStock, appSetting };
