// SPDX-License-Identifier: Apache-2.0
//
// FDRS-646 — Golden-scenario CI gate.
//
// A DETERMINISTIC end-to-end check of the evaluator that needs NO live LLM
// (no ANTHROPIC_API_KEY / OPENAI_API_KEY): it feeds the SHIPPED `[D]` criteria
// of the Stripe scenarios (10–13) against handcrafted "correct-agent" and
// "wrong-agent" final states + event traces, then asserts:
//
//   1. the correct fixture scores ≥ the scenario pass threshold AND passes the
//      A5 guard (`scenarioPassed`), so a CORRECT agent is not falsely failed —
//      this is the exact FDRS-597 regression (correct agent scored 0% on 10–13);
//   2. the wrong fixture scores BELOW threshold (a real FAIL, not "un-evaluated");
//   3. the per-criterion breakdown is what we expect (every criterion evaluated,
//      none `skipped`/`errored` — so the harness actually understood the
//      shipped criteria rather than silently skipping them).
//
// If any shipped `[D]` criterion stops matching, the correct fixture drops below
// 100 (or a criterion flips to `skipped`) and this gate fails in CI — catching
// a matcher regression before it silently zeroes out a real agent's score.
import { describe, expect, it, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evaluateScenario } from "../../src/evaluator/deterministic.js";
import { scenarioPassed, type CriterionResult } from "../../src/evaluator/score.js";
import { parseScenarioFile } from "../../src/scenario/parseScenario.js";
import type { Scenario } from "../../src/scenario/scenarioSchema.js";

const scenariosDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scenarios");

type Fixture = {
  finalState: unknown;
  events: Array<Record<string, unknown>>;
};

const ev = (o: Partial<Record<string, unknown>>): Record<string, unknown> => ({
  ts: "2026-07-02T00:00:00.000Z",
  run_id: "golden",
  twin: "stripe",
  request_id: "req",
  step_id: null,
  tool_call_id: null,
  method: "GET",
  path: "/x402/protected-resource",
  request_body: null,
  status: 200,
  response_body: null,
  latency_ms: 1,
  fidelity: "semantic",
  state_mutation: false,
  state_delta: null,
  error: null,
  ...o,
});

// Golden fixtures per scenario slug. `correct` must satisfy every shipped [D]
// criterion; `wrong` is a plausible failed-agent trace that satisfies none.
const FIXTURES: Record<string, { correct: Fixture; wrong: Fixture }> = {
  "stripe-create-payment-intent": {
    correct: {
      finalState: {
        payment_intents: [{ id: "pi_1", amount: 10000, status: "requires_action" }],
        charges: [],
      },
      events: [],
    },
    wrong: {
      finalState: { payment_intents: [], charges: [] },
      events: [],
    },
  },
  "stripe-handle-failed-payment": {
    correct: {
      finalState: {
        payment_intents: [{ id: "pi_ok", amount: 5000, status: "requires_action" }],
      },
      events: [
        ev({
          method: "POST",
          path: "/v1/payment_intents",
          status: 400,
          response_body: { error: { type: "invalid_request_error", message: "bad amount" } },
        }),
      ],
    },
    wrong: {
      finalState: { payment_intents: [] },
      events: [ev({ method: "POST", path: "/v1/payment_intents", status: 200, response_body: { id: "pi_x" } })],
    },
  },
  "stripe-reconcile-event": {
    correct: {
      finalState: {
        payment_intents: [{ id: "pi_1", amount: 10000, status: "succeeded" }],
        charges: [{ id: "ch_1", amount: 10000, status: "succeeded", payment_intent: "pi_1" }],
        balance_transactions: [{ id: "txn_1", type: "charge", source: "ch_1" }],
        events: [{ id: "evt_1", type: "payment_intent.succeeded" }],
      },
      events: [],
    },
    wrong: {
      finalState: {
        payment_intents: [{ id: "pi_1", amount: 10000, status: "requires_action" }],
        charges: [],
        balance_transactions: [],
        events: [{ id: "evt_1", type: "payment_intent.created" }],
      },
      events: [],
    },
  },
  "stripe-x402-payment-required": {
    correct: {
      finalState: { payment_intents: [{ id: "pi_1", amount: 100, status: "succeeded" }] },
      events: [
        ev({ path: "/x402/protected-resource", status: 402 }),
        ev({ path: "/x402/protected-resource", status: 200 }),
      ],
    },
    wrong: {
      finalState: { payment_intents: [{ id: "pi_1", amount: 100, status: "requires_action" }] },
      events: [ev({ path: "/x402/protected-resource", status: 402 })],
    },
  },
};

const SCENARIO_FILES: Record<string, string> = {
  "stripe-create-payment-intent": "10-stripe-create-payment-intent.md",
  "stripe-handle-failed-payment": "11-stripe-handle-failed-payment.md",
  "stripe-reconcile-event": "12-stripe-reconcile-event.md",
  "stripe-x402-payment-required": "13-stripe-x402-payment-required.md",
};

describe("golden gate — Stripe scenarios 10–13 (FDRS-646, deterministic)", () => {
  const scenarios: Record<string, Scenario> = {};

  beforeAll(async () => {
    for (const [slug, file] of Object.entries(SCENARIO_FILES)) {
      scenarios[slug] = await parseScenarioFile(join(scenariosDir, file));
    }
  });

  it("every scenario uses ONLY deterministic [D] criteria (no live LLM needed)", () => {
    for (const [slug, scenario] of Object.entries(scenarios)) {
      const pTypes = scenario.criteria.filter((c) => c.type === "P");
      expect(pTypes, `${slug} must be [D]-only for the golden gate`).toHaveLength(0);
    }
  });

  for (const slug of Object.keys(SCENARIO_FILES)) {
    describe(slug, () => {
      it("a CORRECT agent fixture scores 100 and PASSES the A5 guard", async () => {
        const scenario = scenarios[slug]!;
        const { correct } = FIXTURES[slug]!;
        const score = await evaluateScenario({
          scenario,
          initialState: {},
          finalState: correct.finalState,
          events: correct.events as never,
          stdout: "",
        });

        // Regression heart of FDRS-597: a correct agent must NOT score 0.
        expect(score.satisfaction, `${slug} correct satisfaction`).toBe(100);
        expect(score.can_pass).toBe(true);
        expect(score.evaluated).toBe(true);
        expect(scenarioPassed(score, scenario.config.passThreshold)).toBe(true);

        // Per-criterion breakdown: every criterion actually evaluated + passed.
        expect(score.results).toHaveLength(scenario.criteria.length);
        for (const r of score.results as CriterionResult[]) {
          expect(r.skipped, `criterion should not be skipped: ${r.criterion.text}`).toBe(false);
          expect(r.passed, `criterion should pass: ${r.criterion.text} — ${r.reason}`).toBe(true);
        }
        expect(score.skipped).toBe(0);
        expect(score.errored).toBe(0);
      });

      it("a WRONG agent fixture scores BELOW threshold (a real FAIL, not un-evaluated)", async () => {
        const scenario = scenarios[slug]!;
        const { wrong } = FIXTURES[slug]!;
        const score = await evaluateScenario({
          scenario,
          initialState: {},
          finalState: wrong.finalState,
          events: wrong.events as never,
          stdout: "",
        });

        expect(score.satisfaction).toBeLessThan(scenario.config.passThreshold);
        expect(scenarioPassed(score, scenario.config.passThreshold)).toBe(false);
        // Wrong-but-understood: criteria were evaluated (failed), NOT skipped —
        // so this is a genuine fail, distinct from an "un-evaluated" harness gap.
        expect(score.skipped).toBe(0);
        expect(score.errored).toBe(0);
        expect(score.evaluated).toBe(true);
      });
    });
  }
});
