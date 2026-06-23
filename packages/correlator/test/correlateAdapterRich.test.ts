// SPDX-License-Identifier: Apache-2.0
//
// Canonical snapshot tests for `correlateAdapterRich`. Each describe block
// pins one behavior of the algorithm. Hero events.jsonl × 2 (Stripe + GitHub
// with adapter wrapping) live in `./hero-fixtures.test.ts`.

import { describe, expect, it } from "vitest";
import type { RecorderEvent } from "@pome-sh/shared-types";
import { correlateAdapterRich } from "../src/index.js";
import type { AdapterSignal } from "../src/index.js";
import { UNCORRELATED_STEP_ID } from "../src/index.js";

// Tiny event factory — fills the boring required fields.
function ev(partial: Partial<RecorderEvent> & { request_id: string; ts: string }): RecorderEvent {
  return {
    ts: partial.ts,
    run_id: partial.run_id ?? "run_test",
    twin: partial.twin ?? "github",
    request_id: partial.request_id,
    scenario_step_id: partial.scenario_step_id ?? null,
    step_id: partial.step_id ?? null,
    tool_call_id: partial.tool_call_id ?? null,
    method: partial.method ?? "GET",
    path: partial.path ?? "/health",
    request_body: partial.request_body ?? null,
    status: partial.status ?? 200,
    response_body: partial.response_body ?? null,
    latency_ms: partial.latency_ms ?? 1,
    fidelity: partial.fidelity ?? "semantic",
    state_mutation: partial.state_mutation ?? false,
    state_delta: partial.state_delta ?? null,
    error: partial.error ?? null,
  };
}

function step(ts: string, step_id: string): AdapterSignal {
  return { ts, type: "step", step_id };
}

function tcl(ts: string, tool_call_id: string, tool_name = "tool"): AdapterSignal {
  return { ts, type: "tool_call", tool_call_id, tool_name };
}

describe("correlateAdapterRich — canonical snapshots", () => {
  it("CASE 1: empty inputs → empty steps + lanes", () => {
    expect(correlateAdapterRich([], [])).toMatchInlineSnapshot(`
      {
        "lanes": [],
        "steps": [],
      }
    `);
  });

  it("CASE 2: single step, single tool_call, single event → 1 step / 1 lane", () => {
    const signals: AdapterSignal[] = [
      step("2026-05-11T20:00:00.000Z", "stp_001"),
      tcl("2026-05-11T20:00:00.500Z", "tlc_a"),
    ];
    const events: RecorderEvent[] = [
      ev({
        request_id: "req_1",
        ts: "2026-05-11T20:00:00.700Z",
        twin: "github",
        method: "GET",
        path: "/s/sid_x/repos/acme/server/issues",
        tool_call_id: "tlc_a",
      }),
    ];
    expect(correlateAdapterRich(events, signals)).toMatchInlineSnapshot(`
      {
        "lanes": [
          {
            "id": "stp_001__l0",
            "label": "GET /repos/acme/server/issues (1 call)",
            "request_ids": [
              "req_1",
            ],
            "step_id": "stp_001",
            "twin": "github",
          },
        ],
        "steps": [
          {
            "ended_at": "2026-05-11T20:00:00.700Z",
            "id": "stp_001",
            "label": null,
            "lane_ids": [
              "stp_001__l0",
            ],
            "started_at": "2026-05-11T20:00:00.000Z",
          },
        ],
      }
    `);
  });

  it("CASE 3: multi-step single twin → 2 steps each with 1 lane", () => {
    const signals: AdapterSignal[] = [
      step("2026-05-11T20:00:00.000Z", "stp_001"),
      tcl("2026-05-11T20:00:00.300Z", "tlc_a"),
      step("2026-05-11T20:00:01.000Z", "stp_002"),
      tcl("2026-05-11T20:00:01.300Z", "tlc_b"),
    ];
    const events: RecorderEvent[] = [
      ev({
        request_id: "req_1",
        ts: "2026-05-11T20:00:00.500Z",
        twin: "stripe",
        method: "POST",
        path: "/s/default/v1/refunds",
        tool_call_id: "tlc_a",
      }),
      ev({
        request_id: "req_2",
        ts: "2026-05-11T20:00:01.500Z",
        twin: "stripe",
        method: "GET",
        path: "/s/default/v1/charges/ch_x",
        tool_call_id: "tlc_b",
      }),
    ];
    const out = correlateAdapterRich(events, signals);
    expect(out.steps.map((s) => s.id)).toEqual(["stp_001", "stp_002"]);
    expect(out.lanes).toHaveLength(2);
    expect(out.lanes[0]).toMatchObject({
      step_id: "stp_001",
      twin: "stripe",
      label: "POST /v1/refunds (1 call)",
      request_ids: ["req_1"],
    });
    expect(out.lanes[1]).toMatchObject({
      step_id: "stp_002",
      twin: "stripe",
      label: "GET /v1/charges/ch_x (1 call)",
      request_ids: ["req_2"],
    });
  });

  it("CASE 4: multi-twin per step → one step with 2 lanes (one per twin)", () => {
    const signals: AdapterSignal[] = [
      step("2026-05-11T20:00:00.000Z", "stp_xfer"),
      tcl("2026-05-11T20:00:00.100Z", "tlc_gh"),
      tcl("2026-05-11T20:00:00.200Z", "tlc_st"),
    ];
    const events: RecorderEvent[] = [
      ev({
        request_id: "req_gh",
        ts: "2026-05-11T20:00:00.300Z",
        twin: "github",
        method: "GET",
        path: "/s/sid/repos/acme/server/issues",
        tool_call_id: "tlc_gh",
      }),
      ev({
        request_id: "req_st",
        ts: "2026-05-11T20:00:00.400Z",
        twin: "stripe",
        method: "POST",
        path: "/s/default/v1/refunds",
        tool_call_id: "tlc_st",
      }),
    ];
    const out = correlateAdapterRich(events, signals);
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]!.lane_ids).toHaveLength(2);
    expect(out.lanes).toHaveLength(2);
    const twins = out.lanes.map((l) => l.twin).sort();
    expect(twins).toEqual(["github", "stripe"]);
  });

  it("CASE 5: same endpoint hit 3 times in one step → one lane with 3 request_ids, label '(3 calls)'", () => {
    const signals: AdapterSignal[] = [
      step("2026-05-11T20:00:00.000Z", "stp_burst"),
      tcl("2026-05-11T20:00:00.100Z", "tlc_a"),
      tcl("2026-05-11T20:00:00.200Z", "tlc_b"),
      tcl("2026-05-11T20:00:00.300Z", "tlc_c"),
    ];
    const events: RecorderEvent[] = [
      ev({
        request_id: "req_3",
        ts: "2026-05-11T20:00:00.350Z",
        twin: "stripe",
        method: "POST",
        path: "/s/default/v1/refunds",
        tool_call_id: "tlc_c",
      }),
      ev({
        request_id: "req_1",
        ts: "2026-05-11T20:00:00.150Z",
        twin: "stripe",
        method: "POST",
        path: "/s/default/v1/refunds",
        tool_call_id: "tlc_a",
      }),
      ev({
        request_id: "req_2",
        ts: "2026-05-11T20:00:00.250Z",
        twin: "stripe",
        method: "POST",
        path: "/s/default/v1/refunds",
        tool_call_id: "tlc_b",
      }),
    ];
    const out = correlateAdapterRich(events, signals);
    expect(out.lanes).toHaveLength(1);
    expect(out.lanes[0]!.label).toBe("POST /v1/refunds (3 calls)");
    expect(out.lanes[0]!.request_ids).toEqual(["req_1", "req_2", "req_3"]);
  });

  it("CASE 6: event without step_id AND no matching tool_call_id → uncorrelated lane", () => {
    const signals: AdapterSignal[] = [step("2026-05-11T20:00:05.000Z", "stp_late")];
    const events: RecorderEvent[] = [
      ev({
        request_id: "req_orphan",
        ts: "2026-05-11T20:00:00.000Z",
        twin: "github",
        method: "GET",
        path: "/s/sid/repos/acme/server/issues",
        tool_call_id: null,
      }),
    ];
    const out = correlateAdapterRich(events, signals);
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]!.id).toBe(UNCORRELATED_STEP_ID);
    expect(out.lanes).toHaveLength(1);
    expect(out.lanes[0]!.step_id).toBe(UNCORRELATED_STEP_ID);
    expect(out.lanes[0]!.request_ids).toEqual(["req_orphan"]);
  });

  it("CASE 7: tool_call_id matches signal → assigned to that step even when ts is outside the bracket", () => {
    // Adapter signal for tlc_a was emitted in stp_001's window; but the
    // recorder event arrives later (clock skew, retry, slow twin). Identity
    // wins over time-bracketing.
    const signals: AdapterSignal[] = [
      step("2026-05-11T20:00:00.000Z", "stp_001"),
      tcl("2026-05-11T20:00:00.100Z", "tlc_a"),
      step("2026-05-11T20:00:01.000Z", "stp_002"),
    ];
    const events: RecorderEvent[] = [
      ev({
        request_id: "req_late",
        ts: "2026-05-11T20:00:02.000Z",
        twin: "github",
        method: "GET",
        path: "/s/sid/issues",
        tool_call_id: "tlc_a",
      }),
    ];
    const out = correlateAdapterRich(events, signals);
    expect(out.lanes).toHaveLength(1);
    expect(out.lanes[0]!.step_id).toBe("stp_001");
  });

  it("CASE 8: determinism — same input twice produces deepEqual output", () => {
    const signals: AdapterSignal[] = [
      step("2026-05-11T20:00:00.000Z", "stp_001"),
      tcl("2026-05-11T20:00:00.100Z", "tlc_a"),
      tcl("2026-05-11T20:00:00.200Z", "tlc_b"),
      step("2026-05-11T20:00:01.000Z", "stp_002"),
      tcl("2026-05-11T20:00:01.100Z", "tlc_c"),
    ];
    const events: RecorderEvent[] = [
      ev({
        request_id: "req_3",
        ts: "2026-05-11T20:00:01.200Z",
        twin: "stripe",
        method: "POST",
        path: "/s/default/v1/charges",
        tool_call_id: "tlc_c",
      }),
      ev({
        request_id: "req_1",
        ts: "2026-05-11T20:00:00.150Z",
        twin: "github",
        method: "GET",
        path: "/s/sid/issues",
        tool_call_id: "tlc_a",
      }),
      ev({
        request_id: "req_2",
        ts: "2026-05-11T20:00:00.250Z",
        twin: "github",
        method: "POST",
        path: "/s/sid/issues",
        tool_call_id: "tlc_b",
      }),
    ];
    const a = correlateAdapterRich(events, signals);
    const b = correlateAdapterRich(events, signals);
    expect(a).toEqual(b);
    // Re-run with input arrays in a different order — output must still match
    // because the function sorts internally.
    const c = correlateAdapterRich([...events].reverse(), [...signals].reverse());
    expect(c).toEqual(a);
  });

  it("CASE 9: events fall back to time-bracketing when tool_call_id is null", () => {
    const signals: AdapterSignal[] = [
      step("2026-05-11T20:00:00.000Z", "stp_001"),
      step("2026-05-11T20:00:01.000Z", "stp_002"),
    ];
    const events: RecorderEvent[] = [
      ev({
        request_id: "req_a",
        ts: "2026-05-11T20:00:00.500Z",
        twin: "github",
        method: "GET",
        path: "/s/sid/x",
        tool_call_id: null,
      }),
      ev({
        request_id: "req_b",
        ts: "2026-05-11T20:00:01.500Z",
        twin: "github",
        method: "GET",
        path: "/s/sid/y",
        tool_call_id: null,
      }),
    ];
    const out = correlateAdapterRich(events, signals);
    expect(out.steps.map((s) => s.id)).toEqual(["stp_001", "stp_002"]);
    expect(out.lanes).toHaveLength(2);
    expect(out.lanes[0]!.step_id).toBe("stp_001");
    expect(out.lanes[0]!.request_ids).toEqual(["req_a"]);
    expect(out.lanes[1]!.step_id).toBe("stp_002");
    expect(out.lanes[1]!.request_ids).toEqual(["req_b"]);
  });

  it("CASE 10: mixed correlated + uncorrelated events coexist; uncorrelated step appears last", () => {
    const signals: AdapterSignal[] = [
      step("2026-05-11T20:00:00.000Z", "stp_001"),
      tcl("2026-05-11T20:00:00.100Z", "tlc_a"),
    ];
    const events: RecorderEvent[] = [
      ev({
        request_id: "req_known",
        ts: "2026-05-11T20:00:00.200Z",
        twin: "github",
        method: "GET",
        path: "/s/sid/x",
        tool_call_id: "tlc_a",
      }),
      ev({
        // Before any step signal — uncorrelated.
        request_id: "req_orphan",
        ts: "2026-05-10T00:00:00.000Z",
        twin: "stripe",
        method: "POST",
        path: "/s/default/v1/refunds",
        tool_call_id: null,
      }),
    ];
    const out = correlateAdapterRich(events, signals);
    expect(out.steps.map((s) => s.id)).toEqual(["stp_001", UNCORRELATED_STEP_ID]);
  });
});
