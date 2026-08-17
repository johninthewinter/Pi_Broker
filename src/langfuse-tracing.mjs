// Optional Langfuse observability for the broker's event broadcast stream.
//
// Opt-in, degrade-to-nothing by design: this module must never throw out of
// `record()`, must never delay or block a dispatch, and must never crash the
// broker if Langfuse is disabled, unreachable, or misconfigured. Every
// registered session/agent still works exactly as before if tracing is off
// or fails to initialize — this is a shared tool other in-flight Strong Card
// sessions depend on.
//
// One Langfuse *trace* per broker session (deterministic trace id derived
// from the session id itself, e.g. "sc-p0-26a", via createTraceId — see
// "Trace and observation IDs" at
// https://langfuse.com/docs/observability/sdk/instrumentation#trace-ids),
// with child observations for what happens inside it:
//   - a span per turn, opened on "agent_start", closed on whichever of
//     "agent_end" / "agent_settled" arrives first
//   - "assistant_message" text captured as a generation's output, nested in
//     the open turn span
//   - "permission_decision", "input", and "turn_summary" (per-SDK-turn tool
//     result counts) recorded as events nested in the open turn span (or the
//     session root span if no turn is open); permission_decision counts are
//     also tallied and attached as metadata when the turn span closes
//   - assistant_message generations additionally carry per-generation model
//     id/params (when the bridge sends them) and context-window usage as
//     metadata; turn spans carry gapSinceLastTurnMs (operator/controller
//     latency since the previous turn closed) as metadata when opened
//   - session-level metadata (cwd/model, when the bridge sends them) applied
//     to the trace's root span; sessionId/tags propagated onto the trace
//     itself via propagateAttributes so the Langfuse Sessions view groups by
//     broker session id
//
// IMPORTANT — a self-hosted Langfuse instance running v4 in
// LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only will REJECT the classic
// `langfuse` npm package (v3.x REST ingestion, trace-create/span-create/
// event-create via /api/public/ingestion) with "Event type not accepted
// ... This endpoint only accepts score and log events". Only the OTEL-based
// v5 SDK (@langfuse/tracing + @langfuse/otel on an @opentelemetry/sdk-node
// NodeSDK) is accepted. Do not "fix" this by swapping back to the
// `langfuse` package without checking your instance's write mode first.
//
// See README.md "Observability (Langfuse)" for the operator-facing summary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_HOST = "http://localhost:3000";
const DEFAULT_ENV_FILE = path.join(os.homedir(), ".langfuse", ".env");

// Arbitrary, fixed, non-existent parent span id used only to anchor new
// root spans onto a deterministic trace id (see parentSpanContext usage
// below) — mirrors the Langfuse docs' own "link to existing trace" example.
// It never corresponds to a real span, so reusing it across sessions is
// harmless; only the (per-session-derived) traceId matters.
const ROOT_PARENT_SPAN_ID = "0123456789abcdef";

function readEnvFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const values = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return values;
  } catch {
    return {};
  }
}

/**
 * Resolve public/secret keys + host. Precedence:
 *   1. PI_BROKER_LANGFUSE_PUBLIC_KEY / PI_BROKER_LANGFUSE_SECRET_KEY
 *      (explicit override, e.g. from `secret get` piped into the environment
 *      by whoever launches the broker)
 *   2. LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (generic env, in case some
 *      other tool already exported them)
 *   3. LANGFUSE_INIT_PROJECT_PUBLIC_KEY / LANGFUSE_INIT_PROJECT_SECRET_KEY
 *      read from your Langfuse instance's `.env` file — for a self-hosted
 *      docker-compose Langfuse, these are the project-scoped keys generated
 *      at init time, distinct from any generic LANGFUSE_PUBLIC_KEY /
 *      LANGFUSE_SECRET_KEY you may have stashed elsewhere (a secrets
 *      manager entry under those generic names won't necessarily match a
 *      given project's credentials — verify against your instance's
 *      /api/public/projects if auth fails). That LANGFUSE_INIT_PROJECT_*
 *      pair is what actually authenticates against a fresh self-hosted
 *      instance, so it's the default source here.
 */
export function resolveCredentials(env = process.env) {
  const host = env.PI_BROKER_LANGFUSE_HOST || env.LANGFUSE_HOST || DEFAULT_HOST;

  if (env.PI_BROKER_LANGFUSE_PUBLIC_KEY && env.PI_BROKER_LANGFUSE_SECRET_KEY) {
    return {
      publicKey: env.PI_BROKER_LANGFUSE_PUBLIC_KEY,
      secretKey: env.PI_BROKER_LANGFUSE_SECRET_KEY,
      host,
    };
  }
  if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
    return {
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      host,
    };
  }
  const fromFile = readEnvFile(env.PI_BROKER_LANGFUSE_ENV_FILE || DEFAULT_ENV_FILE);
  if (
    fromFile.LANGFUSE_INIT_PROJECT_PUBLIC_KEY &&
    fromFile.LANGFUSE_INIT_PROJECT_SECRET_KEY
  ) {
    return {
      publicKey: fromFile.LANGFUSE_INIT_PROJECT_PUBLIC_KEY,
      secretKey: fromFile.LANGFUSE_INIT_PROJECT_SECRET_KEY,
      host,
    };
  }
  return null;
}

export function tracingEnabled(env = process.env) {
  return env.PI_BROKER_LANGFUSE === "1";
}

// Metadata values must be strings for propagateAttributes; best-effort coerce.
function metaString(value) {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

// pi-ai's Usage shape -> Langfuse's usageDetails ({[key: string]: number}).
// Only include fields that are actually present (some providers don't report
// reasoning/cache breakdowns) — an undefined field would otherwise coerce to
// NaN/omit silently depending on the SDK's own handling; be explicit instead.
function usageDetailsFrom(usage) {
  const details = {
    input: usage.input,
    output: usage.output,
    total: usage.totalTokens,
  };
  if (usage.cacheRead) details.cacheRead = usage.cacheRead;
  if (usage.cacheWrite) details.cacheWrite = usage.cacheWrite;
  if (usage.cacheWrite1h) details.cacheWrite1h = usage.cacheWrite1h;
  if (usage.reasoning !== undefined) details.reasoning = usage.reasoning;
  return details;
}

function costDetailsFrom(cost) {
  const details = {};
  for (const [key, value] of Object.entries(cost)) {
    if (typeof value === "number") details[key] = value;
  }
  return details;
}

class SessionState {
  constructor(rootSpan) {
    this.rootSpan = rootSpan;
    this.turnCount = 0;
    this.currentSpan = null;
    this.spanClosed = true;
    this.ended = false;
    // ms since epoch when the current turn's agent_start arrived, used as a
    // generation's startTime so Langfuse can compute real latency/TPS
    // (usage.output / latencySeconds) instead of guessing from ingestion order.
    this.turnStartedAt = null;
    // Running count of "permission_decision" events seen while the current
    // turn span is open, reset on each agent_start, attached as metadata
    // when the span closes (agent_end/agent_settled).
    this.permissionDecisionCount = 0;
    // ms since epoch when the previous turn's span closed (agent_end/
    // agent_settled), used to compute operator/controller gap time before
    // the next turn's agent_start. Null until a first turn has closed.
    this.lastTurnClosedAt = null;
  }
}

export class LangfuseTracer {
  constructor() {
    this.enabled = false;
    this.sdk = null;
    this.processor = null;
    this.createTraceId = null;
    this.startObservation = null;
    this.propagateAttributes = null;
    // sessionId -> Promise<SessionState>, chained so events for one session
    // are always applied in arrival order even though session creation and
    // trace-id derivation are async.
    this.chains = new Map();
    this.warned = false;
  }

  /** Best-effort async init. Never throws; leaves the tracer disabled on any failure. */
  async init(env = process.env) {
    if (!tracingEnabled(env)) return this;
    const creds = resolveCredentials(env);
    if (!creds) {
      this.#warn(
        "PI_BROKER_LANGFUSE=1 set but no Langfuse credentials found " +
          "(checked PI_BROKER_LANGFUSE_*, LANGFUSE_*, and your Langfuse instance's .env) — tracing disabled."
      );
      return this;
    }
    try {
      const [{ NodeSDK }, { LangfuseSpanProcessor }, tracing] = await Promise.all([
        import("@opentelemetry/sdk-node"),
        import("@langfuse/otel"),
        import("@langfuse/tracing"),
      ]);
      this.processor = new LangfuseSpanProcessor({
        publicKey: creds.publicKey,
        secretKey: creds.secretKey,
        baseUrl: creds.host,
      });
      this.sdk = new NodeSDK({ spanProcessors: [this.processor] });
      this.sdk.start();
      this.createTraceId = tracing.createTraceId;
      this.startObservation = tracing.startObservation;
      this.propagateAttributes = tracing.propagateAttributes;
      this.enabled = true;
    } catch (error) {
      this.#warn(`Langfuse init failed, tracing disabled: ${error.message ?? error}`);
      this.enabled = false;
    }
    return this;
  }

  #warn(message) {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`[pi-broker] langfuse: ${message}\n`);
  }

  /** Applies `fn` to a session's state, creating it lazily, preserving per-session order. */
  #enqueue(sessionId, fn) {
    const prev = this.chains.get(sessionId) ?? this.#createState(sessionId);
    const next = prev.then(async (state) => {
      if (!state || state.ended) return state;
      try {
        await fn(state);
      } catch (error) {
        this.#warn(`dropped event for session ${sessionId}: ${error.message ?? error}`);
      }
      return state;
    });
    next.catch(() => {}); // already handled above; guard against stray rejection
    this.chains.set(sessionId, next);
  }

  async #createState(sessionId) {
    try {
      const traceId = await this.createTraceId(sessionId);
      let rootSpan;
      this.propagateAttributes(
        {
          sessionId,
          tags: ["pi-broker"],
          traceName: `pi-broker:${sessionId}`,
          metadata: { sessionId },
        },
        () => {
          rootSpan = this.startObservation(
            `pi-broker:${sessionId}`,
            { metadata: { sessionId } },
            {
              parentSpanContext: {
                traceId,
                spanId: ROOT_PARENT_SPAN_ID,
                traceFlags: 1,
              },
            },
          );
        },
      );
      return new SessionState(rootSpan);
    } catch (error) {
      this.#warn(`failed to open trace for session ${sessionId}: ${error.message ?? error}`);
      return null;
    }
  }

  /** Records one already-broadcast broker event. Swallows all errors, never blocks the caller. */
  record(event) {
    if (!this.enabled || !event || event.type !== "event") return;
    const sessionId = event.sessionId;
    if (!sessionId) return;
    this.#enqueue(sessionId, (state) => this.#apply(state, event));
  }

  #apply(state, event) {
    switch (event.event) {
      case "connected":
        return;

      case "session_start": {
        const metadata = {};
        if (event.cwd) metadata.cwd = event.cwd;
        if (event.model) metadata.model = event.model;
        state.rootSpan.update({ metadata });
        return;
      }

      case "input": {
        const parent = state.currentSpan ?? state.rootSpan;
        parent.startObservation(
          `input:${event.source ?? "unknown"}`,
          {
            input: event.text,
            metadata: { source: metaString(event.source), cursor: metaString(event.cursor) },
          },
          { asType: "event" },
        );
        return;
      }

      case "agent_start": {
        state.turnCount += 1;
        state.turnStartedAt = event.emittedAt ?? Date.now();
        state.permissionDecisionCount = 0;
        // Gap since the previous turn's span closed represents
        // operator/controller latency (time to decide/send the next prompt),
        // not model latency — only meaningful once a prior turn has closed
        // in this session.
        const gapMetadata =
          state.lastTurnClosedAt !== null
            ? { gapSinceLastTurnMs: metaString(state.turnStartedAt - state.lastTurnClosedAt) }
            : {};
        state.currentSpan = state.rootSpan.startObservation(
          `turn-${state.turnCount}`,
          { metadata: { cursor: metaString(event.cursor), ...gapMetadata } },
          { asType: "span" },
        );
        state.spanClosed = false;
        return;
      }

      case "agent_end":
      case "agent_settled": {
        if (state.currentSpan && !state.spanClosed) {
          state.currentSpan
            .update({
              metadata: {
                closedBy: event.event,
                permissionDecisionCount: metaString(state.permissionDecisionCount),
                // Per this project's own audit-trace convention: this turn
                // settled having made zero tool calls since its
                // agent_start — a free, literal "settle-without-tool-call"
                // incident signal for a later LLM-judge to weigh, not an
                // automatic verdict — a
                // turn can legitimately close with zero tool calls (e.g. a
                // plain conversational answer). Defaults to false if the
                // bridge didn't send the flag (older bridge, missing data)
                // so the field is always present and queryable either way.
                settledWithoutToolCall: metaString(event.settledWithoutToolCall ?? false),
              },
            })
            .end();
          state.spanClosed = true;
          // Only the event that actually closes the span sets the gap
          // anchor — agent_end and agent_settled both fire per turn, and
          // the second one (whichever it is) shouldn't push the anchor
          // later than the moment the span truly closed.
          state.lastTurnClosedAt = event.emittedAt ?? Date.now();
        }
        return;
      }

      case "assistant_message": {
        const parent = state.currentSpan ?? state.rootSpan;
        const usage = event.usage;
        const endedAt = event.emittedAt ?? Date.now();
        const contextUsage = event.contextUsage;
        // completionStartTime anchored to the turn's agent_start gives
        // Langfuse a real latency figure (endTime - completionStartTime) to
        // derive tokens/sec from, rather than treating the generation as
        // instantaneous. Falls back to omitted if we never saw agent_start
        // (shouldn't happen in practice — assistant_message always follows it).
        const generation = parent.startObservation(
          "assistant_message",
          {
            output: event.text,
            metadata: {
              stopReason: metaString(event.stopReason),
              cursor: metaString(event.cursor),
              ...(contextUsage
                ? {
                    contextTokens: metaString(contextUsage.tokens),
                    contextWindow: metaString(contextUsage.contextWindow),
                    contextPercent: metaString(contextUsage.percent),
                  }
                : {}),
            },
            ...(event.model ? { model: event.model } : {}),
            ...(event.modelParameters ? { modelParameters: event.modelParameters } : {}),
            ...(state.turnStartedAt
              ? { completionStartTime: new Date(state.turnStartedAt) }
              : {}),
            ...(usage ? { usageDetails: usageDetailsFrom(usage) } : {}),
            ...(usage?.cost ? { costDetails: costDetailsFrom(usage.cost) } : {}),
          },
          { asType: "generation" },
        );
        generation.end(new Date(endedAt));
        return;
      }

      case "permission_decision": {
        const parent = state.currentSpan ?? state.rootSpan;
        if (state.currentSpan && !state.spanClosed) state.permissionDecisionCount += 1;
        parent.startObservation(
          "permission_decision",
          {
            input: {
              surface: event.surface,
              result: event.result,
              resolution: event.resolution,
            },
            metadata: { cursor: metaString(event.cursor) },
          },
          { asType: "event" },
        );
        return;
      }

      case "turn_summary": {
        const parent = state.currentSpan ?? state.rootSpan;
        parent.startObservation(
          "turn_summary",
          {
            metadata: {
              turnIndex: metaString(event.turnIndex),
              toolResultCount: metaString(event.toolResultCount),
              toolNameCounts: metaString(event.toolNameCounts),
            },
          },
          { asType: "event" },
        );
        return;
      }

      case "session_shutdown":
      case "disconnected": {
        if (state.currentSpan && !state.spanClosed) {
          state.currentSpan.update({ metadata: { closedBy: event.event } }).end();
          state.spanClosed = true;
        }
        if (!state.ended) {
          state.rootSpan.end();
          state.ended = true;
        }
        return;
      }

      default:
        return;
    }
  }

  /** Best-effort flush, bounded so a slow/unreachable Langfuse never hangs shutdown. */
  async shutdown(timeoutMs = 5000) {
    if (!this.enabled) return;
    const pending = Promise.allSettled([...this.chains.values()]);
    const flush = pending.then(async () => {
      if (this.processor) await this.processor.forceFlush();
      if (this.sdk) await this.sdk.shutdown();
    });
    try {
      await Promise.race([flush, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    } catch {
      // best-effort — never block process exit on a flush failure
    }
  }
}
