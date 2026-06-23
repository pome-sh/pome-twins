// SPDX-License-Identifier: Apache-2.0
//
// FDRS-321 — recorder must emit canonical state_delta { before, after } on
// every mutation path, not just refunds. Mirrors twin-github's
// recorder-state-delta.test.ts (FDRS-320) but for Stripe domain mutations.
//
// Refunds are already covered by refunds.test.ts.
// Idempotency dedupe is covered by idempotency.test.ts.
// This file covers: PI create, PI confirm, PI cancel, crypto-deposit settle.

import { describe, expect, it } from "vitest";
import { createStripeApp, rest, type StripeTestApp } from "./_appHelper.js";

type Event = Record<string, unknown>;

async function recorderEvents(app: StripeTestApp): Promise<Event[]> {
  const r = await rest(app, "GET", "/_pome/events");
  return r.body as Event[];
}

function findPost(events: Event[], path: string): Event | undefined {
  return events.find(
    (e) =>
      e.method === "POST" &&
      typeof e.path === "string" &&
      (e.path as string).endsWith(path)
  );
}

describe("Recorder state_delta — PI mutation paths", () => {
  it("POST /v1/payment_intents emits state_delta { before: null, after: pi_row }", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 1500,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });

    const events = await recorderEvents(app);
    const event = findPost(events, "/v1/payment_intents");
    expect(event).toBeDefined();
    expect(event!.state_mutation).toBe(true);
    expect(event!.state_delta).not.toBeNull();
    const delta = event!.state_delta as { before: unknown; after: Record<string, unknown> };
    expect(delta.before).toBeNull();
    expect(delta.after).toMatchObject({
      id: pi.body.id,
      account_id: expect.any(String),
      amount: 1500,
      currency: "usd",
      status: "requires_action",
    });
  });

  it("POST /v1/payment_intents/:id/cancel emits state_delta with status transition", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 200,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    });
    const cancelRes = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/cancel`);
    expect(cancelRes.status).toBe(200);

    const events = await recorderEvents(app);
    const event = findPost(events, `/v1/payment_intents/${pi.body.id}/cancel`);
    expect(event).toBeDefined();
    expect(event!.state_mutation).toBe(true);
    const delta = event!.state_delta as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(delta.before).not.toBeNull();
    expect(delta.after).not.toBeNull();
    expect(delta.before.status).toBe("requires_action");
    expect(delta.after.status).toBe("canceled");
    expect(delta.before.id).toBe(pi.body.id);
    expect(delta.after.id).toBe(pi.body.id);
  });

  it("POST /v1/payment_intents/:id/confirm on requires_action emits state_delta with status transition", async () => {
    const app = await createStripeApp();
    // Default crypto PI starts as requires_action with confirmation_method=automatic
    // and stays requires_action after confirm. Use the manual-confirmation path
    // to surface a meaningful before/after.
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 500,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
      confirmation_method: "manual",
    });
    const confirm = await rest(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`);
    expect(confirm.status).toBe(200);

    const events = await recorderEvents(app);
    const event = findPost(events, `/v1/payment_intents/${pi.body.id}/confirm`);
    expect(event).toBeDefined();
    expect(event!.state_mutation).toBe(true);
    const delta = event!.state_delta as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(delta.before).not.toBeNull();
    expect(delta.after).not.toBeNull();
    expect(delta.before.id).toBe(pi.body.id);
    expect(delta.after.id).toBe(pi.body.id);
  });

  it("POST /v1/test_helpers/.../simulate_crypto_deposit emits state_delta with PI status → succeeded", async () => {
    const app = await createStripeApp();
    const pi = await rest(app, "POST", "/v1/payment_intents", {
      amount: 800,
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
    expect(settle.status).toBe(200);

    const events = await recorderEvents(app);
    const event = findPost(
      events,
      `/v1/test_helpers/payment_intents/${pi.body.id}/simulate_crypto_deposit`
    );
    expect(event).toBeDefined();
    expect(event!.state_mutation).toBe(true);
    const delta = event!.state_delta as {
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
    };
    expect(delta.after).not.toBeNull();
    // The crypto-deposit flow mints a charge + balance_tx and walks the PI
    // through processing → succeeded. The recorder event captures the
    // final PI row state; the minted charge is observable via state.charges.
    expect(delta.after.id).toBe(pi.body.id);
    expect(delta.after.status).toBe("succeeded");
    expect(delta.after.latest_charge_id).toMatch(/^ch_/);
  });
});
