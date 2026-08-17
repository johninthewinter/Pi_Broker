#!/usr/bin/env bash
# One-command local quickstart: start the broker, open one real interactive Pi
# session per requested count in its own terminal window (two by default),
# print the exact prompt command. Windows always exactly match session count.
#
# Which terminal is opened is decided by scripts/open-pi-windows.mjs, per
# platform. If no window can be opened, this fails with the manual command
# rather than starting anything hidden.
#
# Usage: scripts/quickstart.sh [session-count]   (default: 2)
#
# This is convenience automation around the manual three-terminal sequence in
# README.md. It changes nothing about the architecture: each window runs the
# same ordinary interactive `pi` TUI with the same explicit bridge extension a
# human would type by hand. No headless Pi (-p / --print / --mode) is used or
# permitted here.
#
# Env overrides:
#   PI_QUICKSTART_DIR          base dir for the socket + state file (default /tmp)
#   PI_QUICKSTART_TARGET_DIR   directory the launched Pi sessions' OWN cwd —
#                              the one governing their file/bash/edit sandbox —
#                              is scoped to, for dispatching work against a
#                              repo other than Pi Broker itself. Default:
#                              unset, meaning Pi Broker's own directory
#                              (unchanged behavior). Requires `npm install` to
#                              have already been run here, so
#                              node_modules/.bin/pi exists: `pi` is launched
#                              directly by its resolved absolute path in this
#                              mode, not via `npm exec`, because `npm exec`
#                              would need to run from Pi Broker's own
#                              directory to resolve — defeating the point.
#   PI_QUICKSTART_PI_COMMAND  command run inside each session window (test seam)
#   PI_QUICKSTART_OPEN        opener called as: <opener> <script-path> <title> (test seam)
#   PI_QUICKSTART_REGISTER_TIMEOUT_MS  how long to wait for every session to
#                              actually register with the broker after the
#                              opener returns, before failing loudly instead
#                              of printing a false "quickstart is up"
#                              (default 20000)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

COUNT="${1:-2}"
if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [ "$COUNT" -lt 1 ]; then
  echo "quickstart: session count must be a positive integer, got '$COUNT'" >&2
  exit 1
fi
if [ "$COUNT" -eq 2 ]; then
  SESSIONS=(session-a session-b)
else
  SESSIONS=()
  for ((i = 1; i <= COUNT; i++)); do
    SESSIONS+=("session-$i")
  done
fi
# Deliberately not $TMPDIR: macOS per-user temp paths are ~49 chars, and a unix
# socket path is capped at 104 bytes — long enough to get silently truncated.
BASE_DIR="${PI_QUICKSTART_DIR:-/tmp}"
STATE_FILE="$BASE_DIR/pi-broker-quickstart.current"

# One state slot: starting a second quickstart before stopping the first would
# silently overwrite this record, leaving the first broker orphaned with no
# way to find it. Refuse instead of leaking a process.
if [ -f "$STATE_FILE" ]; then
  old_pid="$(awk -F= '/^pid=/{print $2}' "$STATE_FILE")"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    echo "quickstart: a broker is already running (pid $old_pid, see $STATE_FILE)." >&2
    echo "quickstart: run 'npm run quickstart:stop' first, or 'kill $old_pid'." >&2
    exit 1
  fi
fi

RUN_DIR="$(mktemp -d "$BASE_DIR/pi-broker-quickstart.XXXXXX")"
SOCKET="$RUN_DIR/broker.sock"

# Target dir for the Pi sessions' OWN cwd/sandbox (see env overrides above).
# Defaults to Pi Broker's own directory, i.e. no change from today.
TARGET_DIR="${PI_QUICKSTART_TARGET_DIR:-}"
if [ -n "$TARGET_DIR" ]; then
  if [ ! -d "$TARGET_DIR" ]; then
    echo "quickstart: PI_QUICKSTART_TARGET_DIR '$TARGET_DIR' is not a directory" >&2
    exit 1
  fi
  TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
fi
SESSION_WORK_DIR="${TARGET_DIR:-$ROOT}"

if [ -n "$TARGET_DIR" ] && [ -z "${PI_QUICKSTART_PI_COMMAND:-}" ]; then
  # npm exec must run with cwd = $ROOT to resolve node_modules and the
  # extension's relative path — but the Pi process itself is about to start
  # with cwd = $TARGET_DIR. Resolve the real pi binary and the extension to
  # absolute paths once, now, while cwd is still $ROOT, and invoke pi
  # directly: no npm exec, so nothing left depending on cwd at launch time.
  PI_BIN="$ROOT/node_modules/.bin/pi"
  if [ ! -x "$PI_BIN" ]; then
    echo "quickstart: $PI_BIN not found; run 'npm install' in $ROOT first" >&2
    exit 1
  fi
  PI_COMMAND="$PI_BIN --extension $ROOT/extensions/pi-broker-bridge.ts"
else
  PI_COMMAND="${PI_QUICKSTART_PI_COMMAND:-npm exec -- pi --extension ./extensions/pi-broker-bridge.ts}"
fi

if [ "${#SOCKET}" -ge 100 ]; then
  echo "quickstart: socket path is too long for a unix socket ($SOCKET)" >&2
  echo "quickstart: set PI_QUICKSTART_DIR to a shorter directory" >&2
  exit 1
fi

# --- broker -----------------------------------------------------------------
node "$ROOT/bin/pi-broker.mjs" serve "$SOCKET" >"$RUN_DIR/broker.log" 2>&1 &
BROKER_PID=$!

for _ in $(seq 1 100); do
  [ -S "$SOCKET" ] && break
  kill -0 "$BROKER_PID" 2>/dev/null || break
  sleep 0.1
done

if [ ! -S "$SOCKET" ]; then
  echo "quickstart: broker failed to start; log follows" >&2
  cat "$RUN_DIR/broker.log" >&2 || true
  kill "$BROKER_PID" 2>/dev/null || true
  exit 1
fi

# --- session windows --------------------------------------------------------
# Shared with the MCP adapter's on-demand provisioning: one implementation of
# "open a visible interactive Pi window", used by both entry points. The
# opener's first argument becomes each launcher's `cd` target, i.e. each Pi
# session's own working directory/sandbox — SESSION_WORK_DIR, not $ROOT,
# so PI_QUICKSTART_TARGET_DIR actually moves the sandbox, not just the shell
# this script itself is running from.
PI_SESSION_PI_COMMAND="$PI_COMMAND" \
PI_SESSION_OPEN="${PI_QUICKSTART_OPEN:-}" \
  bash "$ROOT/scripts/open-pi-windows.sh" "$SESSION_WORK_DIR" "$RUN_DIR" "$SOCKET" "${SESSIONS[@]}"

# An opener exiting 0 only means the launch command was accepted, not that a
# window actually appeared: on macOS, osascript can exit 0 while Terminal.app
# never creates a window (GUI session unreachable, `do script` swallowed).
# So confirm with the broker itself — a session only shows up in `list` once
# its own Pi process has connected — before trusting anything is "up".
REGISTER_TIMEOUT_MS="${PI_QUICKSTART_REGISTER_TIMEOUT_MS:-20000}"
if ! node "$ROOT/scripts/wait-for-sessions.mjs" "$SOCKET" "$REGISTER_TIMEOUT_MS" "${SESSIONS[@]}"; then
  echo "quickstart: window(s) were launched but session(s) never registered with the broker." >&2
  echo "quickstart: broker is still running (pid $BROKER_PID, socket $SOCKET) in case a window is just slow." >&2
  echo "quickstart: start the missing session(s) by hand:" >&2
  for session in "${SESSIONS[@]}"; do
    echo "  PI_BROKER_SOCKET=$SOCKET PI_BROKER_SESSION_ID=$session \\" >&2
    echo "    $PI_COMMAND" >&2
  done
  exit 1
fi

# --- state + operator instructions -----------------------------------------
printf 'pid=%s\nsocket=%s\nrun_dir=%s\n' "$BROKER_PID" "$SOCKET" "$RUN_DIR" >"$STATE_FILE"

cat <<INFO

  pi-broker quickstart is up.

  broker pid : $BROKER_PID
  socket     : $SOCKET
  sessions   : ${SESSIONS[*]}  (one terminal window each, titled "pi-broker <session>")

  Switch between them like any other window.

  See who registered:
    npm exec -- pi-broker list $SOCKET

  Send a turn into a session:
INFO
for session in "${SESSIONS[@]}"; do
  echo "    npm exec -- pi-broker prompt $SOCKET $session 'say hello from the broker'"
done
cat <<INFO

  Interrupt a running turn:
    npm exec -- pi-broker interrupt $SOCKET ${SESSIONS[0]}

  Point an MCP host at it:
    npm exec -- pi-broker mcp $SOCKET

  Stop the broker when you are done (close the Pi windows yourself):
    npm run quickstart:stop        # or: kill $BROKER_PID

INFO
