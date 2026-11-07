// Stock reads (George, 7 Nov 2026). Writes go through withPerson() in the routes; the ledger is
// append-only and on hand is always a sum of it.
import { pool } from './pool.js';
import type { JobMaterial, OrderLine, StockItem, StockMove } from '../domain/stock.js';
import type { Iso } from '../domain/dates.js';

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const ITEM_COLS = 'id, code, name, category, kind, unit, supplier, lead_days, minimum, reorder_qty, bin, image_url, standing, needs_check, use_down, active, notes';
function item(r: Record<string, unknown>): StockItem {
  return { ...(r as unknown as StockItem), minimum: numOrNull(r.minimum), reorder_qty: numOrNull(r.reorder_qty), lead_days: num(r.lead_days) };
}

export async function loadItems(opts: { activeOnly?: boolean } = {}): Promise<StockItem[]> {
  return (await pool.query(`select ${ITEM_COLS} from stock_items ${opts.activeOnly ? 'where active' : ''} order by category, name, code`)).rows.map(item);
}

export async function loadItem(id: number): Promise<StockItem | undefined> {
  const r = (await pool.query(`select ${ITEM_COLS} from stock_items where id = $1`, [id])).rows[0];
  return r && item(r);
}

/** An item by its code or an alias (case doesn't matter), for cut lists and the bin QR. */
export async function findItemByCode(code: string): Promise<StockItem | undefined> {
  const r = (await pool.query(`select ${ITEM_COLS} from stock_items where lower(code) = lower($1)
    union all select i.${ITEM_COLS.replace(/, /g, ', i.')} from code_aliases a join stock_items i on i.id = a.item_id where lower(a.alias) = lower($1) limit 1`, [code])).rows[0];
  return r && item(r);
}

export async function loadAliases(): Promise<{ alias: string; item_id: number }[]> {
  return (await pool.query('select alias, item_id from code_aliases order by alias')).rows;
}

/** On hand per item, from the ledger. */
export async function loadOnHand(): Promise<Map<number, number>> {
  const rows = (await pool.query('select item_id, sum(qty) as qty from stock_moves group by item_id')).rows as { item_id: number; qty: string }[];
  return new Map(rows.map((r) => [r.item_id, num(r.qty)]));
}

export type StockMoveRow = StockMove & { moved_by_name: string | null; client_name: string | null };

export async function loadMoves(itemId: number, limit = 60): Promise<StockMoveRow[]> {
  return (await pool.query(`select m.*, p.name as moved_by_name, j.client_name from stock_moves m left join people p on p.id = m.moved_by left join jobs j on j.id = m.job_id
    where m.item_id = $1 order by m.moved_at desc, m.id desc limit $2`, [itemId, limit])).rows.map((r) => ({ ...r, qty: num(r.qty) }));
}

/** The last count (or opening balance) per item: when, by whom. */
export async function loadLastCounts(): Promise<Map<number, { at: string; by: string | null }>> {
  const rows = (await pool.query(`select distinct on (m.item_id) m.item_id, m.moved_at, p.name from stock_moves m left join people p on p.id = m.moved_by
    where m.kind in ('counted', 'opening') order by m.item_id, m.moved_at desc`)).rows as { item_id: number; moved_at: string; name: string | null }[];
  return new Map(rows.map((r) => [r.item_id, { at: r.moved_at, by: r.name }]));
}

export type JobMaterialRow = JobMaterial & { name: string; code: string; unit: string; kind: StockItem['kind']; supplier: string; lead_days: number; client_name?: string };

function material(r: Record<string, unknown>): JobMaterialRow {
  return { ...(r as unknown as JobMaterialRow), qty: num(r.qty), allocated: num(r.allocated), picked: num(r.picked), lead_days: num(r.lead_days) };
}

export async function loadMaterials(jobId?: number): Promise<JobMaterialRow[]> {
  return (await pool.query(`select m.*, i.name, i.code, i.unit, i.kind, i.supplier, i.lead_days, j.client_name from job_materials m join stock_items i on i.id = m.item_id join jobs j on j.id = m.job_id
    ${jobId ? 'where m.job_id = $1' : "where j.status = 'live'"} order by i.kind, i.name`, jobId ? [jobId] : [])).rows.map(material);
}

export type OrderRow = OrderLine & { name: string; code: string; unit: string; supplier: string; client_name: string | null; listed_by_name: string | null; listed_at: string };

function order(r: Record<string, unknown>): OrderRow {
  return { ...(r as unknown as OrderRow), qty: num(r.qty), received_qty: num(r.received_qty) };
}

export async function loadOrders(opts: { open?: boolean; jobId?: number; itemId?: number; limit?: number } = {}): Promise<OrderRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.open) where.push(`o.status in ('listed', 'ordered')`);
  if (opts.jobId) { params.push(opts.jobId); where.push(`o.job_id = $${params.length}`); }
  if (opts.itemId) { params.push(opts.itemId); where.push(`o.item_id = $${params.length}`); }
  params.push(opts.limit ?? 500);
  return (await pool.query(`select o.*, i.name, i.code, i.unit, i.supplier, j.client_name, p.name as listed_by_name
    from orders o join stock_items i on i.id = o.item_id left join jobs j on j.id = o.job_id left join people p on p.id = o.listed_by
    ${where.length ? `where ${where.join(' and ')}` : ''} order by i.supplier, o.order_by nulls last, o.id limit $${params.length}`, params)).rows.map(order);
}

export async function loadOrder(id: number): Promise<OrderRow | undefined> {
  const r = (await pool.query(`select o.*, i.name, i.code, i.unit, i.supplier, j.client_name, p.name as listed_by_name
    from orders o join stock_items i on i.id = o.item_id left join jobs j on j.id = o.job_id left join people p on p.id = o.listed_by where o.id = $1`, [id])).rows[0];
  return r && order(r);
}

export interface OffcutRow {
  id: number; item_id: number; name: string; length_mm: number; width_mm: number; location: string; note: string;
  logged_by_name: string | null; logged_at: string; used_at: string | null; used_by_name: string | null;
}

export async function loadOffcuts(opts: { open?: boolean; itemId?: number } = {}): Promise<OffcutRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.open) where.push('o.used_at is null');
  if (opts.itemId) { params.push(opts.itemId); where.push(`o.item_id = $${params.length}`); }
  return (await pool.query(`select o.*, i.name, p.name as logged_by_name, u.name as used_by_name from offcuts o join stock_items i on i.id = o.item_id
    left join people p on p.id = o.logged_by left join people u on u.id = o.used_by ${where.length ? `where ${where.join(' and ')}` : ''} order by o.used_at nulls first, i.name, o.id`, params)).rows;
}

/** The standard factory step's start per live job: when its materials are needed. */
export async function factoryDates(): Promise<Map<number, Iso | null>> {
  const rows = (await pool.query(`select j.id, s.start_date from jobs j left join steps s on s.job_id = j.id and s.kind = 'factory' and s.label = '' where j.status = 'live'`)).rows as { id: number; start_date: Iso | null }[];
  return new Map(rows.map((r) => [r.id, r.start_date]));
}

/** Everything the stock sums need: items, the ledger totals, every live job's lines with its factory date, open orders. */
export async function stockContext() {
  const [items, onHand, materials, orders, dates] = await Promise.all([loadItems(), loadOnHand(), loadMaterials(), loadOrders({ open: true }), factoryDates()]);
  return { items, onHand, materials, orders, dates, needs: materials.map((m) => ({ material: m, factoryDate: dates.get(m.job_id) ?? null })) };
}
export type StockContext = Awaited<ReturnType<typeof stockContext>>;
