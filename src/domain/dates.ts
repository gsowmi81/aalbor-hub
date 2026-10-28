// Calendar maths. Every date is a 'YYYY-MM-DD' string; no time zones, no Date objects
// leak out of this file. Working days are Monday to Friday, less blocked days.
// A blocked day with scope 'all' (public holidays, shutdown) stops every step;
// scope 'factory' stops only factory steps.

export type Iso = string;
export type Scope = 'all' | 'factory';

const DAY = 86_400_000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function toMs(d: Iso): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
}
export function fromMs(t: number): Iso {
  return new Date(t).toISOString().slice(0, 10);
}
export function addDays(d: Iso, n: number): Iso {
  return fromMs(toMs(d) + n * DAY);
}
export function dayOfWeek(d: Iso): number {
  return new Date(toMs(d)).getUTCDay();
}
export function daysBetween(a: Iso, b: Iso): number {
  return Math.round((toMs(b) - toMs(a)) / DAY);
}
/** Monday of the week d falls in. */
export function mondayOf(d: Iso): Iso {
  return addDays(d, -((dayOfWeek(d) + 6) % 7));
}
export function isWeekend(d: Iso): boolean {
  const g = dayOfWeek(d);
  return g === 0 || g === 6;
}

/** Today in Sydney, whatever the server's clock zone. */
export function todaySydney(now = new Date()): Iso {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The Sydney calendar date of a stored timestamp. */
export function sydneyDate(ts: string): Iso {
  return todaySydney(new Date(ts));
}

/** "Thu 04 Feb" */
export function fmtShort(d: Iso): string {
  const t = new Date(toMs(d));
  return `${DOW[t.getUTCDay()]} ${String(t.getUTCDate()).padStart(2, '0')} ${MON[t.getUTCMonth()]}`;
}
/** "04 Feb 2027", the house style for full dates. */
export function fmtLong(d: Iso): string {
  const t = new Date(toMs(d));
  return `${String(t.getUTCDate()).padStart(2, '0')} ${MON[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}
/** "Thu 04 Feb 2027" */
export function fmtDay(d: Iso): string {
  return `${DOW[dayOfWeek(d)]} ${fmtLong(d)}`;
}
export function fmtRange(a: Iso | null, b: Iso | null): string {
  if (!a) return 'No date yet';
  if (!b || b === a) return fmtShort(a);
  return `${fmtShort(a)} to ${fmtShort(b)}`;
}

export interface BlockedDay {
  day: Iso;
  scope: Scope;
  reason: string;
}

export class Calendar {
  private all = new Map<Iso, string>();
  private factory = new Map<Iso, string>();

  constructor(blocked: BlockedDay[] = []) {
    for (const b of blocked) (b.scope === 'factory' ? this.factory : this.all).set(b.day, b.reason);
  }

  isWorkingDay(d: Iso, scope: Scope = 'all'): boolean {
    if (isWeekend(d) || this.all.has(d)) return false;
    return !(scope === 'factory' && this.factory.has(d));
  }

  /** Why d is not a working day, or null if it is. */
  whyNotWorking(d: Iso, scope: Scope = 'all'): string | null {
    if (isWeekend(d)) return dayOfWeek(d) === 6 ? 'a Saturday' : 'a Sunday';
    if (this.all.has(d)) return this.all.get(d)!;
    if (scope === 'factory' && this.factory.has(d)) return `factory blocked (${this.factory.get(d)})`;
    return null;
  }

  /** d itself if it is a working day, otherwise the next one. */
  onOrAfter(d: Iso, scope: Scope = 'all'): Iso {
    let x = d;
    while (!this.isWorkingDay(x, scope)) x = addDays(x, 1);
    return x;
  }

  /** Move n working days from d (n may be negative). n = 0 returns d unchanged. */
  addWorkingDays(d: Iso, n: number, scope: Scope = 'all'): Iso {
    let x = d;
    const step = n < 0 ? -1 : 1;
    let left = Math.abs(n);
    while (left > 0) {
      x = addDays(x, step);
      if (this.isWorkingDay(x, scope)) left--;
    }
    return x;
  }

  /** A run of `days` working days starting on or after start. */
  span(start: Iso, days: number, scope: Scope = 'all'): { start: Iso; end: Iso } {
    const s = this.onOrAfter(start, scope);
    return { start: s, end: this.addWorkingDays(s, Math.max(days, 1) - 1, scope) };
  }

  /** Working days from a to b: 0 if same day, 1 if b is the next working day. */
  workingDaysBetween(a: Iso, b: Iso, scope: Scope = 'all'): number {
    if (b < a) return -this.workingDaysBetween(b, a, scope);
    let n = 0;
    for (let x = a; x < b; x = addDays(x, 1)) if (this.isWorkingDay(addDays(x, 1), scope)) n++;
    return n;
  }

  /** Working days of [start, end] that fall inside [from, to]. */
  workingDaysWithin(start: Iso, end: Iso, from: Iso, to: Iso, scope: Scope = 'all'): number {
    let n = 0;
    const a = start > from ? start : from;
    const b = end < to ? end : to;
    for (let x = a; x <= b; x = addDays(x, 1)) if (this.isWorkingDay(x, scope)) n++;
    return n;
  }
}
