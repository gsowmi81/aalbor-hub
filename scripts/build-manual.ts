// The manual as one HTML file (docs/manual.html), for a review copy and for printing. Source: docs/manual/*.md.
import fs from 'node:fs';
import { manualDocument } from '../src/web/help.js';

const css = fs.readFileSync(new URL('../public/hub.css', import.meta.url), 'utf8');
const body = manualDocument();
const out = `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aalbor Hub manual</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>${css}
body { background: var(--bg); color: var(--fg); font-family: var(--sans); margin: 0; }
.manual { padding: 16px; }
.manual-page { margin-bottom: 14px; }
</style></head><body><div class="manual manual-all"><div class="eyebrow">Aalbor Kitchens · Production Hub</div>${body}</div></body></html>`;
fs.writeFileSync(new URL('../docs/manual.html', import.meta.url), out);
console.log(`docs/manual.html: ${Math.round(out.length / 1024)} KB`);
