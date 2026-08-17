// `target` is externally supplied input that becomes a launcher filename, a
// window title, and text inside a generated launch script — on macOS, inside
// an AppleScript that osascript executes. These tests prove it is rejected at
// the MCP edge, and rejected again inside ensureSession, rather than being
// silently rewritten into something "safe" (which would route a delegated turn
// to a session the caller never named).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// An opener that would prove the exploit if it ever ran: it records every
// window it is asked to open. Nothing may reach it.
const recordingOpenerSource = `#!/usr/bin/env bash
echo "$2" >>"$(dirname "$1")/windows.log"
`;

const HOSTILE_TARGETS = [
  '"; rm -rf /tmp"',
  'a" & calc.exe & "',
  "a`id`",
  "a$(id)",
  "../../etc/passwd",
  "a b",
];

test("the MCP layer rejects a hostile session id with a clear error", async (t) => {
  const dir = fs.mkdtempSync("/tmp/sid-test-");
  const openerPath = path.join(dir, "opener.sh");
  fs.writeFileSync(openerPath, recordingOpenerSource, { mode: 0o755 });
  t.after(() => {
    try {
      execFileSync("pkill", [
        "-f",
        `src/broker.mjs ${path.join(dir, "broker.sock")}`,
      ]);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", "mcp-server.mjs")],
    cwd: root,
    stderr: "pipe",
    env: {
      ...process.env,
      PI_BROKER_RUNTIME_DIR: dir,
      PI_SESSION_OPEN: openerPath,
      PI_BROKER_SESSION_TIMEOUT_MS: "5000",
    },
  });
  const client = new Client({ name: "session-id-test", version: "0.1.0" });
  await client.connect(transport);
  t.after(() => transport.close());

  // The SDK reports a schema rejection as an -32602 input validation error
  // result rather than a transport-level throw; either way the tool body never
  // runs, which is the property that matters.
  const refusal = (outcome, label) => {
    assert.equal(outcome.isError, true, `${label} was accepted`);
    const text = outcome.content.map((part) => part.text).join("");
    assert.match(text, /Input validation error/, label);
    assert.match(
      text,
      /session id must be 1-64 characters of A-Z a-z 0-9 _ -/,
      `${label}: the error does not say what a session id may be`,
    );
  };

  for (const target of HOSTILE_TARGETS) {
    refusal(
      await client.callTool({
        name: "pi_prompt",
        arguments: { target, text: "hi" },
      }),
      `pi_prompt ${JSON.stringify(target)}`,
    );
    refusal(
      await client.callTool({ name: "pi_interrupt", arguments: { target } }),
      `pi_interrupt ${JSON.stringify(target)}`,
    );
  }

  // Rejected, not sanitised into some neighbouring session, and no window was
  // opened on the way to finding out.
  assert.ok(
    !fs.existsSync(path.join(dir, "windows.log")),
    "a window was opened for a rejected session id",
  );
  const listed = await client.callTool({ name: "pi_list", arguments: {} });
  assert.deepEqual(listed.structuredContent, { sessions: [] });
});

test("ensureSession re-validates, so a direct caller cannot bypass the MCP schema", async () => {
  const { ensureSession } = await import("../src/autoprovision.mjs");
  for (const target of HOSTILE_TARGETS) {
    await assert.rejects(
      () => ensureSession("/tmp/does-not-exist.sock", target),
      /invalid session id/,
      `ensureSession accepted ${JSON.stringify(target)}`,
    );
  }
});
