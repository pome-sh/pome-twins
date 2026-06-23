// SPDX-License-Identifier: Apache-2.0
//
// Tests for the seller-side x402 paymentMiddleware().
//
// AGENT-B's PI domain may not exist yet at the moment these tests run, so we
// stub the twin via an injected `fetch` that mimics the documented contract.
// When AGENT-B lands, swap the stub for real HTTP and the tests still pass.

import { describe, expect, it, beforeEach } from "vitest";
import { Hono } from "hono";
import { paymentMiddleware } from "../src/x402.js";
import { makeTwinStub } from "./_x402StubTwin.js";

function buildApp(stubFetch: typeof fetch) {
  const app = new Hono();
  const mw = paymentMiddleware(
    {
      "GET /paid": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.01",
            network: "eip155:84532"
          }
        ],
        description: "Data retrieval endpoint",
        mimeType: "application/json"
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
  app.get("/paid", (c) => c.json({ ok: true, secret: "exclusive" }));
  return { app, mw };
}

function buildXPaymentHeader(args: {
  to: string;
  value: string;
  network?: string;
  from?: string;
}) {
  const obj = {
    x402Version: 1,
    scheme: "exact",
    network: args.network ?? "eip155:84532",
    payload: {
      authorization: {
        from: args.from ?? "0xbuyer000000000000000000000000000000000",
        to: args.to,
        value: args.value,
        validAfter: 0,
        validBefore: Math.floor(Date.now() / 1000) + 600,
        nonce: "0xnonce" + Math.random().toString(36).slice(2)
      },
      signature: "0xfake"
    }
  };
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

describe("paymentMiddleware: 402 challenge body", () => {
  let twin: ReturnType<typeof makeTwinStub>;
  beforeEach(() => {
    twin = makeTwinStub();
  });

  it("returns 402 with accepts body when X-PAYMENT is missing", async () => {
    const { app } = buildApp(twin.fetch);
    const res = await app.request("/paid");
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.x402Version).toBe(1);
    expect(body.error).toBe("payment required");
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts).toHaveLength(1);
    const a0 = body.accepts[0];
    expect(a0.scheme).toBe("exact");
    expect(a0.network).toBe("eip155:84532");
    expect(a0.maxAmountRequired).toBe("10000"); // $0.01 USDC = 10000 base units
    expect(a0.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(a0.asset).toBe("USDC");
    expect(twin.state.payment_intents.size).toBe(1);
  });

  it("does not gate non-configured routes", async () => {
    const { app } = buildApp(twin.fetch);
    app.get("/free", (c) => c.json({ ok: true }));
    const res = await app.request("/free");
    expect(res.status).toBe(200);
    expect(twin.state.payment_intents.size).toBe(0);
  });

  it("matches routes mounted under a hosted /s/:sid prefix", async () => {
    const app = new Hono();
    app.use(paymentMiddleware(
      {
        "GET /paid": {
          accepts: [{ scheme: "exact", price: "$0.01", network: "eip155:84532" }]
        }
      },
      {
        twinBaseUrl: "http://127.0.0.1:3333",
        apiKey: "sk_test_pome_default",
        sid: "default",
        fetch: twin.fetch
      }
    ));
    app.get("/s/:sid/paid", (c) => c.json({ ok: true }));

    const res = await app.request("/s/ses_test/paid");
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.accepts[0].payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("paymentMiddleware: happy path", () => {
  let twin: ReturnType<typeof makeTwinStub>;
  beforeEach(() => {
    twin = makeTwinStub();
  });

  it("settles the PI and proxies the handler when X-PAYMENT matches", async () => {
    const { app } = buildApp(twin.fetch);

    // Leg 1: get the challenge to learn the payTo.
    const r1 = await app.request("/paid");
    expect(r1.status).toBe(402);
    const body1 = (await r1.json()) as any;
    const payTo = body1.accepts[0].payTo as string;
    const value = body1.accepts[0].maxAmountRequired as string;

    // Leg 2: send X-PAYMENT.
    const xPayment = buildXPaymentHeader({ to: payTo, value });
    const r2 = await app.request("/paid", {
      headers: { "X-PAYMENT": xPayment }
    });
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as any;
    expect(body2).toEqual({ ok: true, secret: "exclusive" });

    // x402 spec: the seller SHOULD echo a base64 success blob.
    expect(r2.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();

    // PI is succeeded.
    const pis = Array.from(twin.state.payment_intents.values());
    expect(pis).toHaveLength(1);
    expect(pis[0]!.status).toBe("succeeded");
  });
});

describe("paymentMiddleware: rejection paths", () => {
  let twin: ReturnType<typeof makeTwinStub>;
  beforeEach(() => {
    twin = makeTwinStub();
  });

  it("returns 402 when X-PAYMENT.authorization.to is bogus (unknown payTo)", async () => {
    const { app } = buildApp(twin.fetch);

    // Skip leg 1 — go straight to leg 2 with a made-up address.
    const xPayment = buildXPaymentHeader({
      to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      value: "10000"
    });
    const r = await app.request("/paid", {
      headers: { "X-PAYMENT": xPayment }
    });
    expect(r.status).toBe(402);
    const body = (await r.json()) as any;
    expect(body.error).toMatch(/does not match any active challenge/);
    expect(Array.isArray(body.accepts)).toBe(true);
  });

  it("returns 402 when X-PAYMENT.authorization.value mismatches the price", async () => {
    const { app } = buildApp(twin.fetch);

    const r1 = await app.request("/paid");
    const body1 = (await r1.json()) as any;
    const payTo = body1.accepts[0].payTo as string;

    const xPayment = buildXPaymentHeader({ to: payTo, value: "5" }); // wrong amount
    const r2 = await app.request("/paid", {
      headers: { "X-PAYMENT": xPayment }
    });
    expect(r2.status).toBe(402);
    const body2 = (await r2.json()) as any;
    expect(body2.error).toMatch(/value=5 does not match required 10000/);
  });

  it("returns 402 when X-PAYMENT is malformed", async () => {
    const { app } = buildApp(twin.fetch);
    const r = await app.request("/paid", {
      headers: { "X-PAYMENT": "not-base64-json!!!" }
    });
    expect(r.status).toBe(402);
    const body = (await r.json()) as any;
    expect(body.error).toMatch(/X-PAYMENT/);
  });

  it("returns 402 when network mismatches", async () => {
    const { app } = buildApp(twin.fetch);
    const r1 = await app.request("/paid");
    const body1 = (await r1.json()) as any;
    const payTo = body1.accepts[0].payTo as string;
    const value = body1.accepts[0].maxAmountRequired as string;

    const xPayment = buildXPaymentHeader({
      to: payTo,
      value,
      network: "eip155:1" // wrong chain
    });
    const r2 = await app.request("/paid", {
      headers: { "X-PAYMENT": xPayment }
    });
    expect(r2.status).toBe(402);
    const body2 = (await r2.json()) as any;
    expect(body2.error).toMatch(/network=eip155:1/);
  });
});
