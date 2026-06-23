// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createStripeApp, rest } from "./_appHelper.js";

describe("Events", () => {
  it("emits payment_intent.created + payment_intent.requires_action on PI create", async () => {
    const app = await createStripeApp();
    await rest(app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    const events = await rest(app, "GET", "/v1/events");
    expect(events.status).toBe(200);
    const types = events.body.data.map((e: any) => e.type);
    expect(types).toContain("payment_intent.created");
    expect(types).toContain("payment_intent.requires_action");
  });

  it("simulate_crypto_deposit emits processing, succeeded, charge.succeeded", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
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
      `/v1/test_helpers/payment_intents/${pi.body.id}/simulate_crypto_deposit`
    );
    const events = await rest(app, "GET", "/v1/events?limit=20");
    const types = events.body.data.map((e: any) => e.type);
    expect(types).toContain("payment_intent.processing");
    expect(types).toContain("payment_intent.succeeded");
    expect(types).toContain("charge.succeeded");
  });

  it("event shape matches Stripe: id, object, type, api_version, data.object", async () => {
    const app = await createStripeApp();
    await rest(app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    const events = await rest(app, "GET", "/v1/events");
    expect(events.body.data.length).toBeGreaterThan(0);
    for (const event of events.body.data) {
      expect(event.id).toMatch(/^evt_/);
      expect(event.object).toBe("event");
      expect(event.api_version).toBe("2026-03-04.preview");
      expect(typeof event.created).toBe("number");
      expect(event.livemode).toBe(false);
      expect(event.pending_webhooks).toBe(0);
      expect(event.data.object).toBeTruthy();
      expect(event.request).toEqual({ id: null, idempotency_key: null });
    }
  });

  it("retrieves a single event by id", async () => {
    const app = await createStripeApp();
    await rest(app, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    const list = await rest(app, "GET", "/v1/events");
    const id = list.body.data[0].id as string;
    const single = await rest(app, "GET", `/v1/events/${id}`);
    expect(single.status).toBe(200);
    expect(single.body.id).toBe(id);
  });

  it("filters events by type", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
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
      `/v1/test_helpers/payment_intents/${pi.body.id}/simulate_crypto_deposit`
    );
    const onlySucceeded = await rest(app, "GET", "/v1/events?type=payment_intent.succeeded");
    expect(onlySucceeded.body.data).toHaveLength(1);
    expect(onlySucceeded.body.data[0].type).toBe("payment_intent.succeeded");
  });

  it("returns 404 for an unknown event", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "GET", "/v1/events/evt_doesnotexist");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("resource_missing");
  });
});
