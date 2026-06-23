// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { mapOtelSpanToEvent } from "../src/otel/map-span.js";
import { otelEventSchema } from "../src/otel/event-schema.js";
import { eventSchema } from "../src/recorder-events.js";

// `otelEventSchema` is the OTel-inclusive union (src/otel). It keeps
// `OtelSpanEvent` out of the frozen v1 `eventSchema` (additive, non-breaking);
// `pome-cloud` mirrors this surface. OTel-aware readers opt into
// `otelEventSchema`; v1-only readers keep using `eventSchema`.

const validOtelSpan = mapOtelSpanToEvent({
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  span_id: "00f067aa0ba902b7",
  name: "chat gpt-4",
  start_time_unix_nano: "1700000000000000000",
  attributes: { "gen_ai.provider.name": "openai" },
});

const validTwinHttp = {
  ts: "2026-06-02T00:00:00.000Z",
  run_id: "run_1",
  twin: "github",
  request_id: "req_1",
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
  event_id: "evt_1",
  parent_id: null,
};

describe("otelEventSchema", () => {
  it("accepts the OtelSpanEvent variant", () => {
    const result = otelEventSchema.safeParse(validOtelSpan);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.kind).toBe("OtelSpanEvent");
  });

  it("still accepts every legacy variant (superset of the mirror)", () => {
    expect(otelEventSchema.safeParse(validTwinHttp).success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    expect(
      otelEventSchema.safeParse({ kind: "Nope", event_id: "x", parent_id: null }).success,
    ).toBe(false);
  });

  it("recognizes OtelSpanEvent that the mirrored eventSchema does not", () => {
    // The key invariant: the cloud union is a strict superset of the mirror.
    expect(otelEventSchema.safeParse(validOtelSpan).success).toBe(true);
    expect(eventSchema.safeParse(validOtelSpan).success).toBe(false);
  });
});
