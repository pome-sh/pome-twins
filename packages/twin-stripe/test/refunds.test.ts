// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createStripeApp, rest, type StripeTestApp } from "./_appHelper.js";

describe("Refunds — POST/GET /v1/refunds", () => {
  it("creates a refund attached to a settled charge", async () => {
    const app = await createStripeApp();
    const { chargeId, piId } = await createAndSettle(app, 20000);

    const r = await rest(app, "POST", "/v1/refunds", {
      charge: chargeId,
      amount: 7500,
    });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      object: "refund",
      amount: 7500,
      charge: chargeId,
      currency: "usd",
      status: "succeeded",
      payment_intent: piId,
      reason: null,
    });
    expect(r.body.id).toMatch(/^re_/);
    expect(typeof r.body.created).toBe("number");
  });

  it("retrieves a refund by id", async () => {
    const app = await createStripeApp();
    const { chargeId } = await createAndSettle(app, 20000);
    const r = await rest(app, "POST", "/v1/refunds", {
      charge: chargeId,
      amount: 5000,
    });
    const get = await rest(app, "GET", `/v1/refunds/${r.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      object: "refund",
      id: r.body.id,
      amount: 5000,
      charge: chargeId,
    });
  });

  it("returns 404 for an unknown refund", async () => {
    const app = await createStripeApp();
    const r = await rest(app, "GET", "/v1/refunds/re_doesnotexist");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("resource_missing");
  });

  it("lists refunds, filters by charge", async () => {
    const app = await createStripeApp();
    const a = await createAndSettle(app, 20000);
    const b = await createAndSettle(app, 30000);
    await rest(app, "POST", "/v1/refunds", { charge: a.chargeId, amount: 1000 });
    await rest(app, "POST", "/v1/refunds", { charge: a.chargeId, amount: 2000 });
    await rest(app, "POST", "/v1/refunds", { charge: b.chargeId, amount: 3000 });

    const all = await rest(app, "GET", "/v1/refunds");
    expect(all.status).toBe(200);
    expect(all.body.object).toBe("list");
    expect(all.body.data).toHaveLength(3);

    const onlyA = await rest(app, "GET", `/v1/refunds?charge=${a.chargeId}`);
    expect(onlyA.body.data).toHaveLength(2);
    for (const row of onlyA.body.data) {
      expect(row.charge).toBe(a.chargeId);
    }
  });

  it("Idempotency-Key HONORED: replay returns the same refund_id", async () => {
    const app = await createStripeApp();
    const { chargeId } = await createAndSettle(app, 20000);
    const headers = { "Idempotency-Key": "refund-test-key-honored" };
    const r1 = await rest(
      app,
      "POST",
      "/v1/refunds",
      { charge: chargeId, amount: 7500 },
      headers
    );
    const r2 = await rest(
      app,
      "POST",
      "/v1/refunds",
      { charge: chargeId, amount: 7500 },
      headers
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.id).toBe(r2.body.id);
    const list = await rest(app, "GET", "/v1/refunds");
    expect(list.body.data).toHaveLength(1);
  });

  it("Idempotency-Key ABSENT: each POST creates a NEW refund row (FDRS-316 hero bug)", async () => {
    const app = await createStripeApp();
    const { chargeId } = await createAndSettle(app, 20000);
    const r1 = await rest(app, "POST", "/v1/refunds", { charge: chargeId, amount: 7500 });
    const r2 = await rest(app, "POST", "/v1/refunds", { charge: chargeId, amount: 7500 });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.id).not.toBe(r2.body.id);
    const list = await rest(app, "GET", "/v1/refunds");
    expect(list.body.data).toHaveLength(2);
  });

  it("bumps charges.amount_refunded atomically", async () => {
    const app = await createStripeApp();
    const { chargeId } = await createAndSettle(app, 20000);

    await rest(app, "POST", "/v1/refunds", { charge: chargeId, amount: 7500 });
    const c1 = await rest(app, "GET", `/v1/charges/${chargeId}`);
    expect(c1.body.amount_refunded).toBe(7500);
    expect(c1.body.refunded).toBe(false);

    await rest(app, "POST", "/v1/refunds", { charge: chargeId, amount: 12500 });
    const c2 = await rest(app, "GET", `/v1/charges/${chargeId}`);
    expect(c2.body.amount_refunded).toBe(20000);
    expect(c2.body.refunded).toBe(true);
  });

  it("exportState includes refunds[] alongside the other 4 arrays", async () => {
    const app = await createStripeApp();
    const { chargeId } = await createAndSettle(app, 20000);
    const r = await rest(app, "POST", "/v1/refunds", { charge: chargeId, amount: 7500 });

    const state = await rest(app, "GET", "/_pome/state");
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      payment_intents: expect.any(Array),
      charges: expect.any(Array),
      balance_transactions: expect.any(Array),
      events: expect.any(Array),
      refunds: expect.any(Array),
    });
    expect(state.body.refunds).toHaveLength(1);
    expect(state.body.refunds[0]).toMatchObject({
      object: "refund",
      id: r.body.id,
      charge: chargeId,
      amount: 7500,
    });
  });

  it("emits a recorder event with canonical state_delta { before: null, after: row } on refund INSERT", async () => {
    const app = await createStripeApp();
    const { chargeId } = await createAndSettle(app, 20000);
    const r = await rest(app, "POST", "/v1/refunds", { charge: chargeId, amount: 7500 });

    const events = await rest(app, "GET", "/_pome/events");
    const refundPost = (events.body as Array<Record<string, unknown>>).find(
      (e) => e.method === "POST" && typeof e.path === "string" && (e.path as string).endsWith("/v1/refunds")
    );
    expect(refundPost).toBeDefined();
    expect(refundPost!.state_mutation).toBe(true);
    expect(refundPost!.state_delta).not.toBeNull();
    const delta = refundPost!.state_delta as { before: unknown; after: Record<string, unknown> };
    expect(delta.before).toBeNull();
    expect(delta.after).toMatchObject({
      id: r.body.id,
      charge_id: chargeId,
      amount: 7500,
      status: "succeeded",
    });
    // Canonical RecorderEvent fields landed by FDRS-318:
    expect(refundPost!).toMatchObject({
      twin: "stripe",
      step_id: null,
      tool_call_id: null,
    });
  });
});

async function createAndSettle(
  app: StripeTestApp,
  amount: number
): Promise<{ piId: string; chargeId: string }> {
  const pi = await rest(app, "POST", "/v1/payment_intents", {
    amount,
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
  return {
    piId: pi.body.id as string,
    chargeId: settle.body.latest_charge as string,
  };
}
