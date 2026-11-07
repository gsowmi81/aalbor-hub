const { chromium, devices } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
(async () => {
  const b = await chromium.launch();
  const pages = ['/board', '/pipeline', '/me', '/jobs', '/attention', '/more', '/jobs/2', '/jobs/new', '/stock', '/stock/items', '/stock/orders', '/stock/count', '/settings', '/rework', '/suggestions', '/load', '/login', '/me?job=2'];
  const tally = {}; const examples = {};
  for (const phone of [false, true]) {
    const ctx = await b.newContext(phone ? { ...devices['iPhone 13'] } : { viewport: { width: 1366, height: 860 } });
    await ctx.addCookies([{ name: 'hub_session', value: 'qa-george', domain: 'localhost', path: '/' }]);
    const p = await ctx.newPage();
    for (const u of pages) {
      await p.goto('http://localhost:3000' + u, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(200);
      const res = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice']).analyze();
      for (const v of res.violations) {
        const k = `${v.id} [${v.impact}] ${v.help}`;
        tally[k] = (tally[k] || 0) + v.nodes.length;
        if (!examples[k]) examples[k] = `${phone ? 'phone ' : ''}${u}: ${v.nodes[0].html.slice(0, 140)} :: ${v.nodes[0].failureSummary?.split('\n')[1]?.slice(0, 140)}`;
      }
    }
    await ctx.close();
  }
  for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`${n}\t${k}\n\t${examples[k]}`);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
