// Email nudges (George, 7 Nov 2026; docs/jobman-review.html R11). Four fixed emails instead of
// Jobman's trigger builder: a Monday "your week" per person, a daily note to whoever owns a
// step that went overdue, a flag to the person responsible and the Editors, and a "materials
// in" note to the factory. On the preview copy every one of them goes to the suggestions
// address (George) instead, with a line saying who it would have gone to.
import { config } from '../config.js';
import { pool, withSystem } from '../db/pool.js';
import { appSetting, loadEverything, IssueRow } from '../db/queries.js';
import { addDays, dayOfWeek, fmtRange, fmtShort, Iso, mondayOf, todaySydney } from '../domain/dates.js';
import { jobTitle, lastDate, StepRow, stepLabel } from '../domain/checks.js';
import { rowOf } from '../domain/steps.js';
import { isMine } from '../views/me.js';
import { sendEmail } from './mail.js';
import type { Person } from './auth.js';
import { esc } from './html.js';

export interface Nudge {
  kind: 'week' | 'overdue' | 'flag' | 'materials';
  to: { id: number; name: string; email: string };
  subject: string;
  lines: string[];
  link: string;
  linkText: string;
}

type Recipient = Person & { email_digest: boolean };

async function recipients(): Promise<Recipient[]> {
  return (await pool.query(`select id, name, email, role, is_owner, areas, email_digest from people where active and role in ('doer', 'editor') order by name`)).rows;
}

const stepLine = (s: StepRow, title: string) => `${title}: ${stepLabel(s)}, ${fmtRange(s.start_date, s.end_date)}`;

/** Steps that went overdue since the last working day: one email per person who owns any. */
export async function overdueNudges(today: Iso): Promise<Nudge[]> {
  const [all, people] = await Promise.all([loadEverything(), recipients()]);
  const live = new Map(all.jobs.filter((j) => j.status === 'live').map((j) => [j.id, j]));
  const since = addDays(today, -(dayOfWeek(today) === 1 ? 3 : 1));
  const fresh = all.steps.filter((s) => live.has(s.job_id) && !s.done_at && s.start_date && lastDate(s)! < today && lastDate(s)! >= since);
  const out: Nudge[] = [];
  for (const p of people.filter((x) => x.email_digest)) {
    const mine = fresh.filter((s) => isMine(s, p));
    if (!mine.length) continue;
    out.push({
      kind: 'overdue', to: p,
      subject: `Hub: ${mine.length} ${mine.length === 1 ? 'step is' : 'steps are'} overdue`,
      lines: mine.map((s) => stepLine(s, jobTitle(live.get(s.job_id)!))),
      link: `${config.appUrl}/me`, linkText: 'Open My day',
    });
  }
  return out;
}

/** Monday: each person's steps this week, overdue ones first. */
export async function weekNudges(today: Iso): Promise<Nudge[]> {
  const [all, people] = await Promise.all([loadEverything(), recipients()]);
  const live = new Map(all.jobs.filter((j) => j.status === 'live').map((j) => [j.id, j]));
  const mon = mondayOf(today);
  const fri = addDays(mon, 4);
  const out: Nudge[] = [];
  for (const p of people.filter((x) => x.email_digest)) {
    const mine = all.steps.filter((s) => live.has(s.job_id) && !s.done_at && s.start_date && isMine(s, p) && s.start_date <= fri && (lastDate(s)! >= mon || lastDate(s)! < today));
    if (!mine.length) continue;
    const late = mine.filter((s) => lastDate(s)! < today).sort((a, b) => lastDate(a)!.localeCompare(lastDate(b)!));
    const week = mine.filter((s) => lastDate(s)! >= today).sort((a, b) => a.start_date!.localeCompare(b.start_date!));
    out.push({
      kind: 'week', to: p,
      subject: `Hub: your week from ${fmtShort(mon)}${late.length ? ` (${late.length} overdue)` : ''}`,
      lines: [...late.map((s) => `Overdue, ${stepLine(s, jobTitle(live.get(s.job_id)!))}`), ...week.map((s) => stepLine(s, jobTitle(live.get(s.job_id)!)))],
      link: `${config.appUrl}/me`, linkText: 'Open My day',
    });
  }
  return out;
}

/** A flagged problem: the person responsible for its type and every Editor, except whoever raised it. */
export async function flagNudges(issue: IssueRow): Promise<Nudge[]> {
  const people = await recipients();
  const to = people.filter((p) => p.email_digest && p.id !== issue.raised_by && (p.role === 'editor' || p.id === issue.responsible));
  const title = `${issue.client_name}${issue.suburb ? ` · ${issue.suburb}` : ''}`;
  return to.map((p) => ({
    kind: 'flag', to: p,
    subject: `Hub flag: ${issue.type_label} on ${issue.client_name}`,
    lines: [`${title}${issue.step_label || issue.step_kind ? `, ${issue.step_label || issue.step_kind}` : ''}`, `${issue.raised_by_name ?? 'Someone'} says: ${issue.note}`, issue.responsible_name ? `Responsible: ${issue.responsible_name}` : 'No one is set as responsible for this type yet (Settings → Flag types).', issue.photo_ids.length ? `${issue.photo_ids.length} ${issue.photo_ids.length === 1 ? 'photo' : 'photos'} attached.` : ''].filter(Boolean),
    link: `${config.appUrl}/attention#i-${issue.id}`, linkText: 'Open it on Attention',
  }));
}

/** Materials in, ticked: tell the factory. */
export async function materialsInNudges(step: StepRow, job: { client_name: string; suburb: string; id: number }): Promise<Nudge[]> {
  const people = await recipients();
  const to = people.filter((p) => p.email_digest && (p.areas.includes('factory') || rowOf(step) === 'factory' && isMine(step, p)));
  return to.map((p) => ({
    kind: 'materials', to: p,
    subject: `Hub: materials in for ${job.client_name}`,
    lines: [`${jobTitle(job)}: materials are in. The factory can start.`],
    link: `${config.appUrl}/jobs/${job.id}#steps`, linkText: 'Open the job',
  }));
}

/** Sends one nudge. On the preview copy it goes to the suggestions address instead, saying who it was for. */
export async function deliver(n: Nudge): Promise<'sent' | 'logged'> {
  let to = n.to.email;
  let lines = n.lines;
  if (config.preview) {
    to = (await appSetting('suggestions_email')) || to;
    lines = [`Preview: this would have gone to ${n.to.name} <${n.to.email}>.`, '', ...lines];
  }
  const text = `Hi ${n.to.name.split(' ')[0]},\n\n${lines.join('\n')}\n\n${n.link}\n`;
  const htmlBody = `<p>Hi ${esc(n.to.name.split(' ')[0])},</p>${lines.map((l) => `<p style="margin:4px 0">${esc(l)}</p>`).join('')}
<p><a href="${esc(n.link)}" style="display:inline-block;padding:12px 20px;background:#14171C;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${esc(n.linkText)}</a></p>`;
  return sendEmail(to, n.subject, text, htmlBody);
}

/** Sends a batch, never failing the caller: a bad address shouldn't stop a tick. */
export async function deliverAll(nudges: Nudge[]): Promise<number> {
  let sent = 0;
  for (const n of nudges) {
    try { await deliver(n); sent++; } catch (err) { console.error('nudge failed', n.kind, n.to.email, err); }
  }
  return sent;
}

/** What the 7 am run would send today, without sending it (Settings → Emails). */
export async function dailyNudges(today: Iso): Promise<Nudge[]> {
  const g = dayOfWeek(today);
  if (g === 0 || g === 6) return [];
  return [...(g === 1 ? await weekNudges(today) : []), ...(await overdueNudges(today))];
}

/**
 * The daily run: once per day and kind, whatever restarts happen. Returns how many were sent,
 * or null when today's run had already happened.
 */
export async function runDaily(today: Iso, force = false): Promise<number | null> {
  const claimed = await withSystem(async (db) => {
    if (force) {
      await db.query(`insert into digest_runs (day, kind) values ($1, 'daily') on conflict (day, kind) do update set ran_at = now()`, [today]);
      return true;
    }
    const r = await db.query(`insert into digest_runs (day, kind) values ($1, 'daily') on conflict do nothing`, [today]);
    return (r.rowCount ?? 0) > 0;
  });
  if (!claimed) return null;
  const sent = await deliverAll(await dailyNudges(today));
  await withSystem((db) => db.query(`update digest_runs set sent = $2, ran_at = now() where day = $1 and kind = 'daily'`, [today, sent]));
  return sent;
}

export async function lastRuns(limit = 10): Promise<{ day: Iso; kind: string; sent: number; ran_at: string }[]> {
  return (await pool.query('select day, kind, sent, ran_at from digest_runs order by day desc limit $1', [limit])).rows;
}

/** Checks the clock every minute and runs the 7 am Sydney emails once a day. */
export function startScheduler(): NodeJS.Timeout {
  const tick = async () => {
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', hour12: false }).format(now));
    if (hour !== 7) return;
    try {
      const n = await runDaily(todaySydney(now));
      if (n !== null) console.log(`[nudges] ${n} sent for ${todaySydney(now)}`);
    } catch (err) { console.error('[nudges] failed', err); }
  };
  const t = setInterval(tick, 60_000);
  t.unref();
  return t;
}
