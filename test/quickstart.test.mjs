import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// A stand-in for the interactive Pi TUI: it speaks exactly the part of the
// bridge protocol this test is about — register under PI_BROKER_SESSION_ID,
// echo an injected prompt back as an assistant message, settle. The real Pi
// TUI is covered by `npm run poc`; substituting it here keeps the launcher
// testable without a GUI window or a model provider.
const fakeAgentSource = `
import net from "node:net";
const socket = net.createConnection(process.env.PI_BROKER_SOCKET);
socket.setEncoding("utf8");
const send = (value) => socket.write(JSON.stringify(value) + "\\n");
socket.on("connect", () => {
  send({ type: "register", role: "agent", sessionId: process.env.PI_BROKER_SESSION_ID });
  send({ type: "event", event: "session_start" });
});
let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const split = buffer.indexOf("\\n");
    const line = buffer.slice(0, split);
    buffer = buffer.slice(split + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type !== "command" || message.action !== "prompt") continue;
    send({ type: "event", event: "input", source: "extension", text: message.text });
    send({ type: "event", event: "assistant_message", text: "ECHO:" + message.text });
    send({ type: "event", event: "agent_settled" });
  }
});
setTimeout(() => process.exit(0), 60000);
`;

const openerSource = `#!/usr/bin/env bash
# Test opener: stands in for the osascript Terminal.app window.
nohup bash "$1" >"$(dirname "$1")/$2.log" 2>&1 &
`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("quickstart launches a broker, registers both sessions, and stops cleanly", async (t) => {
  // Short base path on purpose: unix socket paths are capped at 104 bytes.
  const tmp = fs.mkdtempSync("/tmp/qs-test-");
  const agentPath = path.join(tmp, "fake-agent.mjs");
  const openerPath = path.join(tmp, "opener.sh");
  fs.writeFileSync(agentPath, fakeAgentSource);
  fs.writeFileSync(openerPath, openerSource, { mode: 0o755 });

  const env = {
    ...process.env,
    PI_QUICKSTART_DIR: tmp,
    PI_QUICKSTART_PI_COMMAND: `${process.execPath} ${agentPath}`,
    PI_QUICKSTART_OPEN: openerPath
  };

  let brokerPid;
  let socket;
  t.after(() => {
    if (brokerPid && alive(brokerPid)) {
      try {
        process.kill(brokerPid, "SIGKILL");
      } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const { stdout } = await run("bash", ["scripts/quickstart.sh"], { cwd: root, env });

  const pidMatch = stdout.match(/broker pid : (\d+)/);
  const socketMatch = stdout.match(/socket {5}: (\S+)/);
  assert.ok(pidMatch, `no broker pid in output:\n${stdout}`);
  assert.ok(socketMatch, `no socket path in output:\n${stdout}`);
  brokerPid = Number(pidMatch[1]);
  socket = socketMatch[1];

  // 1 — the broker is really running on a real socket.
  assert.ok(alive(brokerPid), "broker process is not alive");
  assert.ok(fs.statSync(socket).isSocket(), `${socket} is not a unix socket`);

  // 2 — the printed prompt one-liner is ready to paste: real socket, no placeholder.
  assert.match(
    stdout,
    new RegExp(`pi-broker prompt ${socket} session-a '`),
    "prompt one-liner is missing or not pre-filled"
  );
  assert.doesNotMatch(stdout, /<socket-path>|<session-id>/);

  // 3 — both sessions register under their recognizable names.
  const listed = await waitFor(async () => {
    const { stdout: out } = await run(
      process.execPath,
      ["bin/pi-broker.mjs", "list", socket],
      { cwd: root }
    );
    const sessions = JSON.parse(out).sessions;
    return sessions.length === 2 ? sessions : null;
  });
  assert.deepEqual(listed, ["session-a", "session-b"]);

  // 4 — a prompt sent with the printed CLI actually reaches the named session.
  const { stdout: promptOut } = await run(
    process.execPath,
    ["bin/pi-broker.mjs", "prompt", socket, "session-b", "hello", "from", "quickstart"],
    { cwd: root }
  );
  assert.deepEqual(JSON.parse(promptOut), {
    target: "session-b",
    response: "ECHO:hello from quickstart"
  });

  // 5 — the stop script really stops it and removes the socket.
  const { stdout: stopOut } = await run("bash", ["scripts/quickstart-stop.sh"], {
    cwd: root,
    env
  });
  assert.match(stopOut, new RegExp(`stopped broker ${brokerPid}`));
  const gone = await waitFor(async () => !alive(brokerPid) && !fs.existsSync(socket), 5000);
  assert.ok(gone, "broker or socket survived quickstart-stop");
});

test("quickstart fails loudly, never prints a false 'is up', when a session never registers", async (t) => {
  // Regression test for the exact failure mode a real quickstart run hit on
  // macOS: `osascript` (or any opener) can exit 0 -- meaning only "the launch
  // command was accepted" -- without Terminal.app ever actually creating a
  // window or starting the session process underneath it. Before
  // wait-for-sessions.mjs existed, quickstart.sh trusted that exit code alone
  // and printed "quickstart is up" regardless, leaving the operator to
  // discover by hand, minutes later, that nothing had actually registered.
  //
  // This opener stands in for that failure: it exits 0 and does nothing
  // else, so no session process ever starts and nothing ever connects to the
  // broker. If quickstart.sh still prints success here, the fix has
  // regressed.
  const tmp = fs.mkdtempSync("/tmp/qs-noreg-test-");
  const openerPath = path.join(tmp, "silent-opener.sh");
  fs.writeFileSync(openerPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  const env = {
    ...process.env,
    PI_QUICKSTART_DIR: tmp,
    PI_QUICKSTART_OPEN: openerPath,
    // Real launches get up to 20s (windows and Pi's own startup take a
    // moment); a session that will never register doesn't need that long to
    // prove it, so shorten it here purely to keep the test fast.
    PI_QUICKSTART_REGISTER_TIMEOUT_MS: "1000"
  };

  t.after(() => {
    // The failure path deliberately leaves the broker running (see the
    // comment in quickstart.sh: a slow-but-real window shouldn't have its
    // broker yanked out from under it) -- so this test has to clean up the
    // orphaned broker process itself instead of relying on quickstart-stop.
    const stateFile = path.join(tmp, "pi-broker-quickstart.current");
    if (fs.existsSync(stateFile)) {
      const pidMatch = fs.readFileSync(stateFile, "utf8").match(/pid=(\d+)/);
      if (pidMatch && alive(Number(pidMatch[1]))) {
        try {
          process.kill(Number(pidMatch[1]), "SIGKILL");
        } catch {}
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await assert.rejects(
    run("bash", ["scripts/quickstart.sh"], { cwd: root, env }),
    (error) => {
      assert.equal(error.code, 1, `expected exit 1, got ${error.code}:\n${error.stderr}`);
      assert.match(error.stderr, /session\(s\) never registered/);
      assert.match(error.stderr, /session-a/);
      assert.match(error.stderr, /session-b/);
      // The one claim this whole fix exists to make true: a caller must
      // never see "is up" unless the sessions are really there.
      assert.doesNotMatch(error.stdout ?? "", /quickstart is up/);
      return true;
    }
  );
});

test("the launcher never invokes Pi headlessly", () => {
  const code = fs
    .readFileSync(path.join(root, "scripts", "quickstart.sh"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.match(
    code,
    /PI_QUICKSTART_PI_COMMAND:-npm exec -- pi --extension \.\/extensions\/pi-broker-bridge\.ts/,
    "default session command is not the ordinary interactive Pi + bridge extension"
  );
  for (const forbidden of [" -p ", "--print", "--mode json", "--mode rpc"]) {
    assert.ok(!code.includes(forbidden), `launcher must not contain ${forbidden}`);
  }
});
