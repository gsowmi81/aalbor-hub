# Browser QA scripts (7 Nov 2026)

Not part of `npm test`. They drive a running local hub in a real browser (Playwright) as each role and
report what broke. Used for the QA round on the preview branch; keep them for the next one.

Set-up, once, against the local dev database:

```
psql ... hub_dev  # one person per role, then a session per person whose token is "qa-<name>":
#   insert into sessions (token_hash, person_id, expires_at) values (encode(sha256('qa-phil'), 'hex'), <id>, now() + interval '2 days');
npm run build && HUB_PREVIEW=1 node dist/src/server.js
```

Then, with `S` pointing at a folder for screenshots and `OUT` at a report file:

- `node scripts/qa/crawl.cjs` — every GET link as every role, desktop, phone and with script off: 4xx/5xx, page errors, sideways scroll, small tap targets.
- `node scripts/qa/flows.cjs` — 50 scripted workflows (new job, ticks, moves, pins, tasks, rework, flags, files, materials, settings, suggestions, stock, TV, sign-in), each step pass or fail with a screenshot on failure.
- `node scripts/qa/abuse.cjs` — bad input, cross-site posts, oversized uploads, hostile text, double submits, API without a token.
- `node scripts/qa/axe.cjs` — axe-core accessibility scan of the main screens, desktop and phone.
- `node scripts/qa/keys.cjs` — keyboard walk of the job page: focus rings, Enter on popovers, Escape on the move box.

The scripts expect `OUT`/`S` environment variables and a hub at http://localhost:3000.
