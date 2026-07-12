// SPDX-License-Identifier: Apache-2.0
//
// Payment methods — F-732 (M5 card-on-file chain, ruled F-729).
// Semantic tier: create card PMs (test card numbers → brand/last4, PAN never
// stored), retrieve, attach/detach lifecycle against customers (one-customer
// rule, no reattach after detach, loud errors), the customer PM listing, and
// attach/detach events.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripeApp, rest, type StripeTestApp } from "./_appHelper.js";

const VISA = "4242424242424242";

async function createCustomer(app: StripeTestApp, body: Record<string, unknown> = {}) {
  const r = await rest(app, "POST", "/v1/customers", body);
  expect(r.status).toBe(200);
  return r.body.id as string;
}

async function createCardPM(app: StripeTestApp, number = VISA) {
  const r = await rest(app, "POST", "/v1/payment_methods", {
    type: "card",
    card: { number, exp_month: 12, exp_year: 2032, cvc: "123" },
  });
  expect(r.status).toBe(200);
  return r.body.id as string;
}

describe("Payment methods — POST/GET /v1/payment_methods", () => {
  it("creates a card payment method: brand/last4 derived, PAN never echoed", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "POST", "/v1/payment_methods", {
      type: "card",
      card: { number: VISA, exp_month: 12, exp_year: 2032, cvc: "123" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      object: "payment_method",
      type: "card",
      customer: null,
      livemode: false,
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2032 },
    });
    expect(r.body.id).toMatch(/^pm_/);
    // The PAN must not appear anywhere in the response.
    expect(JSON.stringify(r.body)).not.toContain(VISA);
  });

  it("derives the brand from the test card number", async () => {
    const app = await createStripeApp();
    const mc = await rest(app, "POST", "/v1/payment_methods", {
      type: "card",
      card: { number: "5555555555554444", exp_month: 1, exp_year: 2031 },
    });
    expect(mc.body.card).toMatchObject({ brand: "mastercard", last4: "4444" });

    const amex = await rest(app, "POST", "/v1/payment_methods", {
      type: "card",
      card: { number: "378282246310005", exp_month: 1, exp_year: 2031 },
    });
    expect(amex.body.card).toMatchObject({ brand: "amex", last4: "0005" });
  });

  it("rejects missing type, non-card type, and missing card details", async () => {
    const app = await createStripeApp();
    const noType = await rest(app, "POST", "/v1/payment_methods", {});
    expect(noType.status).toBe(400);
    expect(noType.body.error.code).toBe("parameter_missing");
    expect(noType.body.error.param).toBe("type");

    const sepa = await rest(app, "POST", "/v1/payment_methods", {
      type: "sepa_debit",
    });
    expect(sepa.status).toBe(400);
    expect(sepa.body.error.type).toBe("invalid_request_error");

    const noCard = await rest(app, "POST", "/v1/payment_methods", { type: "card" });
    expect(noCard.status).toBe(400);
    expect(noCard.body.error.param).toBe("card");
  });

  it("rejects a bad card number / expiry with a card_error (Stripe 402)", async () => {
    const app = await createStripeApp();
    const badNumber = await rest(app, "POST", "/v1/payment_methods", {
      type: "card",
      card: { number: "4242424242424241", exp_month: 12, exp_year: 2032 },
    });
    expect(badNumber.status).toBe(402);
    expect(badNumber.body.error).toMatchObject({ type: "card_error", code: "incorrect_number" });

    const badMonth = await rest(app, "POST", "/v1/payment_methods", {
      type: "card",
      card: { number: VISA, exp_month: 13, exp_year: 2032 },
    });
    expect(badMonth.status).toBe(402);
    expect(badMonth.body.error.code).toBe("invalid_expiry_month");

    const pastYear = await rest(app, "POST", "/v1/payment_methods", {
      type: "card",
      card: { number: VISA, exp_month: 12, exp_year: 2020 },
    });
    expect(pastYear.status).toBe(402);
    expect(pastYear.body.error.code).toBe("invalid_expiry_year");
  });

  describe("current-year expiry", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects a past month of the current year; accepts a future month", async () => {
      // Fake Date only — faking timers wholesale would stall the app's async plumbing.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-15T12:00:00Z") });
      const app = await createStripeApp();

      const past = await rest(app, "POST", "/v1/payment_methods", {
        type: "card",
        card: { number: VISA, exp_month: 3, exp_year: 2026 },
      });
      expect(past.status).toBe(402);
      expect(past.body.error.code).toBe("invalid_expiry_month");

      const future = await rest(app, "POST", "/v1/payment_methods", {
        type: "card",
        card: { number: VISA, exp_month: 12, exp_year: 2026 },
      });
      expect(future.status).toBe(200);

      // The current month itself is still valid (cards expire end-of-month).
      const thisMonth = await rest(app, "POST", "/v1/payment_methods", {
        type: "card",
        card: { number: VISA, exp_month: 7, exp_year: 2026 },
      });
      expect(thisMonth.status).toBe(200);
    });
  });

  it("retrieves a payment method by id; 404 for unknown", async () => {
    const app = await createStripeApp();
    const pm = await createCardPM(app);
    const get = await rest(app, "GET", `/v1/payment_methods/${pm}`);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ id: pm, type: "card" });

    const missing = await rest(app, "GET", "/v1/payment_methods/pm_doesnotexist");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("resource_missing");
  });
});

describe("Attach / detach — POST /v1/payment_methods/:id/attach|detach", () => {
  it("attaches a PM to a customer and lists it via GET /v1/customers/:id/payment_methods", async () => {
    const app = await createStripeApp();
    const customer = await createCustomer(app, { name: "Ada" });
    const pm = await createCardPM(app);

    const attach = await rest(app, "POST", `/v1/payment_methods/${pm}/attach`, { customer });
    expect(attach.status).toBe(200);
    expect(attach.body).toMatchObject({ id: pm, customer });

    const list = await rest(app, "GET", `/v1/customers/${customer}/payment_methods`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ object: "list", url: `/v1/customers/${customer}/payment_methods` });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(pm);

    const typed = await rest(app, "GET", `/v1/customers/${customer}/payment_methods?type=card`);
    expect(typed.body.data).toHaveLength(1);
    const wrongType = await rest(app, "GET", `/v1/customers/${customer}/payment_methods?type=sepa_debit`);
    expect(wrongType.body.data).toHaveLength(0);
  });

  it("attach requires a customer param and an existing customer", async () => {
    const app = await createStripeApp();
    const pm = await createCardPM(app);

    const missingParam = await rest(app, "POST", `/v1/payment_methods/${pm}/attach`, {});
    expect(missingParam.status).toBe(400);
    expect(missingParam.body.error).toMatchObject({ code: "parameter_missing", param: "customer" });

    const missingCustomer = await rest(app, "POST", `/v1/payment_methods/${pm}/attach`, {
      customer: "cus_doesnotexist",
    });
    expect(missingCustomer.status).toBe(404);
    expect(missingCustomer.body.error.code).toBe("resource_missing");
  });

  it("refuses to attach an already-attached PM (one customer per PM)", async () => {
    const app = await createStripeApp();
    const c1 = await createCustomer(app);
    const c2 = await createCustomer(app);
    const pm = await createCardPM(app);
    await rest(app, "POST", `/v1/payment_methods/${pm}/attach`, { customer: c1 });

    const again = await rest(app, "POST", `/v1/payment_methods/${pm}/attach`, { customer: c2 });
    expect(again.status).toBe(400);
    expect(again.body.error.type).toBe("invalid_request_error");
    expect(again.body.error.message).toMatch(/already been attached/i);
  });

  it("detaches a PM; a detached PM can never be reattached (Stripe rule)", async () => {
    const app = await createStripeApp();
    const customer = await createCustomer(app);
    const pm = await createCardPM(app);
    await rest(app, "POST", `/v1/payment_methods/${pm}/attach`, { customer });

    const detach = await rest(app, "POST", `/v1/payment_methods/${pm}/detach`);
    expect(detach.status).toBe(200);
    expect(detach.body).toMatchObject({ id: pm, customer: null });

    const list = await rest(app, "GET", `/v1/customers/${customer}/payment_methods`);
    expect(list.body.data).toHaveLength(0);

    const reattach = await rest(app, "POST", `/v1/payment_methods/${pm}/attach`, { customer });
    expect(reattach.status).toBe(400);
    expect(reattach.body.error.message).toMatch(/previously (used|detached)/i);
  });

  it("refuses to detach a PM that is not attached", async () => {
    const app = await createStripeApp();
    const pm = await createCardPM(app);
    const detach = await rest(app, "POST", `/v1/payment_methods/${pm}/detach`);
    expect(detach.status).toBe(400);
    expect(detach.body.error.type).toBe("invalid_request_error");
  });

  it("deleting a customer detaches its payment methods", async () => {
    const app = await createStripeApp();
    const customer = await createCustomer(app);
    const pm = await createCardPM(app);
    await rest(app, "POST", `/v1/payment_methods/${pm}/attach`, { customer });

    await rest(app, "DELETE", `/v1/customers/${customer}`);

    const get = await rest(app, "GET", `/v1/payment_methods/${pm}`);
    expect(get.status).toBe(200);
    expect(get.body.customer).toBeNull();

    // The PM list of a deleted customer 404s like the customer itself.
    const list = await rest(app, "GET", `/v1/customers/${customer}/payment_methods`);
    expect(list.status).toBe(404);
  });

  it("deleting a customer emits payment_method.detached per attached PM", async () => {
    const app = await createStripeApp();
    const customer = await createCustomer(app);
    const pm1 = await createCardPM(app);
    const pm2 = await createCardPM(app, "5555555555554444");
    await rest(app, "POST", `/v1/payment_methods/${pm1}/attach`, { customer });
    await rest(app, "POST", `/v1/payment_methods/${pm2}/attach`, { customer });

    await rest(app, "DELETE", `/v1/customers/${customer}`);

    const events = await rest(app, "GET", "/v1/events?limit=100");
    const detached = (events.body.data as Array<{ type: string; data: { object: { id: string; customer: string | null } } }>)
      .filter((e) => e.type === "payment_method.detached");
    expect(detached.map((e) => e.data.object.id).sort()).toEqual([pm1, pm2].sort());
    for (const event of detached) {
      expect(event.data.object.customer).toBeNull();
    }
  });

  it("emits payment_method.attached / payment_method.detached events", async () => {
    const app = await createStripeApp();
    const customer = await createCustomer(app);
    const pm = await createCardPM(app);
    await rest(app, "POST", `/v1/payment_methods/${pm}/attach`, { customer });
    await rest(app, "POST", `/v1/payment_methods/${pm}/detach`);

    const events = await rest(app, "GET", "/v1/events");
    const types = (events.body.data as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain("payment_method.attached");
    expect(types).toContain("payment_method.detached");
  });

  it("records canonical state_delta on attach (before: unattached, after: attached)", async () => {
    const app = await createStripeApp();
    const customer = await createCustomer(app);
    const pm = await createCardPM(app);
    await rest(app, "POST", `/v1/payment_methods/${pm}/attach`, { customer });

    const events = await rest(app, "GET", "/_pome/events");
    const attachPost = (events.body as Array<Record<string, unknown>>).find(
      (e) => typeof e.path === "string" && (e.path as string).endsWith(`/v1/payment_methods/${pm}/attach`)
    );
    expect(attachPost).toBeDefined();
    expect(attachPost!.state_mutation).toBe(true);
    const delta = attachPost!.state_delta as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(delta.before).toMatchObject({ id: pm, customer_id: null });
    expect(delta.after).toMatchObject({ id: pm, customer_id: customer });
  });
});
