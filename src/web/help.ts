// The manual (George, 7 Nov 2026): docs/manual/*.md, served at /help so it ships with the code and
// the "?" on each screen opens that screen's page. /help/all is the whole thing on one page (print, review).
import express, { Request } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { page } from '../views/layout.js';
import { html, Html, raw } from './html.js';
import { markdown, titleOf } from './markdown.js';
import type { Person } from './auth.js';

// docs/manual, found from wherever this file runs (src/ under tsx, dist/src/ when built).
const DIR = (() => {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const c = path.join(d, 'docs', 'manual');
    if (fs.existsSync(c)) return c;
    d = path.dirname(d);
  }
  return path.resolve(process.cwd(), 'docs/manual');
})();

/** The order of the manual: parts, and the pages in each. The slug is the file name. */
export const MANUAL: { part: string; pages: string[] }[] = [
  { part: 'Your week in the hub', pages: ['owner', 'office', 'factory', 'site-manager', 'installer', 'viewer'] },
  { part: 'The screens', pages: ['board', 'pipeline', 'attention', 'my-day', 'job', 'jobs', 'rework', 'load', 'suggestions', 'new-job', 'find-and-more', 'settings', 'stock', 'stock-items', 'order-list', 'count-and-offcuts', 'bins', 'site-page', 'job-sheet', 'factory-tv'] },
  { part: 'How things are done', pages: ['signing-in', 'job-start-to-finish', 'moving-dates', 'rework-flow', 'flags', 'materials', 'weekly-stock', 'monday-morning', 'emails', 'words'] },
];
const ALL = MANUAL.flatMap((p) => p.pages);

const cache = new Map<string, { title: string; body: Html }>();
function load(slug: string): { title: string; body: Html } | null {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const hit = cache.get(slug);
  if (hit && process.env.NODE_ENV === 'production') return hit;
  const file = path.join(DIR, `${slug}.md`);
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, 'utf8');
  const v = { title: titleOf(src), body: markdown(src) };
  cache.set(slug, v);
  return v;
}

function toc(current?: string): Html {
  return html`<nav class="manual-toc" aria-label="Manual">${MANUAL.map((p) => html`<div class="manual-part"><strong>${p.part}</strong><ul>${p.pages.map((s) => {
    const t = load(s)?.title ?? s;
    return html`<li><a href="/help/${s}"${s === current ? html` aria-current="page"` : ''}>${t}</a></li>`;
  })}</ul></div>`)}</nav>`;
}

export function helpRoutes(): express.Router {
  const r = express.Router();
  const me = (req: Request) => req.person as Person;

  r.get('/help', (req, res) => {
    const index = load('index');
    const body = html`<div class="manual">${index?.body ?? ''}${toc()}<p class="muted small"><a href="/help/all">The whole manual on one page</a> (for printing).</p></div>`;
    res.send(page({ title: 'Manual', tab: 'more', person: me(req), body, sub: 'How the hub works, screen by screen' }).value);
  });

  r.get('/help/all', (req, res) => {
    const parts = MANUAL.map((p) => html`<h1 class="manual-parth">${p.part}</h1>${p.pages.map((s) => html`<section class="manual-page" id="${s}">${load(s)?.body ?? ''}</section>`)}`);
    const body = html`<div class="manual manual-all">${load('index')?.body ?? ''}${parts}</div>`;
    res.send(page({ title: 'Manual', tab: 'more', person: me(req), body, sub: html`<a href="/help">Contents</a>` }).value);
  });

  r.get('/help/:slug', (req, res) => {
    const slug = String(req.params.slug);
    const p = load(slug);
    if (!p || !ALL.includes(slug)) return res.status(404).send(page({ title: 'Manual', tab: 'more', person: me(req), body: html`<p>No such page. <a href="/help">Contents</a></p>` }).value);
    const i = ALL.indexOf(slug);
    const prev = i > 0 ? ALL[i - 1] : null;
    const next = i < ALL.length - 1 ? ALL[i + 1] : null;
    const part = MANUAL.find((x) => x.pages.includes(slug))!;
    const body = html`<div class="manual two"><aside class="manual-side">${toc(slug)}</aside><article class="manual-page">${p.body}
      <div class="manual-foot">${prev ? html`<a class="btn small" href="/help/${prev}">← ${load(prev)?.title ?? prev}</a>` : ''}${next ? html`<a class="btn small" href="/help/${next}">${load(next)?.title ?? next} →</a>` : ''}</div></article></div>`;
    res.send(page({ title: p.title, tab: 'more', person: me(req), body, sub: html`<a href="/help">Manual</a> · ${part.part}` }).value);
  });

  return r;
}

/** The manual as one HTML document, for the review copy (scripts/build-manual.ts). */
export function manualDocument(): string {
  const parts = MANUAL.map((p) => `<h1 class="manual-parth">${p.part}</h1>${p.pages.map((s) => `<section class="manual-page" id="${s}">${load(s)?.body.value ?? ''}</section>`).join('')}`).join('');
  return `${load('index')?.body.value ?? ''}${raw(parts).value}`;
}
