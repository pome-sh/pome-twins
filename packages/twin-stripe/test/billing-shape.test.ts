// SPDX-License-Identifier: Apache-2.0
//
// Billing warm surfaces — F-734 (shape tier per the F-729 ruling).
//
// Shape-level tests: Stripe-shaped responses off stored rows, referential
// 404s, and the deliberate ABSENCE of the semantic billing machine — no
// events emitted, no invoices minted, no billing-cycle arithmetic. The
// compile-time anchor (`satisfies DeepPartial<Stripe.*>` in serializers.ts)
// carries the field-level shape check; these tests pin the wire behavior.

import { describe, expect, it } from "vitest";
import { createStripeApp, rest, type StripeTestApp } from "./_appHelper.js";

async function createProduct(app: StripeTestApp, body: Record<string, unknown> = {}) {
  return rest(app, "POST", "/v1/products", { name: "Pro Plan", ...body });
}

async function createPrice(app: StripeTestApp, body: Record<string, unknown> = {}) {
  const product = await createProduct(app);
  return rest(app, "POST", "/v1/prices", {
    currency: "usd",
    unit_amount: 1500,
    recurring: { interval: "month" },
    product: product.body.id,
    ...body,
  });
}

async function createSubscription(app: StripeTestApp) {
  const customer = await rest(app, "POST", "/v1/customers", { email: "sub@example.com" });
  const price = await createPrice(app);
  const sub = await rest(app, "POST", "/v1/subscriptions", {
    customer: customer.body.id,
    items: [{ price: price.body.id }],
  });
  return { customer, price, sub };
}

describe("products (warm, shape)", () => {
  it("creates and retrieves a Stripe-shaped product", async () => {
    const app = await createStripeApp();
    const created = await createProduct(app, { description: "The pro tier" });
    expect(created.status).toBe(200);
    expect(created.body.id).toMatch(/^prod_/);
    expect(created.body.object).toBe("product");
    expect(created.body.active).toBe(true);
    expect(created.body.name).toBe("Pro Plan");
    expect(created.body.description).toBe("The pro tier");
    expect(created.body.livemode).toBe(false);

    const got = await rest(app, "GET", `/v1/products/${created.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(created.body);
  });

  it("requires name and 404s unknown ids with resource_missing", async () => {
    const app = await createStripeApp();
    const missing = await rest(app, "POST", "/v1/products", {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("parameter_missing");
    expect(missing.body.error.param).toBe("name");

    const notFound = await rest(app, "GET", "/v1/products/prod_nope");
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe("resource_missing");
  });

  it("lists with the Stripe list envelope and active filter", async () => {
    const app = await createStripeApp();
    await createProduct(app, { name: "A" });
    await createProduct(app, { name: "B", active: false });
    const all = await rest(app, "GET", "/v1/products");
    expect(all.body.object).toBe("list");
    expect(all.body.url).toBe("/v1/products");
    expect(all.body.has_more).toBe(false);
    expect(all.body.data).toHaveLength(2);

    const active = await rest(app, "GET", "/v1/products?active=true");
    expect(active.body.data.map((p: { name: string }) => p.name)).toEqual(["A"]);
  });
});

describe("prices (warm, shape)", () => {
  it("creates a recurring price bound to a real product", async () => {
    const app = await createStripeApp();
    const price = await createPrice(app, { nickname: "monthly" });
    expect(price.status).toBe(200);
    expect(price.body.id).toMatch(/^price_/);
    expect(price.body.object).toBe("price");
    expect(price.body.currency).toBe("usd");
    expect(price.body.unit_amount).toBe(1500);
    expect(price.body.unit_amount_decimal).toBe("1500");
    expect(price.body.type).toBe("recurring");
    expect(price.body.recurring).toMatchObject({ interval: "month", interval_count: 1 });

    const got = await rest(app, "GET", `/v1/prices/${price.body.id}`);
    expect(got.body).toEqual(price.body);
  });

  it("defaults to one_time without recurring", async () => {
    const app = await createStripeApp();
    const price = await createPrice(app, { recurring: undefined });
    expect(price.body.type).toBe("one_time");
    expect(price.body.recurring).toBeNull();
  });

  it("404s an unknown product at create time (referential check)", async () => {
    const app = await createStripeApp();
    const price = await rest(app, "POST", "/v1/prices", {
      currency: "usd",
      unit_amount: 500,
      product: "prod_nope",
    });
    expect(price.status).toBe(404);
    expect(price.body.error.code).toBe("resource_missing");
  });

  it("requires currency and product", async () => {
    const app = await createStripeApp();
    const noCurrency = await rest(app, "POST", "/v1/prices", { product: "prod_x" });
    expect(noCurrency.status).toBe(400);
    expect(noCurrency.body.error.param).toBe("currency");
    const noProduct = await rest(app, "POST", "/v1/prices", { currency: "usd" });
    expect(noProduct.status).toBe(400);
    expect(noProduct.body.error.param).toBe("product");
  });

  it("lists with a product filter", async () => {
    const app = await createStripeApp();
    const first = await createPrice(app);
    await createPrice(app);
    const filtered = await rest(
      app,
      "GET",
      `/v1/prices?product=${first.body.product}`
    );
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].id).toBe(first.body.id);
  });
});

describe("subscriptions (warm, shape)", () => {
  it("creates an active subscription with expanded item prices", async () => {
    const app = await createStripeApp();
    const { customer, price, sub } = await createSubscription(app);
    expect(sub.status).toBe(200);
    expect(sub.body.id).toMatch(/^sub_/);
    expect(sub.body.object).toBe("subscription");
    expect(sub.body.status).toBe("active");
    expect(sub.body.customer).toBe(customer.body.id);
    expect(sub.body.currency).toBe("usd");
    expect(sub.body.cancel_at_period_end).toBe(false);
    expect(sub.body.latest_invoice).toBeNull();
    expect(sub.body.items.object).toBe("list");
    expect(sub.body.items.data).toHaveLength(1);
    expect(sub.body.items.data[0].id).toMatch(/^si_/);
    expect(sub.body.items.data[0].object).toBe("subscription_item");
    expect(sub.body.items.data[0].subscription).toBe(sub.body.id);
    expect(sub.body.items.data[0].quantity).toBe(1);
    // Upstream SubscriptionItem.price is the expanded Price object.
    expect(sub.body.items.data[0].price.id).toBe(price.body.id);
    expect(sub.body.items.data[0].price.object).toBe("price");
  });

  it("requires customer and items, and 404s unknown references", async () => {
    const app = await createStripeApp();
    const noCustomer = await rest(app, "POST", "/v1/subscriptions", {
      items: [{ price: "price_x" }],
    });
    expect(noCustomer.status).toBe(400);
    expect(noCustomer.body.error.param).toBe("customer");

    const customer = await rest(app, "POST", "/v1/customers", {});
    const noItems = await rest(app, "POST", "/v1/subscriptions", {
      customer: customer.body.id,
    });
    expect(noItems.status).toBe(400);
    expect(noItems.body.error.param).toBe("items");

    const badCustomer = await rest(app, "POST", "/v1/subscriptions", {
      customer: "cus_nope",
      items: [{ price: "price_x" }],
    });
    expect(badCustomer.status).toBe(404);
    expect(badCustomer.body.error.code).toBe("resource_missing");

    const badPrice = await rest(app, "POST", "/v1/subscriptions", {
      customer: customer.body.id,
      items: [{ price: "price_nope" }],
    });
    expect(badPrice.status).toBe(404);
    expect(badPrice.body.error.code).toBe("resource_missing");
  });

  it("updates metadata per-key and flips cancel_at_period_end", async () => {
    const app = await createStripeApp();
    const { sub } = await createSubscription(app);
    const first = await rest(app, "POST", `/v1/subscriptions/${sub.body.id}`, {
      metadata: { plan: "pro", seat: "5" },
      cancel_at_period_end: true,
    });
    expect(first.status).toBe(200);
    expect(first.body.cancel_at_period_end).toBe(true);
    expect(first.body.metadata).toEqual({ plan: "pro", seat: "5" });

    // Empty value unsets the key (Stripe's metadata contract).
    const second = await rest(app, "POST", `/v1/subscriptions/${sub.body.id}`, {
      metadata: { seat: "" },
    });
    expect(second.body.metadata).toEqual({ plan: "pro" });
    expect(second.body.cancel_at_period_end).toBe(true);
  });

  it("DELETE cancels immediately; re-cancel is idempotent; canceled allows metadata-only updates", async () => {
    const app = await createStripeApp();
    const { sub } = await createSubscription(app);
    const canceled = await rest(app, "DELETE", `/v1/subscriptions/${sub.body.id}`);
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe("canceled");
    expect(canceled.body.canceled_at).toBeGreaterThan(0);
    expect(canceled.body.ended_at).toBe(canceled.body.canceled_at);

    const again = await rest(app, "DELETE", `/v1/subscriptions/${sub.body.id}`);
    expect(again.status).toBe(200);
    expect(again.body.canceled_at).toBe(canceled.body.canceled_at);

    // Real Stripe: a canceled subscription still accepts metadata updates…
    const metadataOnly = await rest(app, "POST", `/v1/subscriptions/${sub.body.id}`, {
      metadata: { a: "b" },
    });
    expect(metadataOnly.status).toBe(200);
    expect(metadataOnly.body.metadata).toEqual({ a: "b" });
    expect(metadataOnly.body.status).toBe("canceled");

    // …but refuses everything else.
    const nonMetadata = await rest(app, "POST", `/v1/subscriptions/${sub.body.id}`, {
      cancel_at_period_end: true,
    });
    expect(nonMetadata.status).toBe(400);
    expect(nonMetadata.body.error.code).toBe("subscription_canceled");
  });

  it("list excludes canceled by default; status=all lifts the filter", async () => {
    const app = await createStripeApp();
    const { customer, price } = await createSubscription(app);
    const second = await rest(app, "POST", "/v1/subscriptions", {
      customer: customer.body.id,
      items: [{ price: price.body.id }],
    });
    await rest(app, "DELETE", `/v1/subscriptions/${second.body.id}`);

    const defaults = await rest(app, "GET", "/v1/subscriptions");
    expect(defaults.body.data).toHaveLength(1);
    const all = await rest(app, "GET", "/v1/subscriptions?status=all");
    expect(all.body.data).toHaveLength(2);
    const canceled = await rest(app, "GET", "/v1/subscriptions?status=canceled");
    expect(canceled.body.data.map((s: { id: string }) => s.id)).toEqual([second.body.id]);

    const byCustomer = await rest(
      app,
      "GET",
      `/v1/subscriptions?customer=${customer.body.id}&status=all`
    );
    expect(byCustomer.body.data).toHaveLength(2);
  });

  it("accepts Stripe's bracket form encoding (stripe-node wire shape)", async () => {
    const app = await createStripeApp();
    const customer = await rest(app, "POST", "/v1/customers", {});
    const price = await createPrice(app);
    const form = new URLSearchParams();
    form.set("customer", customer.body.id);
    form.set("items[0][price]", price.body.id);
    form.set("items[0][quantity]", "3");
    const response = await app.app.request(`${app.base}/v1/subscriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${app.token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { items: { data: Array<{ quantity: number }> } };
    expect(body.items.data[0].quantity).toBe(3);
  });
});

describe("shape tier boundaries (no semantic machine)", () => {
  it("billing writes emit NO events and mint NO invoices", async () => {
    const app = await createStripeApp();
    const { sub } = await createSubscription(app);
    await rest(app, "DELETE", `/v1/subscriptions/${sub.body.id}`);

    const events = await rest(app, "GET", "/v1/events");
    const billingEvents = events.body.data.filter((event: { type: string }) =>
      /^(product|price|subscription|invoice)\./.test(event.type)
    );
    expect(billingEvents).toEqual([]);

    const invoices = await rest(app, "GET", "/v1/invoices");
    expect(invoices.body).toEqual({
      object: "list",
      data: [],
      has_more: false,
      url: "/v1/invoices",
    });
  });

  it("GET /v1/invoices/:id answers Stripe's 404, not a 501", async () => {
    const app = await createStripeApp();
    const got = await rest(app, "GET", "/v1/invoices/in_nope");
    expect(got.status).toBe(404);
    expect(got.body.error.code).toBe("resource_missing");
  });

  it("invoice writes and product/price updates stay unlisted-cold (501)", async () => {
    const app = await createStripeApp();
    const product = await createProduct(app);
    for (const [method, path] of [
      ["POST", "/v1/invoices"],
      ["POST", "/v1/invoices/in_x/finalize"],
      ["POST", "/v1/invoices/in_x/pay"],
      ["POST", `/v1/products/${product.body.id}`],
      ["DELETE", `/v1/products/${product.body.id}`],
      ["POST", "/v1/prices/price_x"],
    ] as const) {
      const r = await rest(app, method, path, method === "POST" ? {} : undefined);
      expect(r.status, `${method} ${path}`).toBe(501);
      expect(r.body.error.code).toBe("endpoint_not_supported");
      expect(r.body.error.fidelity).toBe("unsupported");
    }
  });

  it("state export carries the billing rows; reset clears them", async () => {
    const app = await createStripeApp();
    const { sub } = await createSubscription(app);
    const state = await rest(app, "GET", "/_pome/state");
    expect(state.body.products).toHaveLength(1);
    expect(state.body.prices).toHaveLength(1);
    expect(state.body.subscriptions).toHaveLength(1);
    expect(state.body.subscriptions[0].id).toBe(sub.body.id);

    await app.app.request("/admin/reset", { method: "POST" });
    const after = await rest(app, "GET", "/_pome/state");
    expect(after.body.products).toEqual([]);
    expect(after.body.prices).toEqual([]);
    expect(after.body.subscriptions).toEqual([]);
  });

  it("account scoping holds: another session cannot read billing rows", async () => {
    const app = await createStripeApp();
    const { sub } = await createSubscription(app);
    const otherToken = await (await import("./_authHelper.js")).signTestToken({
      sid: "other",
      account_id: "acct_other",
    });
    const response = await app.app.request("/s/other/v1/subscriptions?status=all", {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: unknown[] };
    expect(body.data).toEqual([]);
    const direct = await app.app.request(`/s/other/v1/subscriptions/${sub.body.id}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(direct.status).toBe(404);
  });
});
