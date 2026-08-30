import { execFile } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  SESSION_ID_PATTERN,
  autoprovisionEnabled,
  defaultSocketPath,
  ensureBroker,
  ensureSession,
} from "./autoprovision.mjs";
import { acquireMessage, releaseMessage, registerMessage } from "./protocol.mjs";

// `target` is externally supplied input that ends up as a launcher filename, a
// window title, and text inside a generated launch script (on macOS, inside an
// AppleScript that osascript executes). Constrain it here, at the edge, to the
// same allow-list the window opener enforces — reject, never sanitise, so a
// turn can never be routed to a session other than the one named.
const sessionId = z
  .string()
  .regex(
    SESSION_ID_PATTERN,
    "session id must be 1-64 characters of A-Z a-z 0-9 _ -",
  );

const execFileAsync = promisify(execFile);
// The socket argument is now optional: with no argument the adapter uses the
// deterministic default path, so every host that starts it lands on the same
// broker instead of each one starting its own.
const socketPath = process.argv[2] || defaultSocketPath();
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const clientPath = path.join(root, "src", "client.mjs");

async function brokerCommand(args, { timeout = 20000 } = {}) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [clientPath, socketPath, ...args],
    { cwd: root, timeout },
  );
  return JSON.parse(stdout);
}

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

// Slot acquire/release need a hold that outlives a single request/response —
// an acquire and its matching release are separate MCP tool calls, minutes
// apart, bracketing an out-of-process dispatch. The list/prompt/interrupt
// tools above spawn a fresh one-shot client.mjs per call and that's fine for
// them, but doing the same for acquire would make the broker's auto-release-
// on-disconnect fire the instant the acquiring process exits — releasing the
// slot before the caller ever gets to use it. So slot operations share one
// persistent controller connection, kept open for the life of this MCP
// server process: the hold's lifetime is the connection's lifetime, and if
// this MCP server itself dies, the broker's disconnect handler correctly
// frees whatever it was still holding.
let slotSocket = null;
let slotBuffer = "";
const slotPending = new Map();
let slotRequestSeq = 0;

function ensureSlotSocket() {
  if (slotSocket) return slotSocket;
  slotSocket = net.createConnection(socketPath);
  slotSocket.setEncoding("utf8");
  slotSocket.on("data", (chunk) => {
    slotBuffer += chunk;
    while (slotBuffer.includes("\n")) {
      const split = slotBuffer.indexOf("\n");
      const line = slotBuffer.slice(0, split);
      slotBuffer = slotBuffer.slice(split + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "registered") continue;
      const pending = slotPending.get(message.id);
      if (!pending) continue;
      slotPending.delete(message.id);
      if (message.type === "error") pending.reject(new Error(message.error));
      else pending.resolve(message);
    }
  });
  const failPending = (error) => {
    for (const pending of slotPending.values()) pending.reject(error);
    slotPending.clear();
    slotSocket = null;
  };
  slotSocket.on("error", failPending);
  slotSocket.on("close", () => failPending(new Error("slot connection closed")));
  slotSocket.write(`${JSON.stringify(registerMessage("controller"))}\n`);
  return slotSocket;
}

function sendSlotMessage(build) {
  const socket = ensureSlotSocket();
  const id = `mcp-slot-${process.pid}-${++slotRequestSeq}`;
  return new Promise((resolve, reject) => {
    slotPending.set(id, { resolve, reject });
    socket.write(`${JSON.stringify(build(id))}\n`);
  });
}

const server = new McpServer({ name: "pi-broker", version: "0.1.0" });

server.registerTool(
  "pi_list",
  {
    description: "List live interactive Pi sessions",
    inputSchema: {},
    outputSchema: { sessions: z.array(z.string()) },
  },
  async () => result(await brokerCommand(["list"])),
);

server.registerTool(
  "pi_prompt",
  {
    description:
      "Send a user turn to one live interactive Pi session and return its response. " +
      "If the named session is not running yet, it is created: a real Terminal.app " +
      "window opens with an ordinary interactive Pi TUI a human can watch and type into.",
    inputSchema: { target: sessionId, text: z.string().min(1) },
    outputSchema: { target: z.string(), response: z.string() },
  },
  async ({ target, text }) => {
    if (autoprovisionEnabled()) await ensureSession(socketPath, target);
    return result(
      await brokerCommand(["prompt", target, text], {
        timeout: Number(process.env.PI_BROKER_PROMPT_TIMEOUT_MS) || 3600000,
      }),
    );
  },
);

server.registerTool(
  "pi_interrupt",
  {
    description: "Interrupt one live interactive Pi session",
    inputSchema: { target: sessionId },
    outputSchema: { target: z.string(), accepted: z.boolean() },
  },
  async ({ target }) => result(await brokerCommand(["interrupt", target])),
);

const resourceName = z.string().min(1);
const holderId = z.string().min(1);

server.registerTool(
  "pi_slot_acquire",
  {
    description:
      "Acquire a slot on a named, capped-concurrency resource (e.g. " +
      "local-mlx, qwencode, openai-gpt) before dispatching work to it. " +
      "Blocks other orchestrators from over-subscribing a scarce local " +
      "model server or quota. Optionally waits up to waitMs for a free " +
      "slot; omit/0 to fail immediately if the resource is full.",
    inputSchema: {
      resource: resourceName,
      holderId,
      waitMs: z.number().int().min(0).optional(),
    },
    outputSchema: { granted: z.boolean(), resource: z.string() },
  },
  async ({ resource, holderId, waitMs }) => {
    const response = await sendSlotMessage((id) =>
      acquireMessage(id, resource, holderId, waitMs ? { waitMs } : {}),
    );
    return result({ granted: response.granted, resource: response.resource });
  },
);

server.registerTool(
  "pi_slot_release",
  {
    description:
      "Release a previously acquired slot on a named resource, freeing it " +
      "for the next queued waiter.",
    inputSchema: { resource: resourceName, holderId },
    outputSchema: { released: z.boolean() },
  },
  async ({ resource, holderId }) => {
    const response = await sendSlotMessage((id) =>
      releaseMessage(id, resource, holderId),
    );
    return result({ released: response.released });
  },
);

server.registerTool(
  "pi_permission_respond",
  {
    description:
      "Answer a permission request a live Pi session is currently blocked on. " +
      "Use the requestId from that session's permission_request event. " +
      "'allow' and 'deny' settle the request; 'defer' hands it back to the human " +
      "at the terminal, whose own Yes/No prompt then decides. Requires the Pi " +
      "session to list 'pi-broker' in its permission authorizerChain config.",
    inputSchema: {
      target: sessionId,
      requestId: z.string().min(1),
      decision: z.enum(["allow", "deny", "defer"]),
      reason: z.string().optional(),
    },
    outputSchema: {
      target: z.string(),
      requestId: z.string(),
      decision: z.string(),
      accepted: z.boolean(),
    },
  },
  async ({ target, requestId, decision, reason }) =>
    result(
      await brokerCommand(
        "permission-respond",
        target,
        requestId,
        decision,
        ...(reason ? [reason] : []),
      ),
    ),
);

// Startup half of the hybrid: guarantee a broker exists before the host can
// call anything. Cheap, idempotent, and opens no window — a host that connects
// and never delegates costs nothing visible. The window is opened later, by
// pi_prompt, only for a session that is actually addressed.
if (autoprovisionEnabled()) await ensureBroker(socketPath);

await server.connect(new StdioServerTransport());
