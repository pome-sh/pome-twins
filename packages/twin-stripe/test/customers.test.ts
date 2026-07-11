// SPDX-License-Identifier: Apache-2.0
//
// Customers — F-732 (M5 customer-management hot path, ruled F-729).
// Customer CRUD at semantic tier: create/retrieve/update/list/delete,
// Stripe metadata merge semantics, the deleted-customer stub, lifecycle
// events, and F1 account scoping.

import { describe, expect, it } from "vitest";
import { callTool, createStripeApp, rest } from "./_appHelper.js";
import { createTwinStripeApp } from "../src/twin.js";
import { openTwinStripeDatabase } from "../src/db.js";

describe("Customers — POST/GET/DELETE /v1/customers", () => {
  it("creates a customer with name/email/metadata", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "POST", "/v1/customers", {
      name: "Ada Lovelace",
      email: "ada@example.com",
      description: "first customer",
      metadata: { plan: "pro" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      object: "customer",
      name: "Ada Lovelace",
      email: "ada@example.com",
      description: "first customer",
      metadata: { plan: "pro" },
      livemode: false,
    });
    expect(r.body.id).toMatch(/^cus_/);
    expect(typeof r.body.created).toBe("number");
  });

  it("creates an empty customer (every field optional, like real Stripe)", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "POST", "/v1/customers", {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      object: "customer",
      name: null,
      email: null,
      description: null,
      metadata: {},
    });
  });

  it("retrieves a customer by id; 404 resource_missing for unknown", async () => {
    const app = await createStripeApp();
    const c = await rest(app, "POST", "/v1/customers", { name: "Ada" });
    const get = await rest(app, "GET", `/v1/customers/${c.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ id: c.body.id, name: "Ada" });

    const missing = await rest(app, "GET", "/v1/customers/cus_doesnotexist");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("resource_missing");
  });

  it("updates fields and merges metadata per-key (empty value unsets)", async () => {
    const app = await createStripeApp();
    const c = await rest(app, "POST", "/v1/customers", {
      name: "Ada",
      metadata: { a: "1", b: "2" },
    });
    const u = await rest(app, "POST", `/v1/customers/${c.body.id}`, {
      email: "ada@example.com",
      metadata: { b: "", c: "3" },
    });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({
      id: c.body.id,
      name: "Ada",
      email: "ada@example.com",
      metadata: { a: "1", c: "3" },
    });
    expect(u.body.metadata.b).toBeUndefined();

    const missing = await rest(app, "POST", "/v1/customers/cus_doesnotexist", { name: "x" });
    expect(missing.status).toBe(404);
  });

  it("lists customers with pagination and email filter, excluding deleted", async () => {
    const app = await createStripeApp();
    const a = await rest(app, "POST", "/v1/customers", { email: "a@example.com" });
    await rest(app, "POST", "/v1/customers", { email: "b@example.com" });
    const gone = await rest(app, "POST", "/v1/customers", { email: "c@example.com" });
    await rest(app, "DELETE", `/v1/customers/${gone.body.id}`);

    const all = await rest(app, "GET", "/v1/customers");
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ object: "list", url: "/v1/customers" });
    expect(all.body.data).toHaveLength(2);

    const filtered = await rest(app, "GET", "/v1/customers?email=a@example.com");
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].id).toBe(a.body.id);

    const limited = await rest(app, "GET", "/v1/customers?limit=1");
    expect(limited.body.data).toHaveLength(1);
    expect(limited.body.has_more).toBe(true);
  });

  it("deletes a customer: returns the deleted stub, then GET serves the stub", async () => {
    const app = await createStripeApp();
    const c = await rest(app, "POST", "/v1/customers", { name: "Ada" });
    const del = await rest(app, "DELETE", `/v1/customers/${c.body.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ id: c.body.id, object: "customer", deleted: true });

    // Real Stripe serves the deleted stub on retrieve, not a 404.
    const get = await rest(app, "GET", `/v1/customers/${c.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body).toEqual({ id: c.body.id, object: "customer", deleted: true });

    // Updates against a deleted customer fail loudly.
    const upd = await rest(app, "POST", `/v1/customers/${c.body.id}`, { name: "Ghost" });
    expect(upd.status).toBe(404);
    expect(upd.body.error.code).toBe("resource_missing");
  });

  it("emits customer.created / customer.updated / customer.deleted events", async () => {
    const app = await createStripeApp();
    const c = await rest(app, "POST", "/v1/customers", { name: "Ada" });
    await rest(app, "POST", `/v1/customers/${c.body.id}`, { name: "Ada L" });
    await rest(app, "DELETE", `/v1/customers/${c.body.id}`);

    const events = await rest(app, "GET", "/v1/events");
    const types = (events.body.data as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain("customer.created");
    expect(types).toContain("customer.updated");
    expect(types).toContain("customer.deleted");
  });

  it("MCP update_customer accepts metadata nulls to unset keys, like the REST surface", async () => {
    const app = await createStripeApp();
    const c = await callTool(app, "create_customer", { metadata: { a: "1", b: "2" } });
    const u = await callTool(app, "update_customer", {
      id: c.body.id,
      metadata: { a: null, c: "3" },
    });
    expect(u.status).toBe(200);
    expect(u.body.metadata).toEqual({ b: "2", c: "3" });
  });

  it("honors Idempotency-Key on POST /v1/customers", async () => {
    const app = await createStripeApp();
    const headers = { "Idempotency-Key": "customer-create-once" };
    const r1 = await rest(app, "POST", "/v1/customers", { name: "Ada" }, headers);
    const r2 = await rest(app, "POST", "/v1/customers", { name: "Ada" }, headers);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
    const list = await rest(app, "GET", "/v1/customers");
    expect(list.body.data).toHaveLength(1);
  });

  it("exportState includes customers[] and payment_methods[]", async () => {
    const app = await createStripeApp();
    const c = await rest(app, "POST", "/v1/customers", { name: "Ada" });
    const state = await rest(app, "GET", "/_pome/state");
    expect(state.status).toBe(200);
    expect(state.body.customers).toHaveLength(1);
    expect(state.body.customers[0]).toMatchObject({ id: c.body.id, object: "customer" });
    expect(state.body.payment_methods).toEqual([]);
  });
});

describe("F1 — customers are account-scoped", () => {
  it("session B cannot read or list session A's customers", async () => {
    const db = openTwinStripeDatabase(":memory:");
    const app = createTwinStripeApp({
      db,
      runId: "scope-test",
      seed: {
        api_keys: [
          { key: "sk_test_pome_a", sid: "a", account_id: "acct_a" },
          { key: "sk_test_pome_b", sid: "b", account_id: "acct_b" },
        ],
      },
    });
    const call = async (sid: string, key: string, method: string, path: string, body?: unknown) => {
      const init: RequestInit = { method, headers: { Authorization: `Bearer ${key}` } };
      if (body !== undefined) {
        init.headers = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const r = await app.request(`/s/${sid}${path}`, init);
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };

    const created = await call("a", "sk_test_pome_a", "POST", "/v1/customers", { name: "Ada" });
    expect(created.status).toBe(200);

    const cross = await call("b", "sk_test_pome_b", "GET", `/v1/customers/${created.body.id}`);
    expect(cross.status).toBe(404);

    const list = await call("b", "sk_test_pome_b", "GET", "/v1/customers");
    expect(list.body.data).toEqual([]);
  });
});
