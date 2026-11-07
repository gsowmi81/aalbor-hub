#!/bin/sh
# Restores the newest dump in the R2 bucket into another database: the preview copy
# (docs/preview.md, George, 7 Nov 2026). Never run it against the live database.
# Needs BACKUP_BUCKET, BACKUP_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and
# RESTORE_DATABASE_URL (the database to overwrite). Afterwards it revokes every API token
# in the copy, so the bot can never reach it, and points suggestion emails at George.
set -eu
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is not set: the database to restore into}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is not set}"
export AWS_DEFAULT_REGION=auto
f=$(aws s3 ls "s3://$BACKUP_BUCKET/" --endpoint-url "$BACKUP_ENDPOINT" | awk '{print $4}' | grep '\.dump$' | sort | tail -1)
[ -n "$f" ] || { echo "No dump found in $BACKUP_BUCKET"; exit 1; }
echo "Restoring $f"
aws s3 cp "s3://$BACKUP_BUCKET/$f" /tmp/restore.dump --endpoint-url "$BACKUP_ENDPOINT"
# hub.system=on lets the owners-only tables load (row-level security); --clean replaces what the
# migrations created on the empty copy. Harmless "already exists" notices are expected.
PGOPTIONS="-c hub.system=on" pg_restore --no-owner --clean --if-exists --dbname "$RESTORE_DATABASE_URL" /tmp/restore.dump \
  || echo "pg_restore reported warnings (see above); carrying on"
PGOPTIONS="-c hub.system=on" psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "update api_tokens set revoked_at = now() where revoked_at is null" \
  -c "update app_settings set value = 'george@aalborkitchens.com.au' where key = 'suggestions_email'" \
  -c "select (select count(*) from jobs) as jobs, (select count(*) from steps) as steps, (select count(*) from people) as people, (select count(*) from api_tokens where revoked_at is null) as live_tokens"
echo "RESTORE-DONE $f"
