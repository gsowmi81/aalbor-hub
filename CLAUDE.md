# Aalbor Hub

Production planning (Phase 1, live) and stock control (Phase 2, not built yet) for Aalbor Kitchens, Botany, Sydney. It replaces Jobman for those two jobs only. Owner: George Sowmi (Managing Director).

- Build brief, 28 Oct 2026: https://claude.ai/artifact/Y6n8ZD3JvPcS8CiHcQuD88
- Approved mock-up (the look to match): https://claude.ai/artifact/HBbUtp5Vc858fJDH2RnK1K
- Approved build plan, with George's answers: `docs/build-plan.html` (phone copy https://claude.ai/artifact/MNiU6BvSXjJ8dj8GHgw1AW)
- Setting it up on Render, email, domain and backups: `docs/setup.md`

## Never put these in the hub

Invoicing, purchase orders, payments, job costing, timesheets, stock valuation. Xero, Buildertrend and Cabinet Vision keep them. The one dollar figure allowed is the rough extra material cost when a rework is closed (George confirmed 28 Oct 2026). Also never store client phone numbers, emails or street addresses; they stay in Buildertrend.

## Writing

Australian English. Dates shown as `DD Mon YYYY` (`fmtLong`), or `Thu 04 Feb` on the board (`fmtShort`). Plain, short copy; name things the way the team does (Check measure, Production drawings, Doors to painting). The painter is "the painter" or "painting", never "A1 Poly".

## Stack

Node 22, TypeScript, Express 5, Postgres 16 (`pg`). Pages are rendered on the server from template functions; `public/hub.js` only adds conveniences and every screen works without it. No front-end framework, no ORM. Hosted on Render (Blueprint in `render.yaml`): web service, Postgres, nightly backup cron (`backup/`). Sign-in emails through Resend.

## Layout

```
migrations/001_schema.sql   tables, role checks (hub_guard), change log (hub_log), settings, NSW holidays
migrations/002_*.sql        painting as its own tick; fixed five Polytec jobs
migrations/003_*.sql        job templates, Owner flag, owners-only rework_responsible + owners_log (row-level security)
src/config.ts               every setting, from the environment
src/db/pool.ts              withPerson() / withSystem(): the only ways to write
src/db/queries.ts           reads, history, syncStepSet()
src/db/migrate.ts           applies migrations/*.sql once each; adds INITIAL_EDITOR_EMAIL as an Editor
src/domain/dates.ts         working-day calendar, date formats
src/domain/steps.ts         step kinds, board rows, owners, proposeDates(), shiftStep()
src/domain/schedule.ts      DEPENDENCIES, violations(), reschedule() (shift / squeeze / only), proposeFromAnchor() for templates
src/domain/checks.ts        overdue(), needsDecision(), capacity(), nextUp()
src/web/auth.ts             emailed-link sign-in, sessions, role courtesy checks
src/web/routes.ts           every screen and form handler
src/web/export.ts           spreadsheet download
src/views/*.ts              the screens (reschedule.ts is the Reschedule screen); public/hub.css is the mock-up's look
scripts/import-notion.ts    one-off load of data/notion-snapshot-2026-10-28.json
test/                       vitest: dates, checks, schedule, permissions and app end to end (real Postgres, as the ordinary user hub_app: see test/db-setup.ts)
```

## Rules that matter

- **Roles live in the database.** `hub_guard()` runs before every insert, update and delete on the business tables. Editor: anything. Doer: tick steps done (plus a note) and raise rework, nothing else. Viewer: nothing. The app tells Postgres who is acting with `withPerson(id, ...)`. `withSystem()` is for migrations, the Notion import and sign-in only; never use it in a request handler for business data. `requireRole()` in the routes is a courtesy so people get a clear page; the database is the real check.
- **Change log.** `hub_log()` writes every change (who, when, before, after) to `change_log`, which can't be edited or deleted. The One job screen's History reads it. New business tables need both triggers: add the table name to the loop in the migration pattern.
- **Dates.** All dates are `YYYY-MM-DD` strings; Postgres `date` is parsed as a string (`pool.ts`). Working days skip weekends and `blocked_days` (scope `all` for everyone, `factory` for factory steps only). Rules and defaults are in `steps.ts` (`proposeDates`) and the `settings` table; the plan's worked example is a test in `test/dates.test.ts`, so a rule change that breaks it is deliberate or a bug.
- **Provisional vs confirmed.** New jobs get proposed dates, all provisional (`confirmed = false`, drawn faded and dashed). Christine ticks Confirmed when a date matches Buildertrend. Imported Notion dates came in confirmed.
- **Needs a decision.** Rules in `checks.ts`. "OK as is" saves a row in `decisions` with a fingerprint of the dates it was judged on; if those dates change, the item shows again.
- **Capacity** is measured in job-days: factory days booked in a week against kitchens a week × default factory days (2 × 2 = 4). Install the same with install days. Check measures: count per day. George may later say he meant a plain count of kitchens; that's a change to `capacity()` only.
- **Painting** is its own tick on a job (`has_painting`, George, 30 Oct 2026), separate from door finish. It adds the Doors to painting and Doors back steps and the extra install week (`install_weeks_poly`). Choosing Polyurethane ticks it in the form; it can be unticked. Migration 002 also fixed five Polytec melamine jobs the first import had loaded as polyurethane.
- **Deleting** (Editors): a rework (with its steps), a rework step or an extra named step, and a whole job added by mistake. Standard steps can't be deleted; clear their dates or untick Painting or Stone. People are switched off, never deleted, so history keeps their names. Every delete is in the change log. The page asks "Yes, delete" itself because the browser confirm box isn't used.
- **Keeping your place:** `public/hub.js` puts the page back at the same scroll position after any form post; without it, the form's `back` anchor (`#c-<step id>`) lands near the item.
- **Dependencies** (George, 30 Oct 2026; `DEPENDENCIES` in `schedule.ts`): finish-to-start, same day allowed unless the lag says otherwise. Check measure → drawings → (soft) materials ordered → materials in → factory → doors to painting → doors back → delivery (also after factory) → install → stone measure (next working day) → stone install (next working day). Materials ordered early only warns. Done steps never move and never count. Broken hard rules show in Needs a decision (`dep:` keys).
- **Reschedule screen** (`/jobs/:id/reschedule?step=&start=&mode=`): every date move by an Editor goes through it: dragging a bar on All jobs (mouse; tap on phones), Overdue "New date", a "Move…" link on each date, and a single date change on the job's dates form. Modes: `shift` (default, every dependent step by the same working days; delivery travels with install), `squeeze` (hold install and later, push the steps between only as far as the rules force, using spare days first), `only`. Every row is editable; a hard clash needs **Move anyway**. Moved dates become provisional. The shift buttons and the dates form with several changes still save directly.
- **Templates** (`job_templates`, Settings → Job types): "Kitchen, polyurethane painted doors" and "Kitchen, melamine doors" (George, 30 Oct 2026). They set door finish, painting, stone, factory and install days, and install weeks after site start (the old `install_weeks_*` settings moved here). The New job form takes one date (site start, check measure, drawings start or install start) and `proposeFromAnchor()` fills the rest; a blank site start is worked out backwards.
- **Owners only: who was responsible** (George, 30 Oct 2026). `people.is_owner` (George and Gus, set by migration 003 by email; owners can tick it for others in Settings). `rework_responsible` and `owners_log` have row-level security: the database returns nothing to non-owners and refuses their writes, so read them only through `withPerson()` (`loadResponsible()`). They are deliberately not in `change_log`, the job History or the spreadsheet. Only an owner can make someone an owner or change an owner's own record (`hub_owner_guard`), so an Editor can't take over an owner's sign-in. RLS doesn't apply to superusers: `migrate` logs a WARNING if the database user is one. Never show the field, its tally or the word "Owners only" to anyone else, Christine included.
- **Steps.** One standard step of each kind per job (`label = ''`). Extra named steps on a row (Tesoriero's "Install painted doors") carry a label. Rework steps are `kind = 'rework'` with a `rework_id`.
- **Who ticks what** (George, 28 Oct 2026): Christine ticks Materials ordered; a shared factory sign-in (Doer) ticks Materials in, Doors back from painting and Delivery; Gus and Phil are Doers; Angela and Michael are Viewers.

## Run it locally

```
npm install
cp .env.example .env          # edit DATABASE_URL if your Postgres differs
npm run migrate:dev
npm run import:notion:dev     # optional: the 18 jobs from Notion
npm run dev                   # http://localhost:3000
```
With no `RESEND_API_KEY`, the sign-in link prints in the console and on the page.

In a Claude Code cloud session there is no Postgres service; start one (as root):
```
mkdir -p /var/tmp/hubpg && chown postgres:postgres /var/tmp/hubpg
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/tmp/hubpg/data -U postgres --auth=trust"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/hubpg/data -l /var/tmp/hubpg/log -o '-p 5433 -k /var/tmp/hubpg' start"
psql -h /var/tmp/hubpg -p 5433 -U postgres -c "create database hub_dev" -c "create database hub_test"
```

## Checks before every push

```
npm run typecheck && npm test && npm run build
```
Tests use `TEST_DATABASE_URL` (default: the local cluster above) and wipe that database. GitHub Actions runs the same on every push (`.github/workflows/ci.yml`).

## Changing the database

Add `migrations/002_what.sql`; never edit a migration that has run on Render. Migrations run as the system before each deploy (`preDeployCommand`). Seeding or fixing data in a migration is fine; it is logged as "System".

## What's live (29 Oct 2026)

Render workspace "Quote-Desk" (Quote Desk lives there too: never touch it). Blueprint `aalbor-hub` on branch `main`, all in Singapore: web service `aalbor-hub` (https://hub.aalborkitchens.com.au; also answers on https://aalbor-hub.onrender.com), Postgres `aalbor-hub-db`, cron `aalbor-hub-backup` (nightly dump to the Cloudflare R2 bucket `aalbor-hub-backups`, kept 90 days). The Notion import has run. DNS is at Crazy Domains; Resend uses Forge CNAMEs on `send` and `rsend`. Leave the existing Microsoft 365, Mailgun/LeadConnector and site records alone. Secrets: `RESEND_API_KEY` on the web service; the R2 keys only on the cron job.

## Dependencies

`npm audit --omit=dev` must stay at 0. `uuid` is pinned to 11.1.1 through `overrides` (exceljs pulls in an older one). The remaining `npm audit` findings are inside vitest, a test-only tool that never runs in the live hub; vitest 4 can't be installed with npm 10.9 (an npm peer-dependency bug), so move to it when npm is updated.

## Deploying

Push to `main`. Render builds, runs `npm run migrate`, then starts the new version. Secrets live only on Render's Environment pages; never in the repository or in chat.

## Phase 2 (Stock), not started

Starts after 2 to 3 weeks of Phase 1 use. Brief section 6: always-stocked boards with minimums, bought-to-order boards, sheet counts per job from Cabinet Vision, 6-week board demand by factory date, standard-range hardware two-bin "running low", per-job hardware, Angela's Monday order list grouped by supplier, offcuts, Phil's Friday count. Load the 183 stock lines from Notion. No stock valuation.
