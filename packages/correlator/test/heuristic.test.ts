// SPDX-License-Identifier: Apache-2.0
//
// Heuristic correlator tests (FDRS-325).
//
// The 9th test (`bundled scenario golden`) is the acceptance test from the
// ticket: it reads the real twin-stripe events.jsonl captured in FDRS-340
// and asserts the correlator produces the 2-step / 2-lane split the
// dashboard's lane-timeline (M1+M2-2) renders for the refund-retry-double-
// charge hero scenario.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { recorderEventSchema, type RecorderEvent } from "@pome-sh/shared-types";
import { correlateHeuristic } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SCENARIO_PATH = resolve(
  HERE,
  "fixtures/stripe-refund-retry.expected-events.jsonl",
);

function ev(overrides: Partial<RecorderEvent> & { ts: string; request_id: string; method?: string; path?: string }): RecorderEvent {
  return {
    ts: overrides.ts,
    run_id: overrides.run_id ?? "run_test",
    twin: overrides.twin ?? "stripe",
    request_id: overrides.request_id,
    step_id: overrides.step_id ?? null,
    tool_call_id: overrides.tool_call_id ?? null,
    method: overrides.method ?? "POST",
    path: overrides.path ?? "/s/default/v1/refunds",
    request_body: overrides.request_body ?? null,
    status: overrides.status ?? 200,
    response_body: overrides.response_body ?? {},
    latency_ms: overrides.latency_ms ?? 0,
    fidelity: overrides.fidelity ?? "semantic",
    state_mutation: overrides.state_mutation ?? false,
    state_delta: overrides.state_delta ?? null,
    error: overrides.error ?? null,
  };
}

describe("correlateHeuristic", () => {
  it("returns empty arrays for empty input", () => {
    expect(correlateHeuristic([])).toEqual({ lanes: [], steps: [] });
  });

  it("produces 1 step + 1 lane for a single event", () => {
    const { steps, lanes } = correlateHeuristic([
      ev({ ts: "2026-05-11T22:21:54.256Z", request_id: "req_1" }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.id).toBe("stp_h00");
    expect(steps[0]!.label).toBeNull();
    expect(steps[0]!.lane_ids).toEqual(["ln_h00_00"]);
    expect(steps[0]!.started_at).toBe("2026-05-11T22:21:54.256Z");
    expect(steps[0]!.ended_at).toBe("2026-05-11T22:21:54.256Z");
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.id).toBe("ln_h00_00");
    expect(lanes[0]!.step_id).toBe("stp_h00");
    expect(lanes[0]!.twin).toBe("stripe");
    expect(lanes[0]!.label).toBe("POST /v1/refunds (1 call)");
    expect(lanes[0]!.request_ids).toEqual(["req_1"]);
  });

  it("keeps two same-family events with sub-gap timing in one step", () => {
    const { steps, lanes } = correlateHeuristic([
      ev({ ts: "2026-05-11T22:21:54.256Z", request_id: "req_1" }),
      ev({ ts: "2026-05-11T22:21:54.257Z", request_id: "req_2" }),
    ]);
    expect(steps).toHaveLength(1);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.request_ids).toEqual(["req_1", "req_2"]);
    expect(lanes[0]!.label).toBe("POST /v1/refunds (2 calls)");
  });

  it("splits two same-family events into two steps when ts gap exceeds gapMs", () => {
    const { steps, lanes } = correlateHeuristic([
      ev({ ts: "2026-05-11T22:21:54.000Z", request_id: "req_1" }),
      ev({ ts: "2026-05-11T22:21:55.000Z", request_id: "req_2" }), // 1000ms > 500ms default
    ]);
    expect(steps).toHaveLength(2);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]!.request_ids).toEqual(["req_1"]);
    expect(lanes[1]!.request_ids).toEqual(["req_2"]);
    expect(lanes[1]!.step_id).toBe("stp_h01");
    expect(lanes[1]!.id).toBe("ln_h01_00");
  });

  it("splits on family change regardless of timing", () => {
    const { steps, lanes } = correlateHeuristic([
      ev({ ts: "2026-05-11T22:21:54.256Z", request_id: "req_1", path: "/s/default/v1/refunds" }),
      ev({ ts: "2026-05-11T22:21:54.257Z", request_id: "req_2", method: "GET", path: "/s/default/v1/charges/ch_x" }),
    ]);
    expect(steps).toHaveLength(2);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]!.label).toBe("POST /v1/refunds (1 call)");
    expect(lanes[1]!.label).toBe("GET /v1/charges (1 call)");
  });

  it("splits within a step into multiple lanes on method change", () => {
    const { steps, lanes } = correlateHeuristic([
      ev({ ts: "2026-05-11T22:21:54.256Z", request_id: "req_1", method: "POST", path: "/s/default/v1/refunds" }),
      ev({ ts: "2026-05-11T22:21:54.257Z", request_id: "req_2", method: "GET", path: "/s/default/v1/refunds" }),
    ]);
    expect(steps).toHaveLength(1);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]!.label).toBe("POST /v1/refunds (1 call)");
    expect(lanes[1]!.label).toBe("GET /v1/refunds (1 call)");
    expect(steps[0]!.lane_ids).toEqual(["ln_h00_00", "ln_h00_01"]);
  });

  it("is deterministic across repeated invocations", () => {
    const input = [
      ev({ ts: "2026-05-11T22:21:54.256Z", request_id: "req_1" }),
      ev({ ts: "2026-05-11T22:21:54.257Z", request_id: "req_2" }),
      ev({ ts: "2026-05-11T22:21:54.258Z", request_id: "req_3", method: "GET", path: "/s/default/v1/charges/ch_x" }),
    ];
    expect(correlateHeuristic(input)).toEqual(correlateHeuristic(input));
  });

  it("sorts unordered input by ts (defensive)", () => {
    const sorted = correlateHeuristic([
      ev({ ts: "2026-05-11T22:21:54.256Z", request_id: "req_a" }),
      ev({ ts: "2026-05-11T22:21:54.257Z", request_id: "req_b" }),
    ]);
    const shuffled = correlateHeuristic([
      ev({ ts: "2026-05-11T22:21:54.257Z", request_id: "req_b" }),
      ev({ ts: "2026-05-11T22:21:54.256Z", request_id: "req_a" }),
    ]);
    expect(shuffled).toEqual(sorted);
  });

  it("golden: bundled scenario 14 (Stripe refund-retry-double-charge)", () => {
    const raw = readFileSync(BUNDLED_SCENARIO_PATH, "utf-8");
    const events = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => recorderEventSchema.parse(JSON.parse(line)));
    expect(events).toHaveLength(3);

    const { steps, lanes } = correlateHeuristic(events);

    expect(steps).toHaveLength(2);
    expect(lanes).toHaveLength(2);

    // Step 0: the two refund POSTs (402 then 200 retry — the double-charge bug)
    expect(steps[0]!.id).toBe("stp_h00");
    expect(steps[0]!.label).toBeNull();
    expect(steps[0]!.lane_ids).toEqual(["ln_h00_00"]);
    expect(steps[0]!.started_at).toBe(events[0]!.ts);
    expect(steps[0]!.ended_at).toBe(events[1]!.ts);
    expect(lanes[0]!.id).toBe("ln_h00_00");
    expect(lanes[0]!.twin).toBe("stripe");
    expect(lanes[0]!.label).toBe("POST /v1/refunds (2 calls)");
    expect(lanes[0]!.request_ids).toEqual([events[0]!.request_id, events[1]!.request_id]);

    // Step 1: the verify-charge GET
    expect(steps[1]!.id).toBe("stp_h01");
    expect(steps[1]!.lane_ids).toEqual(["ln_h01_00"]);
    expect(lanes[1]!.label).toBe("GET /v1/charges (1 call)");
    expect(lanes[1]!.request_ids).toEqual([events[2]!.request_id]);
  });
});
