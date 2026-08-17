import net from "node:net";

const [socketPath, command, target, ...rest] = process.argv.slice(2);
if (!socketPath || !command) {
  process.stderr.write(
    "usage: node src/client.mjs <socket> list|prompt|interrupt <target> [text]\n",
  );
  process.exit(2);
}

const socket = net.createConnection(socketPath);
socket.setEncoding("utf8");
let buffer = "";
let sent = false;
let responseText = "";
const requestId = `cli-${process.pid}`;

function write(value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

function finish(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  socket.end();
}

socket.on("connect", () => write({ type: "register", role: "controller" }));
socket.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const split = buffer.indexOf("\n");
    const line = buffer.slice(0, split);
    buffer = buffer.slice(split + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      socket.destroy();
      process.exit(1);
    }

    if (message.type === "registered" && !sent) {
      sent = true;
      if (command === "list") {
        write({ type: "list", id: requestId });
      } else if (command === "prompt") {
        if (!target || rest.length === 0)
          throw new Error("prompt requires target and text");
        write({
          type: "send",
          id: requestId,
          target,
          action: "prompt",
          text: rest.join(" "),
        });
      } else if (command === "interrupt") {
        if (!target) throw new Error("interrupt requires target");
        write({ type: "send", id: requestId, target, action: "interrupt" });
      } else {
        throw new Error(`unknown command: ${command}`);
      }
      continue;
    }

    if (message.type === "error") {
      process.stderr.write(`${message.error}\n`);
      socket.destroy();
      process.exit(1);
    }

    if (command === "list" && message.id === requestId) {
      finish({ sessions: message.sessions });
      return;
    }
    if (command === "interrupt" && message.id === requestId) {
      finish({ accepted: message.accepted, target });
      return;
    }
    if (command === "prompt" && message.sessionId === target) {
      if (message.event === "assistant_message") responseText = message.text;
      if (message.event === "agent_settled") {
        finish({ target, response: responseText });
        return;
      }
    }
  }
});

socket.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

// A real agentic coding turn can run for many minutes; 15s was only ever
// enough for a smoke-test "say hello" round trip and made every real dispatch
// report a false "timed out" while the session kept working underneath.
const DEFAULT_TIMEOUT_MS = 3600000;
const timeoutMs = Number(process.env.PI_BROKER_PROMPT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
setTimeout(() => {
  process.stderr.write(`timed out waiting for ${command} after ${timeoutMs}ms\n`);
  process.exit(1);
}, timeoutMs).unref();
