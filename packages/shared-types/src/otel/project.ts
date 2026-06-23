// SPDX-License-Identifier: Apache-2.0
/**
 * otel/project — the single attribute→projection function (M1.1 / FDRS-480).
 *
 * The typed `gen_ai_*` / `http_*` / `url_*` / `server_*` / `error_type` fields
 * on an `OtelSpanEvent` are PROJECTIONS of the verbatim `attributes` bag, never
 * an independent source of truth. This module is the ONE place that derivation
 * lives, so:
 *   - the span mapper (`map-span.ts`) builds projections from `attributes`,
 *   - the legacy shim (`legacy-shim.ts`) builds them the same way, and
 *   - the schema (`span-event.ts`) re-derives them in a `superRefine` and
 *     rejects any event whose typed fields drift from `attributes`
 *     (review finding #4 — projection drift; finding #7 — centralize).
 *
 * Pure and deterministic. Reads only the pinned attribute names from `semconv`.
 */

import { z } from "zod";

import {
  ERROR_TYPE,
  GEN_AI_AGENT_ID,
  GEN_AI_AGENT_NAME,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_SYSTEM_DEPRECATED,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_COMPLETION_TOKENS_LEGACY,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_PROMPT_TOKENS_LEGACY,
  HTTP_REQUEST_METHOD,
  HTTP_RESPONSE_STATUS_CODE,
  SERVER_ADDRESS,
  SERVER_PORT,
  URL_FULL,
  URL_PATH,
} from "./semconv.js";

// A flattened OTLP attribute value. OTLP `AnyValue` decoding (kvlist/bytes/
// nested) is M2's job; at the schema boundary an attribute is a primitive or a
// homogeneous-ish array of primitives. Numbers must be FINITE — `Infinity`/`NaN`
// are not representable in OTLP and would corrupt projections (review #4).
const finiteNumber = z.number().finite();
export const otelAttributeValueSchema = z.union([
  z.string(),
  finiteNumber,
  z.boolean(),
  z.array(z.union([z.string(), finiteNumber, z.boolean()])),
]);
export type OtelAttributeValue = z.infer<typeof otelAttributeValueSchema>;

export type OtelAttributeBag = Record<string, OtelAttributeValue>;

// The full set of projection field names, in on-disk order. The schema's
// drift check iterates this so a new projection can never be added to the
// schema without the projector also producing it.
export const OTEL_PROJECTION_KEYS = [
  "gen_ai_provider_name",
  "gen_ai_operation_name",
  "gen_ai_request_model",
  "gen_ai_agent_name",
  "gen_ai_agent_id",
  "gen_ai_tool_name",
  "gen_ai_usage_input_tokens",
  "gen_ai_usage_output_tokens",
  "http_request_method",
  "http_response_status_code",
  "url_full",
  "url_path",
  "server_address",
  "server_port",
  "error_type",
] as const;

export type OtelProjections = {
  gen_ai_provider_name: string | null;
  gen_ai_operation_name: string | null;
  gen_ai_request_model: string | null;
  gen_ai_agent_name: string | null;
  gen_ai_agent_id: string | null;
  gen_ai_tool_name: string | null;
  gen_ai_usage_input_tokens: number | null;
  gen_ai_usage_output_tokens: number | null;
  http_request_method: string | null;
  http_response_status_code: number | null;
  url_full: string | null;
  url_path: string | null;
  server_address: string | null;
  server_port: number | null;
  error_type: string | null;
};

// present-and-string → the string, else null.
function readString(attributes: OtelAttributeBag, key: string): string | null {
  const value = attributes[key];
  return typeof value === "string" ? value : null;
}

// present-and-finite-int → the number, else null. (Finiteness is already
// enforced by the attribute schema; the guard keeps the projector total even
// when called on a not-yet-validated bag.)
function readInt(attributes: OtelAttributeBag, key: string): number | null {
  const value = attributes[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

// present-and-int≥0 → the number, else null. Token counts and ports are
// non-negative.
function readUint(attributes: OtelAttributeBag, key: string): number | null {
  const value = readInt(attributes, key);
  return value !== null && value >= 0 ? value : null;
}

/**
 * Derive the flat typed projections from a verbatim attribute bag. Canonical
 * names win; deprecated/pre-1.27 aliases are accepted as fallbacks.
 */
export function projectAttributes(attributes: OtelAttributeBag): OtelProjections {
  return {
    gen_ai_provider_name:
      readString(attributes, GEN_AI_PROVIDER_NAME) ??
      readString(attributes, GEN_AI_SYSTEM_DEPRECATED),
    gen_ai_operation_name: readString(attributes, GEN_AI_OPERATION_NAME),
    gen_ai_request_model: readString(attributes, GEN_AI_REQUEST_MODEL),
    gen_ai_agent_name: readString(attributes, GEN_AI_AGENT_NAME),
    gen_ai_agent_id: readString(attributes, GEN_AI_AGENT_ID),
    gen_ai_tool_name: readString(attributes, GEN_AI_TOOL_NAME),
    gen_ai_usage_input_tokens:
      readUint(attributes, GEN_AI_USAGE_INPUT_TOKENS) ??
      readUint(attributes, GEN_AI_USAGE_PROMPT_TOKENS_LEGACY),
    gen_ai_usage_output_tokens:
      readUint(attributes, GEN_AI_USAGE_OUTPUT_TOKENS) ??
      readUint(attributes, GEN_AI_USAGE_COMPLETION_TOKENS_LEGACY),
    http_request_method: readString(attributes, HTTP_REQUEST_METHOD),
    // HTTP status codes are non-negative (100–599); `readUint` drops a bogus
    // negative value rather than projecting it as a valid code.
    http_response_status_code: readUint(attributes, HTTP_RESPONSE_STATUS_CODE),
    url_full: readString(attributes, URL_FULL),
    url_path: readString(attributes, URL_PATH),
    server_address: readString(attributes, SERVER_ADDRESS),
    server_port: readUint(attributes, SERVER_PORT),
    error_type: readString(attributes, ERROR_TYPE),
  };
}
