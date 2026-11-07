// Crawl every GET link on the hub as each role, desktop and phone, with and without script.
// Records: non-200 answers, page errors, console errors, error pages, and slow pages.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const ROLES = ['george', 'christine', 'phil', 'gus', 'factory', 'angela', 'michael'];
const SKIP = /^\/(logout|export\.xlsx|auth\/|login|static\/)|\/photos\/|\/files\/\d+$|\/sheet$|\/labels/;
const OUT = process.env.OUT;
const report = { roles: {}, problems: [] };
function problem(role, where, what) { report.problems.push({ role, where, what }); }

async function crawl(role, opts) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...(opts.phone ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } }), javaScriptEnabled: !opts.noJs });
  await ctx.addCookies([{ name: 'hub_session', value: `qa-${role}`, domain: 'localhost', path: '/' }]);
  const p = await ctx.newPage();
  const tag = `${role}${opts.phone ? '/phone' : ''}${opts.noJs ? '/nojs' : ''}`;
  let current = '';
  p.on('pageerror', (e) => problem(tag, current, `page error: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') problem(tag, current, `console error: ${m.text().slice(0, 200)}`); });
  p.on('response', (r) => { const u = new URL(r.url()); if (u.origin === BASE && r.status() >= 400 && !/\/static\//.test(u.pathname)) problem(tag, current, `${r.request().method()} ${u.pathname}${u.search} → ${r.status()}`); });
  const seen = new Set();
  const queue = ['/', '/board', '/pipeline', '/me', '/jobs', '/attention', '/more', '/stock', '/settings', '/suggestions', '/rework', '/load', '/jobs/new', '/find?q=parry', '/tv'];
  let n = 0, slow = 0;
  while (queue.length && n < (opts.max ?? 400)) {
    const path = queue.shift();
    const key = path.replace(/#.*$/, '');
    if (seen.has(key) || SKIP.test(key)) continue;
    seen.add(key); n++;
    current = key;
    const t0 = Date.now();
    let resp;
    try { resp = await p.goto(BASE + key, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch (e) { problem(tag, key, `navigation failed: ${e.message.split('\n')[0]}`); continue; }
    const ms = Date.now() - t0;
    if (ms > 2500) { slow++; problem(tag, key, `slow: ${ms} ms`); }
    const status = resp?.status();
    const text = await p.locator('body').innerText().catch(() => '');
    if (/Something went wrong|That didn't work|Cannot GET|Cannot POST/.test(text)) problem(tag, key, `error page (${status}): ${text.slice(0, 120).replace(/\n/g, ' ')}`);
    if (status === 200 && !opts.phone) {
      // Links on the page, same origin
      const hrefs = await p.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
      for (const h of hrefs) {
        if (!h || h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('http')) continue;
        const clean = h.replace(/#.*$/, '');
        if (!seen.has(clean) && !SKIP.test(clean)) queue.push(clean);
      }
      // horizontal overflow (desktop)
      const over = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      if (over) problem(tag, key, 'page scrolls sideways');
    }
    if (opts.phone) {
      const over = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      if (over) problem(tag, key, 'phone page scrolls sideways');
      const tiny = await p.$$eval('a, button, input[type=checkbox], input[type=radio], select, summary', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && (r.height < 24 || r.width < 24); }).map((e) => `${e.tagName.toLowerCase()} "${(e.textContent || e.getAttribute('aria-label') || e.name || '').trim().slice(0, 30)}"`).slice(0, 6));
      if (tiny.length) problem(tag, key, `small tap targets (<24px): ${tiny.join(', ')}`);
    }
  }
  report.roles[tag] = { pages: n, slow };
  await b.close();
}

(async () => {
  for (const role of ROLES) await crawl(role, {});
  await crawl('george', { phone: true, max: 60 });
  await crawl('phil', { phone: true, max: 40 });
  await crawl('george', { noJs: true, max: 80 });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  const counts = {};
  for (const pr of report.problems) { const k = pr.what.replace(/\d+/g, '#').slice(0, 60); counts[k] = (counts[k] || 0) + 1; }
  console.log('pages per role:', JSON.stringify(report.roles));
  console.log('problems:', report.problems.length);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(v, k);
})().catch((e) => { console.error(e); process.exit(1); });
