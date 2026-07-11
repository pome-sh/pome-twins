// SPDX-License-Identifier: Apache-2.0
//
// Card-mode PaymentIntent chain — F-731 (M5 payments hot path beyond x402).
//
// The ruled collect-payment(card) chain (F-729 list 1/3):
//   create PI with payment_method_types: ["card"] → confirm with a
//   payment_method → decline/retry via Stripe's magic test PMs → update
//   the PI with a new PM (POST /v1/payment_intents/:id) → confirm →
//   succeeded, with the same charge/balance/event side effects as the
//   crypto settle path.

import { describe, expect, it } from "vitest";
import { callTool, createStripeApp, rest } from "./_appHelper.js";

const CARD_OK = "4242424242424242";
const CARD_GENERIC_DECLINE = "4000000000000002";
const CARD_INSUFFICIENT_FUNDS = "4000000000009995";
const CARD_EXPIRED = "4000000000000069";
const CARD_INCORRECT_CVC = "4000000000000127";

async function createPM(app: Awaited<ReturnType<typeof createStripeApp>>, number: string) {
  const pm = await rest(app, "POST", "/v1/payment_methods", {
    type: "card",
    card: { number, exp_month: 12, exp_year: 2033, cvc: "123" },
  });
  expect(pm.status).toBe(200);
  return pm.body;
}

describe("card PaymentIntents — create", () => {
  it("creates a card PI without a PM in requires_payment_method", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "POST", "/v1/payment_intents", {
      amount: 5_000,
      currency: "usd",
      payment_method_types: ["card"],
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(/^pi_/);
    expect(r.body.status).toBe("requires_payment_method");
    expect(r.body.payment_method_types).toEqual(["card"]);
    expect(r.body.payment_method).toBeNull();
    expect(r.body.next_action).toBeNull();
    // No x402 crypto rail on a card PI.
    expect(r.body.payment_method_options.crypto).toBeUndefined();
    expect(r.body.payment_method_options.card).toBeTruthy();

    const events = await rest(app, "GET", "/v1/events");
    const types = events.body.data.map((e: any) => e.type);
    expect(types).toContain("payment_intent.created");
    // requires_action is the crypto deposit rail; card PIs must not emit it.
    expect(types).not.toContain("payment_intent.requires_action");
  });

  it("creates a card PI with an existing PM in requires_confirmation", async () => {
    const app = await createStripeApp();
    const pm = await createPM(app, CARD_OK);
    const r = await rest(app, "POST", "/v1/payment_intents", {
      amount: 5_000,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: pm.id,
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("requires_confirmation");
    expect(r.body.payment_method).toBe(pm.id);
  });

  it("creates and confirms in one call with confirm: true", async () => {
    const app = await createStripeApp();
    const pm = await createPM(app, CARD_OK);
    const r = await rest(app, "POST", "/v1/payment_intents", {
      amount: 7_500,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: pm.id,
      confirm: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("succeeded");
    expect(r.body.amount_received).toBe(7_500);
    expect(r.body.latest_charge).toMatch(/^ch_/);
  });

  it("echoes a live customer on the card PI", async () => {
    const app = await createStripeApp();
    const customer = await rest(app, "POST", "/v1/customers", { name: "Card Buyer" });
    const pm = await createPM(app, CARD_OK);
    await rest(app, "POST", `/v1/payment_methods/${pm.id}/attach`, {
      customer: customer.body.id,
    });
    const r = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card"],
      customer: customer.body.id,
      payment_method: pm.id,
    });
    expect(r.status).toBe(200);
    expect(r.body.customer).toBe(customer.body.id);
    expect(r.body.status).toBe("requires_confirmation");
  });

  it("rejects a PM attached to a different customer", async () => {
    const app = await createStripeApp();
    const owner = await rest(app, "POST", "/v1/customers", { name: "Owner" });
    const other = await rest(app, "POST", "/v1/customers", { name: "Other" });
    const pm = await createPM(app, CARD_OK);
    await rest(app, "POST", `/v1/payment_methods/${pm.id}/attach`, {
      customer: owner.body.id,
    });
    const r = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card"],
      customer: other.body.id,
      payment_method: pm.id,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe("invalid_request_error");
  });

  it("rejects crypto payment_method_options on a card PI", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    expect(r.status).toBe(400);
  });

  it("rejects multi-type and unknown payment_method_types", async () => {
    const app = await createStripeApp();
    const multi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card", "crypto"],
    });
    expect(multi.status).toBe(400);
    const unknown = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["paypal"],
    });
    expect(unknown.status).toBe(400);
  });

  it("keeps the usd-only currency rule for card PIs", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "eur",
      payment_method_types: ["card"],
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("currency_not_supported");
  });
});

describe("card PaymentIntents — confirm", () => {
  it("confirm with a good card settles synchronously with full side effects", async () => {
    const app = await createStripeApp();
    const pm = await createPM(app, CARD_OK);
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 2_000,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: pm.id,
    });
    const confirm = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`);
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("succeeded");
    expect(confirm.body.latest_charge).toMatch(/^ch_/);
    expect(confirm.body.last_payment_error).toBeNull();

    // Charge is card-shaped, paid, captured.
    const charge = await rest(app, "GET", `/v1/charges/${confirm.body.latest_charge}`);
    expect(charge.body.paid).toBe(true);
    expect(charge.body.status).toBe("succeeded");
    expect(charge.body.payment_method).toBe(pm.id);
    expect(charge.body.payment_method_details.type).toBe("card");
    expect(charge.body.payment_method_details.card.brand).toBe("visa");
    expect(charge.body.payment_method_details.card.last4).toBe("4242");

    // Balance reflects the capture.
    const balance = await rest(app, "GET", "/v1/balance");
    const usd = balance.body.available.find((b: any) => b.currency === "usd");
    expect(usd.amount).toBe(2_000);

    // Events: succeeded pair emitted.
    const events = await rest(app, "GET", "/v1/events");
    const types = events.body.data.map((e: any) => e.type);
    expect(types).toContain("payment_intent.succeeded");
    expect(types).toContain("charge.succeeded");
  });

  it("confirm accepts a payment_method in the body from requires_payment_method", async () => {
    const app = await createStripeApp();
    const pm = await createPM(app, CARD_OK);
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 3_000,
      currency: "usd",
      payment_method_types: ["card"],
    });
    expect(pi.body.status).toBe("requires_payment_method");
    const confirm = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`, {
      payment_method: pm.id,
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("succeeded");
    expect(confirm.body.payment_method).toBe(pm.id);
  });

  it("confirm without any PM fails loudly", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 3_000,
      currency: "usd",
      payment_method_types: ["card"],
    });
    const confirm = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`);
    expect(confirm.status).toBe(400);
    expect(confirm.body.error.code).toBe("payment_intent_unexpected_state");
  });

  it("confirm on a succeeded card PI is refused (unlike the crypto no-op)", async () => {
    const app = await createStripeApp();
    const pm = await createPM(app, CARD_OK);
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: pm.id,
      confirm: true,
    });
    expect(pi.body.status).toBe("succeeded");
    const again = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("payment_intent_unexpected_state");
  });

  it("exactly one of N parallel card confirms wins", async () => {
    const app = await createStripeApp();
    const pm = await createPM(app, CARD_OK);
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 4_000,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: pm.id,
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`)
      )
    );
    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status === 400);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);

    const charges = await rest(app, "GET", `/v1/charges?payment_intent=${pi.body.id}`);
    expect(charges.body.data).toHaveLength(1);
  });
});

describe("card PaymentIntents — decline + retry (magic test PMs)", () => {
  const DECLINES: Array<[string, string, string, string]> = [
    // [card number, error code, decline_code, label]
    [CARD_GENERIC_DECLINE, "card_declined", "generic_decline", "generic decline"],
    [CARD_INSUFFICIENT_FUNDS, "card_declined", "insufficient_funds", "insufficient funds"],
    [CARD_EXPIRED, "expired_card", "expired_card", "expired card"],
    [CARD_INCORRECT_CVC, "incorrect_cvc", "incorrect_cvc", "incorrect cvc"],
  ];

  for (const [number, code, declineCode, label] of DECLINES) {
    it(`declines ${label} with a 402 card_error`, async () => {
      const app = await createStripeApp();
      const pm = await createPM(app, number);
      const pi = await rest(app, "POST", "/v1/payment_intents", {
        amount: 2_000,
        currency: "usd",
        payment_method_types: ["card"],
        payment_method: pm.id,
      });
      const confirm = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`);
      expect(confirm.status).toBe(402);
      expect(confirm.body.error.type).toBe("card_error");
      expect(confirm.body.error.code).toBe(code);
      expect(confirm.body.error.decline_code).toBe(declineCode);
      // The envelope embeds the post-attempt PI, like real Stripe.
      expect(confirm.body.error.payment_intent.id).toBe(pi.body.id);
      expect(confirm.body.error.payment_intent.status).toBe("requires_payment_method");
    });
  }

  it("a failed attempt records last_payment_error, a failed charge, and no balance", async () => {
    const app = await createStripeApp();
    const pm = await createPM(app, CARD_GENERIC_DECLINE);
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 2_500,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: pm.id,
    });
    await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`);

    const after = await rest(app, "GET", `/v1/payment_intents/${pi.body.id}`);
    expect(after.body.status).toBe("requires_payment_method");
    expect(after.body.last_payment_error.code).toBe("card_declined");
    expect(after.body.last_payment_error.decline_code).toBe("generic_decline");
    expect(after.body.last_payment_error.type).toBe("card_error");
    expect(after.body.latest_charge).toMatch(/^ch_/);

    // The failed charge is on the record, unpaid, with an issuer_declined outcome.
    const charge = await rest(app, "GET", `/v1/charges/${after.body.latest_charge}`);
    expect(charge.body.status).toBe("failed");
    expect(charge.body.paid).toBe(false);
    expect(charge.body.captured).toBe(false);
    expect(charge.body.failure_code).toBe("card_declined");
    expect(charge.body.outcome.type).toBe("issuer_declined");
    expect(charge.body.outcome.network_status).toBe("declined_by_network");

    // No money moved.
    const balance = await rest(app, "GET", "/v1/balance");
    const usd = balance.body.available.find((b: any) => b.currency === "usd");
    expect(usd?.amount ?? 0).toBe(0);

    // Failure events emitted.
    const events = await rest(app, "GET", "/v1/events");
    const types = events.body.data.map((e: any) => e.type);
    expect(types).toContain("payment_intent.payment_failed");
    expect(types).toContain("charge.failed");
  });

  it("retry-with-new-PM: decline → update PI with new PM → confirm → succeeded", async () => {
    const app = await createStripeApp();
    const badPm = await createPM(app, CARD_INSUFFICIENT_FUNDS);
    const goodPm = await createPM(app, CARD_OK);
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 9_000,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: badPm.id,
    });

    const declined = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`);
    expect(declined.status).toBe(402);

    // The ruled retry step: POST /v1/payment_intents/:id with the new PM.
    const updated = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}`, {
      payment_method: goodPm.id,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe("requires_confirmation");
    expect(updated.body.payment_method).toBe(goodPm.id);

    const confirm = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`);
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("succeeded");
    expect(confirm.body.last_payment_error).toBeNull();

    // Exactly one failed + one succeeded charge on the PI.
    const charges = await rest(app, "GET", `/v1/charges?payment_intent=${pi.body.id}`);
    const statuses = charges.body.data.map((ch: any) => ch.status).sort();
    expect(statuses).toEqual(["failed", "succeeded"]);
  });
});

describe("card PaymentIntents — update (POST /v1/payment_intents/:id)", () => {
  it("updates amount and merges metadata per-key", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card"],
      metadata: { order: "o_1", keep: "yes" },
    });
    const updated = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}`, {
      amount: 1_250,
      metadata: { order: "", note: "retry" },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.amount).toBe(1_250);
    expect(updated.body.metadata).toEqual({ keep: "yes", note: "retry" });
  });

  it("rejects update once the PI is terminal", async () => {
    const app = await createStripeApp();
    const pm = await createPM(app, CARD_OK);
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: pm.id,
      confirm: true,
    });
    expect(pi.body.status).toBe("succeeded");
    const updated = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}`, {
      amount: 2_000,
    });
    expect(updated.status).toBe(400);
    expect(updated.body.error.code).toBe("payment_intent_unexpected_state");
  });

  it("404s on an unknown payment_method", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card"],
    });
    const updated = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}`, {
      payment_method: "pm_doesnotexist",
    });
    expect(updated.status).toBe(404);
    expect(updated.body.error.code).toBe("resource_missing");
  });

  it("allows metadata-only updates on a crypto PI but refuses a payment_method", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    const meta = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}`, {
      metadata: { tag: "x402" },
    });
    expect(meta.status).toBe(200);
    expect(meta.body.metadata.tag).toBe("x402");

    const pm = await createPM(app, CARD_OK);
    const swap = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}`, {
      payment_method: pm.id,
    });
    expect(swap.status).toBe(400);
  });

  it("cancel still works from card states", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card"],
    });
    const cancel = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("canceled");
  });
});

describe("card PaymentIntents — review hardening (F-731)", () => {
  it("refuses to refund a failed charge", async () => {
    const app = await createStripeApp();
    const pm = await createPM(app, CARD_GENERIC_DECLINE);
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 2_000,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: pm.id,
    });
    await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`);
    const after = await rest(app, "GET", `/v1/payment_intents/${pi.body.id}`);
    const failedCharge = after.body.latest_charge;

    const refund = await rest(app, "POST", "/v1/refunds", { charge: failedCharge });
    expect(refund.status).toBe(400);
    expect(refund.body.error.code).toBe("charge_not_refundable");
  });

  it("records a declined confirm as a mutation with a state_delta", async () => {
    const app = await createStripeApp();
    const pm = await createPM(app, CARD_GENERIC_DECLINE);
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 2_000,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: pm.id,
    });
    const confirm = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`);
    expect(confirm.status).toBe(402);

    const events = await rest(app, "GET", "/_pome/events");
    const recorded = (events.body as Array<Record<string, unknown>>).find(
      (e) =>
        e.method === "POST" &&
        typeof e.path === "string" &&
        (e.path as string).endsWith(`/v1/payment_intents/${pi.body.id}/confirm`)
    );
    expect(recorded).toBeDefined();
    expect(recorded!.status).toBe(402);
    // The decline committed a failed charge + PI transition; the recorder
    // must not log it as a non-mutation.
    expect(recorded!.state_mutation).toBe(true);
    const delta = recorded!.state_delta as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(delta.before.status).toBe("requires_confirmation");
    expect(delta.after.status).toBe("requires_payment_method");
  });

  it("refuses amount updates on a crypto PI (x402 challenge stays consistent)", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 10_000,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    const update = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}`, {
      amount: 1,
    });
    expect(update.status).toBe(400);
    const fresh = await rest(app, "GET", `/v1/payment_intents/${pi.body.id}`);
    expect(fresh.body.amount).toBe(10_000);
  });

  it("loudly rejects card-only params on crypto create instead of dropping them", async () => {
    const app = await createStripeApp();
    const customer = await rest(app, "POST", "/v1/customers", { name: "Crypto Buyer" });
    const r = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
      customer: customer.body.id,
    });
    expect(r.status).toBe(400);
  });

  it("re-validates the attached PM when update changes only the customer", async () => {
    const app = await createStripeApp();
    const owner = await rest(app, "POST", "/v1/customers", { name: "Owner" });
    const other = await rest(app, "POST", "/v1/customers", { name: "Other" });
    const pm = await createPM(app, CARD_OK);
    await rest(app, "POST", `/v1/payment_methods/${pm.id}/attach`, {
      customer: owner.body.id,
    });
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card"],
      customer: owner.body.id,
      payment_method: pm.id,
    });
    const update = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}`, {
      customer: other.body.id,
    });
    expect(update.status).toBe(400);
    expect(update.body.error.code).toBe("payment_method_customer_mismatch");
  });

  it("treats an empty payment_method param on confirm as absent", async () => {
    const app = await createStripeApp();
    const pm = await createPM(app, CARD_OK);
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: pm.id,
    });
    const confirm = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`, {
      payment_method: "",
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("succeeded");
  });

  it("charges inherit the PI's customer and the customer filter works (Greptile P1)", async () => {
    const app = await createStripeApp();
    const customer = await rest(app, "POST", "/v1/customers", { name: "Charge Owner" });
    const pm = await createPM(app, CARD_OK);
    await rest(app, "POST", `/v1/payment_methods/${pm.id}/attach`, {
      customer: customer.body.id,
    });
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 3_000,
      currency: "usd",
      payment_method_types: ["card"],
      customer: customer.body.id,
      payment_method: pm.id,
      confirm: true,
    });
    expect(pi.body.status).toBe("succeeded");

    // The settled charge is attributable to the customer.
    const charge = await rest(app, "GET", `/v1/charges/${pi.body.latest_charge}`);
    expect(charge.body.customer).toBe(customer.body.id);

    // A customer-less crypto settle for contrast, then filter by customer.
    const cryptoPi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 500,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    await rest(
      app,
      "POST",
      `/v1/test_helpers/payment_intents/${cryptoPi.body.id}/simulate_crypto_deposit`
    );
    const all = await rest(app, "GET", "/v1/charges");
    expect(all.body.data).toHaveLength(2);
    const filtered = await rest(app, "GET", `/v1/charges?customer=${customer.body.id}`);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].id).toBe(pi.body.latest_charge);
  });

  it("a declined attempt's failed charge also carries the customer (Greptile P1)", async () => {
    const app = await createStripeApp();
    const customer = await rest(app, "POST", "/v1/customers", { name: "Decline Owner" });
    const pm = await createPM(app, CARD_GENERIC_DECLINE);
    await rest(app, "POST", `/v1/payment_methods/${pm.id}/attach`, {
      customer: customer.body.id,
    });
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 2_000,
      currency: "usd",
      payment_method_types: ["card"],
      customer: customer.body.id,
      payment_method: pm.id,
    });
    await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`);

    const after = await rest(app, "GET", `/v1/payment_intents/${pi.body.id}`);
    const charge = await rest(app, "GET", `/v1/charges/${after.body.latest_charge}`);
    expect(charge.body.status).toBe("failed");
    expect(charge.body.customer).toBe(customer.body.id);
  });

  it("confirm: true without a payment_method fails before any PI is created", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1_000,
      currency: "usd",
      payment_method_types: ["card"],
      confirm: true,
    });
    expect(r.status).toBe(400);
    const list = await rest(app, "GET", "/v1/payment_intents");
    expect(list.body.data).toHaveLength(0);
  });
});

describe("card PaymentIntents — MCP tools", () => {
  it("update_payment_intent tool drives the retry chain end-to-end", async () => {
    const app = await createStripeApp();
    const badPm = await callTool(app, "create_payment_method", {
      type: "card",
      card: { number: CARD_GENERIC_DECLINE, exp_month: 12, exp_year: 2033 },
    });
    const goodPm = await callTool(app, "create_payment_method", {
      type: "card",
      card: { number: CARD_OK, exp_month: 12, exp_year: 2033 },
    });
    const pi = await callTool(app, "create_payment_intent", {
      amount: 6_000,
      currency: "usd",
      payment_method_types: ["card"],
      payment_method: badPm.body.id,
    });
    expect(pi.status).toBe(200);

    const declined = await callTool(app, "confirm_payment_intent", { id: pi.body.id });
    expect(declined.status).toBe(402);
    expect(declined.body.error.code).toBe("card_declined");

    const updated = await callTool(app, "update_payment_intent", {
      id: pi.body.id,
      payment_method: goodPm.body.id,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe("requires_confirmation");

    const confirmed = await callTool(app, "confirm_payment_intent", { id: pi.body.id });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("succeeded");
  });
});
