// SPDX-License-Identifier: Apache-2.0
//
// OpenTelemetry gen_ai span emission for pome adapter agents.
//
// pome-cloud's dashboard "Agent telemetry" panel (per-task tokens / latency /
// errors) is fed by `gen_ai` OTLP spans ingested at
// `POST /v1/sessions/:id/traces` (OTLP/HTTP **JSON** only) into the session's
// `otlp-spans.jsonl` blob; `finalize` rolls them up onto the run. Claude Code's
// own telemetry emits OTel *metrics + logs*, never gen_ai trace spans, so this
// module is what produces the spans the rollup reads.
//
// Wiring: the CLI runner injects `POME_OTEL_EXPORTER_OTLP_ENDPOINT` (the full
// session-scoped traces URL), `POME_OTEL_EXPORTER_OTLP_HEADERS` (the agent_token
// bearer), `OTEL_SERVICE_NAME`, and `OTEL_RESOURCE_ATTRIBUTES`. `withPome()`
// stands up an OTLP/JSON trace exporter from those; `query()` emits one CLIENT
// span per assistant turn with the model + that turn's token usage; the run
// flushes before the agent process exits (finalize reads the blob right after).
//
// No endpoint env → every export is a static no-op (standalone dev, or any
// agent run outside the pome CLI). Telemetry failures never surface to the
// agent: init and flush swallow their own errors.

import { SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

export const OTEL_ENDPOINT_ENV = "POME_OTEL_EXPORTER_OTLP_ENDPOINT";
export const OTEL_HEADERS_ENV = "POME_OTEL_EXPORTER_OTLP_HEADERS";

let provider: BasicTracerProvider | null = null;
let tracer: Tracer | null = null;
let initialized = false;

// Parse the OTel `key1=value1,key2=value2` env format (used by both
// OTEL_EXPORTER_OTLP_HEADERS and OTEL_RESOURCE_ATTRIBUTES) into a record. Splits
// each pair on its FIRST `=` so header/attribute values may themselves contain
// `=` (e.g. base64). Malformed pairs (no key) are skipped.
function parseKeyValueList(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Lazily initialize the OTLP/JSON trace exporter. Idempotent: the first call
 * builds the provider (or decides telemetry is off and records that decision),
 * every later call returns the cached tracer. Returns null when telemetry is
 * disabled — no `POME_OTEL_EXPORTER_OTLP_ENDPOINT` — or if setup throws.
 *
 * Called by `withPome()` (the documented init point) and lazily by the span
 * emitter so an agent that emits before `withPome()` still works.
 */
export function ensureOtel(): Tracer | null {
  if (initialized) return tracer;
  initialized = true;

  const endpoint = process.env[OTEL_ENDPOINT_ENV]?.trim();
  if (!endpoint) return null;

  try {
    const attributes: Record<string, string> = {
      "service.name": process.env.OTEL_SERVICE_NAME?.trim() || "pome-agent",
      ...parseKeyValueList(process.env.OTEL_RESOURCE_ATTRIBUTES),
    };
    const exporter = new OTLPTraceExporter({
      // Full session-scoped traces URL from the CLI — used verbatim (the
      // exporter does NOT append `/v1/traces` when `url` is set explicitly).
      url: endpoint,
      headers: parseKeyValueList(process.env[OTEL_HEADERS_ENV]),
    });
    provider = new BasicTracerProvider({
      resource: resourceFromAttributes(attributes),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    tracer = provider.getTracer("@pome-sh/adapter-claude-sdk");
    return tracer;
  } catch {
    // Telemetry must never break the agent run.
    provider = null;
    tracer = null;
    return null;
  }
}

export interface GenAiTurn {
  /** Model id from the assistant message (e.g. "claude-opus-4-8"). */
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Span window in epoch milliseconds (approximated from message timing). */
  startTimeMs: number;
  endTimeMs: number;
  /** Mark the span ERROR (the turn carried an SDK error / non-OK stop). */
  isError: boolean;
}

/**
 * Emit one `gen_ai` CLIENT span for a single LLM turn. Attribute names follow
 * the OTel GenAI semantic conventions pome-cloud projects
 * (`gen_ai.usage.input_tokens` / `output_tokens`, `gen_ai.request.model`).
 * No-op when telemetry is disabled.
 */
export function recordGenAiSpan(turn: GenAiTurn): void {
  const t = ensureOtel();
  if (!t) return;

  const attributes: Record<string, string | number> = {
    "gen_ai.provider.name": "anthropic",
    "gen_ai.operation.name": "chat",
  };
  if (turn.model) attributes["gen_ai.request.model"] = turn.model;
  if (turn.inputTokens != null) attributes["gen_ai.usage.input_tokens"] = turn.inputTokens;
  if (turn.outputTokens != null) attributes["gen_ai.usage.output_tokens"] = turn.outputTokens;

  const span = t.startSpan(`chat ${turn.model ?? "unknown"}`, {
    kind: SpanKind.CLIENT,
    startTime: turn.startTimeMs,
    attributes,
  });
  if (turn.isError) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end(turn.endTimeMs);
}

/**
 * Flush pending spans to the collector. The pome CLI relies on this completing
 * before the agent process exits — finalize reads the session trace blob right
 * after the agent returns. Best-effort: a flush failure is swallowed.
 */
export async function flushPomeTelemetry(): Promise<void> {
  if (!provider) return;
  try {
    await provider.forceFlush();
  } catch {
    // best-effort
  }
}

/** Test-only: reset module state so a fresh env can be re-read. */
export function _resetOtelForTest(): void {
  provider = null;
  tracer = null;
  initialized = false;
}
