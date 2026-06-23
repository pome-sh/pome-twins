// SPDX-License-Identifier: Apache-2.0
// Verifies the idempotency middleware against a synthetic POST endpoint
// mounted via the `extendSession` hook. The chassis ships no real POST
// routes, so we register a counter handler in-test and assert that
// (same key, same body) returns the cached response and (same key, diff
// body) returns 400 with code idempotency_key_in_use.
import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createTwinStripeApp } from "../src/app.js";
import { openTwinStripeDatabase } from "../src/db.js";
import { applySeed, defaultSeed, DEFAULT_API_KEY, DEFAULT_SID } from "../src/seed.js";
import { createStripeApp, rest, type StripeTestApp } from "./_appHelper.js";

function buildApp() {
  const db = openTwinStripeDatabase(":memory:");
  applySeed(db, defaultSeed());

  // Counter shared across handler invocations — proves the second call
  // with the same key skips the handler and returns the cached body.
  let counter = 0;

  const app = createTwinStripeApp({
    db,
    extendSession(session: Hono) {
      session.post("/v1/echo", async (c) => {
        counter += 1;
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        return c.json({ id: `obj_${counter}`, echo: body, counter }, 200);
      });
    }
  });

  return { app, counter: () => counter, db };
}

const authHeader = `Bearer ${DEFAULT_API_KEY}`;
const url = `/s/${DEFAULT_SID}/v1/echo`;

describe("Idempotency-Key middleware", () => {
  it("returns the cached response when key+body match", async () => {
    const { app, counter } = buildApp();
    const init = (idem: string, body: object): RequestInit => ({
      method: "POST",
      headers: {
        Authorization: authHeader,
        "content-type": "application/json",
        "Idempotency-Key": idem
      },
      body: JSON.stringify(body)
    });

    const r1 = await app.request(url, init("k1", { hello: "world" }));
    const r2 = await app.request(url, init("k1", { hello: "world" }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { id: string; counter: number };
    const b2 = (await r2.json()) as { id: string; counter: number };
    expect(b2).toEqual(b1);
    // Handler must have run only once.
    expect(counter()).toBe(1);
  });

  it("returns 400 idempotency_key_in_use when same key is used with a different body", async () => {
    const { app } = buildApp();
    const r1 = await app.request(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "content-type": "application/json",
        "Idempotency-Key": "k2"
      },
      body: JSON.stringify({ a: 1 })
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "content-type": "application/json",
        "Idempotency-Key": "k2"
      },
      body: JSON.stringify({ a: 2 })
    });
    expect(r2.status).toBe(400);
    const body = (await r2.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("idempotency_error");
    expect(body.error.code).toBe("idempotency_key_in_use");
  });

  it("does not cache when no Idempotency-Key header is present", async () => {
    const { app, counter } = buildApp();
    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "content-type": "application/json"
      },
      body: JSON.stringify({ x: 1 })
    };
    const r1 = await app.request(url, init);
    const r2 = await app.request(url, init);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(counter()).toBe(2);
  });

  it("coalesces concurrent matching POSTs into one PaymentIntent", async () => {
    const app = await createStripeApp();
    const body = {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } },
      },
    };

    const [r1, r2] = await Promise.all([
      rest(app, "POST", "/v1/payment_intents", body, { "Idempotency-Key": "same-pi" }),
      rest(app, "POST", "/v1/payment_intents", body, { "Idempotency-Key": "same-pi" }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body);

    const list = await rest(app, "GET", "/v1/payment_intents");
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(r1.body.id);
  });

  it("does not cache GET requests", async () => {
    const { app } = buildApp();
    const res = await app.request(`/s/${DEFAULT_SID}/_pome/health`, {
      headers: { Authorization: authHeader, "Idempotency-Key": "ignore-me" }
    });
    expect(res.status).toBe(200);
  });

  it("FDRS-321 — dedupe cache hit emits a RecorderEvent with idempotency_dedupe=true and state_delta=null", async () => {
    // Real Stripe replays the cached response verbatim on a dedupe hit. The
    // twin must still produce a recorder event so downstream tooling
    // (dashboard, correlator) sees the retry. The event carries
    // state_mutation=false + state_delta=null + idempotency_dedupe=true,
    // distinguishing it from a true mutation.
    const app = await createStripeApp();
    const { chargeId } = await createAndSettle(app, 20000);
    const body = { charge: chargeId, amount: 7500 };
    const headers = { "Idempotency-Key": "dedupe-key-1" };

    const r1 = await rest(app, "POST", "/v1/refunds", body, headers);
    const r2 = await rest(app, "POST", "/v1/refunds", body, headers);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(r1.body);

    const events = await rest(app, "GET", "/_pome/events");
    const refundPosts = (events.body as Array<Record<string, unknown>>).filter(
      (e) => e.method === "POST" && typeof e.path === "string" && (e.path as string).endsWith("/v1/refunds")
    );
    expect(refundPosts).toHaveLength(2);
    const [first, dedupe] = refundPosts;
    expect(first.state_mutation).toBe(true);
    expect(first.state_delta).not.toBeNull();
    expect(first.idempotency_dedupe).toBeUndefined();

    expect(dedupe.state_mutation).toBe(false);
    expect(dedupe.state_delta).toBeNull();
    expect(dedupe.idempotency_dedupe).toBe(true);
    expect(dedupe.status).toBe(200);
    expect(dedupe.response_body).toEqual(first.response_body);
  });

  it("F5 — does not cache 4xx responses; a corrected retry hits the handler", async () => {
    // First request returns 400; second request with the same key but
    // a corrected body must be re-executed and return 200, not the
    // cached 400. Real Stripe re-executes on 4xx.
    const db = openTwinStripeDatabase(":memory:");
    applySeed(db, defaultSeed());
    let handlerInvocations = 0;
    const app = createTwinStripeApp({
      db,
      extendSession(session: Hono) {
        session.post("/v1/echo_strict", async (c) => {
          handlerInvocations += 1;
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          if (body.required !== true) {
            return c.json(
              { error: { type: "invalid_request_error", code: "parameter_missing" } },
              400
            );
          }
          return c.json({ ok: true, count: handlerInvocations }, 200);
        });
      }
    });
    const url = `/s/${DEFAULT_SID}/v1/echo_strict`;
    const headers = {
      Authorization: authHeader,
      "content-type": "application/json",
      "Idempotency-Key": "retry-after-400"
    };

    const r1 = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ required: false })
    });
    expect(r1.status).toBe(400);

    const r2 = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ required: true })
    });
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { ok: boolean; count: number };
    expect(body.ok).toBe(true);
    // Handler ran twice — the 400 was NOT cached.
    expect(handlerInvocations).toBe(2);
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
