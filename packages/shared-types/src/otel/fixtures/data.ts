// SPDX-License-Identifier: Apache-2.0
/**
 * otel/fixtures/data — frozen golden-fixture corpus (M1.3 / FDRS-482).
 *
 * The single source of truth for trace fixtures across M1.2 and M2–M6. Static
 * data, deterministic by construction, and DEEP-FROZEN on export (review
 * finding #6 — exported fixtures were runtime-mutable shared state). Four
 * families:
 *
 *   - LEGACY_FIXTURES      — (legacy record → expected OtelSpanEvent) pairs.
 *                            `expected` is the FROZEN output of the M1.2 shim;
 *                            M1.2's golden test asserts the shim reproduces it.
 *   - EMITTER_FIXTURES     — real-emitter spans (Traceloop / Vercel AI SDK /
 *                            Pydantic Logfire), normalized to `OtelSpanInput`
 *                            with provenance + version metadata. M1.1 parses them.
 *   - TRACE_FIXTURES       — multi-span sub-agent traces (parent_span_id trees).
 *   - EXTERNAL_API_FIXTURES — twin-relevant external-API (HTTP) spans (M4 drift).
 *
 * PROVENANCE NOTE (honest sourcing — `derivedFrom: "documentation-derived"`):
 * the emitter fixtures are NORMALIZED `OtelSpanInput` records whose ATTRIBUTE
 * KEYS are taken verbatim from each emitter's published span output (URLs +
 * `sourceVersion` below); attribute VALUES are representative. They are derived
 * from the emitters' documented conventions, NOT captured from a live export —
 * raw OTLP-envelope capture + the AnyValue decoder are M2's scope. Each fixture
 * records its source so M2 can swap in a live capture without changing keys.
 */

import type {
  LlmCallEvent,
  ToolUseEvent,
  TwinHttpEvent,
} from "../../recorder-events.js";
import type { OtelSpanEvent } from "../span-event.js";
import type { OtelSpanInput } from "../map-span.js";

// The legacy variants the M1.2 shim translates. Declared here (off M1.1) so the
// corpus depends only on the M1.1 schema, not on the M1.2 shim it feeds.
export type LegacyEventRecord = TwinHttpEvent | LlmCallEvent | ToolUseEvent;

// How a fixture's attribute shape was sourced. Kept explicit so consumers never
// mistake a documentation-derived example for a live capture.
export type FixtureDerivedFrom = "documentation-derived" | "pome-internal" | "otel-spec";

// Mirror of the shim's option shape (kept structurally identical).
export interface LegacyFixtureShimOptions {
  run_id?: string;
}

export interface LegacyFixture {
  name: string;
  provenance: string;
  derivedFrom: FixtureDerivedFrom;
  legacy: LegacyEventRecord;
  options: LegacyFixtureShimOptions;
  expected: OtelSpanEvent;
}

export interface EmitterFixture {
  name: string;
  emitter: "traceloop" | "vercel-ai-sdk" | "pydantic-logfire";
  provenance: string;
  // The emitter / spec build the attribute keys were taken from. Honest about
  // being a documented shape, not a captured envelope.
  sourceVersion: string;
  derivedFrom: FixtureDerivedFrom;
  span: OtelSpanInput;
}

export interface TraceFixture {
  name: string;
  provenance: string;
  derivedFrom: FixtureDerivedFrom;
  spans: OtelSpanInput[];
}

export interface ExternalApiFixture {
  name: string;
  provenance: string;
  derivedFrom: FixtureDerivedFrom;
  span: OtelSpanInput;
}

// Recursively freeze a fixture tree so a consumer can never mutate the shared
// corpus (review #6). Returns the same reference, now immutable.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// ─── Legacy → span pairs (frozen expected outputs of the M1.2 shim) ──────────

export const LEGACY_FIXTURES: readonly LegacyFixture[] = deepFreeze<readonly LegacyFixture[]>([
  {
    name: "twin-http/github-create-issue",
    provenance:
      "Pome TwinHttpEvent (packages/shared-types/src/recorder-events.ts). Frozen output of shimLegacyEventToSpan (M1.2).",
    derivedFrom: "pome-internal",
    legacy: {
      ts: "2026-06-02T12:00:00.000Z",
      run_id: "run_otel_demo",
      twin: "github",
      request_id: "req_001",
      step_id: null,
      tool_call_id: null,
      method: "POST",
      path: "/repos/acme/app/issues",
      request_body: { title: "Bug", body: "broken" },
      status: 201,
      response_body: { number: 7 },
      latency_ms: 134,
      fidelity: "semantic",
      state_mutation: true,
      state_delta: { before: null, after: { number: 7 } },
      error: null,
      kind: "TwinHttpEvent",
      event_id: "evt_http_1",
      parent_id: null,
    },
    options: {},
    expected: {
      ts: "2026-06-02T12:00:00.000Z",
      event_id: "legacy:evt_http_1",
      parent_id: null,
      kind: "OtelSpanEvent",
      trace_id: "legacy:run_otel_demo",
      span_id: "legacy:evt_http_1",
      parent_span_id: null,
      name: "POST",
      span_kind: "CLIENT",
      start_time_unix_nano: "1780401600000000000",
      end_time_unix_nano: "1780401600134000000",
      status_code: "UNSET",
      status_message: null,
      gen_ai_provider_name: null,
      gen_ai_operation_name: null,
      gen_ai_request_model: null,
      gen_ai_agent_name: null,
      gen_ai_agent_id: null,
      gen_ai_tool_name: null,
      gen_ai_usage_input_tokens: null,
      gen_ai_usage_output_tokens: null,
      http_request_method: "POST",
      http_response_status_code: 201,
      url_full: null,
      url_path: "/repos/acme/app/issues",
      server_address: null,
      server_port: null,
      error_type: null,
      attributes: {
        "http.request.method": "POST",
        "http.response.status_code": 201,
        "url.path": "/repos/acme/app/issues",
        "pome.legacy.kind": "TwinHttpEvent",
        "pome.legacy.record_json":
          '{"ts":"2026-06-02T12:00:00.000Z","run_id":"run_otel_demo","twin":"github","request_id":"req_001","step_id":null,"tool_call_id":null,"method":"POST","path":"/repos/acme/app/issues","request_body":{"title":"Bug","body":"broken"},"status":201,"response_body":{"number":7},"latency_ms":134,"fidelity":"semantic","state_mutation":true,"state_delta":{"before":null,"after":{"number":7}},"error":null,"kind":"TwinHttpEvent","event_id":"evt_http_1","parent_id":null}',
      },
    },
  },
  {
    name: "llm-call/anthropic-messages",
    provenance:
      "Pome LlmCallEvent (recorder-events.ts). Frozen output of shimLegacyEventToSpan with run_id option.",
    derivedFrom: "pome-internal",
    legacy: {
      ts: "2026-06-02T12:00:01.000Z",
      event_id: "evt_llm_1",
      parent_id: "evt_http_1",
      kind: "LlmCallEvent",
      host: "api.anthropic.com",
      port: 443,
      latency_ms: 820,
      bytes_in: 512,
      bytes_out: 2048,
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      status: 200,
      model: "claude-haiku-4-5",
      prompt_tokens: 320,
      completion_tokens: 96,
      cost_usd: 0.0012,
    },
    options: { run_id: "run_otel_demo" },
    expected: {
      ts: "2026-06-02T12:00:01.000Z",
      event_id: "legacy:evt_llm_1",
      parent_id: "legacy:evt_http_1",
      kind: "OtelSpanEvent",
      trace_id: "legacy:run_otel_demo",
      span_id: "legacy:evt_llm_1",
      parent_span_id: "legacy:evt_http_1",
      name: "chat claude-haiku-4-5",
      span_kind: "CLIENT",
      start_time_unix_nano: "1780401601000000000",
      end_time_unix_nano: "1780401601820000000",
      status_code: "UNSET",
      status_message: null,
      gen_ai_provider_name: null,
      gen_ai_operation_name: "chat",
      gen_ai_request_model: "claude-haiku-4-5",
      gen_ai_agent_name: null,
      gen_ai_agent_id: null,
      gen_ai_tool_name: null,
      gen_ai_usage_input_tokens: 320,
      gen_ai_usage_output_tokens: 96,
      http_request_method: "POST",
      http_response_status_code: 200,
      url_full: "https://api.anthropic.com/v1/messages",
      url_path: null,
      server_address: "api.anthropic.com",
      server_port: 443,
      error_type: null,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "claude-haiku-4-5",
        "gen_ai.usage.input_tokens": 320,
        "gen_ai.usage.output_tokens": 96,
        "http.request.method": "POST",
        "http.response.status_code": 200,
        "url.full": "https://api.anthropic.com/v1/messages",
        "server.address": "api.anthropic.com",
        "server.port": 443,
        "pome.legacy.kind": "LlmCallEvent",
        "pome.legacy.record_json":
          '{"ts":"2026-06-02T12:00:01.000Z","event_id":"evt_llm_1","parent_id":"evt_http_1","kind":"LlmCallEvent","host":"api.anthropic.com","port":443,"latency_ms":820,"bytes_in":512,"bytes_out":2048,"url":"https://api.anthropic.com/v1/messages","method":"POST","status":200,"model":"claude-haiku-4-5","prompt_tokens":320,"completion_tokens":96,"cost_usd":0.0012}',
      },
    },
  },
  {
    name: "tool-use/create-issue",
    provenance:
      "Pome ToolUseEvent (recorder-events.ts). Frozen output of shimLegacyEventToSpan with run_id option.",
    derivedFrom: "pome-internal",
    legacy: {
      ts: "2026-06-02T12:00:02.000Z",
      event_id: "evt_tool_1",
      parent_id: "evt_llm_1",
      kind: "ToolUseEvent",
      tool_use_id: "toolu_abc",
      tool_name: "create_issue",
      input: { title: "Bug" },
    },
    options: { run_id: "run_otel_demo" },
    expected: {
      ts: "2026-06-02T12:00:02.000Z",
      event_id: "legacy:evt_tool_1",
      parent_id: "legacy:evt_llm_1",
      kind: "OtelSpanEvent",
      trace_id: "legacy:run_otel_demo",
      span_id: "legacy:evt_tool_1",
      parent_span_id: "legacy:evt_llm_1",
      name: "execute_tool create_issue",
      span_kind: "INTERNAL",
      start_time_unix_nano: "1780401602000000000",
      end_time_unix_nano: null,
      status_code: "UNSET",
      status_message: null,
      gen_ai_provider_name: null,
      gen_ai_operation_name: "execute_tool",
      gen_ai_request_model: null,
      gen_ai_agent_name: null,
      gen_ai_agent_id: null,
      gen_ai_tool_name: "create_issue",
      gen_ai_usage_input_tokens: null,
      gen_ai_usage_output_tokens: null,
      http_request_method: null,
      http_response_status_code: null,
      url_full: null,
      url_path: null,
      server_address: null,
      server_port: null,
      error_type: null,
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "create_issue",
        "pome.legacy.kind": "ToolUseEvent",
        "pome.legacy.record_json":
          '{"ts":"2026-06-02T12:00:02.000Z","event_id":"evt_tool_1","parent_id":"evt_llm_1","kind":"ToolUseEvent","tool_use_id":"toolu_abc","tool_name":"create_issue","input":{"title":"Bug"}}',
      },
    },
  },
]);

// ─── Real-emitter spans (normalized OtelSpanInput; keys from each emitter) ────
// Successful spans are left status-UNSET (the OTel convention — `OK` is not set
// merely because a span succeeded). `derivedFrom` flags the documented sourcing.

export const EMITTER_FIXTURES: readonly EmitterFixture[] = deepFreeze<readonly EmitterFixture[]>([
  {
    name: "traceloop/openai-chat",
    emitter: "traceloop",
    // Traceloop / OpenLLMetry emits the deprecated gen_ai.system + pre-1.27
    // prompt_tokens/completion_tokens — exercises both ingestion aliases.
    provenance:
      "https://github.com/traceloop/openllmetry semconv_ai constants + https://www.traceloop.com/docs/openllmetry/contributing/semantic-conventions",
    sourceVersion: "OpenLLMetry semconv_ai (documentation-derived; not a live capture)",
    derivedFrom: "documentation-derived",
    span: {
      trace_id: "11111111111111111111111111111111",
      span_id: "1111111111111111",
      name: "openai.chat",
      kind: "CLIENT",
      start_time_unix_nano: "1780401600000000000",
      end_time_unix_nano: "1780401600500000000",
      attributes: {
        "gen_ai.system": "openai",
        "llm.request.type": "chat",
        "gen_ai.request.model": "gpt-4",
        "gen_ai.response.model": "gpt-4-0613",
        "gen_ai.usage.prompt_tokens": 100,
        "gen_ai.usage.completion_tokens": 180,
        "llm.usage.total_tokens": 280,
        "traceloop.span.kind": "workflow",
        "traceloop.entity.name": "openai.chat",
      },
    },
  },
  {
    name: "vercel-ai-sdk/do-generate",
    emitter: "vercel-ai-sdk",
    // The provider (doGenerate) span carries gen_ai.* with the new
    // input_tokens/output_tokens names; older builds still set gen_ai.system.
    provenance: "https://ai-sdk.dev/docs/ai-sdk-core/telemetry",
    sourceVersion: "Vercel AI SDK telemetry docs (documentation-derived; not a live capture)",
    derivedFrom: "documentation-derived",
    span: {
      trace_id: "22222222222222222222222222222222",
      span_id: "2222222222222222",
      parent_span_id: "2222222222222200",
      name: "ai.generateText.doGenerate",
      kind: "CLIENT",
      start_time_unix_nano: "1780401601000000000",
      end_time_unix_nano: "1780401601900000000",
      attributes: {
        "operation.name": "ai.generateText.doGenerate",
        "ai.operationId": "ai.generateText.doGenerate",
        "ai.response.model": "gpt-4-0613",
        "gen_ai.system": "openai",
        "gen_ai.request.model": "gpt-4",
        "gen_ai.request.temperature": 0.7,
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 180,
      },
    },
  },
  {
    name: "pydantic-logfire/chat",
    emitter: "pydantic-logfire",
    // Pydantic Logfire / Pydantic AI is on the canonical gen_ai.provider.name
    // + input/output names and sets gen_ai.operation.name; span name "chat {model}".
    provenance:
      "https://pydantic.dev/docs/ai/integrations/logfire/ + https://pydantic.dev/docs/ai/api/models/instrumented/",
    sourceVersion: "Pydantic AI / Logfire instrumentation docs (documentation-derived; not a live capture)",
    derivedFrom: "documentation-derived",
    span: {
      trace_id: "33333333333333333333333333333333",
      span_id: "3333333333333333",
      name: "chat gpt-4",
      kind: "CLIENT",
      start_time_unix_nano: "1780401602000000000",
      end_time_unix_nano: "1780401602750000000",
      attributes: {
        "gen_ai.provider.name": "openai",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "gpt-4",
        "gen_ai.response.model": "gpt-4",
        "gen_ai.usage.input_tokens": 150,
        "gen_ai.usage.output_tokens": 75,
      },
    },
  },
]);

// ─── Multi-span sub-agent traces ─────────────────────────────────────────────

export const TRACE_FIXTURES: readonly TraceFixture[] = deepFreeze<readonly TraceFixture[]>([
  {
    name: "subagent-fanout/two-children",
    provenance:
      "Pydantic AI invoke_agent + child model spans (https://pydantic.dev/docs/ai/integrations/logfire/). Root agent span fans out to two sub-agent spans, each with one LLM child.",
    derivedFrom: "documentation-derived",
    spans: [
      {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "a000000000000000",
        name: "invoke_agent orchestrator",
        kind: "INTERNAL",
        start_time_unix_nano: "1780401600000000000",
        end_time_unix_nano: "1780401603000000000",
        attributes: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "orchestrator",
          "gen_ai.agent.id": "agent_root",
        },
      },
      {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "a000000000000001",
        parent_span_id: "a000000000000000",
        name: "invoke_agent researcher",
        kind: "INTERNAL",
        start_time_unix_nano: "1780401600100000000",
        end_time_unix_nano: "1780401601500000000",
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "researcher",
          "gen_ai.agent.id": "agent_research",
        },
      },
      {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "a000000000000002",
        parent_span_id: "a000000000000001",
        name: "chat gpt-4",
        kind: "CLIENT",
        start_time_unix_nano: "1780401600200000000",
        end_time_unix_nano: "1780401601400000000",
        attributes: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "gpt-4",
          "gen_ai.usage.input_tokens": 200,
          "gen_ai.usage.output_tokens": 90,
        },
      },
      {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "a000000000000003",
        parent_span_id: "a000000000000000",
        name: "invoke_agent writer",
        kind: "INTERNAL",
        start_time_unix_nano: "1780401601600000000",
        end_time_unix_nano: "1780401602900000000",
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "writer",
          "gen_ai.agent.id": "agent_writer",
        },
      },
      {
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        span_id: "a000000000000004",
        parent_span_id: "a000000000000003",
        name: "chat gpt-4",
        kind: "CLIENT",
        start_time_unix_nano: "1780401601700000000",
        end_time_unix_nano: "1780401602800000000",
        attributes: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "gpt-4",
          "gen_ai.usage.input_tokens": 140,
          "gen_ai.usage.output_tokens": 60,
        },
      },
    ],
  },
  {
    name: "tool-chain/llm-then-tool",
    provenance:
      "OTel GenAI tool spans (https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/). One LLM span followed by an execute_tool child.",
    derivedFrom: "otel-spec",
    spans: [
      {
        trace_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        span_id: "b000000000000000",
        name: "chat gpt-4",
        kind: "CLIENT",
        start_time_unix_nano: "1780401600000000000",
        end_time_unix_nano: "1780401601000000000",
        attributes: {
          "gen_ai.provider.name": "openai",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": "gpt-4",
          "gen_ai.usage.input_tokens": 80,
          "gen_ai.usage.output_tokens": 40,
        },
      },
      {
        trace_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        span_id: "b000000000000001",
        parent_span_id: "b000000000000000",
        name: "execute_tool create_issue",
        kind: "INTERNAL",
        start_time_unix_nano: "1780401601000000000",
        end_time_unix_nano: "1780401601200000000",
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "create_issue",
        },
      },
    ],
  },
]);

// ─── External-API (twin-relevant) spans ──────────────────────────────────────

export const EXTERNAL_API_FIXTURES: readonly ExternalApiFixture[] = deepFreeze<readonly ExternalApiFixture[]>([
  {
    name: "github/get-issue-404",
    provenance:
      "OTel HTTP client semconv (https://opentelemetry.io/docs/specs/semconv/http/http-spans/). A twin-relevant external-API span for M4 drift detection — a 404 from the real GitHub API. Low-cardinality span name (method only).",
    derivedFrom: "otel-spec",
    span: {
      trace_id: "cccccccccccccccccccccccccccccccc",
      span_id: "c000000000000000",
      name: "GET",
      kind: "CLIENT",
      start_time_unix_nano: "1780401600000000000",
      end_time_unix_nano: "1780401600090000000",
      status: { code: "ERROR", message: "Not Found" },
      attributes: {
        "http.request.method": "GET",
        "http.response.status_code": 404,
        "url.full": "https://api.github.com/repos/acme/app/issues/999",
        "url.path": "/repos/acme/app/issues/999",
        "server.address": "api.github.com",
        "server.port": 443,
        "error.type": "404",
      },
    },
  },
]);
