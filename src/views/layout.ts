import { html, Html } from '../web/html.js';
import type { Person } from '../web/auth.js';
import { config } from '../config.js';

/** Shown at the top of every page of a preview copy, signed in or not. */
const previewBar = (): Html => config.preview
  ? html`<div class="preview-bar" role="region" aria-label="Preview notice">Preview copy of the hub. Try anything here; nothing you change is real. The real hub is <a href="https://hub.aalborkitchens.com.au">hub.aalborkitchens.com.au</a>.</div>`
  : html``;

/**
 * Changes on every release (Render sets RENDER_GIT_COMMIT), so browsers fetch the new
 * hub.js and hub.css straight away instead of using a cached copy (George, 31 Oct 2026).
 */
const ASSET_VERSION = (process.env.RENDER_GIT_COMMIT ?? String(Date.now())).slice(0, 12);

const FONTS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap';

function head(title: string): Html {
  return html`<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title} · ${config.preview ? 'Hub preview' : 'Aalbor Hub'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/static/hub.css?v=${ASSET_VERSION}">
<script src="/static/hub.js?v=${ASSET_VERSION}" defer></script>
</head>`;
}

/** Page for signed-out screens: sign-in, errors. */
export function bare(title: string, body: Html): Html {
  return html`${head(title)}<body>${previewBar()}<main class="wrap narrow">${body}</main></body></html>`;
}

/**
 * The tabs (George, 7 Nov 2026) are by role: Editors Board · Pipeline · Attention · Jobs · More; Doers My day · This job · Stock · More;
 * Viewers Board · Pipeline · Jobs · More (Stock too with the stock tick). A screen off the row lights More.
 */
export type Tab = 'board' | 'pipeline' | 'me' | 'jobs' | 'attention' | 'more' | 'job' | 'rework' | 'suggestions' | 'new' | 'settings' | 'stock'
  | 'coming-up';

const ROLE_NAME = { editor: 'Editor', doer: 'Doer', viewer: 'Viewer' } as const;

export function page(opts: { title: string; tab: Tab; person: Person; flash?: string | null; body: Html; sub?: Html | string; attention?: number }): Html {
  const p = opts.person;
  const waiting = p.pending_suggestions ?? 0;
  const att = opts.attention ? html`Attention <span class="badge" aria-label="${opts.attention} to look at">${opts.attention}</span>` : 'Attention';
  const more = waiting ? html`More <span class="badge" aria-label="${waiting} suggestions waiting">${waiting}</span>` : 'More';
  // Tabs by role (George, 7 Nov 2026; redesign A): the office plans, the floor ticks, Viewers look.
  // Whatever is missing from a role's row is on More, so nothing is lost.
  const all: Record<string, [Tab, string | Html, string]> = {
    board: ['board', 'Board', '/board'], pipeline: ['pipeline', 'Pipeline', '/pipeline'], me: ['me', 'My day', '/me'], jobs: ['jobs', 'Jobs', '/jobs'],
    attention: ['attention', att, '/attention'], more: ['more', more, '/more'], job: ['job', 'This job', '/jobs/last'], stock: ['stock', 'Stock', '/stock'],
  };
  const row = p.role === 'doer' ? ['me', 'job', 'stock', 'more'] : p.role === 'viewer' ? ['board', 'pipeline', 'jobs', ...(p.can_stock ? ['stock'] : []), 'more'] : ['board', 'pipeline', 'attention', 'jobs', 'more'];
  const tabs = row.map((k) => all[k]);
  const wanted: Tab = opts.tab === 'coming-up' ? 'board' : opts.tab;
  const current: Tab = tabs.some(([t]) => t === wanted) ? wanted : 'more';
  const flash = opts.flash ? (opts.flash.startsWith('!') ? html`<div class="notice bad" role="alert">${opts.flash.slice(1)}</div>` : html`<div class="notice ok" role="status">${opts.flash}</div>`) : '';
  return html`${head(opts.title)}<body>${previewBar()}<div class="wrap">
  <header class="top">
    <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
      <div class="eyebrow">Aalbor Kitchens · Production Hub</div>
      <h1>${opts.title}</h1>
      ${opts.sub ? html`<div class="muted">${opts.sub}</div>` : ''}
    </div>
    <div class="topright">
      <form method="get" action="/find" class="find" role="search"><input type="search" name="q" placeholder="Find a job" aria-label="Find a job by number, client or suburb" autocomplete="off"><button class="btn small" type="submit">Go</button></form>
      <div class="who"><span class="who-full">${p.name} · ${ROLE_NAME[p.role]}</span><span class="who-short">${p.name.split(' ')[0]}</span>
        <form method="post" action="/logout"><button class="linkbtn" type="submit">Sign out</button></form></div>
    </div>
  </header>
  <nav class="tabs" aria-label="Screens">
    ${tabs.map(([t, label, href]) => html`<a href="${href}"${t === current ? html` aria-current="page"` : ''}>${label}</a>`)}
  </nav>
  <main id="main">
  ${flash}
  ${opts.body}
  </main>
</div></body></html>`;
}
