// The site link and the site log (George, 7 Nov 2026). A session opened from a job link is held to
// that job: siteScope() lets it reach the site page, its photos and the job's plans, and nothing else.
import express, { NextFunction, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { pool, withPerson, withSystem } from '../db/pool.js';
import { UserError } from '../db/edits.js';
import { loadIssue, loadIssues, loadJob } from '../db/queries.js';
import { loadInstallers, loadSiteLogs } from '../db/site.js';
import { todaySydney } from '../domain/dates.js';
import { sitePage } from '../views/site.js';
import { Person, requireRole } from './auth.js';
import { readMultipart } from './upload.js';
import { deliverAll, flagNudges } from './nudges.js';
import { flash, takeFlash } from './routes.js';

const me = (req: Request) => req.person as Person;

/** What a job-link session may reach. Everything else goes to the site page. */
export function siteScope(req: Request, res: Response, next: NextFunction): void {
  const scope = req.person?.job_scope;
  if (!scope) return next();
  const p = req.path;
  const ok = p === '/site' || p.startsWith('/site/') || p === '/logout'
    || (req.method === 'GET' && new RegExp(`^/jobs/${scope}/files/\\d+$`).test(p))
    || (req.method === 'GET' && /^\/issues\/\d+\/photos\/\d+$/.test(p));
  if (ok) return next();
  res.redirect('/site');
}

export function siteRoutes(): express.Router {
  const r = express.Router();
  const doer = requireRole('doer');
  const editor = requireRole('editor');

  const scopedJob = (req: Request) => {
    const id = me(req).job_scope;
    if (!id) throw new UserError('This page is for a job link. Open the link the office sent you.');
    return id;
  };

  r.get('/site', async (req, res) => {
    const id = scopedJob(req);
    const data = await loadJob(id);
    if (!data) throw new UserError("That job isn't in the hub any more.");
    const [logs, issues] = await Promise.all([loadSiteLogs(id), loadIssues({ jobId: id })]);
    res.setHeader('Cache-Control', 'no-store');
    res.send(sitePage({ person: me(req), job: data.job, steps: data.steps, files: data.files, logs, issues, today: todaySydney(), flash: takeFlash(req, res) }).value);
  });

  const photosIn = async (db: { query: (q: string, p: unknown[]) => Promise<unknown> }, logId: number, files: { contentType: string; bytes: Buffer }[]) => {
    for (const f of files) await db.query('insert into site_log_photos (log_id, content_type, bytes, size) values ($1, $2, $3, $4)', [logId, f.contentType, f.bytes, f.bytes.length]);
  };

  // A daily log entry with photos.
  r.post('/site/log', doer, async (req, res) => {
    const id = scopedJob(req);
    const { fields, files } = await readMultipart(req);
    const note = String(fields.note ?? '').trim().slice(0, 1000);
    if (!note && !files.length) throw new UserError('Write a line or add a photo.');
    await withPerson(me(req).id, async (db) => {
      const l = await db.query(`insert into site_logs (job_id, kind, note) values ($1, 'log', $2) returning id`, [id, note]);
      await photosIn(db, l.rows[0].id, files);
    });
    flash(res, 'Added to the log.');
    res.redirect('/site#log');
  });

  // Something missing: a flag to whoever looks after "Missing on site" (Gus) and the Editors, and a log entry.
  r.post('/site/missing', doer, async (req, res) => {
    const id = scopedJob(req);
    const { fields, files } = await readMultipart(req);
    const note = String(fields.note ?? '').trim().slice(0, 300);
    if (!note) throw new UserError("Say what's missing.");
    const install = (await pool.query(`select id from steps where job_id = $1 and kind = 'install' and label = '' limit 1`, [id])).rows[0];
    const issueId = await withPerson(me(req).id, async (db) => {
      const i = await db.query('insert into issues (job_id, step_id, type_key, note) values ($1, $2, $3, $4) returning id', [id, install?.id ?? null, 'missing_on_site', note]);
      for (const f of files) await db.query('insert into issue_photos (issue_id, content_type, bytes, size) values ($1, $2, $3, $4)', [i.rows[0].id, f.contentType, f.bytes, f.bytes.length]);
      await db.query(`insert into site_logs (job_id, step_id, kind, note, issue_id) values ($1, $2, 'missing', $3, $4)`, [id, install?.id ?? null, note, i.rows[0].id]);
      return i.rows[0].id as number;
    });
    const issue = await loadIssue(issueId);
    if (issue) await deliverAll(await flagNudges(issue));
    flash(res, `Sent${issue?.responsible_name ? ` to ${issue.responsible_name}` : ' to the office'}. It stays open until it's sorted.`);
    res.redirect('/site#log');
  });

  // Finished from the installer's side: their word, with the finished photos. The site manager's tick is the sign-off.
  r.post('/site/finished', doer, async (req, res) => {
    const id = scopedJob(req);
    const { fields, files } = await readMultipart(req);
    const note = String(fields.note ?? '').trim().slice(0, 500);
    const install = (await pool.query(`select id, done_at, site_finished_at from steps where job_id = $1 and kind = 'install' and label = '' limit 1`, [id])).rows[0];
    if (!install) throw new UserError('This job has no install step.');
    if (install.done_at) throw new UserError('The install is already signed off.');
    await withPerson(me(req).id, async (db) => {
      if (!install.site_finished_at) await db.query('update steps set site_finished_at = now() where id = $1', [install.id]);
      const l = await db.query(`insert into site_logs (job_id, step_id, kind, note) values ($1, $2, 'finished', $3) returning id`, [id, install.id, note]);
      await photosIn(db, l.rows[0].id, files);
    });
    flash(res, 'Marked finished from your side. The site manager will inspect and sign it off.');
    res.redirect('/site');
  });

  r.get('/site/logs/:id/photos/:pid', async (req, res) => {
    const id = Number(req.params.id);
    const pid = Number(req.params.pid);
    const scope = me(req).job_scope;
    const ph = (await pool.query(`select p.content_type, p.bytes from site_log_photos p join site_logs l on l.id = p.log_id where p.id = $1 and p.log_id = $2${scope ? ' and l.job_id = $3' : ''}`,
      scope ? [pid, id, scope] : [pid, id])).rows[0];
    if (!ph) return res.status(404).send('No such photo.');
    res.setHeader('Content-Type', ph.content_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Disposition', 'inline');
    res.send(ph.bytes);
  });

  // Editors make and stop installer links on the job's Site section.
  r.post('/jobs/:id/site-links', editor, async (req, res) => {
    const jobId = Number(req.params.id);
    const name = String(req.body.name ?? '').trim().slice(0, 60);
    if (!name) throw new UserError("Give the installer's name.");
    if (!(await pool.query('select 1 from jobs where id = $1', [jobId])).rowCount) throw new UserError("That job isn't in the hub.");
    const token = randomBytes(18).toString('base64url');
    await withPerson(me(req).id, async (db) => {
      let person = (await db.query('select id from people where link_only and lower(name) = lower($1)', [name])).rows[0];
      if (!person) {
        // A record for the name on the log; the address can't be used to sign in (link_only).
        person = (await db.query(`insert into people (name, email, role, active, areas, link_only, email_digest) values ($1, $2, 'doer', true, '{install}', true, false) returning id`,
          [name, `installer-${randomBytes(6).toString('hex')}@links.aalbor-hub.local`])).rows[0];
      } else {
        await db.query('update people set active = true where id = $1 and not active', [person.id]);
      }
      await db.query('insert into site_links (job_id, person_id, token) values ($1, $2, $3)', [jobId, person.id, token]);
    });
    flash(res, `Link made for ${name}. Copy it from the Site section and send it to them.`);
    res.redirect(`/jobs/${jobId}#site`);
  });

  r.post('/site-links/:id/revoke', editor, async (req, res) => {
    const id = Number(req.params.id);
    const l = (await pool.query('select job_id from site_links where id = $1', [id])).rows[0];
    if (!l) throw new UserError('That link has gone.');
    await withPerson(me(req).id, (db) => db.query('update site_links set revoked_at = now() where id = $1 and revoked_at is null', [id]));
    // Sessions are the sign-in code's (system): a stopped link signs its phones out.
    await withSystem((db) => db.query('delete from sessions where job_id = $1 and person_id = (select person_id from site_links where id = $2)', [l.job_id, id]));
    flash(res, 'Link stopped. Any phone using it is signed out.');
    res.redirect(`/jobs/${l.job_id}#site`);
  });

  return r;
}

export { loadInstallers };
