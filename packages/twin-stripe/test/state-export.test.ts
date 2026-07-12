// SPDX-License-Identifier: Apache-2.0
//
// Determinism check for the stripe port (F-684, mirroring the F-683 slack
// state-export check): the same seed plus the same operations must export
// an equivalent `/_pome/state` — field-for-field — modulo the values the
// twin intentionally randomizes (Stripe-shaped ids, client secrets, the
// id-derived 0x deposit address) and wall-clock unix timestamps. A row
// ordering race, a dropped column, or a leaked non-deterministic field
// fails the string comparison loudly.

import { beforeAll, describe, expect, it } from "vitest";
import { createStripeApp, rest, type StripeTestApp } from "./_appHelper.js";
import { TEST_AUTH_SECRET } from "./_authHelper.js";

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
});

const TIMESTAMP_KEYS = new Set(["created", "updated", "available_on", "canceled_at", "captured_at"]);

function normalize(value: unknown, key?: string): unknown {
  if (typeof value === "number" && key !== undefined && TIMESTAMP_KEYS.has(key)) return "<ts>";
  if (typeof value === "string") {
    return value
      .replace(/\b(?:pi|ch|re|txn|evt)_[A-Za-z0-9]+(?:_secret_[A-Za-z0-9]+)?\b/g, "<id>")
      .replace(/\b0x[0-9a-f]{40}\b/g, "<addr>");
  }
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v, k)])
    );
  }
  return value;
}

async function runScriptedOps(app: StripeTestApp): Promise<unknown> {
  // PI #1: create → settle → partial refund.
  const pi1 = await rest(app, "POST", "/v1/payment_intents", {
    amount: 20000,
    currency: "usd",
    payment_method_types: ["crypto"],
    payment_method_options: { crypto: { mode: "deposit", deposit_options: { networks: ["base"] } } },
  });
  expect(pi1.status).toBe(200);
  const settle = await rest(
    app,
    "POST",
    `/v1/test_helpers/payment_intents/${pi1.body.id}/simulate_crypto_deposit`
  );
  expect(settle.status).toBe(200);
  const refund = await rest(app, "POST", "/v1/refunds", {
    charge: settle.body.latest_charge,
    amount: 7500,
  });
  expect(refund.status).toBe(200);

  // PI #2: create → cancel.
  const pi2 = await rest(app, "POST", "/v1/payment_intents", {
    amount: 555,
    currency: "usd",
    payment_method_types: ["crypto"],
    payment_method_options: { crypto: { mode: "deposit", deposit_options: { networks: ["base"] } } },
  });
  const cancel = await rest(app, "POST", `/v1/payment_intents/${pi2.body.id}/cancel`);
  expect(cancel.status).toBe(200);

  const state = await rest(app, "GET", "/_pome/state");
  expect(state.status).toBe(200);
  return state.body;
}

describe("state export determinism (F-684)", () => {
  it("fresh default seed exports the identical state twice", async () => {
    const a = await createStripeApp();
    const b = await createStripeApp();
    const ra = await rest(a, "GET", "/_pome/state");
    const rb = await rest(b, "GET", "/_pome/state");
    expect(ra.status).toBe(200);
    expect(JSON.stringify(ra.body)).toBe(JSON.stringify(rb.body));
  });

  it("same seed + same ops => equivalent state (ids/timestamps modulo)", async () => {
    const first = await runScriptedOps(await createStripeApp());
    const second = await runScriptedOps(await createStripeApp());
    expect(JSON.stringify(normalize(first))).toBe(JSON.stringify(normalize(second)));
  });

  it("admin/reset returns the world to the default seed", async () => {
    const app = await createStripeApp();
    await runScriptedOps(app);
    const reset = await app.app.request("/admin/reset", { method: "POST" });
    expect(reset.status).toBe(200);
    const after = await rest(app, "GET", "/_pome/state");
    expect(after.body).toEqual({
      payment_intents: [],
      charges: [],
      balance_transactions: [],
      events: [],
      refunds: [],
      customers: [],
      payment_methods: [],
      products: [],
      prices: [],
      subscriptions: [],
    });
  });
});
