import net from "node:net";
import { compactMessage, permissionRespondMessage } from "./protocol.mjs";

const [socketPath, command, target, ...rest] = process.argv.slice(2);
if (!socketPath || !command) {
  process.stderr.write(
    "usage: node src/client.mjs <socket> list|prompt|interrupt|compact|acquire|release <target> [text]\n" +
      "       node src/client.mjs <socket> permission-respond <target> <requestId> allow|deny|defer [reason]\n",
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
      } else if (command === "compact") {
        if (!target) throw new Error("compact requires target");
        // Trailing words, if any, are the compaction's custom instructions
        // ("keep the API surface decisions"), same positional shape as prompt.
        write(
          compactMessage(
            requestId,
            target,
            rest.length ? rest.join(" ") : undefined,
          ),
        );
      } else if (command === "permission-respond") {
        const [permissionRequestId, decision, ...reason] = rest;
        if (!target || !permissionRequestId || !decision)
          throw new Error(
            "permission-respond requires target, requestId and decision",
          );
        write(
          permissionRespondMessage(
            requestId,
            target,
            permissionRequestId,
            decision,
            reason.length ? reason.join(" ") : undefined,
          ),
        );
      } else if (command === "acquire") {
        // positional: <resource> <holderId> [waitMs]
        const [holderId, waitMsRaw] = rest;
        if (!target || !holderId)
          throw new Error("acquire requires resource and holderId");
        const waitMs = waitMsRaw ? Number(waitMsRaw) : undefined;
        write({
          type: "acquire",
          id: requestId,
          resource: target,
          holderId,
          ...(waitMs ? { waitMs } : {}),
        });
      } else if (command === "release") {
        // positional: <resource> <holderId>
        const [holderId] = rest;
        if (!target || !holderId)
          throw new Error("release requires resource and holderId");
        write({
          type: "release",
          id: requestId,
          resource: target,
          holderId,
        });
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
    if (command === "permission-respond" && message.id === requestId) {
      // `accepted` is delivery, not adjudication: the broker confirms the
      // verdict reached the session. Whether it actually settled the ask (vs.
      // arriving after the human already clicked) comes back as the session's
      // own permission_request_resolved event.
      finish({
        accepted: message.accepted,
        target,
        requestId: rest[0],
        decision: rest[1],
      });
      return;
    }
    // Unlike interrupt, compact does not finish on the broker's delivery ack:
    // the ack only says the command reached the session, and a compaction can
    // still be refused there ("Already compacted", nothing to summarize). The
    // session's own compaction_finished event is the outcome, so wait for it.
    if (command === "compact" && message.event === "compaction_finished") {
      if (message.sessionId !== target) continue;
      finish({
        target,
        compacted: message.ok,
        trigger: message.trigger,
        tokensBefore: message.tokensBefore,
        estimatedTokensAfter: message.estimatedTokensAfter,
        error: message.error,
      });
      return;
    }
    if (command === "acquire" && message.id === requestId) {
      finish({ granted: message.granted, resource: message.resource });
      return;
    }
    if (command === "release" && message.id === requestId) {
      finish({ released: message.released, resource: message.resource });
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
