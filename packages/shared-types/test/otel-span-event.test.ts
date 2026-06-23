// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  OTEL_CORE_SEMCONV_VERSION,
  OTEL_GENAI_SCHEMA_VERSION,
  nanosToIso,
  otelAttributeValueSchema,
  otelSpanEventSchema,
  otelSpanKindSchema,
  otelStatusCodeSchema,
  unixNanoSchema,
} from "../src/otel/index.js";

const START = "1700000000000000000";

// A well-formed OtelSpanEvent whose typed projections exactly match the
// attribute bag (the schema's drift guard requires this).
const validEvent = {
  ts: nanosToIso(START),
  event_id: "00f067aa0ba902b7",
  parent_id: null,
  kind: "OtelSpanEvent" as const,
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  span_id: "00f067aa0ba902b7",
  parent_span_id: null,
  name: "GET",
  span_kind: "CLIENT" as const,
  start_time_unix_nano: START,
  end_time_unix_nano: null,
  status_code: "UNSET" as const,
  status_message: null,
  gen_ai_provider_name: null,
  gen_ai_operation_name: null,
  gen_ai_request_model: null,
  gen_ai_agent_name: null,
  gen_ai_agent_id: null,
  gen_ai_tool_name: null,
  gen_ai_usage_input_tokens: null,
  gen_ai_usage_output_tokens: null,
  http_request_method: "GET",
  http_response_status_code: 200,
  url_full: "https://api.github.com/repos/acme/app",
  url_path: "/repos/acme/app",
  server_address: "api.github.com",
  server_port: 443,
  error_type: null,
  attributes: {
    "http.request.method": "GET",
    "http.response.status_code": 200,
    "url.full": "https://api.github.com/repos/acme/app",
    "url.path": "/repos/acme/app",
    "server.address": "api.github.com",
    "server.port": 443,
  },
};

describe("pinned convention versions", () => {
  it("are two independent literals (core vs genai)", () => {
    expect(OTEL_CORE_SEMCONV_VERSION).toBe("1.41.1");
    expect(OTEL_GENAI_SCHEMA_VERSION).toBe("1.42.0");
  });
});

describe("otelSpanEventSchema — happy path", () => {
  it("accepts a well-formed span event", () => {
    expect(otelSpanEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it("accepts a legacy:-namespaced id pair", () => {
    const legacy = {
      ...validEvent,
      event_id: "legacy:evt_1",
      span_id: "legacy:evt_1",
      trace_id: "legacy:run_1",
      parent_id: "legacy:evt_0",
      parent_span_id: "legacy:evt_0",
    };
    expect(otelSpanEventSchema.safeParse(legacy).success).toBe(true);
  });
});

describe("otelSpanEventSchema — id validation", () => {
  it("rejects a missing required field with a typed ZodError", () => {
    const { trace_id, ...withoutTraceId } = validEvent;
    const result = otelSpanEventSchema.safeParse(withoutTraceId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(z.ZodError);
      expect(result.error.issues[0]?.path).toEqual(["trace_id"]);
    }
  });

  it("rejects an arbitrary (non-W3C, non-legacy) trace id", () => {
    expect(otelSpanEventSchema.safeParse({ ...validEvent, trace_id: "not-hex" }).success).toBe(false);
  });

  it("rejects an all-zero trace id (the W3C invalid sentinel)", () => {
    expect(
      otelSpanEventSchema.safeParse({
        ...validEvent,
        trace_id: "00000000000000000000000000000000",
      }).success,
    ).toBe(false);
  });

  it("rejects an uppercase-hex span id", () => {
    expect(
      otelSpanEventSchema.safeParse({
        ...validEvent,
        span_id: "00F067AA0BA902B7",
        event_id: "00F067AA0BA902B7",
      }).success,
    ).toBe(false);
  });

  it("rejects event_id that does not equal span_id", () => {
    const result = otelSpanEventSchema.safeParse({ ...validEvent, event_id: "1111111111111111" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["event_id"]);
  });

  it("rejects parent_id that does not equal parent_span_id", () => {
    const result = otelSpanEventSchema.safeParse({
      ...validEvent,
      parent_id: "legacy:x",
      parent_span_id: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("otelSpanEventSchema — timing validation", () => {
  it("rejects a non-decimal-string unix-nano timestamp", () => {
    expect(otelSpanEventSchema.safeParse({ ...validEvent, start_time_unix_nano: "12.3" }).success).toBe(false);
  });

  it("rejects a unix-nano that overflows uint64", () => {
    expect(
      otelSpanEventSchema.safeParse({
        ...validEvent,
        start_time_unix_nano: "184467440737095516150", // 21 digits, > 2^64-1
      }).success,
    ).toBe(false);
  });

  it("rejects ts that does not match nanosToIso(start)", () => {
    const result = otelSpanEventSchema.safeParse({ ...validEvent, ts: "2020-01-01T00:00:00.000Z" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["ts"]);
  });

  it("rejects a reversed span (end < start)", () => {
    const result = otelSpanEventSchema.safeParse({
      ...validEvent,
      end_time_unix_nano: "1699999999000000000", // before start
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["end_time_unix_nano"]);
  });

  it("accepts end == start", () => {
    expect(otelSpanEventSchema.safeParse({ ...validEvent, end_time_unix_nano: START }).success).toBe(true);
  });
});

describe("otelSpanEventSchema — attribute + projection validation", () => {
  it("rejects an attribute value that is not a primitive or primitive array", () => {
    expect(otelSpanEventSchema.safeParse({ ...validEvent, attributes: { nested: { no: 1 } } }).success).toBe(false);
  });

  it("rejects a non-finite numeric attribute", () => {
    const result = otelSpanEventSchema.safeParse({
      ...validEvent,
      attributes: { ...validEvent.attributes, "gen_ai.usage.input_tokens": Infinity },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a typed projection that drifts from the attribute bag", () => {
    const result = otelSpanEventSchema.safeParse({ ...validEvent, http_request_method: "POST" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["http_request_method"]);
  });

  it("rejects a provider projection that ignores the gen_ai.system alias", () => {
    // attributes declare a provider via the deprecated alias; the projection
    // must reflect it, not be null.
    const result = otelSpanEventSchema.safeParse({
      ...validEvent,
      attributes: { ...validEvent.attributes, "gen_ai.system": "openai" },
      gen_ai_provider_name: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("leaf schemas", () => {
  it("unixNanoSchema accepts an in-range uint64 and rejects junk/overflow/negative", () => {
    expect(unixNanoSchema.safeParse("1700000000000000000").success).toBe(true);
    expect(unixNanoSchema.safeParse("18446744073709551615").success).toBe(true); // 2^64-1
    expect(unixNanoSchema.safeParse("18446744073709551616").success).toBe(false); // 2^64
    expect(unixNanoSchema.safeParse("-1").success).toBe(false);
    expect(unixNanoSchema.safeParse("12.3").success).toBe(false);
  });

  it("otelSpanKindSchema and otelStatusCodeSchema enumerate the OTLP names", () => {
    expect(otelSpanKindSchema.safeParse("PRODUCER").success).toBe(true);
    expect(otelStatusCodeSchema.safeParse("ERROR").success).toBe(true);
    expect(otelStatusCodeSchema.safeParse("MAYBE").success).toBe(false);
  });

  it("otelAttributeValueSchema accepts finite primitives + arrays, rejects objects/Infinity", () => {
    expect(otelAttributeValueSchema.safeParse("x").success).toBe(true);
    expect(otelAttributeValueSchema.safeParse(7).success).toBe(true);
    expect(otelAttributeValueSchema.safeParse(true).success).toBe(true);
    expect(otelAttributeValueSchema.safeParse(["a", 1, false]).success).toBe(true);
    expect(otelAttributeValueSchema.safeParse({ k: "v" }).success).toBe(false);
    expect(otelAttributeValueSchema.safeParse(Infinity).success).toBe(false);
    expect(otelAttributeValueSchema.safeParse([Number.NaN]).success).toBe(false);
  });
});
