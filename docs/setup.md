# Putting the Aalbor Hub live

For George. About 30 minutes in all, in this order. No key or password ever goes into chat or into the repository: each one is pasted straight into the Render page named in the step.

## 1. Resend, for the sign-in emails (10 minutes)

1. Go to resend.com and sign up with your work email.
2. **Domains → Add domain**: `aalborkitchens.com.au`. Region: Tokyo (ap-northeast-1), the closest to Sydney.
3. Resend shows three DNS records (an MX and a TXT on `send.aalborkitchens.com.au`, and a TXT on `resend._domainkey`). Add them where you manage the domain's DNS. They sit on the `send` subdomain, so your existing Microsoft 365 mail is untouched.
4. Back in Resend, press **Verify**. It can take a few minutes to an hour.
5. **API Keys → Create API key**: name `aalbor-hub`, permission *Sending access*, domain `aalborkitchens.com.au`. Copy the key. Keep the tab open for step 2.

## 2. Render (10 minutes)

1. Render dashboard → **New → Blueprint**.
2. Connect GitHub if asked, and give Render access to the `gsowmi81/aalbor-hub` repository.
3. Pick `aalbor-hub`. Render reads `render.yaml` and lists three things: the web service `aalbor-hub`, the database `aalbor-hub-db` and the cron job `aalbor-hub-backup`.
4. It asks for the secret values:
   - `RESEND_API_KEY`: paste the key from step 1.
   - `APP_URL`: leave empty for now.
   - The four backup values: leave empty for now (step 4).
5. **Apply**. The first build and deploy take about 5 minutes. Cost is about US$15 a month on the Starter and Basic plans (likely; Render's billing page has the exact figure).
6. When the web service shows **Live**, open it: **aalbor-hub → Shell**, type `npm run import:notion` and press Enter. It loads the 18 live jobs from the Notion snapshot of 28 Oct 2026 and lists them. It refuses to run a second time.
7. Open the service's address (shown at the top, like `https://aalbor-hub.onrender.com`) on your phone. Sign in with george@aalborkitchens.com.au.
8. In the hub, **Settings → People**: add Gus and Phil (Doer), the factory sign-in (Doer), Angela, Glenn, Libby and Michael (Viewer). Christine is already there as an Editor.

## 3. The hub's own address (5 minutes)

1. Render → **aalbor-hub → Settings → Custom Domains → Add**: `hub.aalborkitchens.com.au`.
2. At your DNS host add a **CNAME** record: name `hub`, value the onrender.com address Render shows (without `https://`).
3. Back in Render press **Verify**. Render issues the security certificate itself.
4. Render → **aalbor-hub → Environment**: set `APP_URL` to `https://hub.aalborkitchens.com.au` and save. Render redeploys, and sign-in links then use the new address.

## 4. Off-Render backup copy (10 minutes, any time before go-live)

Render already keeps daily backups of the database (on the paid plan, under **aalbor-hub-db → Recovery**; likely, check that page). This adds a copy Render can't lose.

1. Cloudflare dashboard → **R2** → **Create bucket**: `aalbor-hub-backups`, location *Asia-Pacific*.
2. In the bucket: **Settings → Object lifecycle rules → Add rule**: delete objects 90 days after upload.
3. **R2 → Manage API tokens → Create API token**: permission *Object Read & Write*, only the `aalbor-hub-backups` bucket. Cloudflare shows an Access Key ID, a Secret Access Key and the endpoint (`https://<account id>.r2.cloudflarestorage.com`).
4. Render → **aalbor-hub-backup → Environment**: `BACKUP_BUCKET` = `aalbor-hub-backups`, `BACKUP_ENDPOINT` = the endpoint, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` = the two keys. Save.
5. Render → **aalbor-hub-backup → Trigger Run**. The log should end "Backed up aalbor-hub-YYYY-MM-DD.dump".

## Restore a backup (for a developer)

1. Download the `.dump` file from the R2 bucket.
2. Render → **aalbor-hub-db → Networking**: add your own IP address to the allow list for the duration.
3. `pg_restore --clean --if-exists --no-owner --dbname "<External Database URL>" aalbor-hub-YYYY-MM-DD.dump`
4. Remove your IP from the allow list. Restart the web service.

Restore into a scratch database first (`createdb`, then the same command) and check it before overwriting the live one.
