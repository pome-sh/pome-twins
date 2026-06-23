// SPDX-License-Identifier: Apache-2.0
//
// The "exactly one of N parallel writers wins" concurrency test (FDRS-270 / D-ENG-3).
// This is the load-bearing assertion for AGENT-B's CAS implementation. If it fails,
// the state machine has a race that will silently double-debit the
// balance and double-fire `payment_intent.succeeded` in production.

import { describe, expect, it } from "vitest";
import { createStripeApp, rest } from "./_appHelper.js";

describe("PaymentIntents — concurrency (CAS)", () => {
  it("8 parallel simulate_crypto_deposit calls: exactly 1 wins, 7 see 409-style 400", async () => {
    const app = await createStripeApp();
    const created = await rest(app, "POST", "/v1/payment_intents", {
      amount: 4_200,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    expect(created.status).toBe(200);
    const piId = created.body.id as string;

    const calls = Array.from({ length: 8 }, () =>
      rest(app, "POST", `/v1/test_helpers/payment_intents/${piId}/simulate_crypto_deposit`)
    );
    const results = await Promise.all(calls);
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);

    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 400);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    expect(statuses).toEqual([200, 400, 400, 400, 400, 400, 400, 400]);

    // Every loser must surface the canonical Stripe-shaped error code.
    for (const loser of losers) {
      expect(loser.body.error.type).toBe("invalid_request_error");
      expect(loser.body.error.code).toBe("payment_intent_unexpected_state");
    }

    // The winner must report the PI as succeeded.
    expect(winners[0]!.body.status).toBe("succeeded");
    expect(winners[0]!.body.latest_charge).toMatch(/^ch_/);

    // Exactly one charge for this PI.
    const charges = await rest(app, "GET", `/v1/charges?payment_intent=${piId}`);
    expect(charges.status).toBe(200);
    expect(charges.body.data).toHaveLength(1);
    expect(charges.body.data[0].payment_intent).toBe(piId);

    // Exactly one balance transaction; balance reflects exactly the PI
    // amount (not 8x).
    const txs = await rest(app, "GET", "/v1/balance_transactions");
    expect(txs.status).toBe(200);
    const piTxs = txs.body.data.filter((tx: any) => tx.source === piId);
    expect(piTxs).toHaveLength(1);
    expect(piTxs[0].amount).toBe(4_200);
    expect(piTxs[0].net).toBe(4_200);

    const balance = await rest(app, "GET", "/v1/balance");
    expect(balance.status).toBe(200);
    const usd = balance.body.available.find((row: any) => row.currency === "usd");
    expect(usd.amount).toBe(4_200);
  });

  it("4 parallel cancel calls on a fresh PI: exactly 1 wins, 3 see canceled idempotent return", async () => {
    // Cancel is intentionally idempotent if already canceled, so this
    // test asserts that re-cancels return 200 with the canceled state
    // rather than 400.
    const app = await createStripeApp();
    const created = await rest(app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    const piId = created.body.id as string;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        rest(app, "POST", `/v1/payment_intents/${piId}/cancel`)
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => r.body.status === "canceled")).toBe(true);
  });
});
