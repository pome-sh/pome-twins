// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createStripeApp, rest } from "./_appHelper.js";

describe("Charges — read-only routes", () => {
  it("retrieves a charge minted by simulate_crypto_deposit", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 750,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    const settle = await rest(
      app,
      "POST",
      `/v1/test_helpers/payment_intents/${pi.body.id}/simulate_crypto_deposit`
    );
    const chargeId = settle.body.latest_charge as string;
    expect(chargeId).toMatch(/^ch_/);

    const charge = await rest(app, "GET", `/v1/charges/${chargeId}`);
    expect(charge.status).toBe(200);
    expect(charge.body).toMatchObject({
      object: "charge",
      id: chargeId,
      amount: 750,
      amount_captured: 750,
      amount_refunded: 0,
      captured: true,
      status: "succeeded",
      paid: true,
      payment_intent: pi.body.id,
    });
    expect(charge.body.balance_transaction).toMatch(/^txn_/);
    expect(charge.body.payment_method_details).toMatchObject({
      type: "crypto",
      crypto: { network: "base", token_currency: "usdc" },
    });
  });

  it("returns 404 for an unknown charge", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "GET", "/v1/charges/ch_doesnotexist");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("resource_missing");
  });

  it("lists charges, filters by payment_intent", async () => {
    const app = await createStripeApp();
    const piA = await createAndSettle(app, 100);
    const piB = await createAndSettle(app, 200);

    const all = await rest(app, "GET", "/v1/charges");
    expect(all.status).toBe(200);
    expect(all.body.object).toBe("list");
    expect(all.body.data).toHaveLength(2);

    const onlyA = await rest(app, "GET", `/v1/charges?payment_intent=${piA.id}`);
    expect(onlyA.body.data).toHaveLength(1);
    expect(onlyA.body.data[0].payment_intent).toBe(piA.id);

    const onlyB = await rest(app, "GET", `/v1/charges?payment_intent=${piB.id}`);
    expect(onlyB.body.data).toHaveLength(1);
    expect(onlyB.body.data[0].payment_intent).toBe(piB.id);
  });

  it("respects limit + has_more", async () => {
    const app = await createStripeApp();
    for (let i = 0; i < 3; i++) await createAndSettle(app, 10 + i);
    const list = await rest(app, "GET", "/v1/charges?limit=2");
    expect(list.body.data).toHaveLength(2);
    expect(list.body.has_more).toBe(true);
  });
});

async function createAndSettle(
  app: Awaited<ReturnType<typeof createStripeApp>>,
  amount: number
) {
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
  return { id: pi.body.id as string };
}
