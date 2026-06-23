// SPDX-License-Identifier: Apache-2.0
//
// F1 — cross-account scoping. With two sessions (sid=a, sid=b) sharing a
// single DB file (the OSS package supports this; cloud's per-VM-per-session
// arch hides it but the lib must be safe outside that exact deployment),
// session B must not be able to read, list, settle, cancel, or see in
// events anything created by session A.

import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { ResolvedSession } from "../src/types.js";
import { createTwinStripeApp } from "../src/app.js";
import { StripeDomain } from "../src/domain/index.js";
import { openTwinStripeDatabase } from "../src/db.js";
import { listTools } from "../src/tools.js";
import { registerStripeRoutes } from "../src/routes/index.js";
import { applySeed } from "../src/seed.js";

const KEY_A = "sk_test_pome_a";
const KEY_B = "sk_test_pome_b";
const SID_A = "a";
const SID_B = "b";

function bootSharedDbApp() {
  const db = openTwinStripeDatabase(":memory:");
  // Two api keys → two sessions in the same DB.
  applySeed(db, {
    api_keys: [
      { key: KEY_A, sid: SID_A, account_id: `acct_${SID_A}` },
      { key: KEY_B, sid: SID_B, account_id: `acct_${SID_B}` }
    ]
  });
  let domain!: StripeDomain;
  const app = createTwinStripeApp({
    db,
    runId: "scope-test",
    toolCount: listTools().length,
    extendSession: (session: Hono, ctx) => {
      domain = new StripeDomain(ctx.db);
      registerStripeRoutes(session, domain, ctx.recorder, ctx.runId);
      return {
        stateProvider: (_c, sess: ResolvedSession | undefined) => {
          if (!sess) return {};
          return domain.exportState(sess.account_id);
        }
      };
    }
  });
  return { app, db };
}

async function rest(
  app: ReturnType<typeof bootSharedDbApp>["app"],
  sid: string,
  key: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method };
  const headers = new Headers({ Authorization: `Bearer ${key}` });
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  init.headers = headers;
  const r = await app.request(`/s/${sid}${path}`, init);
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

describe("F1 — cross-account isolation", () => {
  it("session B cannot retrieve session A's PI", async () => {
    const { app } = bootSharedDbApp();
    const create = await rest(app, SID_A, KEY_A, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });
    expect(create.status).toBe(200);
    const piId = create.body.id as string;

    // A can retrieve.
    const a = await rest(app, SID_A, KEY_A, "GET", `/v1/payment_intents/${piId}`);
    expect(a.status).toBe(200);
    expect(a.body.id).toBe(piId);

    // B cannot — must be 404 (not 200 with someone else's PI).
    const b = await rest(app, SID_B, KEY_B, "GET", `/v1/payment_intents/${piId}`);
    expect(b.status).toBe(404);
    expect(b.body.error.code).toBe("resource_missing");
  });

  it("session B's list_payment_intents returns only B's PIs", async () => {
    const { app } = bootSharedDbApp();
    // A creates 2 PIs.
    for (let i = 0; i < 2; i++) {
      await rest(app, SID_A, KEY_A, "POST", "/v1/payment_intents", {
        amount: 100 + i,
        currency: "usd",
        payment_method_types: ["crypto"],
        payment_method_options: {
          crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
        }
      });
    }
    // B creates 1.
    await rest(app, SID_B, KEY_B, "POST", "/v1/payment_intents", {
      amount: 999,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });

    const aList = await rest(app, SID_A, KEY_A, "GET", "/v1/payment_intents");
    expect(aList.status).toBe(200);
    expect(aList.body.data).toHaveLength(2);

    const bList = await rest(app, SID_B, KEY_B, "GET", "/v1/payment_intents");
    expect(bList.status).toBe(200);
    expect(bList.body.data).toHaveLength(1);
    expect(bList.body.data[0].amount).toBe(999);
  });

  it("session B cannot settle session A's PI via simulate_crypto_deposit", async () => {
    const { app } = bootSharedDbApp();
    const create = await rest(app, SID_A, KEY_A, "POST", "/v1/payment_intents", {
      amount: 500,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });
    const piId = create.body.id as string;

    // B tries to settle A's PI — must be 404.
    const settle = await rest(
      app,
      SID_B,
      KEY_B,
      "POST",
      `/v1/test_helpers/payment_intents/${piId}/simulate_crypto_deposit`
    );
    expect(settle.status).toBe(404);
    expect(settle.body.error.code).toBe("resource_missing");

    // A's PI must still be in requires_action (B's call was a no-op).
    const a = await rest(app, SID_A, KEY_A, "GET", `/v1/payment_intents/${piId}`);
    expect(a.body.status).toBe("requires_action");
  });

  it("session B cannot cancel session A's PI", async () => {
    const { app } = bootSharedDbApp();
    const create = await rest(app, SID_A, KEY_A, "POST", "/v1/payment_intents", {
      amount: 500,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });
    const piId = create.body.id as string;
    const cancel = await rest(
      app,
      SID_B,
      KEY_B,
      "POST",
      `/v1/payment_intents/${piId}/cancel`
    );
    expect(cancel.status).toBe(404);
    const a = await rest(app, SID_A, KEY_A, "GET", `/v1/payment_intents/${piId}`);
    expect(a.body.status).toBe("requires_action");
  });

  it("session B's balance reflects only B's settled PIs", async () => {
    const { app } = bootSharedDbApp();
    // A creates and settles a $5 PI.
    const aPi = await rest(app, SID_A, KEY_A, "POST", "/v1/payment_intents", {
      amount: 500,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });
    await rest(
      app,
      SID_A,
      KEY_A,
      "POST",
      `/v1/test_helpers/payment_intents/${aPi.body.id}/simulate_crypto_deposit`
    );

    // B's balance must be empty.
    const bBal = await rest(app, SID_B, KEY_B, "GET", "/v1/balance");
    expect(bBal.status).toBe(200);
    expect(bBal.body.available).toEqual([]);

    // A's balance reflects 500.
    const aBal = await rest(app, SID_A, KEY_A, "GET", "/v1/balance");
    const usd = aBal.body.available.find((row: any) => row.currency === "usd");
    expect(usd?.amount).toBe(500);
  });

  it("session B's events list does not include session A's events", async () => {
    const { app } = bootSharedDbApp();
    await rest(app, SID_A, KEY_A, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });

    const aEvents = await rest(app, SID_A, KEY_A, "GET", "/v1/events");
    expect(aEvents.status).toBe(200);
    expect(aEvents.body.data.length).toBeGreaterThan(0);

    const bEvents = await rest(app, SID_B, KEY_B, "GET", "/v1/events");
    expect(bEvents.status).toBe(200);
    expect(bEvents.body.data).toHaveLength(0);
  });

  it("session B's _pome/state shows only B's data", async () => {
    const { app } = bootSharedDbApp();
    await rest(app, SID_A, KEY_A, "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });

    const aState = await rest(app, SID_A, KEY_A, "GET", "/_pome/state");
    expect(aState.status).toBe(200);
    expect(aState.body.payment_intents).toHaveLength(1);

    const bState = await rest(app, SID_B, KEY_B, "GET", "/_pome/state");
    expect(bState.status).toBe(200);
    expect(bState.body.payment_intents).toHaveLength(0);
    expect(bState.body.events).toHaveLength(0);
  });
});
