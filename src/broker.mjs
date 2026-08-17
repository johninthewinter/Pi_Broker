import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandMessage,
  errorMessage,
  eventMessage,
  listMessage,
  parseMessage,
  responseMessage
} from "./protocol.mjs";
import { LangfuseTracer } from "./langfuse-tracing.mjs";

function writeJson(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

export class Broker {
  constructor(socketPath, { tracer } = {}) {
    this.socketPath = socketPath;
    this.server = null;
    this.agents = new Map();
    this.controllers = new Set();
    this.cursor = 0;
    // Opt-in Langfuse observability (PI_BROKER_LANGFUSE=1). A no-op tracer
    // when unset/unconfigured — see langfuse-tracing.mjs for the contract:
    // record() never throws and never blocks #broadcast.
    this.tracer = tracer ?? new LangfuseTracer();
  }

  async start() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    if (fs.existsSync(this.socketPath)) {
      throw new Error(
        `refusing to replace existing socket: ${this.socketPath}`
      );
    }

    this.server = net.createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
  }

  async close() {
    for (const socket of this.agents.values()) socket.destroy();
    for (const socket of this.controllers) socket.destroy();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
    if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    await this.tracer.shutdown();
  }

  #accept(socket) {
    socket.setEncoding("utf8");
    socket._piBrokerRole = null;
    socket._piBrokerSessionId = null;
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const split = buffer.indexOf("\n");
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 1);
        if (!line.trim()) continue;
        try {
          this.#message(socket, parseMessage(line));
        } catch (error) {
          writeJson(socket, errorMessage(String(error.message ?? error)));
        }
      }
    });

    socket.on("close", () => {
      if (socket._piBrokerRole === "agent") {
        const current = this.agents.get(socket._piBrokerSessionId);
        if (current === socket) this.agents.delete(socket._piBrokerSessionId);
        this.#broadcast(
          eventMessage("disconnected", {
            cursor: ++this.cursor,
            sessionId: socket._piBrokerSessionId
          })
        );
      }
      if (socket._piBrokerRole === "controller")
        this.controllers.delete(socket);
    });
  }

  #message(socket, message) {
    if (message.type === "register") {
      if (message.role === "agent") {
        if (!message.sessionId || this.agents.has(message.sessionId)) {
          throw new Error("agent sessionId must be unique and non-empty");
        }
        socket._piBrokerRole = "agent";
        socket._piBrokerSessionId = message.sessionId;
        this.agents.set(message.sessionId, socket);
        writeJson(socket, { type: "registered", sessionId: message.sessionId });
        this.#broadcast(
          eventMessage("connected", {
            cursor: ++this.cursor,
            sessionId: message.sessionId
          })
        );
        return;
      }
      if (message.role === "controller") {
        socket._piBrokerRole = "controller";
        this.controllers.add(socket);
        writeJson(socket, { type: "registered", role: "controller" });
        return;
      }
      throw new Error("unknown registration role");
    }

    if (socket._piBrokerRole === "agent" && message.type === "event") {
      this.#broadcast(
        eventMessage(message.event, {
          ...message,
          cursor: ++this.cursor,
          sessionId: socket._piBrokerSessionId
        })
      );
      return;
    }

    if (socket._piBrokerRole !== "controller") {
      throw new Error("connection must register before sending commands");
    }

    if (message.type === "list") {
      writeJson(
        socket,
        responseMessage(message.id, {
          sessions: [...this.agents.keys()].sort()
        })
      );
      return;
    }

    if (message.type === "send") {
      const agent = this.agents.get(message.target);
      if (!agent) throw new Error(`unknown target: ${message.target}`);
      writeJson(
        agent,
        commandMessage(message.id, message.action, {
          text: message.text,
          delivery: message.delivery
        })
      );
      writeJson(socket, responseMessage(message.id, { accepted: true }));
      return;
    }

    throw new Error(`unknown message type: ${message.type}`);
  }

  #broadcast(event) {
    for (const controller of this.controllers) writeJson(controller, event);
    // Fire-and-forget: tracer.record() is synchronous, self-contained
    // try/catch, and never throws — see langfuse-tracing.mjs.
    this.tracer.record(event);
  }
}

async function main() {
  const socketPath = process.argv[2];
  if (!socketPath) throw new Error("usage: node src/broker.mjs <socket-path>");
  const tracer = await new LangfuseTracer().init();
  const broker = new Broker(socketPath, { tracer });
  await broker.start();
  process.stdout.write(`${JSON.stringify({ type: "ready", socketPath })}\n`);

  const stop = async () => {
    await broker.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });
}
