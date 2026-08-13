#!/bin/sh
set -eu

OUTPUT_DIR="${STEPBY_HEALTH_DIR:-/var/lib/stepby-health}"
OUTPUT_FILE="$OUTPUT_DIR/hourly.csv"
install -d -m 0750 -o root -g stepby "$OUTPUT_DIR"

if [ ! -e "$OUTPUT_FILE" ]; then
  printf '%s\n' 'timestamp_utc,uptime_seconds,load_1m,memory_available_mb,disk_used_percent,db_bytes,api_http_status,api_seconds,api_service,postgres_service,caddy_service,backup_last_result,errors_last_hour,rx_bytes,tx_bytes' > "$OUTPUT_FILE"
fi
chown root:stepby "$OUTPUT_FILE"
chmod 0640 "$OUTPUT_FILE"

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
uptime_seconds="$(cut -d. -f1 /proc/uptime)"
load_1m="$(cut -d' ' -f1 /proc/loadavg)"
memory_available_mb="$(awk '/MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
disk_used_percent="$(df -P / | awk 'NR==2 { gsub(/%/, "", $5); print $5 }')"
db_bytes="$(sudo -u postgres psql -Atqc "SELECT pg_database_size('stepby_app_dev')" postgres 2>/dev/null || printf 0)"

api_metrics="$(curl --silent --show-error --max-time 15 -o /dev/null -w '%{http_code},%{time_total}' https://stepby-api-8-229-191-182.sslip.io/api/config 2>/dev/null || printf '000,15')"
api_http_status="${api_metrics%%,*}"
api_seconds="${api_metrics#*,}"
api_service="$(systemctl is-active stepby-dev 2>/dev/null || true)"
postgres_service="$(systemctl is-active postgresql 2>/dev/null || true)"
caddy_service="$(systemctl is-active caddy 2>/dev/null || true)"
backup_last_result="$(systemctl show stepby-db-backup.service -p Result --value 2>/dev/null || printf unknown)"
errors_last_hour="$(journalctl -u stepby-dev --since '1 hour ago' --no-pager 2>/dev/null | grep -Eic 'uncaught|unhandled|fatal|guest_failed|handler error|status=5[0-9][0-9]' || true)"
network_values="$(awk '$1 ~ /^(ens|eth)[0-9]*:$/ { rx += $2; tx += $10 } END { printf "%d,%d", rx, tx }' /proc/net/dev)"
rx_bytes="${network_values%%,*}"
tx_bytes="${network_values#*,}"

printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
  "$timestamp" "$uptime_seconds" "$load_1m" "$memory_available_mb" "$disk_used_percent" \
  "$db_bytes" "$api_http_status" "$api_seconds" "$api_service" "$postgres_service" \
  "$caddy_service" "$backup_last_result" "$errors_last_hour" "$rx_bytes" "$tx_bytes" >> "$OUTPUT_FILE"

# 31日より古い測定値を捨てる。ヘッダーと期間内の記録だけを残す。
if [ "$(wc -l < "$OUTPUT_FILE")" -gt 800 ]; then
  { head -n 1 "$OUTPUT_FILE"; tail -n 744 "$OUTPUT_FILE"; } > "$OUTPUT_FILE.tmp"
  mv "$OUTPUT_FILE.tmp" "$OUTPUT_FILE"
  chown root:stepby "$OUTPUT_FILE"
  chmod 0640 "$OUTPUT_FILE"
fi
