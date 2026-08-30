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
import { readSlotConfig } from "./slots.mjs";
import { LangfuseTracer } from "./langfuse-tracing.mjs";

function writeJson(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

export class Broker {
  constructor(socketPath, { tracer, slotConfig } = {}) {
    this.socketPath = socketPath;
    this.server = null;
    this.agents = new Map();
    this.controllers = new Set();
    this.cursor = 0;
    // Opt-in Langfuse observability (PI_BROKER_LANGFUSE=1). A no-op tracer
    // when unset/unconfigured — see langfuse-tracing.mjs for the contract:
    // record() never throws and never blocks #broadcast.
    this.tracer = tracer ?? new LangfuseTracer();

    // resource -> { max, holders: Map<holderId, socket>, queue: [] }
    // queue entries: { holderId, socket, id, timer, settled }
    this.slotConfig = slotConfig ?? readSlotConfig();
    this.slots = new Map();
  }

  #slotState(resource) {
    let state = this.slots.get(resource);
    if (!state) {
      state = { holders: new Map(), queue: [] };
      this.slots.set(resource, state);
    }
    return state;
  }

  async start() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
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
    // umask can still widen the socket's own bind-time mode even with a
    // restricted parent dir on some platforms, so pin it explicitly.
    fs.chmodSync(this.socketPath, 0o600);
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

      // Deadlock prevention: a crashed/exited orchestrator must not
      // permanently strand a resource it never explicitly released.
      this.#autoReleaseAll(socket);
    });
  }

  // --- slot/license arbiter -------------------------------------------

  #autoReleaseAll(socket) {
    for (const [resource, state] of this.slots) {
      for (const [holderId, holderSocket] of state.holders) {
        if (holderSocket === socket) {
          state.holders.delete(holderId);
          this.#broadcastSlotStatus(resource);
          this.#grantNextQueued(resource);
        }
      }
    }
  }

  #broadcastSlotStatus(resource) {
    const state = this.#slotState(resource);
    this.#broadcast(
      eventMessage("slot_status", {
        cursor: ++this.cursor,
        resource,
        held: state.holders.size,
        max: this.slotConfig[resource],
        waiting: state.queue.length
      })
    );
  }

  #grantNextQueued(resource) {
    const state = this.#slotState(resource);
    const max = this.slotConfig[resource];
    while (state.queue.length > 0 && state.holders.size < max) {
      const waiter = state.queue.shift();
      if (waiter.settled) continue; // already timed out
      waiter.settled = true;
      clearTimeout(waiter.timer);
      state.holders.set(waiter.holderId, waiter.socket);
      writeJson(
        waiter.socket,
        responseMessage(waiter.id, { granted: true, resource })
      );
      this.#broadcastSlotStatus(resource);
    }
  }

  #acquire(socket, message) {
    const { id, resource, holderId, waitMs } = message;
    if (!(resource in this.slotConfig)) {
      throw new Error(
        `unknown resource: ${resource} (not configured in PI_BROKER_SLOTS)`
      );
    }
    const max = this.slotConfig[resource];
    const state = this.#slotState(resource);

    if (state.holders.has(holderId)) {
      // Idempotent re-acquire by the same holder on the same resource.
      writeJson(socket, responseMessage(id, { granted: true, resource }));
      return;
    }

    if (state.holders.size < max) {
      state.holders.set(holderId, socket);
      writeJson(socket, responseMessage(id, { granted: true, resource }));
      this.#broadcastSlotStatus(resource);
      return;
    }

    const wait = Number(waitMs) || 0;
    if (wait <= 0) {
      writeJson(socket, responseMessage(id, { granted: false, resource }));
      return;
    }

    const waiter = {
      holderId,
      socket,
      id,
      settled: false,
      timer: null
    };
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      const index = state.queue.indexOf(waiter);
      if (index !== -1) state.queue.splice(index, 1);
      writeJson(socket, responseMessage(id, { granted: false, resource }));
    }, wait);
    waiter.timer.unref?.();
    state.queue.push(waiter);
    // No response yet: the request stays open until a slot frees (grant)
    // or waitMs elapses (deny) — see #grantNextQueued and the timer above.
  }

  #release(socket, message) {
    const { id, resource, holderId } = message;
    const state = this.slots.get(resource);
    const held = state?.holders.get(holderId) === socket;
    if (held) {
      state.holders.delete(holderId);
      this.#broadcastSlotStatus(resource);
      this.#grantNextQueued(resource);
    }
    writeJson(socket, responseMessage(id, { released: held, resource }));
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

    if (message.type === "acquire") {
      this.#acquire(socket, message);
      return;
    }

    if (message.type === "release") {
      this.#release(socket, message);
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
