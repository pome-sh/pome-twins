// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { callTool, createStripeApp, rest } from "./_appHelper.js";

describe("PaymentIntents — state machine + happy paths", () => {
  it("creates a crypto-deposit PI in requires_action with full next_action", async () => {
    const app = await createStripeApp();
    const create = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_500,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });

    expect(create.status).toBe(200);
    expect(create.body.id).toMatch(/^pi_/);
    expect(create.body.object).toBe("payment_intent");
    expect(create.body.status).toBe("requires_action");
    expect(create.body.amount).toBe(1_500);
    expect(create.body.currency).toBe("usd");
    expect(create.body.client_secret).toMatch(/^pi_[A-Za-z0-9]+_secret_/);

    const next = create.body.next_action;
    expect(next.type).toBe("display_crypto_deposit_information");
    const base = next.crypto_display_details.deposit_addresses.base;
    expect(base.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(base.supported_tokens[0].token_currency).toBe("usdc");
    expect(base.supported_tokens[0].token_contract_address).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    );
  });

  it("retrieves a PI by id", async () => {
    const app = await createStripeApp();
    const created = await rest(app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    const fetch = await rest(app, "GET", `/v1/payment_intents/${created.body.id}`);
    expect(fetch.status).toBe(200);
    expect(fetch.body.id).toBe(created.body.id);
  });

  it("lists PIs in Stripe-shape with has_more", async () => {
    const app = await createStripeApp();
    for (let i = 0; i < 3; i++) {
      await callTool(app, "create_payment_intent", {
        amount: 100 + i,
        currency: "usd",
        payment_method_types: ["crypto"],
        payment_method_options: {
          crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
        },
      });
    }
    const list = await rest(app, "GET", "/v1/payment_intents?limit=2");
    expect(list.status).toBe(200);
    expect(list.body.object).toBe("list");
    expect(list.body.data).toHaveLength(2);
    expect(list.body.has_more).toBe(true);
    expect(list.body.url).toBe("/v1/payment_intents");
  });

  it("paginates PIs with starting_after and ending_before cursors", async () => {
    const app = await createStripeApp();
    for (let i = 0; i < 3; i++) {
      await callTool(app, "create_payment_intent", {
        amount: 100 + i,
        currency: "usd",
        payment_method_types: ["crypto"],
        payment_method_options: {
          crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
        },
      });
    }

    const firstPage = await rest(app, "GET", "/v1/payment_intents?limit=2");
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data).toHaveLength(2);

    const cursor = firstPage.body.data[1].id;
    const secondPage = await rest(app, "GET", `/v1/payment_intents?limit=2&starting_after=${cursor}`);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.data[0].id).not.toBe(firstPage.body.data[0].id);
    expect(secondPage.body.data[0].id).not.toBe(firstPage.body.data[1].id);
    expect(secondPage.body.has_more).toBe(false);

    const previousPage = await rest(app, "GET", `/v1/payment_intents?limit=2&ending_before=${secondPage.body.data[0].id}`);
    expect(previousPage.status).toBe(200);
    expect(previousPage.body.data.map((pi: { id: string }) => pi.id)).toEqual(
      firstPage.body.data.map((pi: { id: string }) => pi.id)
    );
  });

  it("confirm is idempotent for crypto-deposit PIs", async () => {
    const app = await createStripeApp();
    const created = await rest(app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    const confirm1 = await rest(app, "POST", `/v1/payment_intents/${created.body.id}/confirm`);
    const confirm2 = await rest(app, "POST", `/v1/payment_intents/${created.body.id}/confirm`);
    expect(confirm1.status).toBe(200);
    expect(confirm2.status).toBe(200);
    expect(confirm1.body.status).toBe("requires_action");
    expect(confirm2.body.status).toBe("requires_action");
  });

  it("cancel transitions requires_action → canceled and emits event", async () => {
    const app = await createStripeApp();
    const created = await rest(app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    const cancel = await rest(app, "POST", `/v1/payment_intents/${created.body.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("canceled");
    expect(cancel.body.canceled_at).toBeTypeOf("number");

    const events = await rest(app, "GET", "/v1/events");
    const types = events.body.data.map((e: any) => e.type);
    expect(types).toContain("payment_intent.canceled");
  });

  it("simulate_crypto_deposit drives PI through processing → succeeded", async () => {
    const app = await createStripeApp();
    const created = await rest(app, "POST", "/v1/payment_intents", {
      amount: 250,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });

    const settle = await rest(
      app,
      "POST",
      `/v1/test_helpers/payment_intents/${created.body.id}/simulate_crypto_deposit`
    );
    expect(settle.status).toBe(200);
    expect(settle.body.status).toBe("succeeded");
    expect(settle.body.latest_charge).toMatch(/^ch_/);

    const events = await rest(app, "GET", "/v1/events");
    const types = events.body.data.map((e: any) => e.type).sort();
    expect(types).toContain("payment_intent.processing");
    expect(types).toContain("payment_intent.succeeded");
    expect(types).toContain("charge.succeeded");
  });

  it("rejects simulate_crypto_deposit on a succeeded PI with 400", async () => {
    const app = await createStripeApp();
    const created = await rest(app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    await rest(
      app,
      "POST",
      `/v1/test_helpers/payment_intents/${created.body.id}/simulate_crypto_deposit`
    );
    const second = await rest(
      app,
      "POST",
      `/v1/test_helpers/payment_intents/${created.body.id}/simulate_crypto_deposit`
    );
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("payment_intent_unexpected_state");
  });

  it("rejects cancel on a succeeded PI with 400", async () => {
    const app = await createStripeApp();
    const created = await rest(app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    await rest(
      app,
      "POST",
      `/v1/test_helpers/payment_intents/${created.body.id}/simulate_crypto_deposit`
    );
    const cancel = await rest(app, "POST", `/v1/payment_intents/${created.body.id}/cancel`);
    expect(cancel.status).toBe(400);
    expect(cancel.body.error.code).toBe("payment_intent_unexpected_state");
  });

  it("create rejects unsupported currency with Stripe-shaped error", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "eur",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe("invalid_request_error");
    expect(r.body.error.code).toBe("currency_not_supported");
  });

  it("create rejects card payment_method_types loudly", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("parameter_invalid_string");
  });

  it("retrieve returns 404 for missing PI", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "GET", "/v1/payment_intents/pi_doesnotexist");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("resource_missing");
  });
});
