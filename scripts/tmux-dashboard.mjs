#!/usr/bin/env node
// A tiled, read/write view of every live Pi Broker session at once, built
// entirely from tmux's own primitives — no join-pane, no plugin, nothing
// destructive to the sessions being viewed.
//
// The obvious tmux-native tool for "see several panes at once" is
// `join-pane`, which physically moves a pane out of its window into another.
// That's a real hazard here: the moved-from window loses its only pane and
// tmux destroys it, and every other Pi Broker command (`prompt`, `interrupt`,
// `tmux-cleanup`) addresses a session by that window's *name* — losing or
// renaming it on the way back out (`break-pane`) would silently break those
// commands until it's put back exactly right. This script never touches the
// pi-broker session's own windows at all.
//
// The mechanism (verified live, not assumed — two earlier, plausible-looking
// approaches were tried and disproved before this one):
//   - A plain `tmux attach -t session:window` does NOT pin what a client
//     displays. tmux's "current window" is a property of the *session*, not
//     the client — every ordinary client attached to the same session shows
//     the same current window, so N clients each attaching to the same
//     source session and each running `select-window` for a different
//     window just kept overriding each other; all of them ended up showing
//     whichever selection ran last.
//   - The fix is tmux's "grouped session" feature: `new-session -t <source>
//     -s <name>` creates a *new* session that shares the source session's
//     windows (same underlying panes — nothing copied or moved) but tracks
//     its own current-window pointer independently. One grouped session per
//     target window, each pre-selected to that window, gives each dashboard
//     pane's client a genuinely independent viewport — confirmed live: two
//     grouped sessions, two different `select-window` targets, two clients
//     simultaneously showing two different windows of the same source
//     session, with the source session's own windows completely unaffected
//     throughout.
//
// Usage: node scripts/tmux-dashboard.mjs [dashboardSessionName]
//   (defaults to pi-broker-dashboard)
//
// Env overrides (same test seam every other script in this repo uses):
//   PI_BROKER_TMUX_COMMAND  tmux binary to invoke (default: "tmux")

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listTmuxWindows } from "./tmux-cleanup.mjs";
import { DEFAULT_TMUX_SESSION, TMUX_BOOTSTRAP_WINDOW } from "./open-pi-windows.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_DASHBOARD_SESSION = "pi-broker-dashboard";
const VIEW_SESSION_INFIX = "-view-";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * The grouped-session name for the Nth pane's viewport. Exported so cleanup
 * (in this file and by an operator poking at tmux directly) can recognize
 * these sessions by name without re-deriving the pattern.
 */
export function viewSessionName(dashboardSessionName, index) {
  return `${dashboardSessionName}${VIEW_SESSION_INFIX}${index}`;
}

/**
 * Which windows the dashboard should show: every window in the pi-broker
 * session except the bootstrap one. Pure diff, no I/O, mirrors
 * computeStaleTmuxWindows's shape in tmux-cleanup.mjs.
 */
export function computeDashboardTargets(windowNames, { bootstrapWindow = TMUX_BOOTSTRAP_WINDOW } = {}) {
  return windowNames.filter((name) => name !== bootstrapWindow);
}

/**
 * The full tmux argv sequence that builds the dashboard from scratch: one
 * grouped "view" session per target window (each pre-selected to that
 * window), one dashboard pane attached to each view session, then a tiled
 * layout so every pane is visible at once. Pure and independently testable —
 * no process spawned here.
 *
 * `env -u TMUX` on the pane's attach, not a bare `tmux attach`: every tmux
 * pane's shell inherits `$TMUX` identifying the *outer* (dashboard) session,
 * and tmux treats that as a nested session by default — printing a warning
 * banner and requiring the prefix key twice. Unsetting it for just that one
 * command makes each dashboard pane behave like an ordinary top-level
 * attach, prefix key included, once inside it.
 */
export function buildDashboardCommands({
  sessionName = DEFAULT_TMUX_SESSION,
  dashboardSessionName = DEFAULT_DASHBOARD_SESSION,
  windowNames,
}) {
  if (windowNames.length === 0) {
    throw new Error("no live Pi Broker windows to show — nothing to dashboard");
  }

  const commands = [];
  const paneCommand = (windowName, index) => {
    const view = viewSessionName(dashboardSessionName, index);
    commands.push(["new-session", "-d", "-t", sessionName, "-s", view]);
    commands.push(["select-window", "-t", `${view}:${windowName}`]);
    return `env -u TMUX ${shellQuote("tmux")} attach -t ${shellQuote(view)}`;
  };

  commands.push([
    "new-session",
    "-d",
    "-s",
    dashboardSessionName,
    "-n",
    "dashboard",
    paneCommand(windowNames[0], 0),
  ]);
  windowNames.slice(1).forEach((windowName, offset) => {
    commands.push([
      "split-window",
      "-t",
      `${dashboardSessionName}:dashboard`,
      paneCommand(windowName, offset + 1),
    ]);
  });
  commands.push(["select-layout", "-t", `${dashboardSessionName}:dashboard`, "tiled"]);
  return commands;
}

/**
 * Kill every helper view-session for a dashboard name, plus the dashboard
 * session itself. Best-effort throughout: on an ordinary first run, or after
 * an operator has already torn the dashboard down by hand, there is nothing
 * to kill and every one of these calls is expected to fail — that failure is
 * swallowed, not surfaced.
 *
 * The view sessions are the reason this exists at all, not just the
 * dashboard: killing the dashboard session ends its panes' attached clients,
 * but a tmux session persists with no client attached (that is ordinary tmux
 * behavior, not a bug), so the grouped view sessions from a previous run
 * would otherwise accumulate silently across repeated dashboard rebuilds.
 */
async function killDashboardAndViews(tmuxCommand, dashboardSessionName) {
  let listed = [];
  try {
    const { stdout } = await execFileAsync(tmuxCommand, [
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    listed = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    // No tmux server at all yet — nothing to kill.
    return;
  }
  const prefix = `${dashboardSessionName}${VIEW_SESSION_INFIX}`;
  const stale = listed.filter(
    (name) => name === dashboardSessionName || name.startsWith(prefix),
  );
  for (const name of stale) {
    try {
      await execFileAsync(tmuxCommand, ["kill-session", "-t", name]);
    } catch {
      // Already gone between listing and killing — fine.
    }
  }
}

/**
 * Build (or replace) the dashboard session. If a dashboard session (and its
 * helper view sessions) from a previous run are still around, they are
 * killed first — same "one attach point, always current" contract the
 * pi-broker session itself has, rather than accumulating stale dashboards
 * with a stale set of windows.
 */
export async function openTmuxDashboard({
  tmuxCommand = process.env.PI_BROKER_TMUX_COMMAND || "tmux",
  sessionName = DEFAULT_TMUX_SESSION,
  dashboardSessionName = DEFAULT_DASHBOARD_SESSION,
  bootstrapWindow = TMUX_BOOTSTRAP_WINDOW,
} = {}) {
  const windowNames = await listTmuxWindows(tmuxCommand, sessionName);
  if (windowNames === null) {
    throw new Error(`no "${sessionName}" tmux session — nothing to dashboard yet`);
  }
  const targets = computeDashboardTargets(windowNames, { bootstrapWindow });

  await killDashboardAndViews(tmuxCommand, dashboardSessionName);

  const commands = buildDashboardCommands({ sessionName, dashboardSessionName, windowNames: targets });
  for (const command of commands) {
    await execFileAsync(tmuxCommand, command);
  }
  return { dashboardSessionName, windows: targets };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const dashboardSessionName = process.argv[2] || DEFAULT_DASHBOARD_SESSION;
  try {
    const result = await openTmuxDashboard({ dashboardSessionName });
    process.stdout.write(
      `pi-broker: dashboard ready with ${result.windows.length} pane(s) — attach with:\n` +
        `  tmux attach -t ${result.dashboardSessionName}\n`,
    );
  } catch (error) {
    process.stderr.write(`pi-broker: dashboard failed: ${error.message}\n`);
    process.exit(1);
  }
}
