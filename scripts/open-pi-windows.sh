#!/usr/bin/env bash
# POSIX shim. The window opener itself lives in scripts/open-pi-windows.mjs —
# in Node, because Node is the only runtime this project already requires on
# macOS, Linux, and Windows alike, and bash + AppleScript could never open a
# window anywhere but macOS.
#
# This file exists so the documented POSIX entry point keeps working unchanged
# (scripts/quickstart.sh calls it). It contains no launching logic of its own:
# there is exactly one implementation, and it is the .mjs.
#
# Usage: scripts/open-pi-windows.sh <root> <run-dir> <socket> <session>...
#
# <root> becomes each session's own cwd — the directory its file/bash/edit
# sandbox is scoped to. It is Pi Broker's own directory by default, but
# quickstart.sh points it at PI_QUICKSTART_TARGET_DIR when that is set.
#
# Env overrides (test seams):
#   PI_SESSION_PI_COMMAND  command run inside each session window
#   PI_SESSION_OPEN        opener called as: <opener> <script-path> <title>
#
# No headless Pi (-p / --print / --mode) is used or permitted here.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PI_SESSION_PI_COMMAND="${PI_SESSION_PI_COMMAND:-npm exec -- pi --extension ./extensions/pi-broker-bridge.ts}"
exec node "$HERE/open-pi-windows.mjs" "$@"
