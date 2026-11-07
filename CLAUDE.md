# Aalbor Hub

Production planning (Phase 1, live) and stock control (Phase 2, not built yet) for Aalbor Kitchens, Botany, Sydney. It replaces Jobman for those two jobs only. Owner: George Sowmi (Managing Director).

- Build brief, 28 Oct 2026: https://claude.ai/artifact/Y6n8ZD3JvPcS8CiHcQuD88
- Approved mock-up (the look to match): https://claude.ai/artifact/HBbUtp5Vc858fJDH2RnK1K
- Approved build plan, with George's answers: `docs/build-plan.html` (phone copy https://claude.ai/artifact/MNiU6BvSXjJ8dj8GHgw1AW)
- Setting it up on Render, email, domain and backups: `docs/setup.md`
- The preview copy (a second Render service on the working branch, George, 7 Nov 2026): `docs/preview.md`
- Jobman teardown and step-change recommendations, 6 Nov 2026: `docs/jobman-review.html` (phone copy https://claude.ai/artifact/8QDv1FFbmtRwQtWSAGfubV)

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
migrations/004_*.sql        search_path pinned on trigger/RLS functions (backups)
migrations/005_*.sql        suggestions, api_tokens, api_calls, app_settings (text settings), change_log.suggestion_id
migrations/006_*.sql        rework tasks: steps.rework_area + steps.hours, rework settings, Doers may add undated tasks to their own rework
migrations/007_*.sql        rework items can sit in any board row (rework_area widened to every category)
migrations/008_*.sql        suggestions.decided_by_token; token and Editors may supersede pending suggestions with a reason
migrations/009_*.sql        the preview round: steps.pinned, people.areas, jobs.drawings_url, app_settings.board_message
migrations/010_*.sql        round two: labour_centres + capacity_adjustments (hours), issues + issue_types + issue_photos (flags), people.email_digest, digest_runs
migrations/011_*.sql        round three: steps.gaps_adjusted + steps.site_clean and step_photos (install done with photos)
src/config.ts               every setting, from the environment
src/db/pool.ts              withPerson() / withSystem() / withToken(): the only ways to write
src/db/queries.ts           reads, history, syncStepSet()
src/db/edits.ts             the shared writes (step dates, confirmed, done, job status, new job) used by the screens and by accepted suggestions
src/db/suggestions.ts       checking what the bot sends, decide() (accept / decline / Buildertrend is wrong)
src/db/migrate.ts           applies migrations/*.sql once each; adds INITIAL_EDITOR_EMAIL as an Editor
src/domain/dates.ts         working-day calendar, date formats
src/domain/steps.ts         step kinds, board rows, owners, proposeDates(), shiftStep()
src/domain/schedule.ts      DEPENDENCIES, violations(), reschedule() (shift / squeeze / only), proposeFromAnchor() for templates
src/domain/checks.ts        overdue(), needsDecision(), capacity(), nextUp()
src/web/auth.ts             emailed-link sign-in, sessions, role courtesy checks
src/web/routes.ts           every screen and form handler
src/web/api.ts              /api for the bot: Bearer token, rate limit, call log, suggestions email
src/web/export.ts           spreadsheet download
src/web/upload.ts           multipart forms (photos on a flag), busboy
src/web/nudges.ts           the emails: overdue, your week, flags, materials in; the 7 am scheduler and digest_runs
src/views/*.ts              the screens: comingUp.ts is the Board, attention.ts, pipeline.ts, me.ts (My day, and one job from the job sheet), job.ts, jobs.ts (the Gantt), load.ts,
                            reschedule.ts, items.ts (overdue and decision items shared by Attention and the job), issues.ts (flags), install.ts (install done with photos),
                            sheet.ts (the printable job sheet with its QR code), other.ts (New job, Rework, More, Find, Settings);
                            public/hub.css is the mock-up's look
docs/preview.md             the preview copy on Render: set-up, data rules, cutover
scripts/import-notion.ts    one-off load of data/notion-snapshot-2026-10-28.json
scripts/seed-suggestions.ts example suggestions, local copies only (npm run seed:suggestions:dev)
test/                       vitest: dates, checks, schedule, permissions, suggestions and app end to end (real Postgres, as the ordinary user hub_app: see test/db-setup.ts)
```

## Rules that matter

- **Roles live in the database.** `hub_guard()` runs before every insert, update and delete on the business tables. Editor: anything. Doer: tick steps done (plus a note) and raise rework, including its tasks (undated, unconfirmed, only on an open rework they raised: migration 006), nothing else. Viewer: nothing. The app tells Postgres who is acting with `withPerson(id, ...)`. `withSystem()` is for migrations, the Notion import, sign-in and the API's own bookkeeping (token last used, call log) only; never use it in a request handler for business data. `requireRole()` in the routes is a courtesy so people get a clear page; the database is the real check.
- **Change log.** `hub_log()` writes every change (who, when, before, after) to `change_log`, which can't be edited or deleted. The One job screen's History reads it. New business tables need both triggers: add the table name to the loop in the migration pattern.
- **Dates.** All dates are `YYYY-MM-DD` strings; Postgres `date` is parsed as a string (`pool.ts`). Working days skip weekends and `blocked_days` (scope `all` for everyone, `factory` for factory steps only). Rules and defaults are in `steps.ts` (`proposeDates`) and the `settings` table; the plan's worked example is a test in `test/dates.test.ts`, so a rule change that breaks it is deliberate or a bug.
- **Provisional vs confirmed.** New jobs get proposed dates, all provisional (`confirmed = false`, drawn faded and dashed). Christine ticks Confirmed when a date matches Buildertrend. Imported Notion dates came in confirmed. Moving a date confirms every date the move changes (George, 6 Nov 2026: the drag box always; the Reschedule screen unless "Leave the changed dates provisional" is ticked), so Confirmed now means "someone set this on purpose"; the Buildertrend bot still flags dates that don't match.
- **Needs a decision.** Rules in `checks.ts`. "OK as is" saves a row in `decisions` with a fingerprint of the dates it was judged on; if those dates change, the item shows again.
- **Capacity** is measured in hours per area (George, 7 Nov 2026; Jobman's labour centre). `labour_centres` holds hours available each weekday for Factory and Install crew (Settings → Capacity); `capacity_adjustments` is a date range with different hours a day (a shutdown is 0, leave is less); weekends, holidays and blocked days are 0 (`availableHours()`). A kitchen's factory or install day books `hours_per_day` hours; a rework task books its own hours spread over its working days (`bookedHours()`); rework with no area doesn't count. `capacity()` warns per week when booked hours pass available hours, reporting both hours and job-days (hours ÷ `hours_per_day`) so the team's language still works; with no centres given it falls back to the old kitchens-a-week rules (`centresFromRules()`, used by tests). Migration 010 seeded the centres from those settings (2 × 2 × 8 ÷ 5 = 6.4 h a day) and removed them. `/load` (`loadByDay()`) is six weeks of booked against available per day. Check measures: a count per day, unchanged.
- **Painting** is its own tick on a job (`has_painting`, George, 30 Oct 2026), separate from door finish. It adds the Doors to painting and Doors back steps and the extra install week (`install_weeks_poly`). Choosing Polyurethane ticks it in the form; it can be unticked. Migration 002 also fixed five Polytec melamine jobs the first import had loaded as polyurethane.
- **Deleting** (Editors): a rework (with its steps), a rework step or an extra named step, and a whole job added by mistake. Standard steps can't be deleted; clear their dates or untick Painting or Stone. People are switched off, never deleted, so history keeps their names. Every delete is in the change log. The page asks "Yes, delete" itself because the browser confirm box isn't used.
- **Keeping your place:** `public/hub.js` puts the page back at the same scroll position after any form post; without it, the form's `back` anchor (`#c-<step id>`) lands near the item.
- **Dependencies** (George, 30 Oct 2026; `DEPENDENCIES` in `schedule.ts`): finish-to-start, same day allowed unless the lag says otherwise. Check measure → drawings → (soft) materials ordered → materials in → factory → doors to painting → doors back → delivery (also after factory) → install → stone measure (next working day) → stone install (next working day). Materials ordered early only warns. Done steps never move and never count. Broken hard rules show in Needs a decision (`dep:` keys).
- **Reschedule screen** (`/jobs/:id/reschedule?step=&start=&mode=`): Overdue "New date", a "Move…" link on each date, a tap on a bar on All jobs, and a single date change on the job's dates form all open it. Modes: `shift` (default, every dependent step by the same working days; delivery travels with install), `squeeze` (hold install and later, push the steps between only as far as the rules force, using spare days first), `only`. Every row is editable; a hard clash needs **Move anyway**. Saved dates are confirmed unless the tick box says otherwise. The shift buttons and the dates form with several changes still save directly.
- **Dragging** (George, 31 Oct and 6 Nov 2026): a card sideways on the Coming up week board (day columns are working days, sent as `wd=`; a tap still opens the job; on phones each day-list card has a Move… link) or a bar on All jobs (mouse, calendar days with `snap=1`). On drop, `public/hub.js` shows a small box: Move everything after it / Keep the install date (only when `data-squeeze="1"`, i.e. `canSqueeze()`) / Only this one, plus "See every date first" (the Reschedule screen) and Cancel. A choice posts to `/jobs/:id/reschedule/quick`, which saves at once, confirmed, and returns to the page. If the move makes a **new** hard clash (clashes already there don't count), nothing saves and the Reschedule screen opens with the message.
- **Templates** (`job_templates`, Settings → Job types): "Kitchen, polyurethane painted doors" and "Kitchen, melamine doors" (George, 30 Oct 2026). They set door finish, painting, stone, factory and install days, and install weeks after site start (the old `install_weeks_*` settings moved here). The New job form takes one date (site start, check measure, drawings start or install start) and `proposeFromAnchor()` fills the rest; a blank site start is worked out backwards.
- **Owners only: who was responsible** (George, 30 Oct 2026). `people.is_owner` (George and Gus, set by migration 003 by email; owners can tick it for others in Settings). `rework_responsible` and `owners_log` have row-level security: the database returns nothing to non-owners and refuses their writes, so read them only through `withPerson()` (`loadResponsible()`). They are deliberately not in `change_log`, the job History or the spreadsheet. Only an owner can make someone an owner or change an owner's own record (`hub_owner_guard`), so an Editor can't take over an owner's sign-in. RLS doesn't apply to superusers: `migrate` logs a WARNING if the database user is one. Backups and restores must run with `PGOPTIONS="-c hub.system=on"` and `pg_dump --enable-row-security` (see `backup/backup.sh`), or pg_dump refuses the RLS tables. Functions called by RLS or triggers need `set search_path` (migration 004), because pg_dump runs with an empty search path. Never show the field, its tally or the word "Owners only" to anyone else, Christine included.
- **Steps.** One standard step of each kind per job (`label = ''`). Extra named steps on a row (Tesoriero's "Install painted doors") carry a label. Rework steps are `kind = 'rework'` with a `rework_id`.
- **Tasks for one job** (George, 6 Nov 2026): Editors add them on One job ("Tasks for this job only"): a name, an area (`TASK_AREAS` in `steps.ts`: Production = `production_drawings`, Factory = `factory`, Site = `install`), who, dates. Stored as an extra named step of that kind. They travel with their area's standard step in shift and squeeze moves (`travel()` in `schedule.ts`), not in "Only this one"; they never count for dependencies. Editable (name, area, who) and deletable.
- **Rework as a mini job** (George, 6 Nov 2026). Raising a rework ticks its tasks from `REWORK_AREAS` (drafting/production drawings, factory work, delivery, install); factory work and install need hours. Each task is a rework step with `rework_area` (the standard step it stands for) and `hours`. `rowOf()` puts it in that step's board row, drawn red (`.chip.rw`); the Rework row keeps only rework with no tasks or dates, and old rework steps with no area. An Editor's start date (raise form, or "Set dates" on the rework) fills the dates with `proposeRework()`: drawings `rework_drawings_days`, factory work the next working day for hours ÷ `hours_per_day` days (at least one), delivery the working day after, install the same day as delivery; dated this way they're confirmed. Doers' tasks come in undated. More items are added with "Add a rework item": a name, a **category** from a required dropdown (`REWORK_CATEGORIES`: Drafting for contract, Check measure, Production drawings, Materials orders, Factory, Delivery, Install, Stone; George, 6 Nov 2026), hours for factory or install, and dates; there is no "Who" box, the owner is that step's usual owner (editable afterwards). A rework's tasks run in the job's step order (`FLOW`) (`violations()`; Needs a decision key `dep:rw:<pred id>:<succ id>`); moving one moves the later ones of the same rework by the same working days, and never the main job. The job's −1/+1/+1 week buttons leave rework alone. Editors edit a rework (cause, what happened) and each task (name, who, row, hours).
- **Delivery** sits in the Factory row on Coming up (George, 6 Nov 2026). On All jobs it stays on the lower line beside install.
- **Job lists** ("Choose a job", the Rework page picker) are in job-number order, oldest first, live jobs first (`JOB_NUMBER_ORDER` in `queries.ts`; George, 6 Nov 2026).
- **Pinned headings** (George, 6 Nov 2026): the Coming up day headings are sticky with a line between days (`.daylines`); the phone day list's headings are sticky; All jobs scrolls inside its box with the week headings and job names pinned.
- **Suggestions** (George, 1 Nov 2026; API documented in `README.md`). A bot (Grokbot) checks Buildertrend each weekday and POSTs suggestions to `/api/suggestions` with an API token. Tokens: owners make and revoke them in Settings (shown once, stored as a SHA-256 hash; `hub_token_guard`). The API runs as `withToken()`: Postgres sees no person, so `hub_guard()` refuses every change to jobs and steps, and `hub_suggestion_guard()` lets it only add pending suggestions (and supersede older pending ones through the `suggestions_supersede` trigger: same job number, stage, field and type; notes never). Editors decide on the Suggestions screen (tab with a waiting count; panels on Coming up and One job); Doers and Viewers only look. `decide()` locks the row, checks the hub still shows `current_value` (else `failed`, nothing changes), then applies through `edits.ts` inside a savepoint; a failed apply rolls back to it and records the reason. Accepting a date ticks it Confirmed. Changes made by accepting carry `change_log.suggestion_id` (set from `hub.suggestion_id`), shown as "(suggestion #n)" in History. Decided suggestions can't change again; none are ever deleted. Clearing the queue before a fresh rebuild (George, 6 Nov 2026): `POST /api/suggestions/supersede-pending` (token) or **Supersede all … waiting** on the Suggestions screen (Editors) runs `supersedePending()`: every pending one becomes `superseded` with the reason in `decision_note`; the guard stamps `decided_at` and `decided_by` (Editor) or `decided_by_token` (bot, shown as `api:<token name>`). No email. `add_job` payloads keep only whitelisted fields; street addresses are cut to the suburb and phone numbers and emails are scrubbed from text. One email per batch (first POST of a `batch_id` with an urgent or normal item) to `app_settings.suggestions_email` (Settings; default design@aalborkitchens.com.au). 60 calls a minute per token (in memory, per instance); every call in `api_calls`.
- **The preview round** (George, 7 Nov 2026; `docs/jobman-review.html` R1 to R8). Tabs: Board · Pipeline · My day · Jobs · Attention · More (Rework, Suggestions, New job, Settings, Spreadsheet); a Find a job box in the header (`/find?q=`, one match opens it). `/` sends Doers to `/me`, everyone else to the Board; `/board` is the Board. **Attention** (`/attention`) holds Overdue and Needs a decision grouped by job, soonest install first; the tab shows the count. **Pipeline** (`/pipeline`) is one row per live job, one cell per stage (`STAGES` and `stageCells()` in `checks.ts`): done, this week, later, overdue, no date, skipped (undated but before a done stage: the imported jobs never had Drafting for contract ticked), n/a; the current stage is the first open stage after the last done one (`currentStage()`, and `currentStep()` for the job screen). **My day** (`/me`) lists a person's open steps (overdue, today, later this week, next week) with one Done button each; "theirs" means in one of their `people.areas` (board rows, ticked in Settings → People) or with their first name as the step's owner (`isMine()` in `me.ts`); the office message (`app_settings.board_message`, Settings) shows at the top of My day and the Board. **One job** shows the steps as a timeline (`stepRow()` in `job.ts`): tick, name, owner, the date as a tap target that opens the move box with a date picker (`a.datebtn` in `hub.js`, posting to `/reschedule/quick`; without script it opens the Reschedule screen), pills, Pin; the bulk date form sits behind "Edit all dates" and the shift buttons behind "Move the whole job". **Pinned** (`steps.pinned`, `POST /steps/:id/pin`, Editors): a promised date; `reschedule()` never moves a pinned step in shift or squeeze, `travel()` skips it, the job's −1/+1/+1 week buttons and "work out again" leave it, and pinning also confirms; a clash with a pinned step is a hard violation (Move anyway or a decision). `jobs.drawings_url` is a folder link (https only, `checkUrl()`), shown on the job and on My day; never a file.
- **Flag a problem** (George, 7 Nov 2026; Jobman's job alert). `issues`: a job, optionally a step, a type from `issue_types` (each with a responsible person, Settings → Flagged problems), one line, status open / looking / fixed, close note, and `rework_id` when "Raise rework for this" answered it (the raise form carries `flag_id`). Photos are `issue_photos` rows (bytea, up to 4 of 4 MB; `hub.js` shrinks them to 1600 px JPEG first), served at `/issues/:id/photos/:pid`, guarded but not logged. Doers may raise flags with photos and move along flags they raised or look after (`hub_guard`); Editors anything. Flags show on Attention (first, and in the tab count), on the job (`#flags`) and on My day ("Flags for you"). Raising one emails the responsible person and the Editors.
- **Emails** (George, 7 Nov 2026; `nudges.ts`). Four fixed ones, not a trigger builder: weekdays at 7 am Sydney, whoever owns a step that went overdue since the last working day; Mondays, everyone's week; a flag as it's raised; "materials in" to the factory when that step is ticked. "Owns" is `isMine()` (areas or first name). `people.email_digest` opts someone out. The in-process scheduler (`startScheduler()`, started in `server.ts` only when run for real) checks the clock every minute; `digest_runs` (day, kind) makes a day's run happen once whatever restarts happen. Settings → Emails previews today's run (`/settings/emails`) and sends it now. On the preview copy (`config.preview`) every email goes to `app_settings.suggestions_email` instead, saying who it was for.
- **In place** (George, 7 Nov 2026; `hub.js`): every POST form submits by fetch, follows the hub's redirect, and swaps the new page's `.wrap` into the current one (scroll kept, `init()` re-run); a redirect to another path navigates; a non-redirect answer (a form with a mistake) is written in whole; `data-plain` on a form opts out, and a form with a file input is only sent this way when it has `data-photos`.
- **Install done with photos** (George, 7 Nov 2026; R13). Ticking the standard Install cabinets step (`asksOnDone()`) opens a small form instead of a plain tick: gaps adjusted? site left clean? and up to three photos. `POST /steps/:id/done` takes multipart then; the answers are `steps.gaps_adjusted` and `steps.site_clean` (in the change log, so History says "ticked done (gaps adjusted yes, site left clean no)"), photos are `step_photos` (bytea, guarded, not logged, served at `/steps/:id/photos/:pid`). Unticking clears the answers and keeps the photos. Doers may set the two answers and add photos (`hub_guard`). Shown under the step on the job and on My day; the Monday email tells Editors "Installs finished last week" with the answers and the photo count (`installsDone()`).
- **Job sheet** (George, 7 Nov 2026; R12): `/jobs/:id/sheet` is one printable page (`sheet.ts`, its own document, not the layout): number, client, suburb, finish, days, scope, every standard step with a tick box, and a QR code (`qrcode-generator`, no dependencies) that opens `/me?job=:id`: that job's open steps for whoever scanned it, each with Done and Flag, whatever their areas (`jobDayPage()` in `me.ts`). Linked from the job's pills ("Job sheet ↗"). No cabinet count: the hub doesn't hold one.
- **Where a new job lands** (George, 7 Nov 2026; R7). The proposal on New job shows the factory and install weeks the job lands in with hours booked before and after it against hours available (`weekHours()` in `checks.ts`; `Landing` in `other.ts`). When the job clashes, `proposalFor()` tries the same anchor one to twelve weeks later and offers the first with room as "Use the next week with room: <date>", a button that re-posts the form with `use_week`; the route moves the date worked from and shows the new proposal without saving. None in twelve weeks says so.
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

Add the next `migrations/00N_what.sql`; never edit a migration that has run on Render. Migrations run as the system before each deploy (`preDeployCommand`). Seeding or fixing data in a migration is fine; it is logged as "System".

## What's live (29 Oct 2026)

Render workspace "Quote-Desk" (Quote Desk lives there too: never touch it). Blueprint `aalbor-hub` on branch `main`, all in Singapore: web service `aalbor-hub` (https://hub.aalborkitchens.com.au; also answers on https://aalbor-hub.onrender.com), Postgres `aalbor-hub-db`, cron `aalbor-hub-backup` (nightly dump to the Cloudflare R2 bucket `aalbor-hub-backups`, kept 90 days). The Notion import has run. DNS is at Crazy Domains; Resend uses Forge CNAMEs on `send` and `rsend`. Leave the existing Microsoft 365, Mailgun/LeadConnector and site records alone. Secrets: `RESEND_API_KEY` on the web service; the R2 keys only on the cron job.

## Dependencies

`npm audit --omit=dev` must stay at 0. `uuid` is pinned to 11.1.1 through `overrides` (exceljs pulls in an older one). The remaining `npm audit` findings are inside vitest, a test-only tool that never runs in the live hub; vitest 4 can't be installed with npm 10.9 (an npm peer-dependency bug), so move to it when npm is updated.

## Deploying

Push to `main`. Render builds, runs `npm run migrate`, then starts the new version. Secrets live only on Render's Environment pages; never in the repository or in chat.

## Phase 2 (Stock), not started

Starts after 2 to 3 weeks of Phase 1 use. Brief section 6: always-stocked boards with minimums, bought-to-order boards, sheet counts per job from Cabinet Vision, 6-week board demand by factory date, standard-range hardware two-bin "running low", per-job hardware, Angela's Monday order list grouped by supplier, offcuts, Phil's Friday count. Load the 183 stock lines from Notion. No stock valuation.
