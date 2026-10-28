import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { config } from './config.js';
import { pool, isPermissionError } from './db/pool.js';
import { authRoutes, loadPerson, requireSignIn, sameOrigin } from './web/auth.js';
import { backTo, flash, routes, UserError } from './web/routes.js';
import { bare } from './views/layout.js';
import { html } from './web/html.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = [path.resolve(here, '../public'), path.resolve(here, '../../public')].find((d) => fs.existsSync(d))!;

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.get('/healthz', async (_req, res) => {
    await pool.query('select 1');
    res.send('ok');
  });
  app.use('/static', express.static(publicDir, { maxAge: config.production ? '1h' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(loadPerson);
  app.use(sameOrigin);
  app.use(authRoutes());
  app.use(requireSignIn);
  app.use(routes());

  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof UserError || isPermissionError(err)) {
      const msg = err instanceof UserError ? err.message : `You can't make that change (${err.message}). Ask George or Christine.`;
      if (req.method === 'POST') {
        flash(res, `!${msg}`);
        return res.redirect(backTo(req, req.get('referer')?.replace(/^https?:\/\/[^/]+/, '') || '/'));
      }
      return res.status(400).send(bare('Problem', html`<h1>That didn't work</h1><p>${msg}</p><p><a href="/">Back to Coming up</a></p>`).value);
    }
    console.error(err);
    res.status(500).send(bare('Problem', html`<h1>Something went wrong</h1><p>The hub hit an error and nothing was saved. Try again; if it keeps happening, tell George.</p><p><a href="/">Back to Coming up</a></p>`).value);
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  createApp().listen(config.port, () => console.log(`Aalbor Hub on ${config.appUrl} (port ${config.port})`));
}
