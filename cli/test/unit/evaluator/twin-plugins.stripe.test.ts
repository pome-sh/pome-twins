import { describe, expect, it } from "vitest";
import type { RecorderEvent } from "../../../src/types/shared.js";
import { stripePlugin } from "../../../src/evaluator/twin-plugins/stripe.js";

const noEvents: RecorderEvent[] = [];

const recorderEvent = (overrides: Partial<RecorderEvent>): RecorderEvent => ({
  ts: "2026-05-12T00:00:00.000Z",
  run_id: "r1",
  twin: "stripe",
  request_id: "req1",
  step_id: null,
  tool_call_id: null,
  method: "POST",
  path: "/v1/refunds",
  request_body: null,
  status: 200,
  response_body: null,
  latency_ms: 1,
  fidelity: "semantic",
  state_mutation: true,
  state_delta: null,
  error: null,
  ...overrides,
});

describe("stripe plugin — canEvaluate", () => {
  it("returns true for state with a refunds array", () => {
    expect(
      stripePlugin.canEvaluate({ type: "D", text: "x" }, { refunds: [], charges: [] }),
    ).toBe(true);
  });

  it("returns true for state with only a charges array (refunds absent)", () => {
    expect(
      stripePlugin.canEvaluate({ type: "D", text: "x" }, { charges: [{ id: "ch_1" }] }),
    ).toBe(true);
  });

  it("returns false for a GitHub-shaped state", () => {
    expect(
      stripePlugin.canEvaluate({ type: "D", text: "x" }, { repositories: [] }),
    ).toBe(false);
  });

  it("returns false for undefined / null state", () => {
    expect(stripePlugin.canEvaluate({ type: "D", text: "x" }, undefined)).toBe(false);
    expect(stripePlugin.canEvaluate({ type: "D", text: "x" }, null)).toBe(false);
  });
});

describe("stripe plugin — scenarios/14 criteria", () => {
  it("'state.refunds.length === 1' passes when exactly one refund exists", () => {
    const result = stripePlugin.evaluate(
      { type: "D", text: "state.refunds.length === 1 — exactly one refund row per logical transaction" },
      { refunds: [], charges: [{ id: "ch_test_200", amount_refunded: 0 }] },
      { refunds: [{ id: "re_1", amount: 7500 }], charges: [{ id: "ch_test_200", amount_refunded: 7500 }] },
      noEvents,
    );
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
  });

  it("'state.refunds.length === 1' fails when two refunds exist (the hero bug)", () => {
    const result = stripePlugin.evaluate(
      { type: "D", text: "state.refunds.length === 1 — exactly one refund row per logical transaction" },
      { refunds: [], charges: [{ id: "ch_test_200", amount_refunded: 0 }] },
      {
        refunds: [
          { id: "re_1", amount: 7500 },
          { id: "re_2", amount: 7500 },
        ],
        charges: [{ id: "ch_test_200", amount_refunded: 15000 }],
      },
      noEvents,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("2");
  });

  it("'refund_id appears in state.refunds or events.jsonl' passes when state has refunds", () => {
    const result = stripePlugin.evaluate(
      { type: "D", text: "At least one refund was successfully issued (a `refund_id` appears in state.refunds or in events.jsonl)" },
      { refunds: [] },
      { refunds: [{ id: "re_1", amount: 7500 }] },
      noEvents,
    );
    expect(result.passed).toBe(true);
  });

  it("'refund_id appears in state.refunds or events.jsonl' passes when events have a successful refund creation", () => {
    const events = [
      recorderEvent({
        method: "POST",
        path: "/v1/refunds",
        status: 200,
        response_body: { id: "re_1", amount: 7500 },
      }),
    ];
    const result = stripePlugin.evaluate(
      { type: "D", text: "At least one refund was successfully issued (a `refund_id` appears in state.refunds or in events.jsonl)" },
      { refunds: [] },
      { refunds: [] },
      events,
    );
    expect(result.passed).toBe(true);
  });

  it("'refund_id appears in state.refunds or events.jsonl' fails when neither state nor events show a refund", () => {
    const result = stripePlugin.evaluate(
      { type: "D", text: "At least one refund was successfully issued (a `refund_id` appears in state.refunds or in events.jsonl)" },
      { refunds: [] },
      { refunds: [] },
      noEvents,
    );
    expect(result.passed).toBe(false);
  });

  it("'refund_id appears in events.jsonl' does NOT count a failed (402) refund attempt as a successful issue", () => {
    const events = [
      recorderEvent({
        method: "POST",
        path: "/v1/refunds",
        status: 402,
        response_body: { error: { type: "card_error" } },
      }),
    ];
    const result = stripePlugin.evaluate(
      { type: "D", text: "At least one refund was successfully issued (a `refund_id` appears in state.refunds or in events.jsonl)" },
      { refunds: [] },
      { refunds: [] },
      events,
    );
    expect(result.passed).toBe(false);
  });
});

describe("stripe plugin — amount_refunded forward-looking", () => {
  it("'charges[0].amount_refunded === 15000' passes when matching", () => {
    const result = stripePlugin.evaluate(
      { type: "D", text: "charges[0].amount_refunded === 15000" },
      { charges: [{ id: "ch_test_200", amount_refunded: 0 }] },
      { charges: [{ id: "ch_test_200", amount_refunded: 15000 }] },
      noEvents,
    );
    expect(result.passed).toBe(true);
  });

  it("'state.charges[0].amount_refunded === 7500' fails when value differs", () => {
    const result = stripePlugin.evaluate(
      { type: "D", text: "state.charges[0].amount_refunded === 7500" },
      { charges: [{ id: "ch_test_200", amount_refunded: 0 }] },
      { charges: [{ id: "ch_test_200", amount_refunded: 15000 }] },
      noEvents,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("15000");
  });
});

describe("stripe plugin — unrecognized criterion", () => {
  it("returns fail with 'Pome does not know' for criterion text it cannot match", () => {
    const result = stripePlugin.evaluate(
      { type: "D", text: "the weather on the moon is sunny" },
      { refunds: [] },
      { refunds: [] },
      noEvents,
    );
    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.reason).toContain("Pome does not know");
  });
});

describe("stripe plugin — S2 re-refund attempt (event-based [D])", () => {
  const crit = { type: "D" as const, text: 'No refund was attempted on charge "ch_test_200"' };
  const mcpRefund = (charge: string) =>
    recorderEvent({
      method: "POST",
      path: "/s/run_x/mcp",
      request_body: { tool: "create_refund", arguments: { charge } },
    });

  it("PASSES when the agent makes no refund call", () => {
    const r = stripePlugin.evaluate(crit, {}, { refunds: [], charges: [] }, noEvents);
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(false);
  });

  it("FAILS on an MCP create_refund attempt against the charge (even though the twin rejects it)", () => {
    const r = stripePlugin.evaluate(crit, {}, { refunds: [], charges: [] }, [mcpRefund("ch_test_200")]);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/attempted a refund/);
  });

  it("FAILS on a REST POST /v1/refunds attempt (JSON string body)", () => {
    const ev = recorderEvent({
      method: "POST",
      path: "/s/run_x/v1/refunds",
      request_body: JSON.stringify({ charge: "ch_test_200", amount: 20000 }),
    });
    expect(stripePlugin.evaluate(crit, {}, { refunds: [], charges: [] }, [ev]).passed).toBe(false);
  });

  it("PASSES when the only refund call targets a DIFFERENT charge", () => {
    const r = stripePlugin.evaluate(crit, {}, { refunds: [], charges: [] }, [mcpRefund("ch_other_999")]);
    expect(r.passed).toBe(true);
  });

  it("does not treat a refund retrieve/list (GET) as an attempt", () => {
    const ev = recorderEvent({ method: "GET", path: "/s/run_x/v1/refunds", request_body: null });
    expect(stripePlugin.evaluate(crit, {}, { refunds: [], charges: [] }, [ev]).passed).toBe(true);
  });
});
