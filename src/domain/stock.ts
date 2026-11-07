// Stock (George, 7 Nov 2026; the review's R14 to R20): what is on hand, what each job needs,
// where it comes from, and what to order by when. Pure functions over rows; the screens and the
// tests call these. No prices anywhere.
import { addDays, Calendar, Iso } from './dates.js';

export interface StockItem {
  id: number;
  code: string;
  name: string;
  category: string;
  kind: 'board' | 'edging' | 'hardware' | 'consumable' | 'other';
  unit: string;
  supplier: string;
  lead_days: number;
  minimum: number | null;
  reorder_qty: number | null;
  bin: string;
  image_url: string;
  standing: boolean;
  needs_check: boolean;
  use_down: boolean;
  active: boolean;
  notes: string;
}

export interface StockMove {
  id: number;
  item_id: number;
  kind: 'opening' | 'received' | 'picked' | 'counted' | 'adjusted' | 'offcut';
  qty: number;
  job_id: number | null;
  order_id: number | null;
  reason: string;
  moved_by: number | null;
  moved_at: string;
}

export interface JobMaterial {
  id: number;
  job_id: number;
  item_id: number;
  qty: number;
  allocated: number;
  picked: number;
  nested: boolean;
  note: string;
}

export interface OrderLine {
  id: number;
  item_id: number;
  qty: number;
  job_id: number | null;
  reason: 'shortfall' | 'low' | 'job' | 'manual';
  status: 'listed' | 'ordered' | 'received' | 'cancelled';
  order_by: Iso | null;
  ordered_on: Iso | null;
  expected: Iso | null;
  received_qty: number;
  received_on: Iso | null;
  note: string;
}

export const KIND_LABEL: Record<StockItem['kind'], string> = { board: 'Board', edging: 'Edging', hardware: 'Hardware', consumable: 'Consumable', other: 'Other' };

const r2 = (n: number) => Math.round(n * 100) / 100;

/** On hand per item: the sum of the ledger. Never typed. */
export function onHandByItem(moves: Pick<StockMove, 'item_id' | 'qty'>[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of moves) out.set(m.item_id, r2((out.get(m.item_id) ?? 0) + Number(m.qty)));
  return out;
}

/** Allocated to jobs and not yet picked, per item: the shelf says 100, 80 are spoken for, you have 20. */
export function allocatedByItem(materials: Pick<JobMaterial, 'item_id' | 'allocated' | 'picked'>[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of materials) {
    const open = Math.max(0, Number(m.allocated) - Number(m.picked));
    if (open) out.set(m.item_id, r2((out.get(m.item_id) ?? 0) + open));
  }
  return out;
}

export function available(onHand: Map<number, number>, allocated: Map<number, number>, itemId: number): number {
  return r2((onHand.get(itemId) ?? 0) - (allocated.get(itemId) ?? 0));
}

/** Open orders (listed or ordered) per item: how much is still to come, for which job, and when. */
export function onOrderByItem(orders: OrderLine[]): Map<number, { qty: number; forStock: number; expected: Iso | null; lines: OrderLine[] }> {
  const out = new Map<number, { qty: number; forStock: number; expected: Iso | null; lines: OrderLine[] }>();
  for (const o of orders) {
    if (o.status !== 'listed' && o.status !== 'ordered') continue;
    const open = r2(Number(o.qty) - Number(o.received_qty));
    if (open <= 0) continue;
    const e = out.get(o.item_id) ?? out.set(o.item_id, { qty: 0, forStock: 0, expected: null, lines: [] }).get(o.item_id)!;
    e.qty = r2(e.qty + open);
    if (!o.job_id) e.forStock = r2(e.forStock + open);
    if (o.expected && (!e.expected || o.expected < e.expected)) e.expected = o.expected;
    e.lines.push(o);
  }
  return out;
}

export interface SourcingLine {
  material: JobMaterial;
  /** Taken from stock on hand now. */
  allocate: number;
  /** Covered by stock already on order (for stock, not another job). */
  fromOrder: number;
  /** Still to be ordered for this job. */
  toOrder: number;
  orderBy: Iso | null;
  /** A nearer job needs this item too and is not yet sourced. */
  nearerNeeds: number;
}

/**
 * Source one job's materials (R16): stock on hand first (what is not allocated to any job), then
 * stock already on order, and the rest goes on the order list with an order-by date (the factory
 * date minus the supplier's lead days, in working days). With holdForNearer, stock that jobs with an
 * earlier factory date still need is left for them.
 */
export function sourceJob(
  lines: JobMaterial[],
  ctx: {
    items: Map<number, StockItem>;
    onHand: Map<number, number>;
    allocated: Map<number, number>;
    onOrder: ReturnType<typeof onOrderByItem>;
    /** Unsourced need per item for jobs with an earlier factory date than this one. */
    nearerNeed: Map<number, number>;
    factoryDate: Iso | null;
    cal: Calendar;
    holdForNearer: boolean;
  },
): SourcingLine[] {
  const out: SourcingLine[] = [];
  for (const m of lines) {
    const item = ctx.items.get(m.item_id);
    const need = r2(Number(m.qty) - Number(m.picked));
    const already = Math.max(0, Number(m.allocated) - Number(m.picked));
    const nearer = ctx.nearerNeed.get(m.item_id) ?? 0;
    let free = available(ctx.onHand, ctx.allocated, m.item_id) + already; // this job's own allocation is free to re-use
    if (ctx.holdForNearer) free = Math.max(0, free - nearer);
    const allocate = r2(Math.min(need, Math.max(0, free)));
    const rest = r2(need - allocate);
    const onOrder = ctx.onOrder.get(m.item_id);
    const fromOrder = r2(Math.min(rest, onOrder?.forStock ?? 0));
    const toOrder = r2(rest - fromOrder);
    const lead = item?.lead_days ?? 5;
    const orderBy = toOrder > 0 && ctx.factoryDate ? ctx.cal.addWorkingDays(ctx.factoryDate, -lead) : null;
    out.push({ material: m, allocate, fromOrder, toOrder, orderBy, nearerNeeds: nearer });
  }
  return out;
}

export interface DemandRow {
  item: StockItem;
  onHand: number;
  allocated: number;
  available: number;
  onOrder: number;
  expected: Iso | null;
  /** Needed by jobs in the window, by week Monday, with the jobs. */
  weeks: { monday: Iso; qty: number; jobIds: number[] }[];
  needed: number;
  /** What is still short after on hand (unallocated) and on order for stock. */
  gap: number;
  /** When the first short job needs it, minus the lead days. */
  orderBy: Iso | null;
  firstNeed: Iso | null;
  /** Standing line at or under its minimum. */
  low: boolean;
}

/** Demand against supply (R17): six weeks of need by factory date against on hand and on order. */
export function demand(
  items: StockItem[],
  needs: { material: JobMaterial; factoryDate: Iso | null }[],
  moves: Pick<StockMove, 'item_id' | 'qty'>[],
  orders: OrderLine[],
  cal: Calendar,
  from: Iso,
  weeks = 6,
): DemandRow[] {
  const onHand = onHandByItem(moves);
  const allocated = allocatedByItem(needs.map((n) => n.material));
  const onOrder = onOrderByItem(orders);
  const to = addDays(from, weeks * 7 - 1);
  const mondays = Array.from({ length: weeks }, (_, i) => addDays(from, i * 7));
  const rows: DemandRow[] = [];
  for (const item of items) {
    if (!item.active) continue;
    const mine = needs.filter((n) => n.material.item_id === item.id && Number(n.material.qty) > Number(n.material.picked));
    const inWindow = mine.filter((n) => n.factoryDate && n.factoryDate >= from && n.factoryDate <= to);
    const undated = mine.filter((n) => !n.factoryDate || n.factoryDate < from);
    const wk = mondays.map((monday) => {
      const end = addDays(monday, 6);
      const here = inWindow.filter((n) => n.factoryDate! >= monday && n.factoryDate! <= end);
      return { monday, qty: r2(here.reduce((a, n) => a + Number(n.material.qty) - Number(n.material.picked), 0)), jobIds: [...new Set(here.map((n) => n.material.job_id))] };
    });
    const needed = r2(inWindow.reduce((a, n) => a + Number(n.material.qty) - Number(n.material.picked), 0) + undated.filter((n) => n.factoryDate).reduce((a, n) => a + Number(n.material.qty) - Number(n.material.picked), 0));
    const oh = onHand.get(item.id) ?? 0;
    const al = allocated.get(item.id) ?? 0;
    const oo = onOrder.get(item.id);
    // Allocated stock already covers part of the need; what matters is need beyond what is set aside.
    const unmet = r2(needed - Math.min(needed, al));
    const gap = r2(Math.max(0, unmet - Math.max(0, oh - al) - (oo?.forStock ?? 0)));
    const dated = mine.filter((n) => n.factoryDate).sort((a, b) => a.factoryDate!.localeCompare(b.factoryDate!));
    const firstNeed = dated[0]?.factoryDate ?? null;
    const low = item.standing && item.minimum != null && oh - al <= Number(item.minimum) && !oo;
    if (!mine.length && !low && !item.standing) continue;
    rows.push({
      item, onHand: oh, allocated: al, available: r2(oh - al), onOrder: oo?.qty ?? 0, expected: oo?.expected ?? null,
      weeks: wk, needed, gap, orderBy: gap > 0 && firstNeed ? cal.addWorkingDays(firstNeed, -item.lead_days) : null, firstNeed, low,
    });
  }
  return rows.sort((a, b) => Number(b.gap > 0) - Number(a.gap > 0) || Number(b.low) - Number(a.low) || (a.firstNeed ?? '9999').localeCompare(b.firstNeed ?? '9999') || a.item.name.localeCompare(b.item.name));
}

/** Standing lines at or under their minimum with nothing on order: what the Friday walk used to find (R18, R20). */
export function lowStock(items: StockItem[], onHand: Map<number, number>, allocated: Map<number, number>, onOrder: ReturnType<typeof onOrderByItem>): { item: StockItem; available: number; suggest: number }[] {
  return items
    .filter((i) => i.active && i.standing && !i.use_down && i.minimum != null && !onOrder.has(i.id))
    .map((i) => ({ item: i, available: available(onHand, allocated, i.id) }))
    .filter((x) => x.available <= Number(x.item.minimum))
    .map((x) => ({ ...x, suggest: Number(x.item.reorder_qty) || Math.max(1, r2(Number(x.item.minimum) * 2 - x.available)) }));
}

export type LineState = 'ready' | 'on_order' | 'short' | 'none';

export interface Readiness {
  state: 'ready' | 'short' | 'waiting' | 'none';
  lines: { material: JobMaterial; state: LineState; expected: Iso | null; short: number }[];
  /** Latest expected date among lines on order, when every line is covered. */
  expected: Iso | null;
}

/**
 * Is the job ready to cut (R20)? Each line: ready when picked or allocated from stock; on order when an
 * order for this job covers the rest; short otherwise. The job is ready when every line is, waiting when
 * the rest is on order, short when any line has nothing coming. No lines: none.
 */
export function readiness(materials: JobMaterial[], orders: OrderLine[], jobId: number): Readiness {
  if (!materials.length) return { state: 'none', lines: [], expected: null };
  const lines = materials.map((m) => {
    const covered = Math.max(Number(m.picked), Number(m.allocated));
    const rest = r2(Number(m.qty) - covered);
    if (rest <= 0) return { material: m, state: 'ready' as LineState, expected: null, short: 0 };
    const mine = orders.filter((o) => o.job_id === jobId && o.item_id === m.item_id && (o.status === 'listed' || o.status === 'ordered'));
    const coming = r2(mine.reduce((a, o) => a + Number(o.qty) - Number(o.received_qty), 0));
    const expected = mine.map((o) => o.expected).filter((x): x is Iso => !!x).sort().pop() ?? null;
    if (coming >= rest) return { material: m, state: 'on_order' as LineState, expected, short: 0 };
    return { material: m, state: 'short' as LineState, expected, short: r2(rest - coming) };
  });
  const state = lines.some((l) => l.state === 'short') ? 'short' : lines.some((l) => l.state === 'on_order') ? 'waiting' : 'ready';
  const expected = lines.map((l) => l.expected).filter((x): x is Iso => !!x).sort().pop() ?? null;
  return { state, lines, expected };
}

/** Reads a cut list (R15): "code,quantity" lines, with or without a header, commas or tabs; other columns are ignored. */
export function parseCutList(text: string): { code: string; qty: number; line: number }[] {
  const out: { code: string; qty: number; line: number }[] = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cells = (line.includes('\t') ? line.split('\t') : splitCsv(line)).map((c) => c.trim().replace(/^"|"$/g, ''));
    if (cells.length < 2) return;
    // The code is the first non-empty cell; the quantity the last cell that is a number.
    const code = cells.find((c) => c)!;
    const nums = cells.slice(1).filter((c) => /^-?\d+(\.\d+)?$/.test(c));
    if (!nums.length) return; // a header row, or no quantity
    const qty = Number(nums[nums.length - 1]);
    if (!(qty > 0)) return;
    out.push({ code, qty, line: i + 1 });
  });
  // Same code twice: one line, the sum.
  const merged = new Map<string, { code: string; qty: number; line: number }>();
  for (const l of out) {
    const k = l.code.toLowerCase();
    const e = merged.get(k);
    if (e) e.qty = r2(e.qty + l.qty); else merged.set(k, { ...l });
  }
  return [...merged.values()];
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
