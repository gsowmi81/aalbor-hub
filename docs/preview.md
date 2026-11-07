# The preview copy of the hub

A second copy of the hub on Render, running the `claude/cool-ptolemy-ojevwz` branch, so George can try the
new screens over a weekend while the team keeps using the real hub (George, 7 Nov 2026). Same code, its own
database, its own address. When the branch is merged to `main`, the real hub gets everything and the preview
is deleted.

Rules:

- Its data is a throwaway copy. Nothing ticked or moved there is real. The team keeps using hub.aalborkitchens.com.au.
- Every page carries a yellow "Preview copy" bar and every email it sends starts with "[Preview]" (`HUB_PREVIEW=1`).
- It must have `RESEND_API_KEY` set. Without it the hub prints the sign-in link on the page, which is fine on a
  laptop and a hole on a public address.
- The Buildertrend bot never posts to it. Don't make an API token on it.

## Setting it up (George, once, about 10 minutes)

In Render, workspace "Quote-Desk":

1. **New → Postgres.** Name `aalbor-hub-preview-db`, region Singapore, the smallest plan. Create.
2. **New → Web Service.** Pick the `aalbor-hub` repository. Then:
   - Name: `aalbor-hub-preview`
   - Region: Singapore
   - Branch: `claude/cool-ptolemy-ojevwz`
   - Runtime: Node
   - Build command: `npm ci --include=dev && npm run build`
   - Pre-deploy command: `npm run migrate`
   - Start command: `npm start`
   - Health check path: `/healthz`
   - Plan: Starter
3. **Environment** on the new service (Environment tab), every one of these:

   | Key | Value |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `NODE_ENV` | `production` |
   | `TZ` | `Australia/Sydney` |
   | `DATABASE_URL` | the preview database's **Internal Database URL** (from step 1) |
   | `HUB_PREVIEW` | `1` |
   | `INITIAL_EDITOR_EMAIL` | `george@aalborkitchens.com.au` |
   | `INITIAL_EDITOR_NAME` | `George Sowmi` |
   | `MAIL_FROM` | `Aalbor Hub preview <hub@aalborkitchens.com.au>` |
   | `RESEND_API_KEY` | the same key as the real hub (copy it from the real service's Environment page) |
   | `APP_URL` | leave unset; Render fills the onrender.com address in |

4. Deploy. The first deploy runs the migrations on the empty database and adds George as an Editor.
5. **Load the jobs.** On the service, open **Shell** and run:

   ```
   npm run import:notion
   ```

   That loads the 18 jobs from the Notion snapshot of 28 Oct 2026. It is ten days stale, which is fine for judging
   screens. (A copy of last night's real data instead: see "Fresher data" below.)
6. Open the service's address, sign in with your email, and you're in. Add Christine, Phil or anyone else you want
   trying it under Settings → People, exactly as on the real hub.

Every push to the branch redeploys the preview on its own, usually within three or four minutes.

## Fresher data (optional, before cutover)

To see the new screens on real jobs before merging, restore last night's backup into the preview database.
The nightly dump sits in the Cloudflare R2 bucket `aalbor-hub-backups` (see `backup/backup.sh` for the file name).
Download the latest dump, then from a machine with `psql`:

```
PGOPTIONS="-c hub.system=on" pg_restore --no-owner --clean --if-exists -d "<preview external database URL>" <dump file>
```

Then, on the preview, revoke every API token under Settings → API tokens, so the bot can never reach it.

## Cutover

1. Merge the branch into `main` (a pull request, or George says the word and it's pushed).
2. Render rebuilds the real hub, runs the new migrations, and starts it. Nothing is copied from the preview.
3. Delete the preview web service and its database in Render.
