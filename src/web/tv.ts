// The factory TV: /tv?k=<key>, no sign-in (a screen on the wall), read only. The key lives in
// app_settings.tv_token and is made or replaced in Settings. A signed-in person sees it without the key.
import express from 'express';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { appSetting, loadEverything, loadRules } from '../db/queries.js';
import { todaySydney } from '../domain/dates.js';
import { tvPage } from '../views/tv.js';
import { bare } from '../views/layout.js';
import { html } from './html.js';

export function newTvKey(): string {
  return randomBytes(12).toString('base64url');
}

function keyMatches(given: string, stored: string): boolean {
  if (!stored || !given || given.length !== stored.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(stored));
}

export function tvRoutes(): express.Router {
  const r = express.Router();
  r.get('/tv', async (req, res) => {
    const given = String(req.query.k ?? '');
    const stored = await appSetting('tv_token');
    if (!req.person && !keyMatches(given, stored)) {
      return res.status(403).send(bare('Factory TV', html`<h1>Factory TV</h1><p>This screen needs the link from Settings → Factory TV. Ask George or Christine for it.</p>`).value);
    }
    const [all, message, rules] = await Promise.all([loadEverything(), appSetting('board_message'), loadRules()]);
    res.setHeader('Cache-Control', 'no-store');
    res.send(tvPage({ today: todaySydney(), jobs: all.jobs, steps: all.steps, message, saturdays: rules.saturday_working === 1 }).value);
  });
  return r;
}
