// SPDX-License-Identifier: Apache-2.0
/**
 * otel/legacy-shim — legacy event → `OtelSpanEvent` translation (M1.2 / FDRS-481).
 *
 * The compatibility layer for the transition window: the CLI keeps uploading its
 * current JSONL (no flag day), and OTel-aware downstream (M3 correlation, the
 * native waterfall) reads `OtelSpanEvent`. This shim translates the three legacy
 * variants — `TwinHttpEvent`, `LlmCallEvent`, `ToolUseEvent` — up into spans so
 * legacy and new data share one path.
 *
 * Guarantees:
 *   - **Lossless.** The ENTIRE original record is preserved verbatim as a JSON
 *     string under `attributes["pome.legacy.record_json"]` — serialized from the
 *     raw input BEFORE Zod strips any additive fields (review finding #3). The
 *     mapped fields are ALSO written as canonical OTel attributes, from which
 *     the typed projections are derived by the SAME projector the schema checks.
 *   - **Deterministic.** No clock, no randomness. Same record (+ same `run_id`
 *     option) → byte-identical span, every run.
 *   - **OTel-correct status** (review findings #5/#9). HTTP client spans: 1xx–3xx
 *     leave status UNSET; 4xx/5xx and transport errors are ERROR. (OTel does not
 *     set OK on a merely-successful span.)
 *
 * IDs are namespaced `legacy:<source-id>` so a stored span always declares it
 * originated from a pre-OTel record (the canonical schema accepts either real
 * W3C ids or `legacy:` ids).
 *
 * Pinned convention: the shim targets `OTEL_GENAI_SCHEMA_VERSION` (see `./semconv`).
 */

import { z } from "zod";

import {
  llmCallEventSchema,
  toolUseEventSchema,
  twinHttpEventSchema,
} from "../recorder-events.js";
import { msToNanos, nanosToIso } from "./nano.js";
import {
  projectAttributes,
  type OtelAttributeBag,
  type OtelAttributeValue,
} from "./project.js";
import {
  ERROR_TYPE,
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  HTTP_REQUEST_METHOD,
  HTTP_RESPONSE_STATUS_CODE,
  OTEL_GENAI_SCHEMA_VERSION,
  SERVER_ADDRESS,
  SERVER_PORT,
  URL_FULL,
  URL_PATH,
} from "./semconv.js";
import { otelSpanEventSchema, type OtelSpanEvent } from "./span-event.js";

// The shim targets this pinned GenAI convention version (from M1.1). This
// re-export makes the pin explicit and testable.
export const LEGACY_SHIM_SEMCONV_VERSION = OTEL_GENAI_SCHEMA_VERSION;

// The documented namespace for legacy provenance. `record_json` is the lossless
// source of truth; `kind` records the originating legacy variant.
export const LEGACY_ATTR_NAMESPACE = "pome.legacy" as const;
export const LEGACY_ID_PREFIX = "legacy:" as const;
const ATTR_LEGACY_KIND = `${LEGACY_ATTR_NAMESPACE}.kind`;
const ATTR_LEGACY_RECORD_JSON = `${LEGACY_ATTR_NAMESPACE}.record_json`;

// The legacy variants this shim accepts. Discriminated on `kind`.
//
// NOT-SHIMMABLE-IN-M1: `HookEvent`, `ToolResultEvent`, `SubagentSpawnEvent`, and
// `LlmTurnEvent` (F-766) are intentionally absent. They are captured into
// events.jsonl but not projected to spans yet — the M2 projection layer adds
// full coverage (LlmTurnEvent → a `chat` span carrying the cache-token
// attributes; ToolResult pairs into its execute_tool span; etc.). Until then
// `shimLegacyEventToSpan` rejects these kinds with a typed ZodError rather than
// emitting a lossy span. The otel-legacy-shim test locks this deliberately.
export const shimmableLegacyEventSchema = z.discriminatedUnion("kind", [
  twinHttpEventSchema,
  llmCallEventSchema,
  toolUseEventSchema,
]);
export type ShimmableLegacyEvent = z.infer<typeof shimmableLegacyEventSchema>;

export interface LegacyShimOptions {
  // The legacy RUN this record belongs to — used to group rows into one trace.
  // Legacy JSONL is uploaded per run, so the caller knows it. REQUIRED for
  // `LlmCallEvent` / `ToolUseEvent` (no internal run context); a `TwinHttpEvent`
  // falls back to its own `run_id`. Stored as `legacy:<run_id>`.
  run_id?: string;
}

// `legacy:`-namespace a non-OTel source id. Idempotent if already namespaced.
function legacyId(sourceId: string): string {
  return sourceId.startsWith(LEGACY_ID_PREFIX) ? sourceId : `${LEGACY_ID_PREFIX}${sourceId}`;
}

// Resolve the legacy run id used as the trace grouping key.
function resolveRunId(options: LegacyShimOptions, record: ShimmableLegacyEvent): string {
  if (options.run_id !== undefined) {
    return options.run_id;
  }
  if (record.kind === "TwinHttpEvent") {
    return record.run_id;
  }
  // No run context — LLM/tool rows carry none internally. Refusing here keeps
  // related rows from each landing in their own orphan trace.
  throw new Error(
    `legacy-shim: ${record.kind} requires options.run_id for trace context`,
  );
}

// Drop null/undefined entries so the bag stays a valid attribute record (the
// attribute schema has no null member — an absent attribute is omitted).
function buildBag(
  entries: Record<string, OtelAttributeValue | null | undefined>,
): OtelAttributeBag {
  const bag: OtelAttributeBag = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== null && value !== undefined) bag[key] = value;
  }
  return bag;
}

// OTel HTTP client span status: success (incl. redirects) stays UNSET; 4xx/5xx
// and transport errors are ERROR (review #9). Returns the status + the
// low-cardinality `error.type` token to stamp on the bag.
function httpStatus(
  status: number,
  error: string | null,
): { code: "UNSET" | "ERROR"; errorType: string | null } {
  if (error !== null) return { code: "ERROR", errorType: "network_error" };
  if (status >= 400) return { code: "ERROR", errorType: String(status) };
  return { code: "UNSET", errorType: null };
}

/**
 * Translate a single legacy `TwinHttpEvent` / `LlmCallEvent` / `ToolUseEvent`
 * into a validated `OtelSpanEvent`.
 *
 * Throws a typed `ZodError` if `rawRecord` is not one of those three shapes,
 * or a plain `Error` if an LLM/tool record is missing the required `run_id`.
 */
export function shimLegacyEventToSpan(
  rawRecord: unknown,
  options: LegacyShimOptions = {},
): OtelSpanEvent {
  const record = shimmableLegacyEventSchema.parse(rawRecord);

  const startMs = Date.parse(record.ts);
  const startNano = msToNanos(startMs);
  const traceId = legacyId(resolveRunId(options, record));
  const spanId = legacyId(record.event_id);
  const parentSpanId = record.parent_id !== null ? legacyId(record.parent_id) : null;

  // Lossless: serialize the RAW input (not the Zod-stripped record) so additive
  // legacy fields survive round-trip.
  const legacyNamespace = {
    [ATTR_LEGACY_KIND]: record.kind,
    [ATTR_LEGACY_RECORD_JSON]: JSON.stringify(rawRecord),
  };

  let name: string;
  let spanKind: OtelSpanEvent["span_kind"];
  let endNano: string | null;
  let statusCode: OtelSpanEvent["status_code"];
  let statusMessage: string | null;
  let semanticAttrs: OtelAttributeBag;

  if (record.kind === "TwinHttpEvent") {
    const status = httpStatus(record.status, record.error);
    // Low-cardinality span name: HTTP method only (the concrete path is a high-
    // cardinality URL, not a route template) — review #4.
    name = record.method;
    spanKind = "CLIENT";
    endNano = msToNanos(startMs + record.latency_ms);
    statusCode = status.code;
    statusMessage = record.error;
    semanticAttrs = buildBag({
      [HTTP_REQUEST_METHOD]: record.method,
      [HTTP_RESPONSE_STATUS_CODE]: record.status,
      [URL_PATH]: record.path,
      [ERROR_TYPE]: status.errorType,
    });
  } else if (record.kind === "LlmCallEvent") {
    // Asymmetry vs TwinHttpEvent (intentional, M1): a legacy LlmCallEvent has no
    // transport-error field, so only an HTTP >=400 status drives ERROR here —
    // a connection-level failure with a null status stays UNSET. M3 unifies on
    // real OTel span status; until then LLM rows may under-report errors vs HTTP.
    const errored = record.status !== null && record.status >= 400;
    name = record.model !== null ? `chat ${record.model}` : "chat";
    spanKind = "CLIENT";
    endNano = msToNanos(startMs + record.latency_ms);
    statusCode = errored ? "ERROR" : "UNSET";
    statusMessage = null;
    semanticAttrs = buildBag({
      [GEN_AI_OPERATION_NAME]: "chat",
      [GEN_AI_REQUEST_MODEL]: record.model,
      [GEN_AI_USAGE_INPUT_TOKENS]: record.prompt_tokens,
      [GEN_AI_USAGE_OUTPUT_TOKENS]: record.completion_tokens,
      [HTTP_REQUEST_METHOD]: record.method,
      [HTTP_RESPONSE_STATUS_CODE]: record.status,
      [URL_FULL]: record.url,
      [SERVER_ADDRESS]: record.host,
      [SERVER_PORT]: record.port,
      [ERROR_TYPE]: errored ? String(record.status) : null,
    });
  } else {
    // ToolUseEvent
    name = `execute_tool ${record.tool_name}`;
    spanKind = "INTERNAL";
    endNano = null;
    statusCode = "UNSET";
    statusMessage = null;
    semanticAttrs = buildBag({
      [GEN_AI_OPERATION_NAME]: "execute_tool",
      [GEN_AI_TOOL_NAME]: record.tool_name,
    });
  }

  const attributes: OtelAttributeBag = { ...semanticAttrs, ...legacyNamespace };

  const candidate = {
    ts: nanosToIso(startNano),
    event_id: spanId,
    parent_id: parentSpanId,
    kind: "OtelSpanEvent" as const,
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: parentSpanId,
    name,
    span_kind: spanKind,
    start_time_unix_nano: startNano,
    end_time_unix_nano: endNano,
    status_code: statusCode,
    status_message: statusMessage,
    ...projectAttributes(attributes),
    attributes,
  };

  // Re-validate so the shim's output is provably a canonical `OtelSpanEvent`.
  return otelSpanEventSchema.parse(candidate);
}
