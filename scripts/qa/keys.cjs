const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: 'hub_session', value: 'qa-george', domain: 'localhost', path: '/' }]);
  const p = await ctx.newPage();
  await p.goto('http://localhost:3000/jobs/2');
  const seen = []; let noOutline = 0;
  for (let i = 0; i < 60; i++) {
    await p.keyboard.press('Tab');
    const info = await p.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e); const vis = cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px' || cs.boxShadow !== 'none'; return { tag: e.tagName.toLowerCase(), text: (e.textContent || e.getAttribute('aria-label') || e.value || '').trim().slice(0, 28), vis }; });
    if (!info) continue; seen.push(`${info.tag}:${info.text}${info.vis ? '' : ' [no focus ring]'}`); if (!info.vis) noOutline++;
  }
  console.log('first 60 tab stops on the job page:\n' + seen.join('\n'));
  console.log('without a visible focus ring:', noOutline);
  // Enter on a summary opens it; Escape on the move box closes it
  await p.goto('http://localhost:3000/jobs/2'); const sum = p.locator('summary', { hasText: 'Edit all dates' }).first(); await sum.focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(150);
  console.log('Enter opens details:', await sum.evaluate((s) => s.parentElement.open));
  await p.locator('a.datebtn').first().focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  console.log('Enter on a date opens the move box:', await p.locator('.movebox').count(), '| focus inside box:', await p.evaluate(() => !!document.activeElement.closest('.movebox')));
  await p.keyboard.press('Escape'); await p.waitForTimeout(200); console.log('Escape closes it:', (await p.locator('.movebox').count()) === 0);
  await b.close();
})();
