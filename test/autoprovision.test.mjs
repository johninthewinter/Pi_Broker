import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Stand-in for the interactive Pi TUI, same shape as test/quickstart.test.mjs:
// it speaks only the part of the bridge protocol these tests are about. The
// real interactive Pi in a real Terminal.app window is proven by
// docs/proofs/2026-08-11-mcp-autoprovision.md and `npm run poc`.
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
    send({ type: "event", event: "assistant_message", text: "ECHO:" + message.text });
    send({ type: "event", event: "agent_settled" });
  }
});
setTimeout(() => process.exit(0), 60000);
`;

// Stands in for the osascript Terminal.app window, and records every window it
// was asked to open so a test can prove none was opened twice.
const openerSource = `#!/usr/bin/env bash
echo "$2" >>"$(dirname "$1")/windows.log"
nohup bash "$1" >"$(dirname "$1")/$2.log" 2>&1 &
`;

const failingOpenerSource = `#!/usr/bin/env bash
echo "no window server here" >&2
exit 3
`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function connect(runtimeDir, openerPath, agentPath, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", "mcp-server.mjs")],
    cwd: root,
    stderr: "pipe",
    env: {
      ...process.env,
      PI_BROKER_RUNTIME_DIR: runtimeDir,
      PI_SESSION_OPEN: openerPath,
      PI_SESSION_PI_COMMAND: `${process.execPath} ${agentPath}`,
      PI_BROKER_SESSION_TIMEOUT_MS: "15000",
    },
    ...extraEnv,
  });
  const client = new Client({ name: "autoprovision-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

function setup(t) {
  // Short base path on purpose: unix socket paths are capped at 104 bytes.
  const dir = fs.mkdtempSync("/tmp/ap-test-");
  const agentPath = path.join(dir, "fake-agent.mjs");
  const openerPath = path.join(dir, "opener.sh");
  fs.writeFileSync(agentPath, fakeAgentSource);
  fs.writeFileSync(openerPath, openerSource, { mode: 0o755 });
  t.after(() => {
    // The auto-started broker is detached on purpose (it must outlive the
    // adapter so a reconnect finds it) — so this test has to reap it itself.
    try {
      execFileSync("pkill", ["-f", `src/broker.mjs ${path.join(dir, "broker.sock")}`]);
    } catch {}
    try {
      execFileSync("pkill", ["-f", path.join(dir, "fake-agent.mjs")]);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, agentPath, openerPath };
}

test("a cold MCP connection starts the broker and provisions a session on first prompt", async (t) => {
  const { dir, agentPath, openerPath } = setup(t);
  const socketPath = path.join(dir, "broker.sock");

  // Cold: no broker, no quickstart, nothing listening.
  assert.ok(!fs.existsSync(socketPath), "socket should not exist yet");

  const { client, transport } = await connect(dir, openerPath, agentPath);
  t.after(() => transport.close());

  // 1 — the adapter started a broker by itself, at the deterministic path.
  assert.ok(fs.statSync(socketPath).isSocket(), `${socketPath} is not a socket`);

  // 2 — nothing was provisioned merely by connecting: no window, no session.
  const listedBefore = await client.callTool({
    name: "pi_list",
    arguments: {},
  });
  assert.deepEqual(listedBefore.structuredContent, { sessions: [] });
  assert.ok(!fs.existsSync(path.join(dir, "windows.log")));

  // 3 — the first prompt to an unknown target opens a window for it and reaches it.
  const prompted = await client.callTool({
    name: "pi_prompt",
    arguments: { target: "session-a", text: "hello" },
  });
  assert.deepEqual(prompted.structuredContent, {
    target: "session-a",
    response: "ECHO:hello",
  });
  assert.deepEqual(
    fs.readFileSync(path.join(dir, "windows.log"), "utf8").trim().split("\n"),
    ["pi-broker session-a"],
  );

  // 4 — the window really was a launcher for the ordinary session command,
  //     carrying the broker socket and its own session id.
  const launcher = fs.readFileSync(path.join(dir, "session-a.sh"), "utf8");
  assert.match(launcher, new RegExp(`PI_BROKER_SOCKET="${socketPath}"`));
  assert.match(launcher, /PI_BROKER_SESSION_ID="session-a"/);

  const listedAfter = await client.callTool({ name: "pi_list", arguments: {} });
  assert.deepEqual(listedAfter.structuredContent, { sessions: ["session-a"] });
});

test("a second MCP connection reuses the broker and does not duplicate a session", async (t) => {
  const { dir, agentPath, openerPath } = setup(t);
  const socketPath = path.join(dir, "broker.sock");

  const first = await connect(dir, openerPath, agentPath);
  t.after(() => first.transport.close());
  await first.client.callTool({
    name: "pi_prompt",
    arguments: { target: "session-a", text: "one" },
  });
  const socketInode = fs.statSync(socketPath).ino;

  // A completely separate adapter process, as a second host would start.
  const second = await connect(dir, openerPath, agentPath);
  t.after(() => second.transport.close());

  // 1 — same socket, not a replacement: the first broker is still the broker.
  assert.equal(fs.statSync(socketPath).ino, socketInode);

  // 2 — the second connection can see the session the first one provisioned.
  const listed = await second.client.callTool({
    name: "pi_list",
    arguments: {},
  });
  assert.deepEqual(listed.structuredContent, { sessions: ["session-a"] });

  // 3 — prompting the existing session from the second connection opens no
  //     second window and still reaches the one live session.
  const prompted = await second.client.callTool({
    name: "pi_prompt",
    arguments: { target: "session-a", text: "two" },
  });
  assert.deepEqual(prompted.structuredContent, {
    target: "session-a",
    response: "ECHO:two",
  });
  assert.deepEqual(
    fs.readFileSync(path.join(dir, "windows.log"), "utf8").trim().split("\n"),
    ["pi-broker session-a"],
    "a window was opened twice for one session",
  );

  // 4 — a different target still gets its own window.
  await second.client.callTool({
    name: "pi_prompt",
    arguments: { target: "session-b", text: "three" },
  });
  assert.deepEqual(
    fs.readFileSync(path.join(dir, "windows.log"), "utf8").trim().split("\n"),
    ["pi-broker session-a", "pi-broker session-b"],
  );
});

test("a machine that cannot open a window gets an honest error, never a hidden session", async (t) => {
  const { dir, agentPath } = setup(t);
  const failing = path.join(dir, "failing-opener.sh");
  fs.writeFileSync(failing, failingOpenerSource, { mode: 0o755 });

  const { client, transport } = await connect(dir, failing, agentPath);
  t.after(() => transport.close());

  const outcome = await client.callTool({
    name: "pi_prompt",
    arguments: { target: "session-a", text: "hello" },
  });
  assert.equal(outcome.isError, true);
  // And nothing was quietly registered behind the operator's back.
  const listed = await client.callTool({ name: "pi_list", arguments: {} });
  assert.deepEqual(listed.structuredContent, { sessions: [] });
});

test("auto-provisioning never reaches for a headless Pi", () => {
  const strip = (file) =>
    fs
      .readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith("#") && !trimmed.startsWith("//");
      })
      .join("\n");

  const shared = strip("scripts/open-pi-windows.sh");
  assert.match(
    shared,
    /PI_SESSION_PI_COMMAND:-npm exec -- pi --extension \.\/extensions\/pi-broker-bridge\.ts/,
    "shared window opener's default session command is not ordinary interactive Pi",
  );
  for (const file of [
    "scripts/open-pi-windows.sh",
    "scripts/quickstart.sh",
    "src/autoprovision.mjs",
    "src/mcp-server.mjs",
  ]) {
    const code = strip(file);
    for (const forbidden of [" -p ", "--print", "--mode json", "--mode rpc"]) {
      assert.ok(
        !code.includes(forbidden),
        `${file} must not contain ${forbidden}`,
      );
    }
  }

  // The two entry points must agree on the session command, or "seamless" and
  // "what quickstart proved" would drift apart.
  const quickstart = strip("scripts/quickstart.sh");
  const defaultCommand =
    /pi --extension \.\/extensions\/pi-broker-bridge\.ts/;
  assert.match(quickstart, defaultCommand);
  assert.match(shared, defaultCommand);
});

test("the default socket path is deterministic and shared", async () => {
  const { defaultSocketPath } = await import("../src/autoprovision.mjs");
  const previous = process.env.PI_BROKER_RUNTIME_DIR;
  const previousSocket = process.env.PI_BROKER_SOCKET;
  delete process.env.PI_BROKER_SOCKET;
  delete process.env.PI_BROKER_RUNTIME_DIR;
  try {
    const a = defaultSocketPath();
    const b = defaultSocketPath();
    assert.equal(a, b);
    assert.match(a, /^\/tmp\/pi-broker-\d+\/broker\.sock$/);
    assert.ok(a.length < 100, "default socket path must fit in a unix socket");
  } finally {
    if (previous !== undefined) process.env.PI_BROKER_RUNTIME_DIR = previous;
    if (previousSocket !== undefined)
      process.env.PI_BROKER_SOCKET = previousSocket;
  }
});
