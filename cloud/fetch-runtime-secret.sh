#!/bin/sh
set -eu

PROJECT_ID="${STEPBY_GCP_PROJECT_ID:-stepby-cloud-dev-202608}"
SECRET_ID="${STEPBY_RUNTIME_SECRET_ID:-stepby-dev-runtime}"
OUTPUT_PATH="${STEPBY_RUNTIME_ENV_PATH:-/run/stepby/runtime.env}"
METADATA_URL="http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"

umask 077
install -d -m 0750 -o root -g stepby "$(dirname "$OUTPUT_PATH")"

ACCESS_TOKEN="$(curl --fail --silent --show-error \
  -H 'Metadata-Flavor: Google' \
  "$METADATA_URL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).access_token))')"

TMP_PATH="$(mktemp "${OUTPUT_PATH}.XXXXXX")"
cleanup() {
  test ! -e "$TMP_PATH" || unlink "$TMP_PATH"
}
trap cleanup EXIT HUP INT TERM

curl --fail --silent --show-error \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${SECRET_ID}/versions/latest:access" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(Buffer.from(JSON.parse(s).payload.data,"base64")))' \
  > "$TMP_PATH"

chown root:stepby "$TMP_PATH"
chmod 0640 "$TMP_PATH"
mv -f "$TMP_PATH" "$OUTPUT_PATH"
trap - EXIT HUP INT TERM
