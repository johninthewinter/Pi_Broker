// scripts/tmux-dashboard.mjs: a tiled, non-destructive multi-pane view of
// every live Pi Broker session, built from tmux's "grouped session" feature
// — never join-pane, never touching the pi-broker session's own windows.
// See the top-of-file comment in tmux-dashboard.mjs for why a simpler
// nested-attach approach was tried and rejected first (it does not give
// each pane an independent current-window).
//
// Pure logic (computeDashboardTargets, buildDashboardCommands,
// viewSessionName) is tested directly, no process involved. The I/O wrapper
// (openTmuxDashboard) is tested against a fake `tmux` binary, the same seam
// pattern test/tmux-cleanup.test.mjs and test/open-pi-windows.test.mjs use.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TMUX_BOOTSTRAP_WINDOW, DEFAULT_TMUX_SESSION } from "../scripts/open-pi-windows.mjs";
import {
  DEFAULT_DASHBOARD_SESSION,
  buildDashboardCommands,
  computeDashboardTargets,
  openTmuxDashboard,
  viewSessionName,
} from "../scripts/tmux-dashboard.mjs";

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-dashboard-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- pure logic ------------------------------------------------------------

test("viewSessionName is deterministic and index-scoped", () => {
  assert.equal(viewSessionName("pi-broker-dashboard", 0), "pi-broker-dashboard-view-0");
  assert.equal(viewSessionName("pi-broker-dashboard", 2), "pi-broker-dashboard-view-2");
});

test("computeDashboardTargets drops the bootstrap window and keeps every real session", () => {
  assert.deepEqual(
    computeDashboardTargets([TMUX_BOOTSTRAP_WINDOW, "session-a", "session-b"]),
    ["session-a", "session-b"],
  );
});

test("computeDashboardTargets returns empty when only the bootstrap window exists", () => {
  assert.deepEqual(computeDashboardTargets([TMUX_BOOTSTRAP_WINDOW]), []);
});

test("buildDashboardCommands creates one grouped view session per window, selects its window, attaches a pane to it, then tiles", () => {
  const commands = buildDashboardCommands({
    sessionName: "pi-broker",
    dashboardSessionName: "pi-broker-dashboard",
    windowNames: ["session-a", "session-b"],
  });
  assert.deepEqual(commands, [
    ["new-session", "-d", "-t", "pi-broker", "-s", "pi-broker-dashboard-view-0"],
    ["select-window", "-t", "pi-broker-dashboard-view-0:session-a"],
    [
      "new-session",
      "-d",
      "-s",
      "pi-broker-dashboard",
      "-n",
      "dashboard",
      "env -u TMUX 'tmux' attach -t 'pi-broker-dashboard-view-0'",
    ],
    ["new-session", "-d", "-t", "pi-broker", "-s", "pi-broker-dashboard-view-1"],
    ["select-window", "-t", "pi-broker-dashboard-view-1:session-b"],
    [
      "split-window",
      "-t",
      "pi-broker-dashboard:dashboard",
      "env -u TMUX 'tmux' attach -t 'pi-broker-dashboard-view-1'",
    ],
    ["select-layout", "-t", "pi-broker-dashboard:dashboard", "tiled"],
  ]);
});

test("buildDashboardCommands with a single window still tiles (a no-op layout call, harmless)", () => {
  const commands = buildDashboardCommands({
    sessionName: "pi-broker",
    dashboardSessionName: "pi-broker-dashboard",
    windowNames: ["session-a"],
  });
  // new-session (view-0), select-window, new-session (dashboard), select-layout
  assert.equal(commands.length, 4);
  assert.equal(commands[2][0], "new-session");
  assert.equal(commands[2][3], "pi-broker-dashboard"); // -s pi-broker-dashboard
  assert.equal(commands[3][0], "select-layout");
});

test("buildDashboardCommands refuses to build an empty dashboard", () => {
  assert.throws(
    () => buildDashboardCommands({ windowNames: [] }),
    /nothing to dashboard/,
  );
});

test("buildDashboardCommands quotes a view session name so a hostile window name cannot inject extra tmux commands", () => {
  const commands = buildDashboardCommands({
    sessionName: "pi-broker",
    dashboardSessionName: "pi-broker-dashboard",
    windowNames: ["'; rm -rf /; echo '"],
  });
  // The hostile string lands in the plain (non-shell) select-window argv —
  // harmless there, tmux just fails to find a window with that literal
  // name — and never reaches the shell-interpreted attach command at all,
  // since the pane's command only ever names the *view session*
  // (pi-broker-dashboard-view-0), a name this script controls entirely.
  assert.deepEqual(commands[1], [
    "select-window",
    "-t",
    "pi-broker-dashboard-view-0:'; rm -rf /; echo '",
  ]);
  const attachArg = commands[2][commands[2].length - 1];
  assert.equal(attachArg, "env -u TMUX 'tmux' attach -t 'pi-broker-dashboard-view-0'");
});

// --- I/O wrapper, against a fake tmux ---------------------------------------

function fakeTmux(dir, windowNames, { existingSessions = [] } = {}) {
  fs.writeFileSync(path.join(dir, "windows.json"), JSON.stringify(windowNames));
  fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify(existingSessions));
  const tmuxPath = path.join(dir, "tmux");
  fs.writeFileSync(
    tmuxPath,
    [
      "#!/usr/bin/env bash",
      `LOGDIR="${dir}"`,
      'if [ "$1" = "list-windows" ]; then',
      '  node -e "console.log(JSON.parse(require(\'fs\').readFileSync(process.argv[1],\'utf8\')).join(String.fromCharCode(10)))" "$LOGDIR/windows.json"',
      "  exit 0",
      'elif [ "$1" = "list-sessions" ]; then',
      '  node -e "console.log(JSON.parse(require(\'fs\').readFileSync(process.argv[1],\'utf8\')).join(String.fromCharCode(10)))" "$LOGDIR/sessions.json"',
      "  exit 0",
      "else",
      '  echo "$@" >>"$LOGDIR/commands.log"',
      "  exit 0",
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return tmuxPath;
}

test("openTmuxDashboard builds a grouped view + pane per live window and reports them back", async (t) => {
  const dir = tmpdir(t);
  const tmuxCommand = fakeTmux(dir, [TMUX_BOOTSTRAP_WINDOW, "session-a", "session-b"]);

  const result = await openTmuxDashboard({ tmuxCommand });
  assert.deepEqual(result, {
    dashboardSessionName: DEFAULT_DASHBOARD_SESSION,
    windows: ["session-a", "session-b"],
  });

  const commands = fs.readFileSync(path.join(dir, "commands.log"), "utf8").trim().split("\n");
  assert.ok(commands.some((line) => line.startsWith("new-session -d -t pi-broker -s pi-broker-dashboard-view-0")));
  assert.ok(commands.some((line) => line.startsWith("select-window -t pi-broker-dashboard-view-0:session-a")));
  assert.ok(commands.some((line) => line.startsWith("new-session -d -t pi-broker -s pi-broker-dashboard-view-1")));
  assert.ok(commands.some((line) => line.startsWith("select-window -t pi-broker-dashboard-view-1:session-b")));
  assert.ok(commands.some((line) => line.startsWith("split-window")));
  assert.ok(commands[commands.length - 1].startsWith("select-layout"));
});

test("openTmuxDashboard kills a prior dashboard session and every one of its view sessions before rebuilding", async (t) => {
  const dir = tmpdir(t);
  const tmuxCommand = fakeTmux(dir, [TMUX_BOOTSTRAP_WINDOW, "session-a"], {
    existingSessions: [
      DEFAULT_TMUX_SESSION,
      DEFAULT_DASHBOARD_SESSION,
      viewSessionName(DEFAULT_DASHBOARD_SESSION, 0),
      viewSessionName(DEFAULT_DASHBOARD_SESSION, 1),
      "some-unrelated-session",
    ],
  });

  await openTmuxDashboard({ tmuxCommand });
  const commands = fs.readFileSync(path.join(dir, "commands.log"), "utf8").trim().split("\n");
  const kills = commands.filter((line) => line.startsWith("kill-session"));
  assert.deepEqual(kills.sort(), [
    `kill-session -t ${DEFAULT_DASHBOARD_SESSION}`,
    `kill-session -t ${viewSessionName(DEFAULT_DASHBOARD_SESSION, 0)}`,
    `kill-session -t ${viewSessionName(DEFAULT_DASHBOARD_SESSION, 1)}`,
  ].sort());
  // The unrelated session, and the pi-broker session itself, must never be
  // touched by dashboard cleanup. Exact-match, not substring — a substring
  // check would falsely flag "kill-session -t pi-broker-dashboard-view-0" as
  // touching "pi-broker" too, since it starts with that string.
  assert.ok(!kills.includes("kill-session -t some-unrelated-session"));
  assert.ok(!kills.includes(`kill-session -t ${DEFAULT_TMUX_SESSION}`));
});

test("openTmuxDashboard is a no-op cleanup on an ordinary first run (nothing stale to kill)", async (t) => {
  const dir = tmpdir(t);
  const tmuxCommand = fakeTmux(dir, [TMUX_BOOTSTRAP_WINDOW, "session-a"], {
    existingSessions: [DEFAULT_TMUX_SESSION],
  });
  await openTmuxDashboard({ tmuxCommand });
  const commands = fs.readFileSync(path.join(dir, "commands.log"), "utf8").trim().split("\n");
  assert.ok(!commands.some((line) => line.startsWith("kill-session")));
});

test("openTmuxDashboard refuses when the pi-broker tmux session does not exist at all", async (t) => {
  const dir = tmpdir(t);
  const tmuxPath = path.join(dir, "tmux");
  fs.writeFileSync(
    tmuxPath,
    "#!/usr/bin/env bash\necho \"can't find session pi-broker\" >&2\nexit 1\n",
    { mode: 0o755 },
  );
  await assert.rejects(
    openTmuxDashboard({ tmuxCommand: tmuxPath }),
    /nothing to dashboard yet/,
  );
});

test("openTmuxDashboard refuses when only the bootstrap window is live", async (t) => {
  const dir = tmpdir(t);
  const tmuxCommand = fakeTmux(dir, [TMUX_BOOTSTRAP_WINDOW]);
  await assert.rejects(openTmuxDashboard({ tmuxCommand }), /nothing to dashboard/);
});

// --- optional real-tmux integration ---------------------------------------
//
// This is the exact scenario a fake-tmux unit test cannot prove: that a
// plain `tmux attach -t session:window` does NOT pin what a client displays
// (verified live during development — two clients both ended up showing
// whichever window was last selected, not their own target), and that the
// grouped-session fix genuinely gives each pane an independent, correct
// current-window against a real tmux server — not just the right argv.

let hasTmux = false;
try {
  execFileSync("which", ["tmux"], { stdio: "ignore" });
  hasTmux = true;
} catch {
  hasTmux = false;
}

test(
  "against a real tmux server: each dashboard pane shows its own distinct window, source untouched",
  { skip: !hasTmux && "tmux is not installed on this machine; skipping the real-tmux integration test" },
  async (t) => {
    const sessionName = `pi-broker-dashboard-test-${process.pid}`;
    const dashboardSessionName = `${sessionName}-dashboard`;
    execFileSync("tmux", ["new-session", "-d", "-s", sessionName, "-n", TMUX_BOOTSTRAP_WINDOW]);
    execFileSync("tmux", ["new-window", "-t", `${sessionName}:`, "-n", "alpha", "sleep 60"]);
    execFileSync("tmux", ["new-window", "-t", `${sessionName}:`, "-n", "beta", "sleep 60"]);
    t.after(() => {
      for (const name of [
        dashboardSessionName,
        viewSessionName(dashboardSessionName, 0),
        viewSessionName(dashboardSessionName, 1),
        sessionName,
      ]) {
        try {
          execFileSync("tmux", ["kill-session", "-t", name]);
        } catch {
          // Already gone, or never existed — fine, this is best-effort teardown.
        }
      }
    });

    const result = await openTmuxDashboard({
      tmuxCommand: "tmux",
      sessionName,
      dashboardSessionName,
    });
    assert.deepEqual(result, { dashboardSessionName, windows: ["alpha", "beta"] });

    // Give tmux a moment to finish spawning the nested attach clients before
    // asking them what they're showing.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const paneTtysOutput = execFileSync("tmux", [
      "list-panes",
      "-t",
      `${dashboardSessionName}:dashboard`,
      "-F",
      "#{pane_tty}",
    ]).toString();
    const paneTtys = paneTtysOutput.trim().split("\n").filter(Boolean);
    assert.equal(paneTtys.length, 2, "dashboard window must have exactly one pane per target");

    const shownWindows = paneTtys.map((tty) =>
      execFileSync("tmux", [
        "display-message",
        "-p",
        "-c",
        tty,
        "-t",
        tty,
        "#{window_name}",
      ])
        .toString()
        .trim(),
    );
    assert.deepEqual(new Set(shownWindows), new Set(["alpha", "beta"]));

    // The whole point: the source session's own windows and panes are
    // completely unaffected by any of this.
    const sourceWindows = execFileSync("tmux", [
      "list-windows",
      "-t",
      sessionName,
      "-F",
      "#{window_name}:#{window_panes}",
    ])
      .toString()
      .trim()
      .split("\n");
    assert.deepEqual(
      new Set(sourceWindows),
      new Set([`${TMUX_BOOTSTRAP_WINDOW}:1`, "alpha:1", "beta:1"]),
    );
  },
);
