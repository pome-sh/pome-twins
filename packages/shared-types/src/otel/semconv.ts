// SPDX-License-Identifier: Apache-2.0
/**
 * otel/semconv — pinned OpenTelemetry semantic-convention surface (M1.1 / FDRS-480).
 *
 * The ONE place an upstream spec change is absorbed. Every attribute name the
 * span mapper / shim reads is a constant here; the convention versions are
 * pinned below. When the OTel conventions move, bump the relevant version and
 * edit the affected constant here — `map-span.ts`, `project.ts`, and the schema
 * never hard-code an attribute string, so the blast radius is this file.
 *
 * Two separate pins, because the GenAI and core/HTTP conventions version
 * independently (review finding #5 — a single "1.30.0" mislabelled a mixed
 * surface):
 *   - `OTEL_CORE_SEMCONV_VERSION` — the stable core conventions (HTTP client
 *     spans, url.*, server.*, error.type) we project. Pinned to the v1.41.1
 *     core release.
 *   - `OTEL_GENAI_SCHEMA_VERSION` — the (still-experimental) GenAI conventions
 *     (`gen_ai.*`). Pinned to the GenAI schema 1.42.0, which introduces
 *     `gen_ai.provider.name` and deprecates `gen_ai.system`.
 *
 * Provenance for the pins:
 *   - core:  https://github.com/open-telemetry/semantic-conventions/releases/tag/v1.41.1
 *   - genai: https://github.com/open-telemetry/semantic-conventions/tree/main/docs/gen-ai
 *   - http:  https://opentelemetry.io/docs/specs/semconv/http/http-spans/
 *
 * This module is the canonical home of the pinned OTel convention surface;
 * pome-cloud consumes it as part of `@pome-sh/shared-types` (ownership
 * boundary settled at FDRS-653 — see `./index.ts`).
 */

// Pinned core (HTTP / url / server / error) convention version.
export const OTEL_CORE_SEMCONV_VERSION = "1.41.1" as const;
export type OtelCoreSemconvVersion = typeof OTEL_CORE_SEMCONV_VERSION;

// Pinned GenAI convention/schema version. The GenAI surface is experimental and
// versions ahead of core; `gen_ai.provider.name` is canonical at this version.
export const OTEL_GENAI_SCHEMA_VERSION = "1.42.0" as const;
export type OtelGenaiSchemaVersion = typeof OTEL_GENAI_SCHEMA_VERSION;

// The GenAI schema URL emitters stamp on their resource/scope. Recorded so M2's
// raw-OTLP ingestion can assert the producer's declared schema against our pin.
export const OTEL_GENAI_SCHEMA_URL =
  "https://opentelemetry.io/schemas/1.42.0" as const;

// ── GenAI semantic conventions ───────────────────────────────────────────────
// Emitted by Traceloop/OpenLLMetry, the Vercel AI SDK, Pydantic Logfire, and
// Pome's own runtimes.

// Canonical provider attribute at the pinned GenAI version (replaces
// `gen_ai.system`, which is accepted as a deprecated ingestion alias below).
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
// Deprecated alias for the provider. Still emitted by Traceloop and older AI-SDK
// builds in the wild, so the projector accepts it and normalizes onto
// `gen_ai_provider_name`. Remove when the pinned version drops the alias.
export const GEN_AI_SYSTEM_DEPRECATED = "gen_ai.system";

export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const GEN_AI_AGENT_NAME = "gen_ai.agent.name";
export const GEN_AI_AGENT_ID = "gen_ai.agent.id";
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";

// Pre-1.27 token attribute names. Still emitted by older Traceloop/OpenLLMetry
// builds, so the projector accepts them as a fallback and normalizes onto the
// canonical `input_tokens` / `output_tokens` fields.
export const GEN_AI_USAGE_PROMPT_TOKENS_LEGACY = "gen_ai.usage.prompt_tokens";
export const GEN_AI_USAGE_COMPLETION_TOKENS_LEGACY = "gen_ai.usage.completion_tokens";

// ── HTTP / core semantic conventions ─────────────────────────────────────────
// External-API (twin-relevant) spans. Stable HTTP client conventions at the
// pinned core version (`http.request.method`, not the deprecated `http.method`).
export const HTTP_REQUEST_METHOD = "http.request.method";
export const HTTP_RESPONSE_STATUS_CODE = "http.response.status_code";
export const URL_FULL = "url.full";
// `url.path` is the low-cardinality path component; safe to project even when
// `url.full` carries query params we would not want in a span name.
export const URL_PATH = "url.path";
export const SERVER_ADDRESS = "server.address";
export const SERVER_PORT = "server.port";
// `error.type` is set on failed spans (status ERROR). For HTTP it is typically
// the status-code class or an exception/connection-error identifier.
export const ERROR_TYPE = "error.type";
