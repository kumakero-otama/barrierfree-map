#!/bin/sh
set -eu

BUCKET="${STEPBY_BACKUP_BUCKET:-stepby-cloud-dev-202608-backups}"
RUNTIME_ENV_PATH="${STEPBY_RUNTIME_ENV_PATH:-/run/stepby/runtime.env}"
METADATA_URL="http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"

set -a
. "$RUNTIME_ENV_PATH"
set +a
: "${STEPBY_DB_PASSWORD:?STEPBY_DB_PASSWORD is required}"

umask 077
BACKUP_DIR="/var/lib/stepby-backups"
install -d -m 0700 -o root -g root "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OBJECT_NAME="stepby_app_dev-${STAMP}.dump"
BACKUP_PATH="${BACKUP_DIR}/${OBJECT_NAME}"
UPLOADS_OBJECT_NAME="stepby_uploads-${STAMP}.tar.gz"
UPLOADS_BACKUP_PATH="${BACKUP_DIR}/${UPLOADS_OBJECT_NAME}"

cleanup() {
  test ! -e "$BACKUP_PATH" || unlink "$BACKUP_PATH"
  test ! -e "$UPLOADS_BACKUP_PATH" || unlink "$UPLOADS_BACKUP_PATH"
}
trap cleanup EXIT HUP INT TERM

PGPASSWORD="$STEPBY_DB_PASSWORD" pg_dump \
  --format=custom \
  --compress=6 \
  --no-owner \
  --no-acl \
  --host=127.0.0.1 \
  --username=stepby_dev \
  --file="$BACKUP_PATH" \
  stepby_app_dev

ACCESS_TOKEN="$(curl --fail --silent --show-error \
  -H 'Metadata-Flavor: Google' \
  "$METADATA_URL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).access_token))')"

curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary "@$BACKUP_PATH" \
  "https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${OBJECT_NAME}" \
  >/dev/null

tar -czf "$UPLOADS_BACKUP_PATH" -C /srv/stepby/current uploads
curl --fail --silent --show-error \
  -X POST \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/gzip' \
  --data-binary "@$UPLOADS_BACKUP_PATH" \
  "https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${UPLOADS_OBJECT_NAME}" \
  >/dev/null
