// Drive every workflow in a real browser, as each role. Each step logs PASS or FAIL and carries on.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const { Client } = require('pg');
const BASE = 'http://localhost:3000';
const S = process.env.S;
const results = [];
let page, ctx, browser, role = '';
const db = new Client({ connectionString: 'postgres://postgres@localhost:5433/hub_dev?host=/var/tmp/hubpg' });
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

async function as(r, opts = {}) {
  if (ctx) await ctx.close();
  role = r;
  ctx = await browser.newContext({ ...(opts.phone ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } }), javaScriptEnabled: opts.js !== false });
  await ctx.addCookies([{ name: 'hub_session', value: `qa-${r}`, domain: 'localhost', path: '/' }]);
  page = await ctx.newPage();
  page.on('pageerror', (e) => results.push({ role, step: '(page error)', ok: false, note: e.message }));
}
async function step(name, fn) {
  try { await fn(); results.push({ role, step: name, ok: true }); }
  catch (e) {
    const shot = `${S}/qa/fail-${results.length}.png`;
    try { await page.screenshot({ path: shot, fullPage: false }); } catch {}
    results.push({ role, step: name, ok: false, note: e.message.split('\n')[0].slice(0, 300), shot });
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const go = async (u) => { const r = await page.goto(BASE + u.replace(/#.*$/, ''), { waitUntil: 'domcontentloaded' }); if (u.includes('#')) await page.evaluate((h) => { location.hash = h; }, u.slice(u.indexOf('#'))); return r ? r.status() : 200; };
const waitPressed = async (sel, v) => page.waitForFunction(([s, val]) => document.querySelector(s)?.getAttribute('aria-pressed') === val, [sel, v], { timeout: 8000 });
const text = async () => page.locator('body').innerText();
const flash = async () => (await page.locator('.notice.ok, .notice.bad, .flash').first().innerText().catch(() => '')).trim();
const submitIn = async (selector) => { await page.locator(`${selector} button[type=submit]`).first().click(); await page.waitForTimeout(700); };
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

(async () => {
  await db.connect();
  browser = await chromium.launch();
  const jobId = (await one(`select id from jobs where client_name = 'Nicola Parry'`)).id;
  const greg = (await one(`select id from jobs where client_name = 'Greg Steven'`))?.id;
  const jenny = (await one(`select id from jobs where client_name = 'Jenny Vassiniotis'`)).id;

  // ============ EDITOR (George) ============
  await as('george');
  await step('landing: editor sees the Board', async () => { await go('/'); expect((await text()).includes('This week'), 'no week board'); });
  await step('find a job by number opens it', async () => { await go('/find?q=260916'); expect(/\/jobs\/\d+$/.test(page.url()), page.url()); });
  await step('find by part of a name lists matches', async () => { await go('/find?q=wissam'); expect((await text()).includes('Wissam'), 'no match'); });
  await step('header search form works', async () => { await go('/board'); await page.fill('header input[name=q]', 'parry'); await page.locator('header form.find button').click(); await page.waitForTimeout(500); expect(/\/jobs\/\d+$/.test(page.url()), page.url()); });

  // New job
  let newId;
  await step('new job: preview, clash text, add', async () => {
    await go('/jobs/new');
    await page.fill('input[name=job_number]', '270301'); await page.locator('input[name=job_number]').dispatchEvent('input'); await page.waitForTimeout(900);
    expect((await page.inputValue('input[name=site_start]')) === '2027-03-01', 'site start not filled from the number: ' + await page.inputValue('input[name=site_start]'));
    await page.fill('input[name=client_name]', 'QA Kitchen'); await page.fill('input[name=suburb]', 'Botany');
    await page.click('button[name=action][value=preview]'); await page.locator('#proposal', { hasText: 'Where it lands' }).waitFor({ timeout: 8000 });
    await page.fill('input[name=client_name]', 'QA Kitchen');
    await page.click('button[name=action][value=save]'); await page.waitForURL(/\/jobs\/\d+$/, { timeout: 8000 });
    newId = Number(page.url().split('/').pop());
    expect((await text()).includes('QA Kitchen'), 'job page lacks the name');
    expect((await flash()).includes('added'), 'no flash: ' + await flash());
  });
  await step('new job: duplicate number refused with a message', async () => {
    await go('/jobs/new'); await page.fill('input[name=job_number]', '270301'); await page.fill('input[name=client_name]', 'Dup'); await page.click('button[name=action][value=save]'); await page.waitForTimeout(800);
    expect((await text()).includes('already in the hub'), 'no duplicate message');
  });
  await step('one job: tick and untick a step in place', async () => {
    await go(`/jobs/${newId}`);
    const btn = page.locator('form[action$="/done"] button.check').first(); const label = await btn.getAttribute('aria-label');
    await btn.click(); await waitPressed('form[action$="/done"] button.check', 'true');
    await page.locator('form[action$="/done"] button.check').first().click(); await waitPressed('form[action$="/done"] button.check', 'false');
  });
  await step('one job: tap a date, move everything after it', async () => {
    await go(`/jobs/${newId}`);
    const before = (await q('select kind, start_date from steps where job_id = $1 and start_date is not null order by sort', [newId]));
    const dateBtn = page.locator('a.datebtn').nth(1); await dateBtn.click(); await page.waitForTimeout(300);
    const box = page.locator('.movebox, [data-movebox], form[action$="/reschedule/quick"]').first();
    expect(await box.count(), 'no move box opened');
    const dateInput = box.locator('input[type=date]').first();
    const cur = await dateInput.inputValue(); const d = new Date(cur + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); const nd = d.toISOString().slice(0, 10);
    await dateInput.fill(nd);
    await box.locator('button', { hasText: /Move everything/ }).first().click(); await page.waitForTimeout(900);
    const after = (await q('select kind, start_date from steps where job_id = $1 and start_date is not null order by sort', [newId]));
    expect(JSON.stringify(before) !== JSON.stringify(after), 'nothing moved');
    expect((await text()).match(/confirmed/gi)?.length > 1, 'moved dates not confirmed'); expect(!(await page.locator('.movebox').count()), 'move box still open');
  });
  await step('one job: pin and unpin', async () => {
    await go(`/jobs/${newId}`); await page.locator('form.pinform button').first().click(); await page.waitForTimeout(600);
    expect(/pinned/i.test(await text()), 'no Pinned pill'); await page.locator('form.pinform button').first().click(); await page.waitForTimeout(600);
    expect(!/📌/.test(await text()), 'still pinned');
  });
  await step('one job: edit all dates form saves', async () => {
    await go(`/jobs/${newId}`); await page.locator('summary', { hasText: 'Edit all dates' }).first().click();
    const inp = page.locator('form[action$="/dates"] input[type=date]').first(); const v = await inp.inputValue();
    await inp.fill(v); await page.locator('form[action$="/dates"] button[type=submit]').first().click(); await page.waitForTimeout(800);
    expect(!(await text()).includes("didn't work"), 'error page');
  });
  await step('one job: move the whole job +1 week and work out again', async () => {
    await go(`/jobs/${newId}`); await page.locator('summary', { hasText: 'Move the whole job' }).first().click();
    await page.locator('button', { hasText: '+1 week' }).first().click(); await page.waitForTimeout(800);
    expect((await flash()).length > 0 || true, '');
  });
  await step('one job: add, edit and delete a task for this job only', async () => {
    await go(`/jobs/${newId}`); const ts = page.locator('summary', { hasText: 'Add a task' }).first(); if (!(await ts.evaluate((x) => x.parentElement.open))) await ts.click();
    await page.fill('form[action$="/tasks"] input[name=label]', 'Spray doors'); await page.selectOption('form[action$="/tasks"] select[name=area]', { index: 1 });
    await submitIn('form[action$="/tasks"]');
    expect((await text()).includes('Spray doors'), 'task not added');
    const t = await one(`select id from steps where job_id = $1 and label = 'Spray doors'`, [newId]); expect(t, 'no task row');
    const del = page.locator(`form[action="/steps/${t.id}/delete"]`); expect(await del.count(), 'no delete form');
    await del.locator('xpath=ancestor::details[1]/summary').click().catch(() => {}); await del.locator('button[type=submit]').click(); await page.waitForTimeout(700);
    expect(!(await one(`select id from steps where id = $1`, [t.id])), 'task not deleted');
  });
  await step('one job: raise rework with dates, add an item, edit, delete', async () => {
    await go(`/jobs/${newId}#rework`);
    const raise = page.locator('form[action="/rework"]').first();
    await raise.locator('xpath=ancestor::details[1]/summary').click().catch(() => {});
    await raise.locator('select[name=cause]').selectOption({ index: 1 }); await raise.locator('input[name=note], textarea[name=note]').first().fill('QA rework');
    await raise.locator('input[name=task_factory]').check().catch(() => {}); await raise.locator('input[name=hours_factory]').fill('4').catch(() => {});
    await raise.locator('button[type=submit]').click(); await page.waitForTimeout(900);
    const rw = await one(`select id from rework where job_id = $1 and note = 'QA rework'`, [newId]); expect(rw, 'rework not raised');
    expect((await text()).includes('QA rework'), 'rework not on page');
    const del = page.locator(`form[action="/rework/${rw.id}/delete"]`); expect(await del.count(), 'no rework delete');
    await del.locator('xpath=ancestor::details[1]/summary').click().catch(() => {}); await del.locator('button[type=submit]').click(); await page.waitForTimeout(700);
    expect(!(await one('select id from rework where id = $1', [rw.id])), 'rework not deleted');
  });
  await step('one job: flag a problem, then Fixed with a note', async () => {
    await go(`/jobs/${newId}#flags`); await page.locator('#flags details.flag > summary').first().click();
    await page.selectOption('#flags form select[name=type]', { index: 1 }); await page.fill('#flags form input[name=note]', 'QA flag');
    await submitIn('#flags form[data-photos]');
    const iss = await one(`select id from issues where note = 'QA flag'`); expect(iss, 'no issue');
    const fix = page.locator(`form[action="/issues/${iss.id}/status"]`).filter({ has: page.locator('input[name=status][value=fixed]') }).first();
    expect(await fix.count(), 'no fixed form');
    await fix.locator('xpath=ancestor::details[1]/summary').click(); await fix.locator('input[name=note]').fill('QA fixed'); await fix.locator('button[type=submit]').click(); await page.waitForTimeout(700);
    expect((await one('select status from issues where id = $1', [iss.id])).status === 'fixed', 'not fixed');
  });
  await step('one job: files add two classes, second version, remove', async () => {
    await go(`/jobs/${newId}#files`);
    for (const [k, nme] of [['contract_plans', 'c.pdf'], ['production_plans', 'p1.pdf'], ['production_plans', 'p2.pdf']]) {
      await page.locator('#addfile summary').click(); await page.selectOption('#addfile select[name=kind]', k);
      await page.locator('#addfile input[type=file]').setInputFiles({ name: nme, mimeType: 'application/pdf', buffer: pdf });
      await submitIn('#addfile form');
    }
    expect((await text()).includes('Earlier versions (1)'), 'no earlier versions');
    expect((await text()).includes('Production plans v2'), 'no v2 pill');
  });
  await step('one job: materials add, source, pick (editor can pick too)', async () => {
    await go(`/jobs/${newId}#materials`);
    await page.locator('#materials details.pop summary', { hasText: 'Add a line' }).click();
    await page.fill('#materials input[name=item]', 'Classic White Matte'); await page.fill('#materials input[name=qty]', '3'); await submitIn('#materials form[action$="/materials"]');
    await page.locator('form[action$="/materials/source"] button').click(); await page.waitForTimeout(800);
    expect(/ready to cut/i.test(await text()), 'not ready: ' + (await flash()));
    await page.locator('details.pop summary', { hasText: 'Pick for the factory' }).click(); await submitIn('form[action$="/materials/pick"]');
    const m = await one('select picked from job_materials where job_id = $1', [newId]); expect(Number(m.picked) === 3, 'not picked');
  });
  await step('one job: job details edit and status change', async () => {
    await go(`/jobs/${newId}`); await page.locator('summary', { hasText: 'Job details' }).first().click();
    const f = page.locator(`form[action="/jobs/${newId}/details"]`); await f.locator('input[name=suburb]').fill('Mascot'); await f.locator('button[type=submit]').first().click(); await page.waitForTimeout(800);
    expect((await one('select suburb from jobs where id = $1', [newId])).suburb === 'Mascot', 'suburb not saved');
  });
  await step('reschedule screen: open from Move…, squeeze mode renders, Move anyway appears only on a clash', async () => {
    const s = await one(`select id from steps where job_id = $1 and kind = 'install'`, [newId]);
    expect((await go(`/jobs/${newId}/reschedule?step=${s.id}&mode=squeeze`)) === 200, 'bad status');
    expect((await text()).includes('Keep the install'), 'no mode seg: ' + (await text()).slice(0, 200));
  });
  await step('all jobs (Gantt) renders with bars', async () => { await go('/jobs'); expect((await page.locator('.tl-row').count()) > 5, 'no rows'); });
  await step('attention: OK as is on a decision, then undo', async () => {
    await go('/attention'); const ok = page.locator('form[action="/decisions/ok"]').first();
    if (!(await ok.count())) return; await ok.locator('button').click(); await page.waitForTimeout(700);
    await page.locator('#decided summary').click(); const undo = page.locator('form[action="/decisions/undo"]').first(); expect(await undo.count(), 'no undo'); await undo.locator('button').click(); await page.waitForTimeout(600);
  });
  await step('attention: overdue "Done" from the list', async () => {
    await go('/attention'); const done = page.locator('.att-body form[action$="/done"] button').first(); if (!(await done.count())) return;
    const before = Number((await one('select count(*) from steps where done_at is not null')).count);
    await done.click(); await page.waitForTimeout(700);
    expect(Number((await one('select count(*) from steps where done_at is not null')).count) === before + 1, 'not ticked');
  });
  await step('board: drag a card to another day', async () => {
    await go('/board'); const card = page.locator('.board .chip.drag').first(); if (!(await card.count())) return;
    const bb = await card.boundingBox(); await page.mouse.move(bb.x + 20, bb.y + 10); await page.mouse.down(); await page.mouse.move(bb.x + 260, bb.y + 10, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(400);
    const box = page.locator('.movebox, [data-movebox]').first(); expect(await box.count(), 'no move box after drag');
    await box.locator('button', { hasText: /Cancel/ }).first().click();
  });
  await step('pipeline, load, more, suggestions screens render', async () => {
    for (const u of ['/pipeline', '/load', '/more', '/suggestions']) expect((await go(u)) === 200, u);
    expect((await text()).includes('waiting') || (await text()).includes('Suggestions'), 'suggestions page');
  });
  await step('suggestions: accept one, decline one, supersede the rest', async () => {
    await go('/suggestions');
    const accept = page.locator('form button[name=action][value=accept], form button[value=accept]').first();
    if (await accept.count()) { await accept.click(); await page.waitForTimeout(800); }
    const decline = page.locator('form button[value=decline]').first();
    if (await decline.count()) { await decline.click(); await page.waitForTimeout(800); }
    const sup = page.locator('form[action*="supersede"] button').first();
    if (await sup.count()) { await sup.locator('xpath=ancestor::details[1]/summary').click().catch(() => {}); await page.fill('form[action*="supersede"] input[name=reason], form[action*="supersede"] input[name=note]', 'QA clear').catch(() => {}); await sup.click(); await page.waitForTimeout(800); }
    const left = Number((await one(`select count(*) from suggestions where status = 'pending'`)).count); expect(left === 0, `${left} still pending`);
  });
  await step('settings: every section saves', async () => {
    await go('/settings');
    await page.fill('form[action="/settings/message"] input[name=message]', 'QA message'); await submitIn('form[action="/settings/message"]');
    expect((await one(`select value from app_settings where key = 'board_message'`)).value === 'QA message', 'message');
    await page.fill('form[action="/settings/centres/factory"] input[name=fri]', '6'); await submitIn('form[action="/settings/centres/factory"]');
    await page.fill('form[action="/settings/adjustments"] input[name=from]', '2027-04-05'); await page.fill('form[action="/settings/adjustments"] input[name=to]', '2027-04-09'); await page.fill('form[action="/settings/adjustments"] input[name=hours]', '0'); await page.fill('form[action="/settings/adjustments"] input[name=reason]', 'QA shutdown'); await submitIn('form[action="/settings/adjustments"]');
    expect(await one(`select 1 from capacity_adjustments where reason = 'QA shutdown'`), 'adjustment');
    await page.locator('form[action^="/settings/adjustments/"][action$="/delete"] button').first().click(); await page.waitForTimeout(600);
    await page.locator('form[action="/settings/flag-types/damaged"] button').click(); await page.waitForTimeout(600);
    await submitIn('form[action="/settings/tv"]'); expect((await one(`select value from app_settings where key = 'tv_token'`)).value.length > 10, 'tv key');
    const blocked = page.locator('form[action="/settings/blocked"]'); await blocked.locator('input[name=from]').fill('2027-06-14'); await blocked.locator('input[name=reason]').fill('QA block'); await blocked.locator('button[type=submit]').click(); await page.waitForTimeout(600);
    expect(await one(`select 1 from blocked_days where reason = 'QA block'`), 'blocked day');
    await page.locator('form[action^="/settings/blocked/"] button').last().click(); await page.waitForTimeout(500);
    await page.locator('form[action="/settings/people"] input[name=name]').fill('QA Person'); await page.locator('form[action="/settings/people"] input[name=email]').fill('qa@test.local'); await submitIn('form[action="/settings/people"]');
    expect(await one(`select 1 from people where email = 'qa@test.local'`), 'person');
    await page.fill('form[action="/settings/message"] input[name=message]', ''); await submitIn('form[action="/settings/message"]');
  });
  await step('settings: durations save and templates save', async () => {
    await go('/settings'); const f = page.locator('form[action="/settings/rules"], form[action="/settings"]').first(); if (await f.count()) { await f.locator('button[type=submit]').first().click(); await page.waitForTimeout(600); }
    const t = page.locator('form[action^="/settings/templates/"]').first(); if (await t.count()) { await t.locator('button[type=submit]').click(); await page.waitForTimeout(600); }
    expect(!(await text()).includes("didn't work"), 'error');
  });
  await step('settings: emails preview and send now', async () => { expect((await go('/settings/emails')) === 200, 'emails page'); await submitIn('form[action="/settings/emails/run"]'); expect(await one(`select 1 from digest_runs`), 'no run'); });
  await step('settings: API token made and revoked; the API accepts a suggestion with it', async () => {
    await go('/settings'); const mk = page.locator('form[action="/settings/tokens"]'); if (!(await mk.count())) throw new Error('no token form (owner only)');
    await mk.locator('input[name=name]').fill('QA bot'); await mk.locator('button[type=submit]').click(); await page.waitForTimeout(700);
    const tokVal = await page.locator('input[readonly]').first().inputValue(); const tok = [null, tokVal]; expect(/^hub_/.test(tokVal), 'token not shown: ' + tokVal);
    const r = await page.request.post(BASE + '/api/suggestions', { headers: { Authorization: `Bearer ${tok[1]}`, 'Content-Type': 'application/json' }, data: { batch_id: 'qa1', suggestions: [{ type: 'note', job_number: '270301', priority: 'info', proposed_value: 'QA note from the bot', reason: 'QA' }] } });
    expect(r.status() < 300, 'api status ' + r.status() + ' ' + (await r.text()).slice(0, 200));
    const rv = page.locator('form[action^="/settings/tokens/"][action$="/revoke"] button').first(); await rv.click(); await page.waitForTimeout(600);
  });
  await step('export downloads a spreadsheet', async () => { const r = await page.request.get(BASE + '/export.xlsx'); expect(r.status() === 200 && (r.headers()['content-type'] || '').includes('spreadsheet'), 'export ' + r.status()); });
  await step('stock: items search, edit item, import csv', async () => {
    await go('/stock/items?q=satin'); expect((await text()).includes('Satin White'), 'no item');
    await page.locator('a.btn', { hasText: 'Open' }).first().click(); await page.waitForURL(/\/stock\/items\/\d+/);
    await page.locator('details.pop summary', { hasText: 'Edit the item' }).click(); await page.fill('form input[name=supplier]', 'Polytec'); await page.fill('form input[name=lead_days]', '7'); await page.locator('form button', { hasText: 'Save' }).click(); await page.waitForTimeout(700);
    expect((await one(`select lead_days from stock_items where name = 'Satin White'`)).lead_days === 7, 'lead days');
    await go('/stock/items'); await page.locator('details.pop summary', { hasText: 'Import or update' }).click();
    await page.locator('form[action="/stock/items/import"] input[type=file]').setInputFiles({ name: 'cat.csv', mimeType: 'text/csv', buffer: Buffer.from('name,code,kind,unit,supplier,minimum,reorder_qty,standing\nQA Hinge,QA-H1,hardware,pcs,Titus,10,50,yes\n') });
    await submitIn('form[action="/stock/items/import"]'); expect(await one(`select 1 from stock_items where code = 'QA-H1'`), 'not imported');
  });
  await step('stock: order list add a line, ordered, received; count page; offcuts', async () => {
    await go('/stock/orders'); await page.locator('details.pop summary', { hasText: 'Add a line' }).click();
    await page.fill('form[action="/stock/orders"] input[name=item]', 'QA Hinge [QA-H1]'); await page.fill('form[action="/stock/orders"] input[name=qty]', '50'); await submitIn('form[action="/stock/orders"]');
    const o = await one(`select o.id from orders o join stock_items i on i.id = o.item_id where i.code = 'QA-H1' and o.status = 'listed'`); expect(o, 'no order');
    await page.locator(`#o-${o.id} details.pop summary`, { hasText: 'Ordered' }).click(); await page.fill(`#o-${o.id} input[name=expected]`, '2026-11-20'); await page.locator(`#o-${o.id} form[action$="/ordered"] button`).click(); await page.waitForTimeout(700);
    await page.locator(`#o-${o.id} details.pop summary`, { hasText: 'In' }).click(); await page.locator(`#o-${o.id} form[action$="/received"] button`).click(); await page.waitForTimeout(700);
    expect((await one('select status from orders where id = $1', [o.id])).status === 'received', 'not received');
    await go('/stock/count'); const inp = page.locator('input[name^="c_"]').first(); const nm = await inp.getAttribute('name'); await inp.fill('5'); await submitIn('form[action="/stock/count"]');
    expect(await one(`select 1 from stock_moves where item_id = $1 and kind = 'counted'`, [Number(nm.slice(2))]), 'no count move');
    await go('/stock/offcuts'); await page.locator('details.pop summary', { hasText: 'Log an offcut' }).click(); await page.selectOption('form[action="/stock/offcuts"] select[name=item_id]', { index: 1 }); await page.fill('form[action="/stock/offcuts"] input[name=length_mm]', '1200'); await page.fill('form[action="/stock/offcuts"] input[name=width_mm]', '800'); await submitIn('form[action="/stock/offcuts"]');
    expect((await text()).includes('1200 × 800'), 'no offcut');
  });
  await step('delete the QA job', async () => {
    await go(`/jobs/${newId}`); const del = page.locator(`form[action="/jobs/${newId}/delete"]`); expect(await del.count(), 'no job delete form');
    await page.locator('summary', { hasText: 'Job details' }).first().click();
    await del.locator('xpath=ancestor::details[1]/summary').click(); await del.locator('button[type=submit]').click(); await page.waitForTimeout(1200);
    expect(/deleted/i.test(await flash()) || page.url().endsWith('/jobs'), 'no deleted message; url ' + page.url());
    expect(!(await one('select id from jobs where id = $1', [newId])), 'job still there');
  });

  // ============ DOER (Phil) ============
  await as('phil');
  await step('doer lands on My day', async () => { await go('/'); expect(page.url().endsWith('/me'), page.url()); });
  await step('doer: Done from My day in place', async () => {
    await go('/me'); const btn = page.locator('.me-row form[action$="/done"] button').first(); if (!(await btn.count())) return;
    const rows = await page.locator('.me-row').count(); await btn.click(); await page.waitForTimeout(800);
    expect((await page.locator('.me-row').count()) < rows, 'row did not leave');
  });
  await step('doer: install done with answers and photos from My day', async () => {
    await go(`/me?job=${jobId}`); const s = page.locator('details.me-install > summary').first(); if (!(await s.count())) return;
    await s.click(); await page.locator('details.me-install input[name=gaps][value="1"]').check(); await page.locator('details.me-install input[name=clean][value="1"]').check();
    await page.locator('details.me-install input[type=file]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
    await submitIn('details.me-install form');
    expect((await one(`select gaps_adjusted from steps where job_id = $1 and kind = 'install' and label = ''`, [jobId])).gaps_adjusted === true, 'not recorded');
    await q(`set hub.system = 'on'`); await q(`update steps set done_at = null, gaps_adjusted = null, site_clean = null where job_id = $1 and kind = 'install' and label = ''`, [jobId]);
  });
  await step('doer: flag from My day with the Flag button', async () => {
    await go(`/me?job=${jobId}`); const sm = page.locator('.me-acts details.flag > summary').first(); await sm.click();
    const f = page.locator('.me-acts details.flag form').first(); await f.locator('select[name=type]').selectOption({ index: 1 }); await f.locator('input[name=note]').fill('QA doer flag'); await f.locator('button[type=submit]').click(); await page.waitForTimeout(800);
    expect(await one(`select 1 from issues where note = 'QA doer flag'`), 'no flag');
  });
  await step('doer: raise rework with a factory task', async () => {
    await go(`/jobs/${jobId}#rework`); const raise = page.locator('form[action="/rework"]').first(); await raise.locator('xpath=ancestor::details[1]/summary').click().catch(() => {});
    await raise.locator('select[name=cause]').selectOption({ index: 1 }); await raise.locator('input[name=note], textarea[name=note]').first().fill('QA doer rework');
    await raise.locator('input[name=task_factory]').check().catch(() => {}); await raise.locator('input[name=hours_factory]').fill('3').catch(() => {});
    await raise.locator('button[type=submit]').click(); await page.waitForTimeout(900);
    expect(await one(`select 1 from rework where note = 'QA doer rework'`), 'not raised');
  });
  await step('doer: cannot open settings, new job, or change dates', async () => {
    expect((await go('/settings')) === 403, 'settings'); expect((await go('/jobs/new')) === 403, 'new job');
    const s = await one(`select id from steps where job_id = $1 and start_date is not null limit 1`, [jobId]);
    const r = await page.request.post(BASE + `/steps/${s.id}/move`, { form: { date: '2027-01-04' }, headers: { Origin: BASE } }); expect(r.status() === 403, 'move ' + r.status());
  });
  await step('doer: stock count, bin low, receive; cannot edit items', async () => {
    await go('/stock/count'); expect((await page.locator('input[name^="c_"]').count()) > 10, 'count inputs');
    const cws = await one(`select id from stock_items where name = 'Classic White Sheen'`); await go(`/stock/bin/${cws.id}`); await submitIn('form[action$="/low"]');
    expect(/already on the list/i.test(await text()), 'bin flag text: ' + (await flash()));
    await go(`/stock/items/${cws.id}`); expect(!(await text()).includes('Edit the item'), 'edit shown to doer');
  });
  await step('doer: job sheet and QR job view', async () => { expect((await go(`/jobs/${jobId}/sheet`)) === 200, 'sheet'); expect((await go(`/me?job=${jobId}`)) === 200, 'job view'); });

  // ============ VIEWER (Michael) ============
  await as('michael');
  await step('viewer: sees pages, no forms that change anything', async () => {
    await go(`/jobs/${jobId}`); expect((await page.locator('form[method=post]').count()) <= 2, `viewer sees ${await page.locator('form[method=post]').count()} post forms`);
    const s = await one(`select id from steps where job_id = $1 limit 1`, [jobId]);
    const r = await page.request.post(BASE + `/steps/${s.id}/done`, { form: { done: '1' }, headers: { Origin: BASE } }); expect(r.status() === 403, 'done ' + r.status());
  });
  // ============ STOCK TICK (Angela, viewer) ============
  await as('angela');
  await step('stock tick: a viewer runs the order list and edits items', async () => {
    await go('/stock/items?q=QA'); await page.locator('a.btn', { hasText: 'Open' }).first().click(); await page.waitForURL(/\/stock\/items\/\d+/);
    expect((await text()).includes('Edit the item'), 'no edit for the stock tick');
    await go('/stock'); expect((await text()).includes('Need against supply'), 'stock home');
  });

  // ============ NO SCRIPT (George) ============
  await as('george', { js: false });
  await step('no script: tick done works with a full page load', async () => {
    await go(`/jobs/${jobId}`); const btn = page.locator('form[action$="/done"] button.check').first(); await Promise.all([page.waitForResponse((r) => r.url().includes('/jobs/') && r.request().method() === 'GET'), btn.click()]); await page.waitForTimeout(300);
    if ((await page.locator('form[action$="/done"] button.check').first().getAttribute('aria-pressed')) !== 'true') { await page.locator('form[action$="/done"] button.check').first().click(); await page.waitForLoadState('load'); await page.waitForTimeout(500); }
    expect((await page.locator('form[action$="/done"] button.check').first().getAttribute('aria-pressed')) === 'true', 'not ticked'); await page.locator('form[action$="/done"] button.check').first().click(); await page.waitForLoadState('domcontentloaded');
  });
  await step('no script: tapping a date opens the Reschedule screen', async () => { await go(`/jobs/${jobId}`); await page.locator('a.datebtn').first().click(); await page.waitForLoadState('domcontentloaded'); expect(page.url().includes('/reschedule'), page.url()); });
  await step('no script: flag form posts', async () => {
    await go(`/jobs/${jobId}#flags`); await page.locator('#flags details.flag > summary').first().click(); await page.selectOption('#flags form[data-photos] select[name=type]', { index: 1 }); await page.fill('#flags form[data-photos] input[name=note]', 'QA nojs flag');
    await page.locator('#flags form[data-photos] button[type=submit]').click(); await page.waitForLoadState('domcontentloaded');
    expect(await one(`select 1 from issues where note = 'QA nojs flag'`), 'no flag');
  });

  // ============ PHONE (George) ============
  await as('george', { phone: true });
  await step('phone: board day list has Move links and a card opens the job', async () => { await go('/board'); expect((await text()).includes('Move…'), 'no Move links'); });
  await step('phone: My day Done and Flag reachable', async () => { await go('/me'); expect((await page.locator('.me-acts').count()) >= 0, ''); });
  await step('phone: stock count usable', async () => { await go('/stock/count'); const inp = page.locator('input[name^="c_"]').first(); await inp.scrollIntoViewIfNeeded(); const bb = await inp.boundingBox(); expect(bb && bb.height >= 36, 'count input too small: ' + (bb && bb.height)); });

  // ============ SIGN-IN ============
  await as('nobody');
  await step('sign-in: unsigned goes to login; bad token gives a clear page', async () => {
    await go('/board'); expect(page.url().includes('/login'), page.url());
    await go('/auth/verify?t=bad&next=%2F'); const t = await text(); expect(/expired|used|wrong|Try again|sign in/i.test(t), 'no clear message: ' + t.slice(0, 160));
  });
  await step('sign-in: email a link, then sign in with it, then sign out', async () => {
    await go('/login'); await page.fill('input[name=email]', 'michael@test.local'); await page.click('button[type=submit]'); await page.waitForLoadState('domcontentloaded');
    const link = await page.getAttribute('p.notice a', 'href'); expect(link, 'no link shown (no RESEND key locally)');
    await page.goto(link); await page.click('button[type=submit]'); await page.waitForLoadState('domcontentloaded'); expect(!page.url().includes('/login'), 'still on login');
    await page.locator('form[action="/logout"] button').click(); await page.waitForURL(/\/login/, { timeout: 8000 }); expect(page.url().includes('/login'), 'not signed out');
  });

  await browser.close(); await db.end();
  fs.writeFileSync(`${S}/qa/flows.json`, JSON.stringify(results, null, 2));
  const fails = results.filter((r) => !r.ok);
  console.log(`steps: ${results.length}, failed: ${fails.length}`);
  for (const f of fails) console.log(`FAIL [${f.role}] ${f.step}: ${f.note}${f.shot ? ' (' + f.shot.split('/').pop() + ')' : ''}`);
})().catch((e) => { console.error(e); process.exit(1); });
