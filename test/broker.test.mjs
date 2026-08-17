import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Broker } from "../src/broker.mjs";
import {
  commandMessage,
  errorMessage,
  eventMessage,
  isValidMessage,
  listMessage,
  parseMessage,
  registerMessage,
  responseMessage,
  sendMessage,
} from "../src/protocol.mjs";

const execFileAsync = promisify(execFile);

test("protocol freezes all broker wire shapes and rejects incomplete messages", () => {
  const messages = [
    registerMessage("agent", "alpha"),
    registerMessage("controller"),
    eventMessage("agent_start"),
    listMessage("list-1"),
    sendMessage("send-1", "alpha", "prompt", { text: "hello" }),
    commandMessage("send-1", "prompt", { text: "hello" }),
    responseMessage("list-1", { sessions: ["alpha"] }),
    errorMessage("bad request"),
  ];
  for (const message of messages)
    assert.deepEqual(parseMessage(JSON.stringify(message)), message);
  for (const message of [
    { type: "register" },
    { type: "register", role: "agent" },
    { type: "send", id: "x", target: "alpha" },
    { type: "send", id: "x", action: "prompt" },
    { type: "event" },
  ])
    assert.equal(isValidMessage(message), false);
});

function peer(socketPath) {
  const socket = net.createConnection(socketPath);
  socket.setEncoding("utf8");
  const messages = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const split = buffer.indexOf("\n");
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  return { socket, messages };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for broker message");
}

test("broker registers, lists, routes, and broadcasts without cross-target leakage", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pi-broker-test-"));
  const socketPath = path.join(runtime, "broker.sock");
  const broker = new Broker(socketPath);
  await broker.start();

  const controller = peer(socketPath);
  const alpha = peer(socketPath);
  const beta = peer(socketPath);

  controller.socket.write('{"type":"register","role":"controller"}\n');
  alpha.socket.write(
    '{"type":"register","role":"agent","sessionId":"alpha"}\n',
  );
  beta.socket.write('{"type":"register","role":"agent","sessionId":"beta"}\n');
  await waitFor(
    () =>
      controller.messages.filter((item) => item.event === "connected")
        .length === 2,
  );

  controller.socket.write('{"type":"list","id":"list-1"}\n');
  const listed = await waitFor(() =>
    controller.messages.find((item) => item.id === "list-1"),
  );
  assert.deepEqual(listed.sessions, ["alpha", "beta"]);

  controller.socket.write(
    '{"type":"send","id":"send-1","target":"beta","action":"prompt","text":"hello"}\n',
  );
  const routed = await waitFor(() =>
    beta.messages.find((item) => item.id === "send-1"),
  );
  assert.equal(routed.text, "hello");
  assert.equal(
    alpha.messages.some((item) => item.id === "send-1"),
    false,
  );

  beta.socket.write('{"type":"event","event":"agent_start"}\n');
  const event = await waitFor(() =>
    controller.messages.find((item) => item.event === "agent_start"),
  );
  assert.equal(event.sessionId, "beta");
  assert.equal(typeof event.cursor, "number");

  controller.socket.destroy();
  alpha.socket.destroy();
  beta.socket.destroy();
  await broker.close();
  fs.rmdirSync(runtime);
});

test("broker refuses duplicate agent identifiers", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pi-broker-test-"));
  const socketPath = path.join(runtime, "broker.sock");
  const broker = new Broker(socketPath);
  await broker.start();

  const first = peer(socketPath);
  const duplicate = peer(socketPath);
  first.socket.write('{"type":"register","role":"agent","sessionId":"same"}\n');
  await waitFor(() =>
    first.messages.find((item) => item.type === "registered"),
  );
  duplicate.socket.write(
    '{"type":"register","role":"agent","sessionId":"same"}\n',
  );
  const error = await waitFor(() =>
    duplicate.messages.find((item) => item.type === "error"),
  );
  assert.match(error.error, /unique/);

  first.socket.destroy();
  duplicate.socket.destroy();
  await broker.close();
  fs.rmdirSync(runtime);
});

test("host-neutral CLI lists registered sessions", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pi-broker-test-"));
  const socketPath = path.join(runtime, "broker.sock");
  const broker = new Broker(socketPath);
  await broker.start();
  const alpha = peer(socketPath);
  alpha.socket.write(
    '{"type":"register","role":"agent","sessionId":"alpha"}\n',
  );
  await waitFor(() =>
    alpha.messages.find((item) => item.type === "registered"),
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [path.resolve("src/client.mjs"), socketPath, "list"],
    { cwd: path.resolve(".") },
  );
  assert.deepEqual(JSON.parse(stdout), { sessions: ["alpha"] });

  alpha.socket.destroy();
  await broker.close();
  fs.rmdirSync(runtime);
});

function execFileWithExitCode(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test("pi-broker list prints registered sessions and exits successfully", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pi-broker-test-"));
  const socketPath = path.join(runtime, "broker.sock");
  const broker = new Broker(socketPath);
  await broker.start();
  const alpha = peer(socketPath);
  alpha.socket.write(
    '{"type":"register","role":"agent","sessionId":"alpha"}\n',
  );
  await waitFor(() =>
    alpha.messages.find((item) => item.type === "registered"),
  );

  const { code, stdout, stderr } = await execFileWithExitCode(
    process.execPath,
    [path.resolve("bin/pi-broker.mjs"), "list", socketPath],
    { cwd: path.resolve(".") },
  );
  assert.equal(code, 0);
  assert.equal(stdout, '{"sessions":["alpha"]}\n');
  assert.equal(stderr, "");

  alpha.socket.destroy();
  await broker.close();
  fs.rmdirSync(runtime);
});

test("pi-broker prompt prints the agent response and exits successfully", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "pi-broker-test-"));
  const socketPath = path.join(runtime, "broker.sock");
  const broker = new Broker(socketPath);
  await broker.start();
  const alpha = peer(socketPath);
  alpha.socket.write(
    '{"type":"register","role":"agent","sessionId":"alpha"}\n',
  );
  await waitFor(() =>
    alpha.messages.find((item) => item.type === "registered"),
  );

  const result = execFileWithExitCode(
    process.execPath,
    [
      path.resolve("bin/pi-broker.mjs"),
      "prompt",
      socketPath,
      "alpha",
      "hello there",
    ],
    { cwd: path.resolve(".") },
  );
  const command = await waitFor(() =>
    alpha.messages.find((item) => item.type === "command"),
  );
  assert.equal(command.action, "prompt");
  assert.equal(command.text, "hello there");
  alpha.socket.write(
    '{"type":"event","event":"assistant_message","text":"Hello back"}\n',
  );
  alpha.socket.write('{"type":"event","event":"agent_settled"}\n');

  const { code, stdout, stderr } = await result;
  assert.equal(code, 0);
  assert.equal(stdout, '{"target":"alpha","response":"Hello back"}\n');
  assert.equal(stderr, "");

  alpha.socket.destroy();
  await broker.close();
  fs.rmdirSync(runtime);
});

test("pi-broker rejects an invalid subcommand with usage and exit code 2", async () => {
  const { code, stderr } = await execFileWithExitCode(
    process.execPath,
    [path.resolve("bin/pi-broker.mjs"), "bogus-command"],
    { cwd: path.resolve(".") },
  );
  assert.equal(code, 2);
  assert.notEqual(stderr.trim(), "");
  assert.match(stderr, /usage:/);
});
