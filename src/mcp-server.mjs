import { execFile } from "node:child_process";
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

async function brokerCommand(...args) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [clientPath, socketPath, ...args],
    { cwd: root, timeout: 20000 },
  );
  return JSON.parse(stdout);
}

function result(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

const server = new McpServer({ name: "pi-broker", version: "0.1.0" });

server.registerTool(
  "pi_list",
  {
    description: "List live interactive Pi sessions",
    inputSchema: {},
    outputSchema: { sessions: z.array(z.string()) },
  },
  async () => result(await brokerCommand("list")),
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
    return result(await brokerCommand("prompt", target, text));
  },
);

server.registerTool(
  "pi_interrupt",
  {
    description: "Interrupt one live interactive Pi session",
    inputSchema: { target: sessionId },
    outputSchema: { target: z.string(), accepted: z.boolean() },
  },
  async ({ target }) => result(await brokerCommand("interrupt", target)),
);

// Startup half of the hybrid: guarantee a broker exists before the host can
// call anything. Cheap, idempotent, and opens no window — a host that connects
// and never delegates costs nothing visible. The window is opened later, by
// pi_prompt, only for a session that is actually addressed.
if (autoprovisionEnabled()) await ensureBroker(socketPath);

await server.connect(new StdioServerTransport());
