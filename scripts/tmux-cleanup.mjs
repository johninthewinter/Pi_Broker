#!/usr/bin/env node
// Cleanup half of the tmux consolidation layer (scripts/open-pi-windows.mjs
// builds the windows; this removes the stale ones).
//
// A tmux window whose Pi process exited closes itself in the ordinary case,
// but the more useful cleanup target is windows for sessions the *broker* no
// longer has registered as a live agent — the same "gone" the broker itself
// signals via its `disconnected` event (src/broker.mjs). This diffs
// `tmux list-windows -t pi-broker` against `listSessions(socketPath)` (the
// same controller round-trip src/autoprovision.mjs already uses) and kills
// every window that is neither a live session nor the bootstrap window.
//
// Usage: node scripts/tmux-cleanup.mjs [socket]
//   (with no socket argument, uses the same deterministic default path every
//   other entry point in this repo falls back to — see defaultSocketPath())
//
// Env overrides (test seam, mirrors PI_SESSION_OPEN in open-pi-windows.mjs):
//   PI_BROKER_TMUX_COMMAND  tmux binary to invoke (default: "tmux")

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultSocketPath, listSessions } from "../src/autoprovision.mjs";
import { DEFAULT_TMUX_SESSION, TMUX_BOOTSTRAP_WINDOW } from "./open-pi-windows.mjs";

const execFileAsync = promisify(execFile);

/**
 * Pure diff: which tmux window names are neither a currently-registered
 * session nor the bootstrap window. Exported and kept free of any tmux or
 * broker I/O so it is testable without a real tmux process or a real broker.
 */
export function computeStaleTmuxWindows(
  windowNames,
  liveSessions,
  { bootstrapWindow = TMUX_BOOTSTRAP_WINDOW } = {},
) {
  const live = new Set(liveSessions);
  return windowNames.filter(
    (name) => name !== bootstrapWindow && !live.has(name),
  );
}

/**
 * The window names currently in the pi-broker tmux session, or `null` if
 * that tmux session does not exist at all (nothing to clean up — not an
 * error, since "no session yet" is the ordinary state before the first
 * session has ever been opened).
 */
export async function listTmuxWindows(tmuxCommand, sessionName) {
  try {
    const { stdout } = await execFileAsync(tmuxCommand, [
      "list-windows",
      "-t",
      sessionName,
      "-F",
      "#{window_name}",
    ]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const message = `${error.stderr || error.message || ""}`;
    if (/can't find session|no server running/i.test(message)) return null;
    throw error;
  }
}

/**
 * Remove every tmux window in the pi-broker session that does not correspond
 * to a session the broker currently has registered, leaving the bootstrap
 * window and every live session's window untouched.
 */
export async function cleanupTmuxWindows({
  socketPath,
  tmuxCommand = process.env.PI_BROKER_TMUX_COMMAND || "tmux",
  sessionName = DEFAULT_TMUX_SESSION,
  bootstrapWindow = TMUX_BOOTSTRAP_WINDOW,
} = {}) {
  const windowNames = await listTmuxWindows(tmuxCommand, sessionName);
  if (windowNames === null) return { sessionName, removed: [] };

  const liveSessions = await listSessions(socketPath);
  const stale = computeStaleTmuxWindows(windowNames, liveSessions, {
    bootstrapWindow,
  });
  for (const name of stale) {
    await execFileAsync(tmuxCommand, [
      "kill-window",
      "-t",
      `${sessionName}:${name}`,
    ]);
  }
  return { sessionName, removed: stale };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const socketPath = process.argv[2] || defaultSocketPath();
  try {
    const result = await cleanupTmuxWindows({ socketPath });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`pi-broker: tmux cleanup failed: ${error.message}\n`);
    process.exit(1);
  }
}
