#!/bin/sh
# Dumps the hub database and uploads it to the R2 bucket. Keep 90 days with an R2
# lifecycle rule on the bucket (see docs/setup.md). Restore: docs/setup.md, "Restore a backup".
set -eu
if [ -z "${BACKUP_BUCKET:-}" ]; then
  echo "Backup not set up yet: BACKUP_BUCKET is empty. Render's own daily database backups still run."
  exit 0
fi
name="aalbor-hub-$(date -u +%Y-%m-%d).dump"
# The owners-only tables have row-level security. Dump as the system (as migrations run) with
# row security on, so pg_dump copies every row instead of refusing (failed backup, 31 Oct 2026).
PGOPTIONS="-c hub.system=on" pg_dump "$DATABASE_URL" --format=custom --no-owner --enable-row-security --file "/tmp/$name"
size=$(wc -c < "/tmp/$name")
[ "$size" -gt 1000 ] || { echo "Dump is only $size bytes; something is wrong."; exit 1; }
AWS_DEFAULT_REGION=auto aws s3 cp "/tmp/$name" "s3://$BACKUP_BUCKET/$name" --endpoint-url "$BACKUP_ENDPOINT"
echo "Backed up $name ($size bytes) to $BACKUP_BUCKET"
