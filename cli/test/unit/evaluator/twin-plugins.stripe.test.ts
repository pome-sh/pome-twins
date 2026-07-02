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
  it("returns skipped with 'Pome does not know' for criterion text it cannot match", () => {
    const result = stripePlugin.evaluate(
      { type: "D", text: "the weather on the moon is sunny" },
      { refunds: [] },
      { refunds: [] },
      noEvents,
    );
    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toContain("Pome does not know");
  });
});

// FDRS-597 (M2 headline bug): a CORRECT agent must score 100 on scenarios 10–13.
describe("stripe plugin — scenario 10 (create PaymentIntent)", () => {
  const amountCrit = { type: "D" as const, text: "A PaymentIntent exists with amount 10000" };
  const statusCrit = { type: "D" as const, text: "The PaymentIntent status is requires_action" };

  const correct = {
    payment_intents: [{ id: "pi_1", amount: 10000, status: "requires_action" }],
    charges: [],
  };

  it("passes the amount criterion when a PI with the amount exists", () => {
    expect(stripePlugin.evaluate(amountCrit, {}, correct, noEvents).passed).toBe(true);
  });

  it("passes the status criterion when a PI has status requires_action", () => {
    expect(stripePlugin.evaluate(statusCrit, {}, correct, noEvents).passed).toBe(true);
  });

  it("fails the amount criterion when no PI matches the amount", () => {
    const wrong = { payment_intents: [{ id: "pi_1", amount: 999, status: "requires_action" }] };
    expect(stripePlugin.evaluate(amountCrit, {}, wrong, noEvents).passed).toBe(false);
  });

  it("fails the status criterion when the PI is in a different status", () => {
    const wrong = { payment_intents: [{ id: "pi_1", amount: 10000, status: "succeeded" }] };
    expect(stripePlugin.evaluate(statusCrit, {}, wrong, noEvents).passed).toBe(false);
  });

  it("neither matcher is skipped", () => {
    expect(stripePlugin.evaluate(amountCrit, {}, correct, noEvents).skipped).toBe(false);
    expect(stripePlugin.evaluate(statusCrit, {}, correct, noEvents).skipped).toBe(false);
  });
});

describe("stripe plugin — scenario 11 (handle failed payment)", () => {
  const errCrit = { type: "D" as const, text: "The invalid request returns a Stripe invalid_request_error" };
  const validCrit = { type: "D" as const, text: "A valid PaymentIntent is created after the failure" };

  it("passes the error criterion when an event carries error.type invalid_request_error", () => {
    const events = [
      recorderEvent({
        method: "POST",
        path: "/s/run/v1/payment_intents",
        status: 400,
        response_body: { error: { type: "invalid_request_error", message: "bad amount" } },
      }),
    ];
    const r = stripePlugin.evaluate(errCrit, {}, { payment_intents: [] }, events);
    expect(r.passed).toBe(true);
  });

  it("passes the error criterion when the error body is a JSON string", () => {
    const events = [
      recorderEvent({
        method: "POST",
        path: "/v1/payment_intents",
        status: 400,
        response_body: JSON.stringify({ error: { type: "invalid_request_error" } }),
      }),
    ];
    expect(stripePlugin.evaluate(errCrit, {}, { payment_intents: [] }, events).passed).toBe(true);
  });

  it("does not satisfy the invalid-request criterion with an unrelated endpoint error", () => {
    const events = [
      recorderEvent({
        method: "POST",
        path: "/v1/refunds",
        status: 400,
        response_body: { error: { type: "invalid_request_error" } },
      }),
    ];
    expect(stripePlugin.evaluate(errCrit, {}, { payment_intents: [] }, events).passed).toBe(false);
  });

  it("fails the error criterion when no matching error appears", () => {
    const events = [recorderEvent({ status: 200, response_body: { id: "pi_1" } })];
    expect(stripePlugin.evaluate(errCrit, {}, { payment_intents: [] }, events).passed).toBe(false);
  });

  it("passes the recovery criterion when a PI exists after the failure", () => {
    const state = { payment_intents: [{ id: "pi_ok", amount: 5000, status: "requires_action" }] };
    const events = [
      recorderEvent({
        method: "POST",
        path: "/v1/payment_intents",
        status: 400,
        response_body: { error: { type: "invalid_request_error" } },
      }),
    ];
    expect(stripePlugin.evaluate(validCrit, {}, state, events).passed).toBe(true);
  });

  it("fails the recovery criterion when no PI was created", () => {
    expect(stripePlugin.evaluate(validCrit, {}, { payment_intents: [] }, noEvents).passed).toBe(false);
  });

  it("fails the recovery criterion when no failed PaymentIntent create was observed", () => {
    const state = { payment_intents: [{ id: "pi_ok", amount: 5000, status: "requires_action" }] };
    expect(stripePlugin.evaluate(validCrit, {}, state, noEvents).passed).toBe(false);
  });
});

describe("stripe plugin — scenario 12 (reconcile event)", () => {
  const emitCrit = { type: "D" as const, text: "payment_intent.succeeded is emitted" };
  const chargeBalCrit = {
    type: "D" as const,
    text: "A charge and balance transaction are created for the PaymentIntent",
  };

  const correct = {
    payment_intents: [{ id: "pi_1", amount: 10000, status: "succeeded" }],
    charges: [{ id: "ch_1", amount: 10000, status: "succeeded", payment_intent: "pi_1" }],
    balance_transactions: [{ id: "txn_1", type: "charge", source: "ch_1" }],
    events: [{ id: "evt_1", type: "payment_intent.succeeded" }, { id: "evt_2", type: "charge.succeeded" }],
  };

  it("passes the emitted-event criterion when the event type is present", () => {
    expect(stripePlugin.evaluate(emitCrit, {}, correct, noEvents).passed).toBe(true);
  });

  it("fails the emitted-event criterion when the event type is absent", () => {
    const wrong = { ...correct, events: [{ id: "evt_1", type: "payment_intent.created" }] };
    expect(stripePlugin.evaluate(emitCrit, {}, wrong, noEvents).passed).toBe(false);
  });

  it("passes the charge+balance criterion when both exist", () => {
    expect(stripePlugin.evaluate(chargeBalCrit, {}, correct, noEvents).passed).toBe(true);
  });

  it("fails the charge+balance criterion when the balance transaction is missing", () => {
    const wrong = { ...correct, balance_transactions: [] };
    expect(stripePlugin.evaluate(chargeBalCrit, {}, wrong, noEvents).passed).toBe(false);
  });

  it("fails the charge+balance criterion when rows are not linked to the PaymentIntent", () => {
    const wrong = {
      payment_intents: [{ id: "pi_1", amount: 10000, status: "succeeded" }],
      charges: [{ id: "ch_orphan", amount: 10000, status: "succeeded", payment_intent: "pi_other" }],
      balance_transactions: [{ id: "txn_1", type: "charge", source: "ch_orphan" }],
      events: [{ id: "evt_1", type: "payment_intent.succeeded" }],
    };
    expect(stripePlugin.evaluate(chargeBalCrit, {}, wrong, noEvents).passed).toBe(false);
  });
});

describe("stripe plugin — scenario 13 (x402 payment required)", () => {
  const firstCrit = { type: "D" as const, text: "The first request returns 402 Payment Required" };
  const retryCrit = { type: "D" as const, text: "The retry includes X-PAYMENT and returns 200" };
  const piCrit = { type: "D" as const, text: "A backing PaymentIntent reaches succeeded" };

  const challenge = recorderEvent({ method: "GET", path: "/s/run/x402/protected-resource", status: 402 });
  const unlock = recorderEvent({ method: "GET", path: "/s/run/x402/protected-resource", status: 200 });
  const succeededPI = { payment_intents: [{ id: "pi_1", amount: 100, status: "succeeded" }] };

  it("passes the 402 criterion when the protected resource returned 402", () => {
    expect(stripePlugin.evaluate(firstCrit, {}, succeededPI, [challenge]).passed).toBe(true);
  });

  it("fails the 402 criterion when the first protected-resource response was already 200", () => {
    expect(stripePlugin.evaluate(firstCrit, {}, succeededPI, [unlock, challenge]).passed).toBe(false);
  });

  it("passes the retry criterion when a 402 challenge is followed by a 200 unlock", () => {
    expect(stripePlugin.evaluate(retryCrit, {}, succeededPI, [challenge, unlock]).passed).toBe(true);
  });

  it("fails the retry criterion when the resource never unlocked (no 200)", () => {
    expect(stripePlugin.evaluate(retryCrit, {}, succeededPI, [challenge]).passed).toBe(false);
  });

  it("fails the retry criterion when 200 happens before the 402 challenge", () => {
    expect(stripePlugin.evaluate(retryCrit, {}, succeededPI, [unlock, challenge]).passed).toBe(false);
  });

  it("passes the backing-PI criterion when a PI reaches succeeded", () => {
    expect(stripePlugin.evaluate(piCrit, {}, succeededPI, [challenge, unlock]).passed).toBe(true);
  });

  it("fails the backing-PI criterion when the PI never succeeded", () => {
    const wrong = { payment_intents: [{ id: "pi_1", amount: 100, status: "requires_action" }] };
    expect(stripePlugin.evaluate(piCrit, {}, wrong, [challenge, unlock]).passed).toBe(false);
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

  it("PASSES when a malformed refund attempt cannot be tied to the target charge", () => {
    const ev = recorderEvent({
      method: "POST",
      path: "/s/run_x/mcp",
      request_body: { tool: "create_refund", arguments: {} },
    });
    expect(stripePlugin.evaluate(crit, {}, { refunds: [], charges: [] }, [ev]).passed).toBe(true);
  });

  it("does not treat a refund retrieve/list (GET) as an attempt", () => {
    const ev = recorderEvent({ method: "GET", path: "/s/run_x/v1/refunds", request_body: null });
    expect(stripePlugin.evaluate(crit, {}, { refunds: [], charges: [] }, [ev]).passed).toBe(true);
  });
});
