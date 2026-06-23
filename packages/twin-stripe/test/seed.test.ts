// SPDX-License-Identifier: Apache-2.0
//
// FDRS-364: the seed schema must accept payment_intents / charges / refunds /
// balance_transactions so scenarios can establish prerequisite state before
// the agent runs. Without this, scenario 14's `pi_test_200` + `ch_test_200`
// seed block is silently dropped by zod (default strip mode), the agent has
// no charge to refund, and the evaluator reports `state.refunds.length: 0`.
//
// The seed → DB → readback path mirrors what `/_pome/state` surfaces to the
// cloud evaluator, so a green test here is the unit-level equivalent of
// `pome run --hosted scenarios/14-stripe-refund-retry.md` showing the seeded
// rows in `state-before.json`. The full live-flow check is cross-repo
// (CLI at `cli/` + cloud + scenario file at `cli/scenarios/`) and is verified separately.

import { describe, expect, it } from "vitest";
import { openTwinStripeDatabase } from "../src/db.js";
import { StripeDomain } from "../src/domain/index.js";
import { applySeed, parseSeed } from "../src/seed.js";

// Scenario 14 prerequisite state: one settled PI + its charge + the
// matching balance transaction. No refunds yet — the agent flow is what
// produces them.
const SCENARIO_14_SEED = {
  api_keys: [
    { key: "sk_test_pome_default", sid: "default", account_id: "acct_default" },
  ],
  payment_intents: [
    {
      id: "pi_test_200",
      account_id: "acct_default",
      amount: 20000,
      currency: "usd",
      status: "succeeded",
      payment_method_types: ["crypto"],
      latest_charge_id: "ch_test_200",
      client_secret: "pi_test_200_secret_test",
      created: 1700000000,
      updated: 1700000000,
      captured_at: 1700000000,
    },
  ],
  charges: [
    {
      id: "ch_test_200",
      account_id: "acct_default",
      payment_intent_id: "pi_test_200",
      amount: 20000,
      amount_captured: 20000,
      amount_refunded: 0,
      status: "succeeded",
      balance_transaction_id: "txn_test_200",
      captured: true,
      currency: "usd",
      created: 1700000000,
    },
  ],
  balance_transactions: [
    {
      id: "txn_test_200",
      account_id: "acct_default",
      type: "charge",
      amount: 20000,
      fee: 0,
      net: 20000,
      currency: "usd",
      source_id: "ch_test_200",
      source_type: "charge",
      available_on: 1700000000,
      status: "available",
      created: 1700000000,
    },
  ],
  refunds: [],
} as const;

describe("seed: payment_intents / charges / refunds / balance_transactions (FDRS-364)", () => {
  it("parseSeed preserves the new top-level arrays (no silent strip)", () => {
    const parsed = parseSeed(SCENARIO_14_SEED) as {
      payment_intents?: Array<{ id: string }>;
      charges?: Array<{ id: string }>;
      refunds?: unknown[];
      balance_transactions?: Array<{ id: string }>;
    };
    expect(parsed.payment_intents).toHaveLength(1);
    expect(parsed.payment_intents?.[0]?.id).toBe("pi_test_200");
    expect(parsed.charges).toHaveLength(1);
    expect(parsed.charges?.[0]?.id).toBe("ch_test_200");
    expect(parsed.balance_transactions).toHaveLength(1);
    expect(parsed.balance_transactions?.[0]?.id).toBe("txn_test_200");
    expect(parsed.refunds).toEqual([]);
  });

  it("parseSeed defaults missing collections to empty arrays (backward compat)", () => {
    const parsed = parseSeed({}) as {
      payment_intents?: unknown[];
      charges?: unknown[];
      refunds?: unknown[];
      balance_transactions?: unknown[];
    };
    expect(parsed.payment_intents ?? []).toEqual([]);
    expect(parsed.charges ?? []).toEqual([]);
    expect(parsed.refunds ?? []).toEqual([]);
    expect(parsed.balance_transactions ?? []).toEqual([]);
  });

  it("applySeed writes payment_intents readable via PaymentIntentsDomain.requireById", () => {
    const db = openTwinStripeDatabase(":memory:");
    const domain = new StripeDomain(db);
    applySeed(db, parseSeed(SCENARIO_14_SEED));
    const pi = domain.paymentIntents.requireById("acct_default", "pi_test_200");
    expect(pi).toMatchObject({
      id: "pi_test_200",
      account_id: "acct_default",
      amount: 20000,
      currency: "usd",
      status: "succeeded",
      latest_charge_id: "ch_test_200",
      client_secret: "pi_test_200_secret_test",
      created: 1700000000,
      updated: 1700000000,
      captured_at: 1700000000,
    });
  });

  it("applySeed writes charges readable via ChargesDomain.requireById", () => {
    const db = openTwinStripeDatabase(":memory:");
    const domain = new StripeDomain(db);
    applySeed(db, parseSeed(SCENARIO_14_SEED));
    const ch = domain.charges.requireById("acct_default", "ch_test_200");
    expect(ch).toMatchObject({
      id: "ch_test_200",
      account_id: "acct_default",
      payment_intent_id: "pi_test_200",
      amount: 20000,
      amount_captured: 20000,
      amount_refunded: 0,
      status: "succeeded",
      balance_transaction_id: "txn_test_200",
      currency: "usd",
      created: 1700000000,
    });
    // captured is stored as 0|1 in the row
    expect(ch.captured).toBe(1);
  });

  it("applySeed writes balance_transactions readable via BalanceDomain.requireById", () => {
    const db = openTwinStripeDatabase(":memory:");
    const domain = new StripeDomain(db);
    applySeed(db, parseSeed(SCENARIO_14_SEED));
    const tx = domain.balance.requireById("acct_default", "txn_test_200");
    expect(tx).toMatchObject({
      id: "txn_test_200",
      account_id: "acct_default",
      type: "charge",
      amount: 20000,
      fee: 0,
      net: 20000,
      currency: "usd",
      source_id: "ch_test_200",
      source_type: "charge",
      available_on: 1700000000,
      status: "available",
      created: 1700000000,
    });
  });

  it("a seeded charge is indistinguishable from an agent-created one — refund flow works", () => {
    // This is the load-bearing assertion: scenario 14's agent flow must be
    // able to POST /v1/refunds against the seeded ch_test_200 and have the
    // refunds domain accept it. If `applySeed` left the charge in any way
    // different from what `simulateCryptoDeposit` produces, refund creation
    // would 404 or 400 here.
    const db = openTwinStripeDatabase(":memory:");
    const domain = new StripeDomain(db);
    applySeed(db, parseSeed(SCENARIO_14_SEED));
    const { row, charge } = domain.refunds.create("acct_default", {
      charge: "ch_test_200",
      amount: 7500,
    });
    expect(row.amount).toBe(7500);
    expect(row.charge_id).toBe("ch_test_200");
    expect(row.payment_intent_id).toBe("pi_test_200");
    expect(row.status).toBe("succeeded");
    expect(charge.amount_refunded).toBe(7500);
  });

  it("exportState surfaces seeded rows so /_pome/state matches what the evaluator reads", () => {
    const db = openTwinStripeDatabase(":memory:");
    const domain = new StripeDomain(db);
    applySeed(db, parseSeed(SCENARIO_14_SEED));
    const state = domain.exportState("acct_default") as {
      payment_intents: Array<{ id: string }>;
      charges: Array<{ id: string }>;
      balance_transactions: Array<{ id: string }>;
      refunds: unknown[];
    };
    expect(state.payment_intents.map((p) => p.id)).toEqual(["pi_test_200"]);
    expect(state.charges.map((c) => c.id)).toEqual(["ch_test_200"]);
    expect(state.balance_transactions.map((b) => b.id)).toEqual(["txn_test_200"]);
    expect(state.refunds).toEqual([]);
  });

  it("seed without the new collections leaves the twin empty (default-seed behavior unchanged)", () => {
    const db = openTwinStripeDatabase(":memory:");
    const domain = new StripeDomain(db);
    applySeed(db, parseSeed({ api_keys: [], failure_injection: [] }));
    const state = domain.exportState("acct_default") as {
      payment_intents: unknown[];
      charges: unknown[];
      balance_transactions: unknown[];
      refunds: unknown[];
    };
    expect(state.payment_intents).toEqual([]);
    expect(state.charges).toEqual([]);
    expect(state.balance_transactions).toEqual([]);
    expect(state.refunds).toEqual([]);
  });
});
