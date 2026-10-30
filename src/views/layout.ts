import { html, Html } from '../web/html.js';
import type { Person } from '../web/auth.js';

/**
 * Changes on every release (Render sets RENDER_GIT_COMMIT), so browsers fetch the new
 * hub.js and hub.css straight away instead of using a cached copy (George, 31 Oct 2026).
 */
const ASSET_VERSION = (process.env.RENDER_GIT_COMMIT ?? String(Date.now())).slice(0, 12);

const FONTS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap';

function head(title: string): Html {
  return html`<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title} · Aalbor Hub</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/static/hub.css?v=${ASSET_VERSION}">
<script src="/static/hub.js?v=${ASSET_VERSION}" defer></script>
</head>`;
}

/** Page for signed-out screens: sign-in, errors. */
export function bare(title: string, body: Html): Html {
  return html`${head(title)}<body><main class="wrap narrow">${body}</main></body></html>`;
}

export type Tab = 'coming-up' | 'jobs' | 'job' | 'new' | 'rework' | 'settings';

const ROLE_NAME = { editor: 'Editor', doer: 'Doer', viewer: 'Viewer' } as const;

export function page(opts: { title: string; tab: Tab; person: Person; flash?: string | null; body: Html; sub?: Html | string }): Html {
  const p = opts.person;
  const tabs: [Tab, string, string][] = [
    ['coming-up', 'Coming up', '/'],
    ['jobs', 'All jobs', '/jobs'],
    ['job', 'One job', '/job'],
    ['rework', 'Rework', '/rework'],
  ];
  if (p.role === 'editor') tabs.push(['new', 'New job', '/jobs/new'], ['settings', 'Settings', '/settings']);
  const flash = opts.flash ? (opts.flash.startsWith('!') ? html`<div class="notice bad" role="alert">${opts.flash.slice(1)}</div>` : html`<div class="notice ok" role="status">${opts.flash}</div>`) : '';
  return html`${head(opts.title)}<body><div class="wrap">
  <header class="top">
    <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
      <div class="eyebrow">Aalbor Kitchens · Production Hub</div>
      <h1>${opts.title}</h1>
      ${opts.sub ? html`<div class="muted">${opts.sub}</div>` : ''}
    </div>
    <div class="who">${p.name} · ${ROLE_NAME[p.role]}
      <form method="post" action="/logout"><button class="linkbtn" type="submit">Sign out</button></form></div>
  </header>
  <nav class="tabs" aria-label="Screens">
    ${tabs.map(([t, label, href]) => html`<a href="${href}"${t === opts.tab ? html` aria-current="page"` : ''}>${label}</a>`)}
  </nav>
  ${flash}
  ${opts.body}
</div></body></html>`;
}
