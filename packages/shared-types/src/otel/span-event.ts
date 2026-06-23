// SPDX-License-Identifier: Apache-2.0
/**
 * otel/span-event — the `OtelSpanEvent` Zod schema (M1.1 / FDRS-480).
 *
 * The canonical internal representation of a single OpenTelemetry span, mapped
 * onto Pome's event union. From M1 on, OTel spans are the canonical model;
 * legacy `TwinHttpEvent` / `LlmCallEvent` / `ToolUseEvent` rows are shimmed *up*
 * into this shape (M1.2). `OtelSpanEvent` is a non-breaking `kind` extension of
 * the event union (composed in `./event-schema.ts`, cloud-only).
 *
 * Invariants enforced (review finding #4 — the schema was too weak):
 *   - `*_unix_nano` are uint64 decimal strings WITHIN range (no overflow that
 *     could throw a RangeError downstream).
 *   - IDs are real W3C trace context (32-/16-char lowercase hex, non-zero) OR
 *     an explicit `legacy:<source-id>` (the shim's namespace). Nothing else.
 *   - `end_time_unix_nano >= start_time_unix_nano` (no reversed spans).
 *   - `event_id === span_id` and `parent_id === parent_span_id` (the base
 *     event-union chain mirrors span context).
 *   - `ts` is exactly `nanosToIso(start_time_unix_nano)`.
 *   - the typed `gen_ai_*` / `http_*` / `url_*` / `server_*` / `error_type`
 *     fields EQUAL `projectAttributes(attributes)` — they are projections of
 *     the verbatim bag and cannot drift from it.
 *
 * Field conventions: snake_case, flat. `attributes` holds the FULL verbatim
 * attribute bag; the typed fields above are projections of it (see `project.ts`).
 */

import { z } from "zod";

import { compareUint64, isUint64, nanosToIso } from "./nano.js";
import {
  OTEL_PROJECTION_KEYS,
  otelAttributeValueSchema,
  projectAttributes,
} from "./project.js";

// OTel SpanKind, by name. OTLP encodes these as ints 0–5; the mapper normalizes
// numeric input onto these names. Order matches the OTLP enum (index == int).
export const OTEL_SPAN_KINDS = [
  "UNSPECIFIED",
  "INTERNAL",
  "SERVER",
  "CLIENT",
  "PRODUCER",
  "CONSUMER",
] as const;
export const otelSpanKindSchema = z.enum(OTEL_SPAN_KINDS);
export type OtelSpanKind = z.infer<typeof otelSpanKindSchema>;

// OTel status code, by name. OTLP encodes these as ints 0–2 (index == int).
export const OTEL_STATUS_CODES = ["UNSET", "OK", "ERROR"] as const;
export const otelStatusCodeSchema = z.enum(OTEL_STATUS_CODES);
export type OtelStatusCode = z.infer<typeof otelStatusCodeSchema>;

// uint64 nanoseconds-since-epoch as a decimal string, WITHIN the uint64 range.
export const unixNanoSchema = z
  .string()
  .refine(isUint64, "expected a uint64 decimal string (unix nanoseconds) within range");

// ── W3C trace-context identifiers ────────────────────────────────────────────
// Real OTel IDs are lowercase hex, fixed-width, and never all-zero (the
// all-zero id is the "invalid" sentinel). The shim namespaces non-OTel legacy
// ids as `legacy:<source-id>` so a stored span always declares its provenance.
const NON_ZERO = (hex: string) => /[1-9a-f]/.test(hex);
export const w3cTraceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "expected a 32-char lowercase-hex W3C trace id")
  .refine(NON_ZERO, "trace id must not be all-zero");
export const w3cSpanIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/, "expected a 16-char lowercase-hex W3C span id")
  .refine(NON_ZERO, "span id must not be all-zero");
const legacyIdSchema = z
  .string()
  .regex(/^legacy:.+$/, "expected a `legacy:<source-id>` namespaced id");

// A canonical stored id: either real W3C trace context or an explicit
// `legacy:` id. Used for the `OtelSpanEvent` (which may originate from the shim).
export const canonicalTraceIdSchema = z.union([w3cTraceIdSchema, legacyIdSchema]);
export const canonicalSpanIdSchema = z.union([w3cSpanIdSchema, legacyIdSchema]);

const otelSpanEventObjectSchema = z.object({
  // ── shared event-union base (mirrors `eventBaseShape` in recorder-events.ts) ─
  ts: z.string().datetime(),
  event_id: canonicalSpanIdSchema,
  parent_id: canonicalSpanIdSchema.nullable(),
  kind: z.literal("OtelSpanEvent"),

  // ── W3C trace context — real span parentage (M3 correlation reads these) ────
  trace_id: canonicalTraceIdSchema,
  span_id: canonicalSpanIdSchema,
  parent_span_id: canonicalSpanIdSchema.nullable(),

  // ── span identity / timing / status ────────────────────────────────────────
  name: z.string().min(1),
  span_kind: otelSpanKindSchema,
  start_time_unix_nano: unixNanoSchema,
  end_time_unix_nano: unixNanoSchema.nullable(),
  status_code: otelStatusCodeSchema,
  status_message: z.string().nullable(),

  // ── GenAI projections (flat; null when the span lacks the attribute) ────────
  gen_ai_provider_name: z.string().nullable(),
  gen_ai_operation_name: z.string().nullable(),
  gen_ai_request_model: z.string().nullable(),
  gen_ai_agent_name: z.string().nullable(),
  gen_ai_agent_id: z.string().nullable(),
  gen_ai_tool_name: z.string().nullable(),
  gen_ai_usage_input_tokens: z.number().int().min(0).nullable(),
  gen_ai_usage_output_tokens: z.number().int().min(0).nullable(),

  // ── HTTP / core projections (flat; null when the span lacks the attribute) ──
  http_request_method: z.string().nullable(),
  http_response_status_code: z.number().int().nullable(),
  url_full: z.string().nullable(),
  url_path: z.string().nullable(),
  server_address: z.string().nullable(),
  server_port: z.number().int().min(0).nullable(),
  error_type: z.string().nullable(),

  // ── full, verbatim attribute bag (lossless; typed fields project from this) ─
  attributes: z.record(z.string(), otelAttributeValueSchema),
});

export const otelSpanEventSchema = otelSpanEventObjectSchema.superRefine((event, ctx) => {
  // Base-union chain mirrors span context.
  if (event.event_id !== event.span_id) {
    ctx.addIssue({
      code: "custom",
      path: ["event_id"],
      message: "event_id must equal span_id",
    });
  }
  if (event.parent_id !== event.parent_span_id) {
    ctx.addIssue({
      code: "custom",
      path: ["parent_id"],
      message: "parent_id must equal parent_span_id",
    });
  }

  // `ts` is the human-sortable mirror of the span start time.
  if (event.ts !== nanosToIso(event.start_time_unix_nano)) {
    ctx.addIssue({
      code: "custom",
      path: ["ts"],
      message: "ts must equal nanosToIso(start_time_unix_nano)",
    });
  }

  // No reversed spans.
  if (
    event.end_time_unix_nano !== null &&
    compareUint64(event.end_time_unix_nano, event.start_time_unix_nano) < 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["end_time_unix_nano"],
      message: "end_time_unix_nano must be >= start_time_unix_nano",
    });
  }

  // Projection-drift guard: typed fields must equal the attribute bag's
  // projection. The mapper and shim both build them via `projectAttributes`,
  // so a mismatch means a hand-constructed (or corrupted) event.
  const projected = projectAttributes(event.attributes);
  for (const key of OTEL_PROJECTION_KEYS) {
    if (event[key] !== projected[key]) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} must equal projectAttributes(attributes).${key}`,
      });
    }
  }
});
export type OtelSpanEvent = z.infer<typeof otelSpanEventObjectSchema>;
