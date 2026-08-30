import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Broker } from "../src/broker.mjs";
import {
  isValidMessage,
  parseMessage,
  permissionRequestMessage,
  permissionRespondMessage,
} from "../src/protocol.mjs";

test("protocol freezes the permission-answer shapes and rejects bad verdicts", () => {
  const respond = permissionRespondMessage(
    "cli-1",
    "alpha",
    "req-7",
    "deny",
    "path looks like a typo",
  );
  assert.deepEqual(parseMessage(JSON.stringify(respond)), {
    type: "send",
    id: "cli-1",
    target: "alpha",
    action: "permission_respond",
    requestId: "req-7",
    decision: "deny",
    reason: "path looks like a typo",
  });
  // reason is optional; the three verdicts are the whole vocabulary.
  for (const decision of ["allow", "deny", "defer"])
    assert.equal(
      isValidMessage(permissionRespondMessage("i", "alpha", "r", decision)),
      true,
    );
  assert.deepEqual(
    parseMessage(JSON.stringify(permissionRequestMessage("req-7"))),
    { type: "event", event: "permission_request", requestId: "req-7" },
  );

  // A verdict without a request to attach it to, or with a decision outside
  // the vocabulary, must never reach a session.
  for (const message of [
    { type: "send", id: "i", target: "a", action: "permission_respond" },
    {
      type: "send",
      id: "i",
      target: "a",
      action: "permission_respond",
      requestId: "r",
    },
    {
      type: "send",
      id: "i",
      target: "a",
      action: "permission_respond",
      requestId: "r",
      decision: "maybe",
    },
    {
      type: "command",
      id: "i",
      action: "permission_respond",
      requestId: "r",
      decision: "yes",
    },
  ])
    assert.equal(isValidMessage(message), false);
});

/**
 * Stands in for the pi-broker-bridge extension's agent side: registers, raises
 * one blocked `ask`, and records the permission_respond command the broker
 * relays back to it.
 */
function fakeAskingAgent(socketPath, requestId) {
  const socket = net.createConnection(socketPath);
  socket.setEncoding("utf8");
  const commands = [];
  let buffer = "";
  socket.on("connect", () => {
    socket.write('{"type":"register","role":"agent","sessionId":"alpha"}\n');
  });
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const split = buffer.indexOf("\n");
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.type === "registered") {
        // The shape the bridge's authorizer link emits while it blocks the ask.
        socket.write(
          `${JSON.stringify(
            permissionRequestMessage(requestId, {
              source: "tool_call",
              surface: "bash",
              value: "rm -rf build",
              agentName: "alpha",
              message: "Allow bash: rm -rf build?",
            }),
          )}\n`,
        );
        continue;
      }
      if (message.type === "command") commands.push(message);
    }
  });
  return { socket, commands };
}

function controller(socketPath) {
  const socket = net.createConnection(socketPath);
  socket.setEncoding("utf8");
  const events = [];
  let buffer = "";
  socket.on("connect", () => {
    socket.write('{"type":"register","role":"controller"}\n');
  });
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const split = buffer.indexOf("\n");
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  });
  return { socket, events };
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

test("a controller can answer a live permission request through MCP", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pi-broker-perm-"));
  const socketPath = path.join(runtime, "broker.sock");
  const broker = new Broker(socketPath);
  await broker.start();

  const watcher = controller(socketPath);
  await waitFor(
    () => broker.controllers.size === 1,
    "the watching controller to register",
  );
  const agent = fakeAskingAgent(socketPath, "req-42");
  await waitFor(() => broker.agents.has("alpha"), "the asking agent");

  // 1. The blocked ask reaches a controller, stamped with its session and
  //    carrying enough to identify what is being asked.
  const request = await waitFor(
    () => watcher.events.find((e) => e.event === "permission_request"),
    "the permission_request event",
  );
  assert.equal(request.sessionId, "alpha");
  assert.equal(request.requestId, "req-42");
  assert.equal(request.surface, "bash");
  assert.equal(request.value, "rm -rf build");
  assert.ok(typeof request.cursor === "number");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("src/mcp-server.mjs"), socketPath],
    cwd: path.resolve("."),
    stderr: "pipe",
  });
  const client = new Client({ name: "pi-broker-test", version: "0.1.0" });
  await client.connect(transport);

  assert.ok(
    (await client.listTools()).tools.some(
      (tool) => tool.name === "pi_permission_respond",
    ),
    "pi_permission_respond must be exposed",
  );

  // 2. The controller answers that exact request by id.
  const answered = await client.callTool({
    name: "pi_permission_respond",
    arguments: {
      target: "alpha",
      requestId: request.requestId,
      decision: "deny",
      reason: "build is not disposable",
    },
  });
  assert.deepEqual(answered.structuredContent, {
    target: "alpha",
    requestId: "req-42",
    decision: "deny",
    accepted: true,
  });

  // 3. The verdict actually arrives at the agent side, intact — this is the
  //    hop that turns watching a permission prompt into answering one.
  const relayed = await waitFor(
    () => agent.commands.find((c) => c.action === "permission_respond"),
    "the permission_respond command at the agent",
  );
  assert.equal(relayed.requestId, "req-42");
  assert.equal(relayed.decision, "deny");
  assert.equal(relayed.reason, "build is not disposable");

  // An unroutable target is refused rather than silently dropped. The broker
  // rejects the send, so the tool reports a tool error instead of pretending
  // the verdict landed somewhere.
  const ghost = await client.callTool({
    name: "pi_permission_respond",
    arguments: { target: "ghost", requestId: "req-42", decision: "allow" },
  });
  assert.equal(ghost.isError, true);

  await transport.close();
  agent.socket.destroy();
  watcher.socket.destroy();
  await broker.close();
  fs.rmdirSync(runtime);
});
