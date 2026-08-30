// The cleanup half of the tmux consolidation layer: removing windows for
// sessions the broker no longer has registered (matching the same "gone" the
// broker signals via its `disconnected` event, see src/broker.mjs).
//
// The diff logic (computeStaleTmuxWindows) is pure and tested directly, with
// no tmux process involved at all. The I/O wrapper (cleanupTmuxWindows) is
// tested against a fake `tmux` binary, the same seam pattern
// test/open-pi-windows.test.mjs uses for terminal emulators. A real-tmux
// integration test runs only when `tmux` is actually on PATH, and skips with
// a clear message otherwise rather than failing the whole suite on a machine
// without it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TMUX_BOOTSTRAP_WINDOW,
  DEFAULT_TMUX_SESSION,
} from "../scripts/open-pi-windows.mjs";
import {
  cleanupTmuxWindows,
  computeStaleTmuxWindows,
  listTmuxWindows,
} from "../scripts/tmux-cleanup.mjs";

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-cleanup-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- pure diff logic -----------------------------------------------------

test("computeStaleTmuxWindows keeps live sessions and the bootstrap window, drops the rest", () => {
  const windowNames = [TMUX_BOOTSTRAP_WINDOW, "session-a", "session-b", "session-c"];
  const liveSessions = ["session-a", "session-c"];
  assert.deepEqual(
    computeStaleTmuxWindows(windowNames, liveSessions),
    ["session-b"],
  );
});

test("computeStaleTmuxWindows never flags the bootstrap window even with zero live sessions", () => {
  assert.deepEqual(
    computeStaleTmuxWindows([TMUX_BOOTSTRAP_WINDOW], []),
    [],
  );
});

test("computeStaleTmuxWindows flags everything when nothing is live", () => {
  assert.deepEqual(
    computeStaleTmuxWindows(["session-a", "session-b"], []),
    ["session-a", "session-b"],
  );
});

test("computeStaleTmuxWindows honours a custom bootstrap window name", () => {
  assert.deepEqual(
    computeStaleTmuxWindows(["home", "session-a"], [], { bootstrapWindow: "home" }),
    ["session-a"],
  );
});

// --- I/O wrapper, against a fake tmux binary ------------------------------

/** Fake `tmux` that answers `list-windows` from a JSON file on disk and logs
 * every `kill-window` invocation, so assertions don't need a real server. */
function fakeTmux(dir, windowNames) {
  fs.writeFileSync(path.join(dir, "windows.json"), JSON.stringify(windowNames));
  const tmuxPath = path.join(dir, "tmux");
  fs.writeFileSync(
    tmuxPath,
    [
      "#!/usr/bin/env bash",
      `LOGDIR="${dir}"`,
      'if [ "$1" = "list-windows" ]; then',
      '  node -e "console.log(JSON.parse(require(\'fs\').readFileSync(process.argv[1],\'utf8\')).join(String.fromCharCode(10)))" "$LOGDIR/windows.json"',
      "  exit 0",
      'elif [ "$1" = "kill-window" ]; then',
      '  echo "$@" >>"$LOGDIR/kills.log"',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return tmuxPath;
}

/** A minimal stand-in broker controller endpoint: answers exactly the
 * register/list round-trip src/autoprovision.mjs's listSessions() expects. */
function fakeBroker(t, sessions) {
  const socketPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "tmux-cleanup-broker-")),
    "broker.sock",
  );
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const split = buffer.indexOf("\n");
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.type === "register") {
          socket.write(`${JSON.stringify({ type: "registered" })}\n`);
        } else if (message.type === "list") {
          socket.write(
            `${JSON.stringify({ id: message.id, sessions })}\n`,
          );
        }
      }
    });
  });
  t.after(() => {
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(socketPath));
  });
}

test("listTmuxWindows returns null when the pi-broker tmux session does not exist", async (t) => {
  const dir = tmpdir(t);
  const tmuxPath = path.join(dir, "tmux");
  fs.writeFileSync(
    tmuxPath,
    "#!/usr/bin/env bash\necho \"can't find session pi-broker\" >&2\nexit 1\n",
    { mode: 0o755 },
  );
  assert.equal(await listTmuxWindows(tmuxPath, DEFAULT_TMUX_SESSION), null);
});

test("cleanupTmuxWindows kills only the windows the broker no longer knows about", async (t) => {
  const dir = tmpdir(t);
  const tmuxCommand = fakeTmux(dir, [
    TMUX_BOOTSTRAP_WINDOW,
    "session-a",
    "session-b",
  ]);
  const socketPath = await fakeBroker(t, ["session-a"]);

  const result = await cleanupTmuxWindows({ socketPath, tmuxCommand });
  assert.deepEqual(result, {
    sessionName: DEFAULT_TMUX_SESSION,
    removed: ["session-b"],
  });
  const kills = fs.readFileSync(path.join(dir, "kills.log"), "utf8").trim().split("\n");
  assert.deepEqual(kills, [`kill-window -t ${DEFAULT_TMUX_SESSION}:session-b`]);
});

test("cleanupTmuxWindows removes nothing when every window is either live or bootstrap", async (t) => {
  const dir = tmpdir(t);
  const tmuxCommand = fakeTmux(dir, [TMUX_BOOTSTRAP_WINDOW, "session-a"]);
  const socketPath = await fakeBroker(t, ["session-a"]);

  const result = await cleanupTmuxWindows({ socketPath, tmuxCommand });
  assert.deepEqual(result, { sessionName: DEFAULT_TMUX_SESSION, removed: [] });
  assert.ok(!fs.existsSync(path.join(dir, "kills.log")));
});

// --- optional real-tmux integration ---------------------------------------

let hasTmux = false;
try {
  execFileSync("which", ["tmux"], { stdio: "ignore" });
  hasTmux = true;
} catch {
  hasTmux = false;
}

test(
  "against a real tmux server: cleanup removes a dead session's window and leaves a live one",
  { skip: !hasTmux && "tmux is not installed on this machine; skipping the real-tmux integration test" },
  async (t) => {
    const dir = tmpdir(t);
    const sessionName = `pi-broker-test-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", sessionName, "-n", TMUX_BOOTSTRAP_WINDOW]);
    execFileSync("tmux", ["new-window", "-t", `${sessionName}:`, "-n", "session-live", "sleep 60"]);
    execFileSync("tmux", ["new-window", "-t", `${sessionName}:`, "-n", "session-dead", "sleep 60"]);
    t.after(() => {
      try {
        execFileSync("tmux", ["kill-session", "-t", sessionName]);
      } catch {}
    });

    const socketPath = await fakeBroker(t, ["session-live"]);
    const result = await cleanupTmuxWindows({ socketPath, sessionName });
    assert.deepEqual(result, { sessionName, removed: ["session-dead"] });

    const remaining = await listTmuxWindows("tmux", sessionName);
    assert.deepEqual(
      new Set(remaining),
      new Set([TMUX_BOOTSTRAP_WINDOW, "session-live"]),
    );
  },
);
