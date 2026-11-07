import { describe, expect, it } from 'vitest';
import { Calendar } from '../src/domain/dates.js';
import { allocatedByItem, demand, JobMaterial, lowStock, onHandByItem, onOrderByItem, OrderLine, parseCutList, readiness, sourceJob, StockItem } from '../src/domain/stock.js';

const cal = new Calendar([]);
const item = (id: number, over: Partial<StockItem> = {}): StockItem => ({
  id, code: `C${id}`, name: `Item ${id}`, category: 'Boards – full sheets', kind: 'board', unit: 'sheet', supplier: 'Polytec', lead_days: 5,
  minimum: null, reorder_qty: null, bin: '', image_url: '', standing: false, needs_check: false, use_down: false, active: true, notes: '', ...over,
});
const mat = (id: number, job_id: number, item_id: number, qty: number, over: Partial<JobMaterial> = {}): JobMaterial => ({ id, job_id, item_id, qty, allocated: 0, picked: 0, nested: false, note: '', ...over });
const order = (id: number, item_id: number, qty: number, over: Partial<OrderLine> = {}): OrderLine => ({ id, item_id, qty, job_id: null, reason: 'manual', status: 'listed', order_by: null, ordered_on: null, expected: null, received_qty: 0, received_on: null, note: '', ...over });

describe('the ledger', () => {
  it('on hand is the sum of moves; spoken for is allocated and not yet picked', () => {
    const oh = onHandByItem([{ item_id: 1, qty: 34 }, { item_id: 1, qty: -6 }, { item_id: 2, qty: 3 }]);
    expect([...oh]).toEqual([[1, 28], [2, 3]]);
    const al = allocatedByItem([mat(1, 1, 1, 6, { allocated: 6, picked: 2 }), mat(2, 2, 1, 4, { allocated: 4, picked: 4 })]);
    expect(al.get(1)).toBe(4);
  });
});

describe('sourcing a job (R16)', () => {
  const items = new Map([[1, item(1)], [2, item(2, { lead_days: 10 })]]);
  it('takes stock first, then stock on order, and lists the rest with an order-by date', () => {
    const lines = [mat(1, 10, 1, 6), mat(2, 10, 2, 5)];
    const plan = sourceJob(lines, {
      items, onHand: new Map([[1, 4], [2, 0]]), allocated: new Map(), onOrder: onOrderByItem([order(1, 2, 2, { status: 'ordered', expected: '2026-11-20' })]),
      nearerNeed: new Map(), factoryDate: '2026-11-30', cal, holdForNearer: true,
    });
    expect(plan.map((p) => [p.allocate, p.fromOrder, p.toOrder, p.orderBy])).toEqual([[4, 0, 2, '2026-11-23'], [0, 2, 3, '2026-11-16']]);
  });
  it('leaves stock a nearer job still needs, unless told not to', () => {
    const lines = [mat(1, 10, 1, 6)];
    const ctx = { items, onHand: new Map([[1, 8]]), allocated: new Map(), onOrder: onOrderByItem([]), nearerNeed: new Map([[1, 5]]), factoryDate: '2026-11-30', cal };
    expect(sourceJob(lines, { ...ctx, holdForNearer: true })[0]).toMatchObject({ allocate: 3, toOrder: 3, nearerNeeds: 5 });
    expect(sourceJob(lines, { ...ctx, holdForNearer: false })[0]).toMatchObject({ allocate: 6, toOrder: 0 });
  });
  it('counts what this job already has as its own, and skips what is picked', () => {
    const lines = [mat(1, 10, 1, 6, { allocated: 6, picked: 2 })];
    const plan = sourceJob(lines, { items, onHand: new Map([[1, 4]]), allocated: new Map([[1, 4]]), onOrder: onOrderByItem([]), nearerNeed: new Map(), factoryDate: null, cal, holdForNearer: true });
    expect(plan[0]).toMatchObject({ allocate: 4, toOrder: 0, orderBy: null });
  });
});

describe('demand against supply (R17) and running low (R20)', () => {
  const it1 = item(1, { name: 'Satin White', lead_days: 5 });
  const it2 = item(2, { name: 'Classic White Sheen', standing: true, minimum: 10, reorder_qty: 20 });
  it('says what is short in the next six weeks and by when to order it', () => {
    const needs = [
      { material: mat(1, 1, 1, 6), factoryDate: '2026-11-03' },
      { material: mat(2, 2, 1, 4), factoryDate: '2026-11-18' },
      { material: mat(3, 3, 1, 9), factoryDate: '2027-01-20' }, // outside the window
    ];
    const rows = demand([it1, it2], needs, [{ item_id: 1, qty: 2 }, { item_id: 2, qty: 30 }], [], cal, '2026-11-02', 6);
    const sw = rows.find((r) => r.item.id === 1)!;
    expect(sw.weeks.map((w) => w.qty)).toEqual([6, 0, 4, 0, 0, 0]);
    expect(sw).toMatchObject({ onHand: 2, available: 2, needed: 10, gap: 8, firstNeed: '2026-11-03', orderBy: '2026-10-27' });
    const cw = rows.find((r) => r.item.id === 2)!;
    expect(cw).toMatchObject({ needed: 0, gap: 0, low: false });
  });
  it('stock on order for stock covers a gap; an order for another job does not', () => {
    const needs = [{ material: mat(1, 1, 1, 6), factoryDate: '2026-11-10' }];
    const forStock = demand([it1], needs, [], [order(1, 1, 6, { status: 'ordered', expected: '2026-11-05' })], cal, '2026-11-02')[0];
    expect(forStock).toMatchObject({ gap: 0, onOrder: 6, expected: '2026-11-05' });
    const forOther = demand([it1], needs, [], [order(1, 1, 6, { job_id: 99, status: 'ordered' })], cal, '2026-11-02')[0];
    expect(forOther.gap).toBe(6);
  });
  it('flags a standing line at or under its minimum with nothing on order', () => {
    const low = lowStock([it1, it2], new Map([[2, 10]]), new Map(), onOrderByItem([]));
    expect(low.map((l) => [l.item.id, l.available, l.suggest])).toEqual([[2, 10, 20]]);
    expect(lowStock([it2], new Map([[2, 10]]), new Map(), onOrderByItem([order(1, 2, 20)]))).toHaveLength(0);
    expect(lowStock([it2], new Map([[2, 14]]), new Map([[2, 5]]), onOrderByItem([]))).toHaveLength(1); // 9 free
  });
});

describe('readiness on the job (R20)', () => {
  it('is ready when every line is on hand or picked, waiting when the rest is ordered for the job, short otherwise', () => {
    const lines = [mat(1, 7, 1, 6, { allocated: 6 }), mat(2, 7, 2, 4, { allocated: 1 })];
    expect(readiness(lines, [], 7)).toMatchObject({ state: 'short', expected: null });
    expect(readiness(lines, [], 7).lines[1]).toMatchObject({ state: 'short', short: 3 });
    const withOrder = readiness(lines, [order(1, 2, 3, { job_id: 7, status: 'ordered', expected: '2026-11-12' })], 7);
    expect(withOrder).toMatchObject({ state: 'waiting', expected: '2026-11-12' });
    expect(readiness([mat(1, 7, 1, 6, { picked: 6 })], [], 7).state).toBe('ready');
    expect(readiness([], [], 7).state).toBe('none');
  });
});

describe('reading a cut list (R15)', () => {
  it('takes the code from the first column and the quantity from the last number, skips headers, merges repeats', () => {
    const text = 'Code,Description,Qty\nCWS-2415,Classic White Sheen 2415,6\n"H-110",110 degree hinge,24\ncws-2415,more of it,2\nNOTES,no quantity here,\n';
    expect(parseCutList(text)).toEqual([{ code: 'CWS-2415', qty: 8, line: 2 }, { code: 'H-110', qty: 24, line: 3 }]);
    expect(parseCutList('A1\t3\r\nB2\t1.5\r\n')).toEqual([{ code: 'A1', qty: 3, line: 1 }, { code: 'B2', qty: 1.5, line: 2 }]);
  });
});
