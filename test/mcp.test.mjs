import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Broker } from "../src/broker.mjs";

function fakeAgent(socketPath) {
  const socket = net.createConnection(socketPath);
  socket.setEncoding("utf8");
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
      if (message.type !== "command" || message.action !== "prompt") continue;
      socket.write(
        `${JSON.stringify({ type: "event", event: "assistant_message", text: `MCP:${message.text}` })}\n`,
      );
      socket.write('{"type":"event","event":"agent_settled"}\n');
    }
  });
  return socket;
}

async function waitForSession(broker, sessionId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (broker.agents.has(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fake MCP agent did not register");
}

test("MCP exposes list, prompt, and interrupt over the broker", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pi-broker-mcp-"));
  const socketPath = path.join(runtime, "broker.sock");
  const broker = new Broker(socketPath);
  await broker.start();
  const agent = fakeAgent(socketPath);
  await waitForSession(broker, "alpha");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("src/mcp-server.mjs"), socketPath],
    cwd: path.resolve("."),
    stderr: "pipe",
  });
  const client = new Client({ name: "pi-broker-test", version: "0.1.0" });
  await client.connect(transport);

  assert.deepEqual(client.getServerVersion(), {
    name: "pi-broker",
    version: "0.1.0",
  });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "pi_interrupt",
    "pi_list",
    "pi_prompt",
  ]);

  const listed = await client.callTool({ name: "pi_list", arguments: {} });
  assert.deepEqual(listed.structuredContent, { sessions: ["alpha"] });

  const prompted = await client.callTool({
    name: "pi_prompt",
    arguments: { target: "alpha", text: "hello" },
  });
  assert.deepEqual(prompted.structuredContent, {
    target: "alpha",
    response: "MCP:hello",
  });

  const interrupted = await client.callTool({
    name: "pi_interrupt",
    arguments: { target: "alpha" },
  });
  assert.deepEqual(interrupted.structuredContent, {
    target: "alpha",
    accepted: true,
  });

  await transport.close();
  agent.destroy();
  await broker.close();
  fs.rmdirSync(runtime);
});
