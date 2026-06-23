// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  LEGACY_ATTR_NAMESPACE,
  LEGACY_SHIM_SEMCONV_VERSION,
  shimLegacyEventToSpan,
} from "../src/otel/legacy-shim.js";
import { otelSpanEventSchema } from "../src/otel/span-event.js";
import { getLegacyFixtures } from "../src/otel/fixtures/index.js";

const twinHttp = {
  ts: "2026-06-02T12:00:00.000Z",
  run_id: "run_x",
  twin: "github",
  request_id: "req",
  step_id: null,
  tool_call_id: null,
  method: "GET",
  path: "/repos/acme/app",
  request_body: null,
  status: 200,
  response_body: null,
  latency_ms: 10,
  fidelity: "semantic" as const,
  state_mutation: false,
  state_delta: null,
  error: null,
  kind: "TwinHttpEvent" as const,
  event_id: "e_http",
  parent_id: null,
};

const llmCall = {
  ts: "2026-06-02T12:00:00.000Z",
  event_id: "e_llm",
  parent_id: null,
  kind: "LlmCallEvent" as const,
  host: "api.openai.com",
  port: 443,
  latency_ms: 100,
  bytes_in: 1,
  bytes_out: 2,
  url: null,
  method: null,
  status: null,
  model: null,
  prompt_tokens: null,
  completion_tokens: null,
  cost_usd: null,
};

const toolUse = {
  ts: "2026-06-02T12:00:00.000Z",
  event_id: "e_tool",
  parent_id: null,
  kind: "ToolUseEvent" as const,
  tool_use_id: "tu",
  tool_name: "search",
  input: null,
};

const RUN = { run_id: "run_x" };

describe("pins", () => {
  it("targets the M1.1 GenAI convention version + legacy namespace", () => {
    expect(LEGACY_SHIM_SEMCONV_VERSION).toBe("1.42.0");
    expect(LEGACY_ATTR_NAMESPACE).toBe("pome.legacy");
  });
});

describe("golden fixtures — shim reproduces the frozen expected spans", () => {
  for (const fixture of getLegacyFixtures()) {
    it(`${fixture.name} maps byte-identically`, () => {
      const span = shimLegacyEventToSpan(fixture.legacy, fixture.options);
      expect(span).toEqual(fixture.expected);
      expect(JSON.stringify(span)).toBe(JSON.stringify(fixture.expected));
    });
  }

  it("covers all three legacy event kinds", () => {
    const kinds = getLegacyFixtures().map((f) => f.legacy.kind);
    expect(new Set(kinds)).toEqual(new Set(["TwinHttpEvent", "LlmCallEvent", "ToolUseEvent"]));
  });
});

describe("losslessness — the RAW record survives, incl. additive fields", () => {
  it("round-trips the entire record through pome.legacy.record_json", () => {
    const span = shimLegacyEventToSpan(twinHttp);
    const recovered = JSON.parse(span.attributes["pome.legacy.record_json"] as string);
    expect(recovered).toEqual(twinHttp);
    expect(span.attributes["pome.legacy.kind"]).toBe("TwinHttpEvent");
  });

  it("preserves additive fields Zod would otherwise strip", () => {
    // `idempotency_dedupe` is an additive field present in the OSS recorder-events
    // but not in the cloud mirror — it must NOT be lost by the shim.
    const withExtra = { ...twinHttp, idempotency_dedupe: true, future_field: 42 };
    const span = shimLegacyEventToSpan(withExtra);
    const recovered = JSON.parse(span.attributes["pome.legacy.record_json"] as string);
    expect(recovered.idempotency_dedupe).toBe(true);
    expect(recovered.future_field).toBe(42);
  });
});

describe("determinism — identical input → identical output", () => {
  it("produces byte-identical spans across runs", () => {
    const a = shimLegacyEventToSpan(llmCall, RUN);
    const b = shimLegacyEventToSpan(llmCall, RUN);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("OTel status semantics (HTTP client span)", () => {
  it("leaves a 2xx success UNSET (not OK)", () => {
    expect(shimLegacyEventToSpan(twinHttp).status_code).toBe("UNSET");
  });

  it("marks a 4xx as ERROR with error.type = status code", () => {
    const span = shimLegacyEventToSpan({ ...twinHttp, status: 404, event_id: "e1" });
    expect(span.status_code).toBe("ERROR");
    expect(span.error_type).toBe("404");
    expect(span.attributes["error.type"]).toBe("404");
  });

  it("marks a transport error as ERROR with error.type = network_error", () => {
    const span = shimLegacyEventToSpan({ ...twinHttp, error: "ECONNRESET", event_id: "e2" });
    expect(span.status_code).toBe("ERROR");
    expect(span.error_type).toBe("network_error");
    expect(span.status_message).toBe("ECONNRESET");
  });

  it("leaves an LlmCall with null status UNSET and a 5xx ERROR", () => {
    expect(shimLegacyEventToSpan(llmCall, RUN).status_code).toBe("UNSET");
    expect(shimLegacyEventToSpan({ ...llmCall, status: 500 }, RUN).status_code).toBe("ERROR");
  });
});

describe("trace context resolution", () => {
  it("namespaces the option run_id as the trace id", () => {
    expect(shimLegacyEventToSpan(toolUse, { run_id: "abc" }).trace_id).toBe("legacy:abc");
  });

  it("does not double-namespace an already-legacy: run_id (idempotent)", () => {
    expect(shimLegacyEventToSpan(toolUse, { run_id: "legacy:abc" }).trace_id).toBe("legacy:abc");
  });

  it("falls back to a TwinHttpEvent's own run_id", () => {
    const span = shimLegacyEventToSpan(twinHttp);
    expect(span.trace_id).toBe("legacy:run_x");
  });

  it("namespaces span/parent ids as legacy:<source-id>", () => {
    const span = shimLegacyEventToSpan({ ...twinHttp, parent_id: "e_root" });
    expect(span.span_id).toBe("legacy:e_http");
    expect(span.event_id).toBe("legacy:e_http");
    expect(span.parent_span_id).toBe("legacy:e_root");
    expect(span.parent_id).toBe("legacy:e_root");
  });

  it("requires explicit run_id for LlmCall / ToolUse rows", () => {
    expect(() => shimLegacyEventToSpan(llmCall)).toThrow(/requires options.run_id/);
    expect(() => shimLegacyEventToSpan(toolUse)).toThrow(/requires options.run_id/);
  });
});

describe("span semantics + attribute-derived projections", () => {
  it("names a TwinHttp span by method only (low cardinality)", () => {
    const span = shimLegacyEventToSpan(twinHttp);
    expect(span.name).toBe("GET");
    expect(span.http_request_method).toBe("GET");
    expect(span.url_path).toBe("/repos/acme/app");
  });

  it("names an LlmCall with a model 'chat <model>' and projects tokens", () => {
    const span = shimLegacyEventToSpan(
      { ...llmCall, model: "gpt-4o", prompt_tokens: 5, completion_tokens: 6 },
      RUN,
    );
    expect(span.name).toBe("chat gpt-4o");
    expect(span.span_kind).toBe("CLIENT");
    expect(span.gen_ai_request_model).toBe("gpt-4o");
    expect(span.gen_ai_usage_input_tokens).toBe(5);
    expect(span.gen_ai_usage_output_tokens).toBe(6);
    expect(span.server_address).toBe("api.openai.com");
    expect(span.server_port).toBe(443);
  });

  it("names a model-less LlmCall just 'chat'", () => {
    expect(shimLegacyEventToSpan(llmCall, RUN).name).toBe("chat");
  });

  it("maps ToolUse to an execute_tool INTERNAL span with no end time", () => {
    const span = shimLegacyEventToSpan(toolUse, RUN);
    expect(span.name).toBe("execute_tool search");
    expect(span.span_kind).toBe("INTERNAL");
    expect(span.gen_ai_operation_name).toBe("execute_tool");
    expect(span.gen_ai_tool_name).toBe("search");
    expect(span.end_time_unix_nano).toBeNull();
  });
});

describe("every valid legacy record maps to a schema-valid span", () => {
  const variants: unknown[] = [
    twinHttp,
    { ...twinHttp, status: 404, event_id: "e1" },
    { ...twinHttp, error: "boom", event_id: "e2" },
    { ...twinHttp, status: 201, event_id: "e3" },
    llmCall,
    { ...llmCall, status: 200, model: "gpt-4", prompt_tokens: 5, completion_tokens: 6, event_id: "e4" },
    { ...llmCall, status: 500, model: "gpt-4", url: "https://x", method: "POST", event_id: "e5" },
    toolUse,
  ];

  for (const [i, variant] of variants.entries()) {
    it(`variant ${i} parses under M1.1`, () => {
      expect(otelSpanEventSchema.safeParse(shimLegacyEventToSpan(variant, RUN)).success).toBe(true);
    });
  }
});

describe("rejects non-shimmable input", () => {
  it("throws a typed ZodError on an unsupported kind / empty object", () => {
    expect(() => shimLegacyEventToSpan({ kind: "HookEvent", event_id: "h", parent_id: null })).toThrow(z.ZodError);
    expect(() => shimLegacyEventToSpan({})).toThrow(z.ZodError);
  });

  it("throws a typed ZodError on an invalid ts (rejected by the datetime schema)", () => {
    // `ts` is validated as ISO-8601 by the legacy schema before any nano math,
    // so a bad timestamp surfaces as a ZodError, never a NaN nano string.
    expect(() => shimLegacyEventToSpan({ ...twinHttp, ts: "not-a-date" })).toThrow(z.ZodError);
  });
});
