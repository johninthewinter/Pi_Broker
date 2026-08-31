import net from "node:net";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type PermissionDecision = "allow" | "deny" | "defer";

type BrokerCommand = {
  type: "command";
  id?: string;
  action:
    | "prompt"
    | "interrupt"
    | "shutdown"
    | "permission_respond"
    | "compact";
  text?: string;
  delivery?: "steer" | "followUp";
  requestId?: string;
  decision?: PermissionDecision;
  reason?: string;
};

// The subset of @gotgenes/pi-permission-system's authorizer-chain contract this
// bridge depends on. Declared structurally rather than imported as types so a
// Pi install without the permission system still type-checks and loads; the
// real service is picked up at runtime by dynamic import (see
// registerBrokerAuthorizer).
type AuthorizerVerdict =
  | { kind: "allow" }
  | { kind: "deny"; reason?: string }
  | { kind: "defer" };

type PromptPermissionDetails = {
  requestId: string;
  source: "tool_call" | "skill_input" | "skill_read";
  agentName: string | null;
  message: string;
  toolName?: string;
  skillName?: string;
  path?: string;
  command?: string;
  target?: string;
  toolInputPreview?: string;
  surface?: string | null;
  value?: string | null;
  accessIntent?: { surface: string };
};

type PermissionsService = {
  registerAuthorizer(
    name: string,
    authorize: (
      details: PromptPermissionDetails,
      query: unknown,
      log: unknown,
    ) => Promise<AuthorizerVerdict>,
  ): () => void;
};

// How long a pending `ask` waits on the controller before the bridge hands it
// back to the human. This is a hand-back window, not a race: the permission
// system's chain is sequential (composeAuthorizerChain awaits each link, then
// falls through to the terminal LocalUserAuthorizer), so the TUI prompt is not
// yet on screen while the controller is thinking. Keep it short enough that an
// unattended controller does not strand the operator staring at an idle TUI.
const PERMISSION_WAIT_MS =
  Number(process.env.PI_BROKER_PERMISSION_TIMEOUT_MS) || 120000;

// The name the operator must list in the permission system's `authorizerChain`
// config for this link to have any authority at all. Registration alone grants
// nothing (ADR 0007 invariant 3).
const AUTHORIZER_NAME = "pi-broker";

// --- Mid-loop compaction ---------------------------------------------------
//
// Pi's own auto-compaction check (`_checkCompaction` in core/agent-session.js)
// only runs at `agent_end` or before a new prompt is submitted. It never runs
// between the individual tool calls of one uninterrupted agent run, so a model
// that keeps answering `stopReason: "toolUse"` never reaches the check at all.
// Upstream: https://github.com/earendil-works/pi/issues/8884. A real dispatched
// session here climbed 13k -> 170k tokens across 558 consecutive tool-use
// messages, past its configured reserve, with zero compactions, until the local
// model server ran out of memory and died.
//
// The bridge is in a position to close that gap without leaving the TUI:
// `message_end` fires once per assistant message *including* every message
// inside a tool loop, and `ExtensionContext.compact()` is a first-class API on
// the same ctx the handler already receives. So the fix is a threshold check on
// the context reading this handler already reads for telemetry.
//
// Percent of the context window at which a mid-loop compaction is forced. The
// incident's server died around 65% of a 262k window, so the default leaves
// real headroom below that rather than trying to land just under it — one
// oversized tool result between two checks must not be enough to cross from
// "safe" to "dead". Set the env var to 0 (or any non-positive value) to turn
// the automatic trigger off and keep only the manual `compact` action.
const AUTO_COMPACT_PERCENT = (() => {
  const raw = process.env.PI_BROKER_COMPACT_AT_PERCENT;
  if (raw === undefined || raw.trim() === "") return 55;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 55;
})();

// `compact()` aborts the running agent before summarizing (see
// AgentSession.compact), and pi's own threshold path deliberately does not
// auto-retry either — so a mid-loop compaction ends the run. For a *delegated*
// session that would silently abandon the controller's task half-done, which is
// not a mitigation. Once the summary lands the bridge therefore sends one
// ordinary user message telling the agent to carry on; it goes through the same
// `sendUserMessage` path as any delegated prompt, so it shows up in the TUI as
// visible input the human can see, interrupt, or override.
const COMPACT_RESUME_TEXT =
  process.env.PI_BROKER_COMPACT_RESUME_TEXT ??
  "[pi-broker] Your context was compacted mid-task because it was about to " +
    "overflow the model's context window. The summary above is what survived. " +
    "Continue the task you were working on from exactly where you left off — " +
    "do not restart it, and do not re-do work the summary says is already done.";

// After this many consecutive failures the automatic trigger stands down for
// the rest of the session. A failing compaction is usually a permanent
// condition for this branch ("Already compacted", "Nothing to compact", no
// model) rather than a transient one, and retrying it on every subsequent
// assistant message would be its own runaway loop.
const MAX_AUTO_COMPACT_FAILURES = 3;

// A compaction can succeed and still leave context above the threshold — a
// branch whose kept tail (`keepRecentTokens`) is already bigger than the
// threshold allows, or a threshold set below the session's own floor. Firing
// again on the next message would then abort the agent every single turn
// forever: a worse failure than the one being fixed. One ineffective
// compaction stands the automatic trigger down for the rest of the session and
// says so; pi's own end-of-turn check and the manual `compact` action both
// still work.

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
  // Asks currently blocked inside the authorizer link, keyed by the permission
  // system's own requestId. An entry lives only for the duration of one
  // authorize() call; settle() is idempotent so a duplicate or late controller
  // answer is dropped rather than resolving a second, unrelated ask.
  const pendingPermissions = new Map<
    string,
    (verdict: AuthorizerVerdict) => void
  >();
  let disposeAuthorizer: (() => void) | undefined;
  // Compaction is asynchronous and fire-and-forget: `context.compact()` returns
  // immediately and reports back through onComplete/onError. Nothing on
  // ExtensionContext exposes "a compaction is running" (isIdle() answers a
  // different question — the agent is idle *because* compaction aborted it), so
  // the bridge holds that state itself. Without it, every assistant message
  // arriving while the first summary is still being generated would start
  // another one.
  let compactionInFlight = false;
  // Set when the compaction currently in flight interrupted a live tool loop,
  // i.e. the agent had more work queued and must be told to resume afterwards.
  let resumeAfterCompaction = false;
  let consecutiveAutoCompactFailures = 0;
  let autoCompactStoodDown = false;

  function send(value: unknown) {
    if (socket?.writable) socket.write(`${JSON.stringify(value)}\n`);
  }

  function respondToPermission(command: BrokerCommand) {
    const { requestId, decision } = command;
    if (!requestId || !decision) return;
    const settle = pendingPermissions.get(requestId);
    if (!settle) {
      // The ask is already gone — the human clicked first, or it timed out and
      // was handed back. Say so explicitly so the controller learns its verdict
      // did not land instead of assuming silence meant success.
      send({
        type: "event",
        event: "permission_request_resolved",
        requestId,
        decision,
        applied: false,
        resolvedBy: "unknown",
        emittedAt: Date.now(),
      });
      return;
    }
    if (decision === "allow") settle({ kind: "allow" });
    else if (decision === "deny")
      settle({ kind: "deny", reason: command.reason });
    else settle({ kind: "defer" });
  }

  /**
   * Start a compaction and report both ends of it broker-ward.
   *
   * `trigger` distinguishes the automatic mid-loop threshold from a controller
   * asking for one, because they want different follow-through: only the
   * automatic one interrupted work that was still in progress and therefore
   * needs the resume nudge.
   *
   * Returns false when the request was dropped (no live context, or one is
   * already running) so the manual path can say so instead of implying it fired.
   */
  function startCompaction(
    trigger: "auto" | "manual",
    options: { resume: boolean; customInstructions?: string },
  ): boolean {
    if (!context || compactionInFlight) return false;
    compactionInFlight = true;
    resumeAfterCompaction = options.resume;
    const usage = context.getContextUsage?.();
    send({
      type: "event",
      event: "compaction_started",
      trigger,
      willResume: options.resume,
      contextUsage: usage
        ? {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
          }
        : undefined,
      emittedAt: Date.now(),
    });
    context.compact({
      customInstructions: options.customInstructions,
      onComplete: (result) => {
        compactionInFlight = false;
        if (trigger === "auto") consecutiveAutoCompactFailures = 0;
        // contextWindow is read from the pre-compaction usage above; the model
        // has not changed underneath a compaction it just ran.
        const window = usage?.contextWindow ?? 0;
        const after = result?.estimatedTokensAfter;
        if (
          trigger === "auto" &&
          window > 0 &&
          typeof after === "number" &&
          (after / window) * 100 >= AUTO_COMPACT_PERCENT
        ) {
          autoCompactStoodDown = true;
          context?.ui.notify(
            `Pi Broker: compaction left context at ${Math.round(
              (after / window) * 100,
            )}% of the window, still at or above the ${AUTO_COMPACT_PERCENT}% ` +
              "trigger. Automatic mid-loop compaction is standing down for this " +
              "session to avoid aborting every turn; raise " +
              "PI_BROKER_COMPACT_AT_PERCENT or lower keepRecentTokens.",
            "warning",
          );
        }
        send({
          type: "event",
          event: "compaction_finished",
          trigger,
          ok: true,
          tokensBefore: result?.tokensBefore,
          estimatedTokensAfter: result?.estimatedTokensAfter,
          emittedAt: Date.now(),
        });
        if (!resumeAfterCompaction) return;
        resumeAfterCompaction = false;
        // Plain delivery, not "steer": compaction left the session idle, and a
        // steer would be queued against a turn that no longer exists.
        pi.sendUserMessage(COMPACT_RESUME_TEXT);
      },
      onError: (error) => {
        compactionInFlight = false;
        resumeAfterCompaction = false;
        if (trigger === "auto") consecutiveAutoCompactFailures += 1;
        send({
          type: "event",
          event: "compaction_finished",
          trigger,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          emittedAt: Date.now(),
        });
      },
    });
    return true;
  }

  /**
   * The mitigation itself: the per-assistant-message threshold check pi does
   * not do.
   *
   * Deliberately scoped to `stopReason === "toolUse"` — the case pi genuinely
   * never covers. Any other stop reason means the run is about to reach
   * `agent_end`, where pi's own `_checkCompaction` runs; firing here as well
   * would race that check and abort a turn that was finishing anyway.
   */
  function maybeAutoCompact(
    stopReason: string | undefined,
    percent: number | null | undefined,
  ) {
    if (AUTO_COMPACT_PERCENT <= 0 || autoCompactStoodDown) return;
    if (stopReason !== "toolUse") return;
    if (compactionInFlight) return;
    if (consecutiveAutoCompactFailures >= MAX_AUTO_COMPACT_FAILURES) return;
    // null is pi's "unknown", e.g. immediately after a compaction and before
    // the next response reports usage — not a low reading, so never a trigger.
    if (percent === null || percent === undefined) return;
    if (percent < AUTO_COMPACT_PERCENT) return;
    startCompaction("auto", { resume: true });
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
    if (command.action === "permission_respond") {
      respondToPermission(command);
      return;
    }
    if (command.action === "compact") {
      // A controller-forced compaction does not resume on its own: the human or
      // the controller asked for this, so the next instruction is theirs to
      // give. Only the automatic mid-loop trigger, which interrupted work
      // nobody asked to stop, sends the resume nudge.
      const accepted = startCompaction("manual", {
        resume: false,
        customInstructions: command.text,
      });
      if (!accepted)
        send({
          type: "event",
          event: "compaction_finished",
          trigger: "manual",
          ok: false,
          error: compactionInFlight
            ? "a compaction is already running"
            : "no live session context",
          emittedAt: Date.now(),
        });
      return;
    }
    if (command.action === "shutdown") context?.shutdown();
  }

  /**
   * The live-permission link. Registered with the permission system's
   * authorizer chain, so it is consulted on every `ask` *before* the terminal
   * authorizer (the human's TUI prompt) is reached.
   *
   * Returning `defer` — on timeout, on a disconnected broker, or because the
   * controller said so — falls the ask through to that terminal, which is what
   * keeps the local operator's own Yes/No button working. The bridge only ever
   * answers *ahead of* the human; it never removes them from the loop.
   *
   * Note the permission system caps this link with its bounded-delegation
   * envelope: an `allow` on the `path` or `external_directory` surface is
   * downgraded to `defer` by the chain owner, so those asks always reach the
   * human no matter what the controller says. `deny` is never capped.
   */
  async function authorizeViaBroker(
    details: PromptPermissionDetails,
  ): Promise<AuthorizerVerdict> {
    if (!socket?.writable) return { kind: "defer" };

    const { requestId } = details;
    send({
      type: "event",
      event: "permission_request",
      requestId,
      source: details.source,
      surface: details.accessIntent?.surface ?? details.surface ?? null,
      value: details.value ?? null,
      agentName: details.agentName,
      message: details.message,
      toolName: details.toolName,
      skillName: details.skillName,
      path: details.path,
      command: details.command,
      target: details.target,
      toolInputPreview: details.toolInputPreview,
      timeoutMs: PERMISSION_WAIT_MS,
      emittedAt: Date.now(),
    });

    const verdict = await new Promise<AuthorizerVerdict>((resolve) => {
      let done = false;
      const settle = (value: AuthorizerVerdict) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pendingPermissions.delete(requestId);
        resolve(value);
      };
      const timer = setTimeout(
        () => settle({ kind: "defer" }),
        PERMISSION_WAIT_MS,
      );
      // Never hold the session's event loop open on an unanswered ask.
      timer.unref?.();
      pendingPermissions.set(requestId, settle);
    });

    send({
      type: "event",
      event: "permission_request_resolved",
      requestId,
      decision: verdict.kind,
      applied: verdict.kind !== "defer",
      // A `defer` is the hand-back: from here the human's TUI prompt decides.
      resolvedBy: verdict.kind === "defer" ? "human" : "controller",
      reason: verdict.kind === "deny" ? verdict.reason : undefined,
      emittedAt: Date.now(),
    });
    return verdict;
  }

  /**
   * Get the running permission system's published service.
   *
   * Preferred path is the package's own `getPermissionsService()` accessor.
   * The package's `.` export points at a `.ts` source file, so that import
   * only resolves under a TS-aware loader (jiti, which is what Pi loads
   * extensions with) — under a plain-Node loader it throws. The fallback reads
   * the very slot that accessor reads: the service is published onto
   * `globalThis` under `Symbol.for("@gotgenes/pi-permission-system:service")`,
   * deliberately process-global so it survives jiti's per-extension module
   * registry. Same instance either way; the fallback just needs no module
   * resolution.
   */
  async function resolvePermissionsService(): Promise<
    PermissionsService | undefined
  > {
    try {
      const mod = (await import("@gotgenes/pi-permission-system")) as {
        getPermissionsService?: () => PermissionsService | undefined;
      };
      const service = mod.getPermissionsService?.();
      if (service) return service;
    } catch {
      // Fall through to the globalThis slot.
    }
    const slot = (globalThis as Record<symbol, unknown>)[
      Symbol.for("@gotgenes/pi-permission-system:service")
    ];
    return slot as PermissionsService | undefined;
  }

  async function registerBrokerAuthorizer() {
    // permissions:ready re-fires on /reload. Drop any prior registration first
    // — the package's disposer is identity-guarded, so this is a no-op against
    // a fresh registry and prevents the duplicate-name throw against a
    // surviving one.
    disposeAuthorizer?.();
    disposeAuthorizer = undefined;
    try {
      const service = await resolvePermissionsService();
      if (!service) return;
      disposeAuthorizer = service.registerAuthorizer(
        AUTHORIZER_NAME,
        (details) => authorizeViaBroker(details),
      );
    } catch (error) {
      context?.ui.notify(
        `Pi Broker could not register its permission authorizer: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warning",
      );
    }
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
    // Report first, act second: the threshold check aborts the run, so doing it
    // before the send would cost the controller the very reading that explains
    // why the compaction fired.
    maybeAutoCompact(event.message.stopReason, contextUsage?.percent);
  });

  // Forwarded for observability only — the bridge's own compaction state is
  // driven by compact()'s onComplete/onError callbacks, not by this event,
  // because this one also fires for compactions pi ran by itself and (for ours)
  // fires partway through, before the summary is installed.
  pi.on("session_compact", (event, ctx) => {
    context = ctx;
    send({
      type: "event",
      event: "session_compact",
      reason: event.reason,
      willRetry: event.willRetry,
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
    // Hand every still-blocked ask back to the terminal authorizer before the
    // socket goes away, so a shutdown mid-ask cannot wedge the session.
    for (const settle of pendingPermissions.values()) settle({ kind: "defer" });
    pendingPermissions.clear();
    disposeAuthorizer?.();
    disposeAuthorizer = undefined;
    send({ type: "event", event: "session_shutdown" });
    socket?.end();
  });

  // Registration point per the permission system's own guidance: registering
  // from permissions:ready is robust to extension load order and survives
  // /reload (which re-publishes a fresh service and re-fires this event).
  pi.events.on("permissions:ready", () => {
    void registerBrokerAuthorizer();
  });

  // The moment the ask reaches the human's prompt — i.e. this bridge deferred,
  // or was never in the chain. Forwarded so a controller watching a session can
  // tell "waiting on me" (permission_request) from "waiting on the operator".
  pi.events.on("permissions:ui_prompt", (prompt: Record<string, unknown>) => {
    send({
      type: "event",
      event: "permission_ui_prompt",
      requestId: prompt.requestId,
      surface: prompt.surface,
      value: prompt.value,
      agentName: prompt.agentName,
      message: prompt.message,
      emittedAt: Date.now(),
    });
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
