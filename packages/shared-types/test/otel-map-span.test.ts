// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mapOtelSpanToEvent, otelSpanEventSchema } from "../src/otel/index.js";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const PARENT = "00f067aa0ba90200";

describe("mapOtelSpanToEvent — GenAI LLM span", () => {
  const event = mapOtelSpanToEvent({
    trace_id: TRACE,
    span_id: SPAN,
    name: "chat google/gemini-2.5-flash",
    start_time_unix_nano: "1700000000000000000",
    end_time_unix_nano: "1700000001000000000",
    status: { code: 1, message: null },
    attributes: {
      "gen_ai.provider.name": "google",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gemini-2.5-flash",
      "gen_ai.usage.input_tokens": 42,
      "gen_ai.usage.output_tokens": 99,
    },
  });

  it("derives ts (ISO-8601, UTC) from start_time_unix_nano", () => {
    expect(event.ts).toBe("2023-11-14T22:13:20.000Z");
  });

  it("uses span_id as the canonical event_id and span context", () => {
    expect(event.event_id).toBe(SPAN);
    expect(event.span_id).toBe(SPAN);
    expect(event.parent_id).toBeNull();
    expect(event.parent_span_id).toBeNull();
  });

  it("defaults an unset span_kind to INTERNAL", () => {
    expect(event.span_kind).toBe("INTERNAL");
  });

  it("normalizes a numeric status code to its name", () => {
    expect(event.status_code).toBe("OK");
    expect(event.status_message).toBeNull();
  });

  it("projects GenAI attributes onto flat fields (canonical provider.name)", () => {
    expect(event.gen_ai_provider_name).toBe("google");
    expect(event.gen_ai_operation_name).toBe("chat");
    expect(event.gen_ai_request_model).toBe("gemini-2.5-flash");
    expect(event.gen_ai_usage_input_tokens).toBe(42);
    expect(event.gen_ai_usage_output_tokens).toBe(99);
  });

  it("leaves HTTP projections null on a non-HTTP span", () => {
    expect(event.http_request_method).toBeNull();
    expect(event.http_response_status_code).toBeNull();
    expect(event.url_full).toBeNull();
    expect(event.url_path).toBeNull();
    expect(event.server_address).toBeNull();
    expect(event.server_port).toBeNull();
    expect(event.error_type).toBeNull();
  });

  it("preserves the verbatim attribute bag", () => {
    expect(event.attributes["gen_ai.provider.name"]).toBe("google");
  });

  it("is itself a valid span-event", () => {
    expect(otelSpanEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("mapOtelSpanToEvent — deprecated gen_ai.system alias", () => {
  it("projects the deprecated gen_ai.system onto gen_ai_provider_name", () => {
    const event = mapOtelSpanToEvent({
      trace_id: TRACE,
      span_id: SPAN,
      name: "openai.chat",
      start_time_unix_nano: "0",
      attributes: { "gen_ai.system": "openai" },
    });
    expect(event.gen_ai_provider_name).toBe("openai");
  });

  it("prefers gen_ai.provider.name when both are present", () => {
    const event = mapOtelSpanToEvent({
      trace_id: TRACE,
      span_id: SPAN,
      name: "openai.chat",
      start_time_unix_nano: "0",
      attributes: { "gen_ai.provider.name": "azure", "gen_ai.system": "openai" },
    });
    expect(event.gen_ai_provider_name).toBe("azure");
  });
});

describe("mapOtelSpanToEvent — HTTP (twin-relevant) span", () => {
  const event = mapOtelSpanToEvent({
    trace_id: TRACE,
    span_id: SPAN,
    parent_span_id: PARENT,
    name: "POST",
    kind: 3, // CLIENT
    start_time_unix_nano: "1700000000000000000",
    status: { code: 2, message: "boom" },
    attributes: {
      "http.request.method": "POST",
      "http.response.status_code": 402,
      "url.full": "https://api.stripe.com/v1/charges?x=1",
      "url.path": "/v1/charges",
      "server.address": "api.stripe.com",
      "server.port": 443,
      "error.type": "402",
    },
  });

  it("normalizes a numeric span kind", () => {
    expect(event.span_kind).toBe("CLIENT");
  });

  it("carries parent linkage from parent_span_id", () => {
    expect(event.parent_id).toBe(PARENT);
    expect(event.parent_span_id).toBe(PARENT);
  });

  it("maps a numeric status code to ERROR and keeps the message", () => {
    expect(event.status_code).toBe("ERROR");
    expect(event.status_message).toBe("boom");
  });

  it("projects HTTP attributes including url_path, server_port, error_type", () => {
    expect(event.http_request_method).toBe("POST");
    expect(event.http_response_status_code).toBe(402);
    expect(event.url_full).toBe("https://api.stripe.com/v1/charges?x=1");
    expect(event.url_path).toBe("/v1/charges");
    expect(event.server_address).toBe("api.stripe.com");
    expect(event.server_port).toBe(443);
    expect(event.error_type).toBe("402");
  });

  it("leaves GenAI projections null on a pure HTTP span", () => {
    expect(event.gen_ai_provider_name).toBeNull();
    expect(event.gen_ai_usage_input_tokens).toBeNull();
  });
});

describe("mapOtelSpanToEvent — bare span and string-typed enums", () => {
  it("defaults attributes to {} and projects everything to null/INTERNAL/UNSET", () => {
    const event = mapOtelSpanToEvent({
      trace_id: TRACE,
      span_id: SPAN,
      name: "internal work",
      start_time_unix_nano: "0",
    });
    expect(event.span_kind).toBe("INTERNAL");
    expect(event.status_code).toBe("UNSET");
    expect(event.status_message).toBeNull();
    expect(event.end_time_unix_nano).toBeNull();
    expect(event.attributes).toEqual({});
    expect(event.gen_ai_provider_name).toBeNull();
    expect(event.http_request_method).toBeNull();
    expect(event.ts).toBe("1970-01-01T00:00:00.000Z");
  });

  it("accepts already-named span_kind and status code (string passthrough)", () => {
    const event = mapOtelSpanToEvent({
      trace_id: TRACE,
      span_id: SPAN,
      name: "server span",
      kind: "SERVER",
      start_time_unix_nano: "0",
      status: { code: "OK" },
    });
    expect(event.span_kind).toBe("SERVER");
    expect(event.status_code).toBe("OK");
  });
});

describe("mapOtelSpanToEvent — token-attribute aliasing", () => {
  it("falls back to pre-1.27 prompt/completion token names", () => {
    const event = mapOtelSpanToEvent({
      trace_id: TRACE,
      span_id: SPAN,
      name: "legacy traceloop span",
      start_time_unix_nano: "0",
      attributes: {
        "gen_ai.usage.prompt_tokens": 10,
        "gen_ai.usage.completion_tokens": 20,
      },
    });
    expect(event.gen_ai_usage_input_tokens).toBe(10);
    expect(event.gen_ai_usage_output_tokens).toBe(20);
  });

  it("prefers the canonical input/output names when both are present", () => {
    const event = mapOtelSpanToEvent({
      trace_id: TRACE,
      span_id: SPAN,
      name: "dual-named span",
      start_time_unix_nano: "0",
      attributes: {
        "gen_ai.usage.input_tokens": 1,
        "gen_ai.usage.prompt_tokens": 999,
      },
    });
    expect(event.gen_ai_usage_input_tokens).toBe(1);
  });

  it("rejects non-integer / negative token counts (projects to null)", () => {
    const event = mapOtelSpanToEvent({
      trace_id: TRACE,
      span_id: SPAN,
      name: "bad tokens",
      start_time_unix_nano: "0",
      attributes: {
        "gen_ai.usage.input_tokens": 3.5, // not an integer
        "gen_ai.usage.output_tokens": -1, // negative
        "http.response.status_code": 200.5, // not an integer
      },
    });
    expect(event.gen_ai_usage_input_tokens).toBeNull();
    expect(event.gen_ai_usage_output_tokens).toBeNull();
    expect(event.http_response_status_code).toBeNull();
  });
});

describe("mapOtelSpanToEvent — input validation", () => {
  it("rejects a non-hex trace id", () => {
    expect(() =>
      mapOtelSpanToEvent({ trace_id: "t", span_id: SPAN, name: "x", start_time_unix_nano: "0" }),
    ).toThrow(z.ZodError);
  });

  it("rejects a reversed span (end < start) with a typed ZodError", () => {
    expect(() =>
      mapOtelSpanToEvent({
        trace_id: TRACE,
        span_id: SPAN,
        name: "reversed",
        start_time_unix_nano: "1700000001000000000",
        end_time_unix_nano: "1700000000000000000",
      }),
    ).toThrow(z.ZodError);
  });

  it("throws a typed ZodError on malformed input", () => {
    expect(() => mapOtelSpanToEvent({})).toThrow(z.ZodError);
    expect(() =>
      mapOtelSpanToEvent({ trace_id: TRACE, span_id: SPAN, name: "x", start_time_unix_nano: "nope" }),
    ).toThrow(z.ZodError);
  });
});

describe("mapOtelSpanToEvent — determinism", () => {
  const input = {
    trace_id: TRACE,
    span_id: SPAN,
    name: "deterministic",
    start_time_unix_nano: "1700000000123456789",
    attributes: { "gen_ai.provider.name": "anthropic" },
  };

  it("same input → byte-identical output", () => {
    expect(JSON.stringify(mapOtelSpanToEvent(input))).toBe(JSON.stringify(mapOtelSpanToEvent(input)));
  });

  it("floors sub-millisecond nanos deterministically", () => {
    expect(mapOtelSpanToEvent(input).ts).toBe("2023-11-14T22:13:20.123Z");
  });
});
