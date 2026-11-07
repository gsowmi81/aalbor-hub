// Sign-in by emailed link. Only addresses in `people` (active) get a link.
// The link opens a page with a Sign in button; the POST from that button is what
// uses the link up, so Outlook's link scanner can't spend it first.
import crypto from 'node:crypto';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import { pool, withSystem } from '../db/pool.js';
import { config } from '../config.js';
import { sendSignInEmail } from './mail.js';
import { html } from './html.js';
import { bare } from '../views/layout.js';

export type Role = 'editor' | 'doer' | 'viewer';
export interface Person {
  id: number;
  name: string;
  email: string;
  role: Role;
  /** George and Gus: can see who was responsible for each rework. */
  is_owner: boolean;
  /** Board rows this person works in (Settings → People): their steps on My day. */
  areas: string[];
  /** The Stock tick (George, 7 Nov 2026): may do anything on the stock tables, whatever their role. */
  can_stock: boolean;
  /** Bot suggestions waiting for an Editor (the count on the Suggestions tab). */
  pending_suggestions?: number;
  /** Signed in by a job link (an installer, George, 7 Nov 2026): held to this one job's site page. */
  job_scope?: number | null;
  /** Signs in only by a job link; the emailed sign-in refuses them. */
  link_only?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      person?: Person;
    }
  }
}

const COOKIE = 'hub_session';
const SESSION_DAYS = 90;
const LINK_MINUTES = 20;

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function setCookie(res: Response, name: string, value: string, maxAgeSeconds: number): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.production) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

/** Loads the signed-in person, if any. */
export async function loadPerson(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const t = readCookie(req, COOKIE);
  if (t) {
    const r = await pool.query(
      `select p.id, p.name, p.email, p.role, p.is_owner, p.areas, p.can_stock, p.link_only, s.job_id as job_scope,
              (select count(*)::int from suggestions where status = 'pending') as pending_suggestions
       from sessions s join people p on p.id = s.person_id
       where s.token_hash = $1 and s.expires_at > now() and p.active`,
      [hash(t)],
    );
    if (r.rows[0]) req.person = r.rows[0];
  }
  next();
}

export function requireSignIn(req: Request, res: Response, next: NextFunction): void {
  if (req.person) return next();
  if (req.method === 'GET') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  // A form posted after the sign-in expired: say so and bring them back to where they were.
  const back = (req.get('referer') ?? '/').replace(/^https?:\/\/[^/]+/, '') || '/';
  if ((req.headers.accept ?? '').includes('text/html') || req.headers['x-hub-live']) {
    return res.redirect(`/login?next=${encodeURIComponent(back)}&expired=1`);
  }
  res.status(401).send('Sign in first.');
}

const rank: Record<Role, number> = { viewer: 0, doer: 1, editor: 2 };
export function can(p: Person | undefined, role: Role): boolean {
  return !!p && rank[p.role] >= rank[role];
}

/** A courtesy check so people get a clear page; the database enforces the same rules regardless. */
export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (can(req.person, role)) return next();
    res.status(403).send(bare('Not allowed', html`<h1>You can't do that</h1><p>Your sign-in can't make this change. Ask George or Christine.</p><p><a href="/">Back to Coming up</a></p>`).value);
  };
}

/** Refuse cross-site form posts (belt and braces with SameSite=Lax). */
export function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') return next();
  const origin = req.headers.origin ?? req.headers.referer;
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch {
    /* fall through */
  }
  res.status(403).send('This form came from another site.');
}

function safeNext(n: unknown): string {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/';
}

function loginPage(opts: { email?: string; next?: string; message?: string; devLink?: string } = {}) {
  return bare('Sign in', html`
    <div class="eyebrow">Aalbor Kitchens · Production Hub</div>
    <h1>Sign in</h1>
    ${opts.message ? html`<p class="notice">${opts.message}</p>` : html`<p class="muted">Type your work email. We'll email you a link that signs you in on this phone or computer for ${SESSION_DAYS} days.</p>`}
    ${opts.devLink ? html`<p class="notice">Local test mode, no email sent: <a href="${opts.devLink}">open the sign-in link</a></p>` : ''}
    <form method="post" action="/login" class="stack" data-plain>
      <input type="hidden" name="next" value="${opts.next ?? '/'}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required value="${opts.email ?? ''}">
      <button class="btn primary" type="submit">Email me a sign-in link</button>
    </form>`);
}

export function authRoutes(): Router {
  const r = express.Router();

  r.get('/login', (req, res) => {
    if (req.person) return res.redirect('/');
    res.send(loginPage({ next: safeNext(req.query.next), message: req.query.expired ? 'Your sign-in has run out. Sign in again and you can carry on where you were.' : undefined }).value);
  });

  r.post('/login', async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const next = safeNext(req.body.next);
    const sent = `If ${email} is on the Aalbor Hub list, a sign-in link is on its way. It works for ${LINK_MINUTES} minutes. Check junk mail if it isn't there in a minute.`;
    const p = (await pool.query('select id, name, email from people where email = $1 and active and not link_only', [email])).rows[0];
    if (!p) return res.send(loginPage({ email, next, message: sent }).value);

    const recent = await pool.query(
      `select count(*)::int as n from sign_in_links where person_id = $1 and expires_at > now()`, [p.id]);
    if (recent.rows[0].n >= 5) {
      return res.send(loginPage({ email, next, message: 'Five links have gone to this address in the last 20 minutes. Use the newest one, or wait a little and try again.' }).value);
    }
    const t = token();
    await withSystem((db) => db.query(
      `insert into sign_in_links (token_hash, person_id, expires_at) values ($1, $2, now() + make_interval(mins => $3))`,
      [hash(t), p.id, LINK_MINUTES]));
    const link = `${config.appUrl}/auth/verify?t=${t}&next=${encodeURIComponent(next)}`;
    try {
      const how = await sendSignInEmail(p.email, p.name, link);
      res.send(loginPage({ email, next, message: sent, devLink: how === 'logged' ? link : undefined }).value);
    } catch (err) {
      console.error(err);
      res.status(500).send(loginPage({ email, next, message: "The sign-in email didn't send. Tell George; the email service needs checking." }).value);
    }
  });

  r.get('/auth/verify', (req, res) => {
    const t = String(req.query.t ?? '');
    res.send(bare('Sign in', html`
      <div class="eyebrow">Aalbor Kitchens · Production Hub</div>
      <h1>Sign in</h1>
      <form method="post" action="/auth/verify" class="stack" data-plain>
        <input type="hidden" name="t" value="${t}">
        <input type="hidden" name="next" value="${safeNext(req.query.next)}">
        <button class="btn primary" type="submit">Sign in to the Aalbor Hub</button>
      </form>`).value);
  });

  r.post('/auth/verify', async (req, res) => {
    const t = String(req.body.t ?? '');
    const s = token();
    const person = await withSystem(async (db) => {
      const used = await db.query(
        `update sign_in_links set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning person_id`,
        [hash(t)]);
      const id = used.rows[0]?.person_id;
      if (!id) return null;
      await db.query(
        `insert into sessions (token_hash, person_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`,
        [hash(s), id, SESSION_DAYS]);
      await db.query(`delete from sign_in_links where expires_at < now() - interval '1 day'`);
      await db.query(`delete from sessions where expires_at < now()`);
      return id as number;
    });
    if (!person) {
      return res.status(400).send(loginPage({ message: 'That link has expired or has already been used. Ask for a new one below.' }).value);
    }
    setCookie(res, COOKIE, s, SESSION_DAYS * 86400);
    res.redirect(safeNext(req.body.next));
  });

  // A job link (George, 7 Nov 2026): the installer's way in. It opens one job's site page and nothing else.
  r.get('/site/go/:token', async (req, res) => {
    const t = String(req.params.token ?? '');
    const link = (await pool.query(`select l.id, l.job_id, l.person_id from site_links l join people p on p.id = l.person_id join jobs j on j.id = l.job_id
      where l.token = $1 and l.revoked_at is null and p.active and j.status <> 'cancelled'`, [t])).rows[0];
    if (!link) return res.status(404).send(bare('Site link', html`<h1>This link has stopped</h1><p>Ask the office for a new one.</p>`).value);
    const s = token();
    await withSystem(async (db) => {
      await db.query(`insert into sessions (token_hash, person_id, expires_at, job_id) values ($1, $2, now() + make_interval(days => $3), $4)`, [hash(s), link.person_id, SESSION_DAYS, link.job_id]);
      await db.query('update site_links set last_used_at = now() where id = $1', [link.id]);
    });
    setCookie(res, COOKIE, s, SESSION_DAYS * 86400);
    res.redirect('/site');
  });

  r.post('/logout', async (req, res) => {
    const t = readCookie(req, COOKIE);
    if (t) await withSystem((db) => db.query('delete from sessions where token_hash = $1', [hash(t)]));
    setCookie(res, COOKIE, '', 0);
    res.redirect('/login');
  });

  return r;
}
