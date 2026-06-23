// SPDX-License-Identifier: Apache-2.0
/**
 * otel/map-span — pure OTel span → `OtelSpanEvent` mapping (M1.1 / FDRS-480).
 *
 * Deterministic: same input → byte-identical event, every run. Has no clock,
 * no randomness; `ts` is derived from the span's start time.
 *
 * Input is a NORMALIZED span: real W3C trace context (lowercase-hex ids) and a
 * flat `attributes` `Record<string, value>`. Decoding raw OTLP/JSON `AnyValue`
 * (`{ stringValue }`, kvlist, bytes) and the `[{ key, value }]` attribute array
 * into this flat record is M2's job (the `@opentelemetry/otlp-transformer`
 * dependency) — keeping M1.1 free of an OTLP decoder keeps the schema
 * self-testable.
 *
 * Round-trip example:
 *
 *   mapOtelSpanToEvent({
 *     trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
 *     span_id: "00f067aa0ba902b7",
 *     name: "chat google/gemini-2.5-flash",
 *     start_time_unix_nano: "1700000000000000000",
 *     attributes: {
 *       "gen_ai.provider.name": "google",
 *       "gen_ai.request.model": "gemini-2.5-flash",
 *       "gen_ai.usage.input_tokens": 42,
 *     },
 *   })
 *   // → { ts: "2023-11-14T22:13:20.000Z", event_id: "00f067aa0ba902b7", … }
 */

import { z } from "zod";

import { nanosToIso } from "./nano.js";
import { otelAttributeValueSchema, projectAttributes } from "./project.js";
import {
  OTEL_SPAN_KINDS,
  OTEL_STATUS_CODES,
  otelSpanEventSchema,
  otelSpanKindSchema,
  otelStatusCodeSchema,
  unixNanoSchema,
  w3cSpanIdSchema,
  w3cTraceIdSchema,
  type OtelSpanEvent,
  type OtelSpanKind,
  type OtelStatusCode,
} from "./span-event.js";

// Normalized OTLP span input. IDs are strict W3C trace context (real OTel
// always emits hex). `kind` / `status.code` accept either the OTLP integer
// (0–5 / 0–2) or the name; everything else is already decoded.
export const otelSpanInputSchema = z.object({
  trace_id: w3cTraceIdSchema,
  span_id: w3cSpanIdSchema,
  parent_span_id: w3cSpanIdSchema.nullable().optional(),
  name: z.string().min(1),
  kind: z.union([otelSpanKindSchema, z.number().int().min(0).max(5)]).optional(),
  start_time_unix_nano: unixNanoSchema,
  end_time_unix_nano: unixNanoSchema.nullable().optional(),
  status: z
    .object({
      code: z.union([otelStatusCodeSchema, z.number().int().min(0).max(2)]).optional(),
      message: z.string().nullable().optional(),
    })
    .optional(),
  attributes: z.record(z.string(), otelAttributeValueSchema).default({}),
});
export type OtelSpanInput = z.infer<typeof otelSpanInputSchema>;

function normalizeSpanKind(kind: OtelSpanInput["kind"]): OtelSpanKind {
  if (kind === undefined) {
    // OTel SDKs default an unset kind to INTERNAL.
    return "INTERNAL";
  }
  if (typeof kind === "number") {
    // Bounded 0–5 by `otelSpanInputSchema`; `!` avoids an unreachable branch.
    return OTEL_SPAN_KINDS[kind]!;
  }
  return kind;
}

function normalizeStatusCode(code: number | OtelStatusCode | undefined): OtelStatusCode {
  if (code === undefined) {
    return "UNSET";
  }
  if (typeof code === "number") {
    // Bounded 0–2 by `otelSpanInputSchema`; `!` avoids an unreachable branch.
    return OTEL_STATUS_CODES[code]!;
  }
  return code;
}

/**
 * Map a normalized OTLP span onto a validated `OtelSpanEvent`.
 *
 * Throws a `ZodError` (typed; names the offending field) when the input is
 * malformed — a non-hex `trace_id`, an out-of-range unix-nano, a reversed span
 * (end < start), a non-finite attribute value, etc.
 */
export function mapOtelSpanToEvent(rawSpan: unknown): OtelSpanEvent {
  const span = otelSpanInputSchema.parse(rawSpan);
  const attributes = span.attributes;
  const parentSpanId = span.parent_span_id ?? null;

  const candidate = {
    ts: nanosToIso(span.start_time_unix_nano),
    // The span id IS the canonical row id for an OTel event; the base
    // parent-chain mirrors span parentage so downstream union readers and M3
    // correlation agree.
    event_id: span.span_id,
    parent_id: parentSpanId,
    kind: "OtelSpanEvent" as const,

    trace_id: span.trace_id,
    span_id: span.span_id,
    parent_span_id: parentSpanId,

    name: span.name,
    span_kind: normalizeSpanKind(span.kind),
    start_time_unix_nano: span.start_time_unix_nano,
    end_time_unix_nano: span.end_time_unix_nano ?? null,
    status_code: normalizeStatusCode(span.status?.code),
    status_message: span.status?.message ?? null,

    // Verbatim bag plus its single-source projection. The schema re-derives the
    // projection and rejects drift, so this is the only place it is computed.
    ...projectAttributes(attributes),
    attributes,
  };

  // Re-validate the assembled event so the canonical model is always schema-
  // valid. This DOES fire for bad input the input schema let through (e.g. a
  // reversed span), surfacing a typed ZodError instead of a silent bad row.
  return otelSpanEventSchema.parse(candidate);
}
