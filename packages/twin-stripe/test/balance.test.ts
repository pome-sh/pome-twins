// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createStripeApp, rest } from "./_appHelper.js";

describe("Balance + balance_transactions", () => {
  it("starts empty (no charges → no balance)", async () => {
    const app = await createStripeApp();
    const balance = await rest(app, "GET", "/v1/balance");
    expect(balance.status).toBe(200);
    expect(balance.body.object).toBe("balance");
    expect(balance.body.available).toEqual([]);
    expect(balance.body.pending).toEqual([]);
  });

  it("settled PI bumps available balance and mints a balance_transaction", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_234,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    await rest(
      app,
      "POST",
      `/v1/test_helpers/payment_intents/${pi.body.id}/simulate_crypto_deposit`
    );

    const balance = await rest(app, "GET", "/v1/balance");
    expect(balance.body.available).toEqual([
      { currency: "usd", amount: 1_234, source_types: { card: 0 } },
    ]);

    const txs = await rest(app, "GET", "/v1/balance_transactions");
    expect(txs.body.data).toHaveLength(1);
    expect(txs.body.data[0]).toMatchObject({
      object: "balance_transaction",
      type: "charge",
      amount: 1_234,
      net: 1_234,
      fee: 0,
      currency: "usd",
      status: "available",
      source: pi.body.id,
    });
  });

  it("multiple settled PIs accumulate", async () => {
    const app = await createStripeApp();
    let total = 0;
    for (const amount of [100, 200, 300]) {
      const pi = await rest(app, "POST", "/v1/payment_intents", {
        amount,
        currency: "usd",
        payment_method_types: ["crypto"],
        payment_method_options: {
          crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
        },
      });
      await rest(
        app,
        "POST",
        `/v1/test_helpers/payment_intents/${pi.body.id}/simulate_crypto_deposit`
      );
      total += amount;
    }
    const balance = await rest(app, "GET", "/v1/balance");
    expect(balance.body.available[0].amount).toBe(total);
  });

  it("filters balance_transactions by type", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 50,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    await rest(
      app,
      "POST",
      `/v1/test_helpers/payment_intents/${pi.body.id}/simulate_crypto_deposit`
    );
    const charges = await rest(app, "GET", "/v1/balance_transactions?type=charge");
    expect(charges.body.data).toHaveLength(1);
    const refunds = await rest(app, "GET", "/v1/balance_transactions?type=refund");
    expect(refunds.body.data).toHaveLength(0);
  });
});
