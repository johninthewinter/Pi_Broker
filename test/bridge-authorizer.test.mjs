// Exercises the real extensions/pi-broker-bridge.ts against a stand-in
// permission service, to prove the authorizer-chain wiring itself — not just
// the broker transport. Node strips types from local .ts sources, so the
// extension under test is the same file Pi loads.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Broker } from "../src/broker.mjs";

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pi-broker-bridge-"));
const socketPath = path.join(runtime, "broker.sock");

// PERMISSION_WAIT_MS is read once at module load, so the env must be set before
// the extension is imported. Short, so the hand-back case is quick to assert.
const WAIT_MS = 400;
process.env.PI_BROKER_SOCKET = socketPath;
process.env.PI_BROKER_SESSION_ID = "alpha";
process.env.PI_BROKER_PERMISSION_TIMEOUT_MS = String(WAIT_MS);

const SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:service");

const { default: piBrokerBridge } = await import(
  "../extensions/pi-broker-bridge.ts"
);

/** Minimal ExtensionAPI/ExtensionContext stand-in with fireable handlers. */
function fakePi() {
  const lifecycle = new Map();
  const events = new Map();
  const notifications = [];
  const ctx = {
    cwd: "/tmp",
    model: { id: "test-model" },
    ui: { setStatus() {}, notify: (m, l) => notifications.push([m, l]) },
    isIdle: () => true,
    abort() {},
    shutdown() {},
    getContextUsage: () => undefined,
  };
  return {
    pi: {
      on: (name, handler) => lifecycle.set(name, handler),
      events: { on: (name, handler) => events.set(name, handler) },
      sendUserMessage() {},
    },
    ctx,
    notifications,
    fire: (name, event) => lifecycle.get(name)?.(event ?? {}, ctx),
    emit: (name, payload) => events.get(name)?.(payload),
  };
}

function controller(socket_path) {
  const socket = net.createConnection(socket_path);
  socket.setEncoding("utf8");
  const events = [];
  let buffer = "";
  socket.on("connect", () =>
    socket.write('{"type":"register","role":"controller"}\n'),
  );
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const split = buffer.indexOf("\n");
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  });
  const write = (value) => socket.write(`${JSON.stringify(value)}\n`);
  return { socket, events, write };
}

async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ask = (requestId, overrides = {}) => ({
  requestId,
  source: "tool_call",
  agentName: "alpha",
  message: "Allow bash: rm -rf build?",
  surface: "bash",
  value: "rm -rf build",
  command: "rm -rf build",
  accessIntent: { surface: "bash" },
  ...overrides,
});

test("the bridge registers a live authorizer a controller can answer", async () => {
  const broker = new Broker(socketPath);
  await broker.start();

  // Stand in for @gotgenes/pi-permission-system: publish a service on the same
  // process-global slot its getPermissionsService() reads, and capture the link
  // the bridge registers. This is the seam the whole feature rests on.
  let registered;
  let disposed = false;
  globalThis[SERVICE_KEY] = {
    registerAuthorizer(name, authorize) {
      assert.equal(name, "pi-broker");
      registered = authorize;
      return () => {
        disposed = true;
      };
    },
  };

  const host = fakePi();
  piBrokerBridge(host.pi);
  host.fire("session_start");
  await waitFor(() => broker.agents.has("alpha"), "the bridge to register");

  const watcher = controller(socketPath);
  await waitFor(() => broker.controllers.size === 1, "the controller");

  // permissions:ready is the documented registration point.
  host.emit("permissions:ready", {});
  await waitFor(() => registered, "the authorizer to be registered");

  // ── A controller answers the ask ────────────────────────────────────────
  const verdict = registered(ask("req-1"), {}, {});

  const request = await waitFor(
    () => watcher.events.find((e) => e.event === "permission_request"),
    "the permission_request event",
  );
  assert.equal(request.sessionId, "alpha");
  assert.equal(request.requestId, "req-1");
  assert.equal(request.surface, "bash");
  assert.equal(request.value, "rm -rf build");
  assert.equal(request.timeoutMs, WAIT_MS);

  watcher.write({
    type: "send",
    id: "c-1",
    target: "alpha",
    action: "permission_respond",
    requestId: "req-1",
    decision: "deny",
    reason: "build is not disposable",
  });

  // The controller's answer resolves the *pending* ask — the thing a
  // permissions:decision listener could only ever observe after the fact.
  assert.deepEqual(await verdict, {
    kind: "deny",
    reason: "build is not disposable",
  });
  const resolved = await waitFor(
    () =>
      watcher.events.find(
        (e) => e.event === "permission_request_resolved" && e.requestId === "req-1",
      ),
    "the resolution event",
  );
  assert.equal(resolved.applied, true);
  assert.equal(resolved.resolvedBy, "controller");

  // ── An allow is a real allow ────────────────────────────────────────────
  const allowVerdict = registered(ask("req-2"), {}, {});
  await waitFor(
    () => watcher.events.find((e) => e.requestId === "req-2"),
    "the second request",
  );
  watcher.write({
    type: "send",
    id: "c-2",
    target: "alpha",
    action: "permission_respond",
    requestId: "req-2",
    decision: "allow",
  });
  assert.deepEqual(await allowVerdict, { kind: "allow" });

  // ── Silence hands the ask back to the human ─────────────────────────────
  // This is what keeps the operator's own TUI button alive: an unanswered ask
  // defers, and the permission system falls through to its terminal authorizer
  // (the interactive prompt) exactly as if this link were not installed.
  const started = Date.now();
  const deferred = await registered(ask("req-3"), {}, {});
  assert.deepEqual(deferred, { kind: "defer" });
  assert.ok(
    Date.now() - started >= WAIT_MS - 50,
    "defer must wait out the controller window, not short-circuit",
  );
  const handback = await waitFor(
    () =>
      watcher.events.find(
        (e) =>
          e.event === "permission_request_resolved" && e.requestId === "req-3",
      ),
    "the hand-back event",
  );
  assert.equal(handback.applied, false);
  assert.equal(handback.resolvedBy, "human");

  // ── A late or duplicate answer is dropped, never misapplied ─────────────
  watcher.write({
    type: "send",
    id: "c-3",
    target: "alpha",
    action: "permission_respond",
    requestId: "req-3",
    decision: "allow",
  });
  const late = await waitFor(
    () =>
      watcher.events.find(
        (e) =>
          e.event === "permission_request_resolved" &&
          e.requestId === "req-3" &&
          e.resolvedBy === "unknown",
      ),
    "the late-answer notice",
  );
  assert.equal(late.applied, false);

  // ── The human's own prompt is still reported to the controller ──────────
  host.emit("permissions:ui_prompt", {
    requestId: "req-3",
    surface: "bash",
    value: "rm -rf build",
    agentName: "alpha",
    message: "Allow bash: rm -rf build?",
  });
  const uiPrompt = await waitFor(
    () => watcher.events.find((e) => e.event === "permission_ui_prompt"),
    "the ui_prompt relay",
  );
  assert.equal(uiPrompt.requestId, "req-3");

  // Shutdown unregisters the link rather than leaving a dead one in the chain.
  host.fire("session_shutdown");
  assert.equal(disposed, true);

  watcher.socket.destroy();
  await broker.close();
  delete globalThis[SERVICE_KEY];
  fs.rmSync(runtime, { recursive: true, force: true });
});
