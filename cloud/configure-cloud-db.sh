#!/bin/sh
set -eu

RUNTIME_ENV_PATH="${STEPBY_RUNTIME_ENV_PATH:-/run/stepby/runtime.env}"
DB_CONFIG_PATH="${STEPBY_DB_CONFIG_PATH:-/etc/stepby/config.dev.yaml}"

test -r "$RUNTIME_ENV_PATH"
set -a
. "$RUNTIME_ENV_PATH"
set +a
: "${STEPBY_DB_PASSWORD:?STEPBY_DB_PASSWORD is required}"

DB_PASSWORD_SQL="$(printf '%s' "$STEPBY_DB_PASSWORD" | sed "s/'/''/g")"

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stepby_dev') THEN
    CREATE ROLE stepby_dev LOGIN;
  END IF;
END
\$\$;
ALTER ROLE stepby_dev PASSWORD '${DB_PASSWORD_SQL}';
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='stepby_app_dev'" | grep -q 1; then
  sudo -u postgres createdb --owner=stepby_dev stepby_app_dev
fi

install -d -m 0750 -o root -g stepby "$(dirname "$DB_CONFIG_PATH")"
umask 027
TMP_PATH="$(mktemp "${DB_CONFIG_PATH}.XXXXXX")"
cleanup() {
  test ! -e "$TMP_PATH" || unlink "$TMP_PATH"
}
trap cleanup EXIT HUP INT TERM

cat > "$TMP_PATH" <<EOF
db:
  host: 127.0.0.1
  port: 5432
  user: stepby_dev
  password: "$(printf '%s' "$STEPBY_DB_PASSWORD" | sed 's/[\\"$`]/\\&/g')"
  database: stepby_app_dev
  ssl: false
EOF
chown root:stepby "$TMP_PATH"
chmod 0640 "$TMP_PATH"
mv -f "$TMP_PATH" "$DB_CONFIG_PATH"
trap - EXIT HUP INT TERM
