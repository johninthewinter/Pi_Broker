#!/usr/bin/env bash
# Stop the broker started by scripts/quickstart.sh and clean up its run dir.
# The Pi session windows are ordinary terminals — close them yourself.
set -euo pipefail

STATE_FILE="${PI_QUICKSTART_DIR:-/tmp}/pi-broker-quickstart.current"

if [ ! -f "$STATE_FILE" ]; then
  echo "quickstart-stop: no run recorded at $STATE_FILE" >&2
  exit 1
fi

pid=""
socket=""
run_dir=""
while IFS='=' read -r key value; do
  case "$key" in
    pid) pid="$value" ;;
    socket) socket="$value" ;;
    run_dir) run_dir="$value" ;;
  esac
done <"$STATE_FILE"

if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  kill "$pid"
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  echo "quickstart-stop: stopped broker $pid"
else
  echo "quickstart-stop: broker $pid was not running"
fi

[ -n "$socket" ] && rm -f "$socket"
case "$run_dir" in
  */pi-broker-quickstart.*) rm -rf "$run_dir" ;;
esac
rm -f "$STATE_FILE"
