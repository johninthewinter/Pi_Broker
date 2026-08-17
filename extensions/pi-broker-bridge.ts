import net from "node:net";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type BrokerCommand = {
  type: "command";
  id?: string;
  action: "prompt" | "interrupt" | "shutdown";
  text?: string;
  delivery?: "steer" | "followUp";
};

export default function piBrokerBridge(pi: ExtensionAPI) {
  const socketPath = process.env.PI_BROKER_SOCKET;
  const sessionId = process.env.PI_BROKER_SESSION_ID;
  let socket: net.Socket | undefined;
  let context: ExtensionContext | undefined;
  let buffer = "";
  // Per this project's own audit-trace convention: tracking total tool
  // calls seen since the current agent run's agent_start, reset there and
  // accumulated from turn_end's event.toolResults (already-received data,
  // no new instrumentation). Read at agent_end/agent_settled to flag a run
  // that settled having made zero tool calls — a free, literal
  // "settle-without-tool-call" incident signal.
  let toolCallsSinceAgentStart = 0;

  function send(value: unknown) {
    if (socket?.writable) socket.write(`${JSON.stringify(value)}\n`);
  }

  function handle(command: BrokerCommand) {
    if (command.action === "prompt") {
      if (!command.text) return;
      if (context?.isIdle()) {
        pi.sendUserMessage(command.text);
      } else {
        pi.sendUserMessage(command.text, {
          deliverAs: command.delivery ?? "steer",
        });
      }
      return;
    }
    if (command.action === "interrupt") {
      context?.abort();
      return;
    }
    if (command.action === "shutdown") context?.shutdown();
  }

  function connect() {
    if (!socketPath || !sessionId || socket) return;
    socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      send({ type: "register", role: "agent", sessionId });
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const split = buffer.indexOf("\n");
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as BrokerCommand;
        if (message.type === "command") handle(message);
      }
    });
    socket.on("error", (error) => {
      context?.ui.notify(`Pi Broker disconnected: ${error.message}`, "error");
    });
  }

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    connect();
    ctx.ui.setStatus(
      "pi-broker",
      sessionId ? `broker:${sessionId}` : "broker:disabled",
    );
    // cwd/model are best-effort extras for observability (e.g. Langfuse
    // trace metadata) — optional, additive fields, ignored by any consumer
    // that predates them.
    send({
      type: "event",
      event: "session_start",
      cwd: ctx.cwd,
      model: ctx.model?.id,
    });
  });

  pi.on("input", (event, ctx) => {
    context = ctx;
    send({
      type: "event",
      event: "input",
      source: event.source,
      text: event.text,
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    // Reset the tool-call tally for the new agent run.
    toolCallsSinceAgentStart = 0;
    // emittedAt lets Langfuse compute real turn/generation latency (and thus
    // TPS from usage.output / latency) instead of relying on ingestion-time
    // ordering, which can lag the actual model timing under load.
    send({ type: "event", event: "agent_start", emittedAt: Date.now() });
  });

  pi.on("agent_end", (_event, ctx) => {
    context = ctx;
    // emittedAt lets the tracer compute turn-to-turn gap time (operator/
    // controller latency between one turn closing and the next agent_start).
    // settledWithoutToolCall: this project's audit-trace red-flag signal —
    // this agent run is closing (agent_end) having made zero tool calls
    // since its agent_start.
    // Not a verdict on its own (a plain conversational answer legitimately
    // has zero tool calls too) — just the literal, free signal for a later
    // LLM-judge to weigh alongside the turn's text/stopReason.
    send({
      type: "event",
      event: "agent_end",
      emittedAt: Date.now(),
      settledWithoutToolCall: toolCallsSinceAgentStart === 0,
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    context = ctx;
    // Same audit-trace signal as agent_end — agent_end/agent_settled both fire
    // per run (whichever arrives first closes the tracer's turn span), so
    // both carry the same flag value for that run.
    send({
      type: "event",
      event: "agent_settled",
      emittedAt: Date.now(),
      settledWithoutToolCall: toolCallsSinceAgentStart === 0,
    });
  });

  pi.on("message_end", (event, ctx) => {
    context = ctx;
    if (event.message.role !== "assistant") return;
    const text = event.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    // event.message.usage (pi-ai's Usage type) carries real per-message token
    // accounting (input/output/totalTokens/cacheRead/cacheWrite/reasoning/cost)
    // when the provider reports it — forwarded as-is so Langfuse can attach
    // real usageDetails/costDetails to the generation, not just output text.
    //
    // event.message.model is the AssistantMessage's own model id (pi-ai's
    // Message type), which can differ from the session-level model sent at
    // session_start if the user switched models mid-session — genuinely
    // per-generation data, not a duplicate of session_start's ctx.model?.id.
    //
    // ctx.thinkingLevel is the closest per-generation "model parameter" pi
    // exposes to extensions (it's the reasoning-effort dial). Raw sampling
    // params (temperature/top_p/top_k) are StreamOptions passed straight to
    // the provider request and are NOT surfaced to extensions anywhere in
    // this SDK version — not forwarded here; would require new
    // instrumentation, not a free read.
    //
    // ctx.getContextUsage() reads already-computed context accounting
    // (tokens/contextWindow/percent) off the same ctx object this handler
    // already receives — no new API call.
    const contextUsage = ctx.getContextUsage?.();
    send({
      type: "event",
      event: "assistant_message",
      text,
      stopReason: event.message.stopReason,
      usage: event.message.usage,
      model: event.message.model,
      modelParameters:
        ctx.thinkingLevel !== undefined ? { reasoningEffort: ctx.thinkingLevel } : undefined,
      contextUsage: contextUsage
        ? {
            tokens: contextUsage.tokens,
            contextWindow: contextUsage.contextWindow,
            percent: contextUsage.percent,
          }
        : undefined,
      emittedAt: Date.now(),
    });
  });

  pi.on("turn_end", (event, ctx) => {
    context = ctx;
    // turn_end is a finer-grained event than agent_end/agent_settled — it
    // fires once per LLM-response-plus-tool-calls turn, and an agent_start
    // run can contain several of them when the model keeps calling tools.
    // event.toolResults is already carried on the event pi fires; just
    // counting/tallying it, no new instrumentation.
    const toolNameCounts: Record<string, number> = {};
    for (const result of event.toolResults) {
      toolNameCounts[result.toolName] = (toolNameCounts[result.toolName] ?? 0) + 1;
    }
    // Feeds the zero-tool-call tally read back at agent_end/agent_settled.
    toolCallsSinceAgentStart += event.toolResults.length;
    send({
      type: "event",
      event: "turn_summary",
      turnIndex: event.turnIndex,
      toolResultCount: event.toolResults.length,
      toolNameCounts,
      emittedAt: Date.now(),
    });
  });

  pi.on("session_shutdown", () => {
    send({ type: "event", event: "session_shutdown" });
    socket?.end();
  });

  pi.events.on("permissions:decision", (decision: Record<string, unknown>) => {
    send({
      type: "event",
      event: "permission_decision",
      surface: decision.surface,
      result: decision.result,
      resolution: decision.resolution,
    });
  });
}
