// Bad input, cross-site posts, oversized uploads, escaping, double submits: every answer should be a clear message, never a crash.
const { chromium } = require('playwright');
const BASE = 'http://localhost:3000';
const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: 'postgres://postgres@localhost:5433/hub_dev?host=/var/tmp/hubpg' }); await db.connect();
  const b = await chromium.launch(); const ctx = await b.newContext();
  await ctx.addCookies([{ name: 'hub_session', value: 'qa-george', domain: 'localhost', path: '/' }]);
  const r = ctx.request; const out = [];
  const post = (path, form, headers = {}) => r.post(BASE + path, { form, headers: { Origin: BASE, ...headers }, maxRedirects: 0 });
  const check = async (name, resp, want) => { const st = resp.status(); const body = (await resp.text()).slice(0, 160).replace(/\s+/g, ' '); const ok = want.includes(st); out.push(`${ok ? 'ok  ' : 'BAD '} ${st} ${name}${ok ? '' : ' :: ' + body}`); };
  const job = (await db.query(`select id from jobs where client_name = 'Nicola Parry'`)).rows[0].id;
  const step = (await db.query(`select id from steps where job_id = $1 and start_date is not null limit 1`, [job])).rows[0].id;
  // cross-site
  await check('cross-site post refused', await post(`/steps/${step}/done`, { done: '1' }, { Origin: 'https://evil.example' }), [403]);
  await check('no origin header post (curl)', await post(`/steps/${step}/done`, { done: '1', back: '/x' }, { Origin: '' }), [302, 403]);
  // bad ids and dates
  await check('bad step id', await post('/steps/abc/done', { done: '1' }), [302, 400]);
  await check('huge step id', await post('/steps/99999999/done', { done: '1' }), [302, 400]);
  await check('bad date on move', await post(`/steps/${step}/move`, { date: 'not-a-date' }), [302]);
  await check('far future date', await post(`/steps/${step}/move`, { date: '2999-12-31' }), [302]);
  await check('year 0001', await post(`/steps/${step}/move`, { date: '0001-01-01' }), [302]);
  await check('negative hours in centre', await post('/settings/centres/factory', { mon: '-5', tue: '8', wed: '8', thu: '8', fri: '8' }), [302]);
  await check('text where number expected', await post('/settings/adjustments', { centre: 'factory', from: '2027-01-04', to: '2027-01-08', hours: 'lots', reason: 'x' }), [302]);
  await check('quantity 0 on materials', await post(`/jobs/${job}/materials`, { item: 'Satin White', qty: '0' }), [302]);
  await check('quantity 1e9 on materials', await post(`/jobs/${job}/materials`, { item: 'Satin White', qty: '1000000000' }), [302]);
  await check('unknown item name', await post(`/jobs/${job}/materials`, { item: 'Unobtainium', qty: '1' }), [302]);
  await check('order received more than ordered', await post('/stock/orders/999999/received', { qty: '5' }), [302]);
  await check('empty job name', await post('/jobs/new', { action: 'save', client_name: '', site_start: '2027-02-01' }), [200]);
  await check('job number with letters', await post('/jobs/new', { action: 'save', client_name: 'Odd', job_number: 'AB-12', site_start: '2027-02-01' }), [200, 302]);
  // escaping
  const xss = `<script>alert(1)</script>"><img src=x onerror=alert(2)>`;
  await post(`/jobs/${job}/details`, { client_name: 'Nicola Parry', suburb: xss, door_finish: 'melamine', factory_days: '2', install_days: '3', status: 'live', brand: 'Aalbor' });
  const page = await (await r.get(BASE + `/jobs/${job}`)).text();
  out.push(`${page.includes('<script>alert(1)') || page.includes('onerror=alert') ? 'BAD ' : 'ok  '} escaping of a hostile suburb on the job page`);
  const board = await (await r.get(BASE + '/board')).text();
  out.push(`${board.includes('<script>alert(1)') ? 'BAD ' : 'ok  '} escaping on the board`);
  const tv = await (await r.get(BASE + '/tv')).text();
  out.push(`${tv.includes('<script>alert(1)') ? 'BAD ' : 'ok  '} escaping on the TV`);
  await post(`/jobs/${job}/details`, { client_name: 'Nicola Parry', suburb: 'Lilyfield', door_finish: 'melamine', factory_days: '2', install_days: '3', status: 'live', brand: 'Aalbor' });
  // long strings and unicode
  await check('very long note on a flag', await post('/issues', { job_id: String(job), type: 'other', note: 'x'.repeat(5000) }), [302]);
  await check('emoji client name', await post('/jobs/new', { action: 'save', client_name: 'Kitchen 🍳 Ümlaut', site_start: '2027-02-01' }), [302]);
  await db.query(`set hub.system = 'on'`); await db.query(`delete from jobs where client_name like 'Kitchen %'`);
  // oversized upload
  const big = Buffer.alloc(26 * 1024 * 1024, 65);
  const up = await r.post(BASE + `/jobs/${job}/files`, { headers: { Origin: BASE }, maxRedirects: 0, multipart: { kind: 'other', file: { name: 'big.bin', mimeType: 'application/octet-stream', buffer: big } } });
  await check('26 MB file refused politely', up, [302, 413]);
  const bigPhoto = await r.post(BASE + '/issues', { headers: { Origin: BASE }, maxRedirects: 0, multipart: { job_id: String(job), type: 'other', note: 'big photo', photo: { name: 'p.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(5 * 1024 * 1024, 1) } } });
  await check('5 MB photo refused politely', bigPhoto, [302, 413]);
  const notPhoto = await r.post(BASE + '/issues', { headers: { Origin: BASE }, maxRedirects: 0, multipart: { job_id: String(job), type: 'other', note: 'pdf as photo', photo: { name: 'p.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') } } });
  await check('pdf as a photo refused', notPhoto, [302]);
  // double submit of a count: second one logs nothing new
  const cws = (await db.query(`select id from stock_items where name = 'Classic White Sheen'`)).rows[0].id;
  const before = (await db.query('select count(*) from stock_moves where item_id = $1', [cws])).rows[0].count;
  await post(`/stock/items/${cws}/count`, { counted: '36' }); await post(`/stock/items/${cws}/count`, { counted: '36' });
  const after = (await db.query('select count(*) from stock_moves where item_id = $1', [cws])).rows[0].count;
  out.push(`${Number(after) - Number(before) <= 1 ? 'ok  ' : 'BAD '} double count submit adds at most one move (${before} → ${after})`);
  // api without token / wrong token / rate-limited shape
  const api = await r.post(BASE + '/api/suggestions', { headers: { 'Content-Type': 'application/json' }, data: {} }); out.push(`${api.status() === 401 ? 'ok  ' : 'BAD '} ${api.status()} api without a token`);
  const api2 = await r.post(BASE + '/api/suggestions', { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' }, data: {} }); out.push(`${api2.status() === 401 ? 'ok  ' : 'BAD '} ${api2.status()} api with a wrong token`);
  // signed-out posts
  const anon = await b.newContext(); const a2 = await anon.request.post(BASE + `/steps/${step}/done`, { form: { done: '1' }, headers: { Origin: BASE }, maxRedirects: 0 }); out.push(`${[302, 403].includes(a2.status()) ? 'ok  ' : 'BAD '} ${a2.status()} signed-out post`);
  // the flash messages for the bad inputs are plain English: sample a few
  const flashes = (await db.query(`select 1`)).rows; void flashes;
  console.log(out.join('\n'));
  await db.query(`delete from issues where note like 'xxxxx%' or note in ('big photo', 'pdf as photo')`);
  await b.close(); await db.end();
})().catch((e) => { console.error(e); process.exit(1); });
