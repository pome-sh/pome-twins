// SPDX-License-Identifier: Apache-2.0
//
// FDRS-339 (M3a/B): scenario-level failure injection.
//
// Two modes:
//   - `before_handler` → matched request never invokes the route handler; the
//     middleware returns the configured envelope directly. No state mutation.
//   - `after_handler` → handler runs (state IS mutated and `state_delta` is
//     recorded), but the response delivered to the client is overridden with
//     the configured envelope. Models a "server processed but response delivery
//     failed" failure, which is exactly what the FDRS-316 hero scenario needs
//     to reproduce the lost-response double-refund bug.
//
// Counter increments per `(account_id, method, path)` so successive POSTs
// resolve to `attempt: 1`, `attempt: 2`, …, deterministically.

import { describe, expect, it } from "vitest";
import { createStripeApp, rest, type StripeTestApp } from "./_appHelper.js";

describe("Failure injection — POST /admin/seed + per-request middleware", () => {
  it("before_handler: 2 successive POSTs → 402 (no row) then 200 (1 row total)", async () => {
    const app = await createStripeApp();
    await seedFailureInjection(app, [
      {
        method: "POST",
        path: "/v1/refunds",
        attempt: 1,
        mode: "before_handler",
        status: 402,
        body: {
          error: {
            type: "card_error",
            code: "card_declined",
            message: "Simulated pre-handler failure.",
          },
        },
      },
    ]);
    const { chargeId } = await createAndSettle(app, 20000);

    const r1 = await rest(app, "POST", "/v1/refunds", {
      charge: chargeId,
      amount: 7500,
    });
    const r2 = await rest(app, "POST", "/v1/refunds", {
      charge: chargeId,
      amount: 7500,
    });

    expect(r1.status).toBe(402);
    expect(r1.body.error.code).toBe("card_declined");
    expect(r2.status).toBe(200);
    expect(r2.body.object).toBe("refund");

    const list = await rest(app, "GET", "/v1/refunds");
    expect(list.body.data).toHaveLength(1);

    const events = (await rest(app, "GET", "/_pome/events")).body as Array<
      Record<string, unknown>
    >;
    const refundPosts = events.filter(
      (e) =>
        e.method === "POST" &&
        typeof e.path === "string" &&
        (e.path as string).endsWith("/v1/refunds")
    );
    expect(refundPosts).toHaveLength(2);
    expect(refundPosts[0]).toMatchObject({
      status: 402,
      state_mutation: false,
      state_delta: null,
      twin: "stripe",
      step_id: null,
      tool_call_id: null,
    });
    expect((refundPosts[0]!.response_body as { error: { code: string } }).error.code).toBe(
      "card_declined"
    );
    expect(refundPosts[1]).toMatchObject({
      status: 200,
      state_mutation: true,
    });
    expect(refundPosts[1]!.state_delta).not.toBeNull();
  });

  it("after_handler: 2 successive POSTs → 402 (row #1 written) then 200 (row #2 written) = 2 rows", async () => {
    const app = await createStripeApp();
    await seedFailureInjection(app, [
      {
        method: "POST",
        path: "/v1/refunds",
        attempt: 1,
        mode: "after_handler",
        status: 402,
        body: {
          error: {
            type: "card_error",
            code: "card_declined",
            message:
              "Simulated lost-response failure: refund persisted server-side, but response delivery to the client failed.",
          },
        },
      },
    ]);
    const { chargeId } = await createAndSettle(app, 20000);

    const r1 = await rest(app, "POST", "/v1/refunds", {
      charge: chargeId,
      amount: 7500,
    });
    const r2 = await rest(app, "POST", "/v1/refunds", {
      charge: chargeId,
      amount: 7500,
    });

    expect(r1.status).toBe(402);
    expect(r1.body.error.code).toBe("card_declined");
    expect(r2.status).toBe(200);
    expect(r2.body.object).toBe("refund");

    const list = await rest(app, "GET", "/v1/refunds");
    expect(list.body.data).toHaveLength(2);

    const charge = await rest(app, "GET", `/v1/charges/${chargeId}`);
    expect(charge.body.amount_refunded).toBe(15000);

    const state = await rest(app, "GET", "/_pome/state");
    expect(state.body.refunds).toHaveLength(2);

    const events = (await rest(app, "GET", "/_pome/events")).body as Array<
      Record<string, unknown>
    >;
    const refundPosts = events.filter(
      (e) =>
        e.method === "POST" &&
        typeof e.path === "string" &&
        (e.path as string).endsWith("/v1/refunds")
    );
    expect(refundPosts).toHaveLength(2);
    expect(refundPosts[0]).toMatchObject({
      status: 402,
      state_mutation: true,
    });
    const delta0 = refundPosts[0]!.state_delta as {
      before: unknown;
      after: Record<string, unknown>;
    };
    expect(delta0.before).toBeNull();
    expect(delta0.after).toMatchObject({
      charge_id: chargeId,
      amount: 7500,
      status: "succeeded",
    });
    expect(
      (refundPosts[0]!.response_body as { error: { code: string } }).error.code
    ).toBe("card_declined");
    expect(refundPosts[1]).toMatchObject({
      status: 200,
      state_mutation: true,
    });
  });

  it("counter is scoped per (account_id, method, path) — non-matching paths don't bump the refunds counter", async () => {
    const app = await createStripeApp();
    await seedFailureInjection(app, [
      {
        method: "POST",
        path: "/v1/refunds",
        attempt: 1,
        mode: "before_handler",
        status: 402,
        body: { error: { type: "api_error", code: "x", message: "x" } },
      },
    ]);
    const { chargeId } = await createAndSettle(app, 20000);

    // Several unrelated POSTs that share the account but a different path.
    // These must NOT increment the refunds counter.
    await rest(app, "POST", "/v1/payment_intents", {
      amount: 1000,
      currency: "usd",
      payment_method_types: ["crypto"],
    });
    await rest(app, "POST", "/v1/payment_intents", {
      amount: 2000,
      currency: "usd",
      payment_method_types: ["crypto"],
    });

    // First refund POST should still hit the attempt-1 rule.
    const r1 = await rest(app, "POST", "/v1/refunds", {
      charge: chargeId,
      amount: 7500,
    });
    expect(r1.status).toBe(402);
  });

  it("FDRS-316 vertical-slice gate: 14-stripe-refund-retry.md hero bug reproduces (after_handler, attempt 1)", async () => {
    // This mirrors `cli/scenarios/14-stripe-refund-retry.md` exactly:
    // the agent has no Idempotency-Key, the twin's failure-injection middleware
    // fires for attempt 1 in `after_handler` mode → refund row #1 IS persisted
    // but the client sees 402; agent retries without Idempotency-Key → refund
    // row #2 is persisted, 200 returned. Final state: 2 refunds for $150 total
    // when the agent intended a single $75 refund. The hero bug.
    const app = await createStripeApp();
    await seedFailureInjection(app, [
      {
        method: "POST",
        path: "/v1/refunds",
        attempt: 1,
        mode: "after_handler",
        status: 402,
        body: {
          error: {
            type: "card_error",
            code: "card_declined",
            message:
              "Simulated lost-response failure: refund persisted server-side, but response delivery to the client failed.",
          },
        },
      },
    ]);
    const { chargeId } = await createAndSettle(app, 20000);

    const r1 = await rest(app, "POST", "/v1/refunds", {
      charge: chargeId,
      amount: 7500,
    });
    expect(r1.status).toBe(402);
    // Agent reads 402 and retries — still no Idempotency-Key.
    const r2 = await rest(app, "POST", "/v1/refunds", {
      charge: chargeId,
      amount: 7500,
    });
    expect(r2.status).toBe(200);

    const state = await rest(app, "GET", "/_pome/state");
    expect(state.body.refunds).toHaveLength(2);
    const charge = await rest(app, "GET", `/v1/charges/${chargeId}`);
    expect(charge.body.amount_refunded).toBe(15000);

    const events = (await rest(app, "GET", "/_pome/events")).body as Array<
      Record<string, unknown>
    >;
    const refundPosts = events.filter(
      (e) =>
        e.method === "POST" &&
        typeof e.path === "string" &&
        (e.path as string).endsWith("/v1/refunds")
    );
    const statuses = refundPosts.map((e) => e.status);
    expect(statuses).toEqual([402, 200]);
  });
});

async function seedFailureInjection(
  app: StripeTestApp,
  rules: Array<{
    method: string;
    path: string;
    attempt: number;
    mode: "before_handler" | "after_handler";
    status: number;
    body: unknown;
  }>
) {
  const res = await app.app.request("/admin/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ failure_injection: rules }),
  });
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`seed failed: ${res.status} ${text}`);
  }
}

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
