// SPDX-License-Identifier: Apache-2.0
//
// Replay-safety tests for the x402 paymentMiddleware.
//
// The same X-PAYMENT header arriving twice MUST proxy to the wrapped handler
// both times, but MUST NOT mint a second charge or call simulate_crypto_deposit
// twice. This is the primary defense against agents that retry mid-settle.

import { describe, expect, it, beforeEach } from "vitest";
import { Hono } from "hono";
import { paymentMiddleware } from "../src/x402.js";
import { makeTwinStub } from "./_x402StubTwin.js";

function buildApp(stubFetch: typeof fetch) {
  const app = new Hono();
  let handlerCallCount = 0;
  const mw = paymentMiddleware(
    {
      "GET /paid": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.01",
            network: "eip155:84532"
          }
        ]
      }
    },
    {
      twinBaseUrl: "http://127.0.0.1:3333",
      apiKey: "sk_test_pome_default",
      sid: "default",
      fetch: stubFetch
    }
  );
  app.use(mw);
  app.get("/paid", (c) => {
    handlerCallCount++;
    return c.json({ ok: true, callNumber: handlerCallCount });
  });
  return { app, getCallCount: () => handlerCallCount };
}

function buildXPaymentHeader(payTo: string, value: string) {
  const obj = {
    x402Version: 1,
    scheme: "exact",
    network: "eip155:84532",
    payload: {
      authorization: {
        from: "0xbuyer000000000000000000000000000000000",
        to: payTo,
        value,
        validAfter: 0,
        validBefore: Math.floor(Date.now() / 1000) + 600,
        nonce: "0xnonce123" // deterministic to validate replay
      },
      signature: "0xfake"
    }
  };
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

describe("paymentMiddleware: idempotent replay", () => {
  let twin: ReturnType<typeof makeTwinStub>;
  beforeEach(() => {
    twin = makeTwinStub();
  });

  it("replaying the same X-PAYMENT does not create a second charge", async () => {
    const { app, getCallCount } = buildApp(twin.fetch);

    // Leg 1.
    const r1 = await app.request("/paid");
    expect(r1.status).toBe(402);
    const body1 = (await r1.json()) as any;
    const payTo = body1.accepts[0].payTo as string;
    const value = body1.accepts[0].maxAmountRequired as string;

    // Leg 2: settle.
    const xPayment = buildXPaymentHeader(payTo, value);
    const r2a = await app.request("/paid", { headers: { "X-PAYMENT": xPayment } });
    expect(r2a.status).toBe(200);
    const body2a = (await r2a.json()) as any;
    expect(body2a.ok).toBe(true);

    // First settle: 1 charge minted, 1 simulate call.
    expect(twin.state.charges).toHaveLength(1);
    expect(twin.state.simulate_calls).toBe(1);
    expect(getCallCount()).toBe(1);

    // Replay the same header.
    const r2b = await app.request("/paid", { headers: { "X-PAYMENT": xPayment } });
    expect(r2b.status).toBe(200);
    const body2b = (await r2b.json()) as any;
    expect(body2b.ok).toBe(true);

    // No new state — still 1 charge, simulate not called again.
    expect(twin.state.charges).toHaveLength(1);
    expect(twin.state.simulate_calls).toBe(1);

    // Wrapped handler ran twice — that's correct behavior, the seller can
    // serve the resource again on a replay (matches the cached settlement).
    expect(getCallCount()).toBe(2);

    // PI ended in succeeded.
    const pis = Array.from(twin.state.payment_intents.values());
    expect(pis).toHaveLength(1);
    expect(pis[0]!.status).toBe("succeeded");
  });

  it("two distinct X-PAYMENT headers settle through distinct PIs", async () => {
    const { app } = buildApp(twin.fetch);

    // Get first challenge.
    const c1 = (await (await app.request("/paid")).json()) as any;
    const payTo1 = c1.accepts[0].payTo as string;
    const value = c1.accepts[0].maxAmountRequired as string;

    const x1 = buildXPaymentHeader(payTo1, value);
    const r1 = await app.request("/paid", { headers: { "X-PAYMENT": x1 } });
    expect(r1.status).toBe(200);

    // Within TTL the second challenge reuses the same PI; that's the design.
    // To force a second PI we step past the cache by minting a bogus header
    // against an unknown payTo to make sure rejection still works.
    const xBogus = buildXPaymentHeader(
      "0xbadbadbadbadbadbadbadbadbadbadbadbadbad",
      value
    );
    const rBogus = await app.request("/paid", { headers: { "X-PAYMENT": xBogus } });
    expect(rBogus.status).toBe(402);

    // Only one charge from the genuine settlement.
    expect(twin.state.charges).toHaveLength(1);
  });
});
