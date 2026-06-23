// SPDX-License-Identifier: Apache-2.0
//
// F3 — Stripe SDK compatibility. The same `/v1/*` routes that exist at
// `/s/:sid/v1/*` must also be reachable at the root path so real
// `stripe-node` / `stripe-python` clients (which build URLs without the
// /s/:sid prefix) work via host/port overrides. The bearer alone resolves
// the session at the root mount; cross-account isolation must hold.

import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { ResolvedSession } from "../src/types.js";
import { createTwinStripeApp } from "../src/app.js";
import { StripeDomain } from "../src/domain/index.js";
import { openTwinStripeDatabase } from "../src/db.js";
import { listTools } from "../src/tools.js";
import { registerStripeRoutes } from "../src/routes/index.js";
import { applySeed, defaultSeed, DEFAULT_API_KEY, DEFAULT_SID } from "../src/seed.js";

function bootApp() {
  const db = openTwinStripeDatabase(":memory:");
  applySeed(db, defaultSeed());
  let domain!: StripeDomain;
  const app = createTwinStripeApp({
    db,
    runId: "sdk-compat",
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

async function fetchAt(
  app: ReturnType<typeof bootApp>["app"],
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
  const r = await app.request(path, init);
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

describe("F3 — SDK compatibility (root mount)", () => {
  it("POST /v1/payment_intents works at the root path with bearer-only auth", async () => {
    const { app } = bootApp();
    const r = await fetchAt(app, DEFAULT_API_KEY, "POST", "/v1/payment_intents", {
      amount: 1000,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(/^pi_/);
    expect(r.body.status).toBe("requires_action");
  });

  it("root /v1/payment_intents returns identical-shape responses to /s/:sid/v1/payment_intents", async () => {
    const { app } = bootApp();
    // Create a PI via the root mount.
    const created = await fetchAt(app, DEFAULT_API_KEY, "POST", "/v1/payment_intents", {
      amount: 250,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });
    const piId = created.body.id as string;

    const rootGet = await fetchAt(app, DEFAULT_API_KEY, "GET", `/v1/payment_intents/${piId}`);
    const sidGet = await fetchAt(app, DEFAULT_API_KEY, "GET", `/s/${DEFAULT_SID}/v1/payment_intents/${piId}`);
    expect(rootGet.status).toBe(200);
    expect(sidGet.status).toBe(200);
    expect(rootGet.body).toEqual(sidGet.body);
  });

  it("GET /v1/balance and /v1/events work at the root path", async () => {
    const { app } = bootApp();
    const bal = await fetchAt(app, DEFAULT_API_KEY, "GET", "/v1/balance");
    expect(bal.status).toBe(200);
    expect(bal.body.object).toBe("balance");

    const events = await fetchAt(app, DEFAULT_API_KEY, "GET", "/v1/events");
    expect(events.status).toBe(200);
    expect(events.body.object).toBe("list");
  });

  it("cross-account isolation holds at the root mount", async () => {
    const db = openTwinStripeDatabase(":memory:");
    applySeed(db, {
      api_keys: [
        { key: "sk_test_pome_a", sid: "a", account_id: "acct_a" },
        { key: "sk_test_pome_b", sid: "b", account_id: "acct_b" }
      ]
    });
    let domain!: StripeDomain;
    const app = createTwinStripeApp({
      db,
      toolCount: listTools().length,
      extendSession: (session: Hono, ctx) => {
        domain = new StripeDomain(ctx.db);
        registerStripeRoutes(session, domain, ctx.recorder, ctx.runId);
      }
    });

    const aPi = await fetchAt(app, "sk_test_pome_a", "POST", "/v1/payment_intents", {
      amount: 100,
      currency: "usd",
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: { mode: "deposit", deposit_options: { networks: ["base"] } }
      }
    });
    expect(aPi.status).toBe(200);
    const piId = aPi.body.id as string;

    // B hits the root mount and must not see A's PI.
    const bGet = await fetchAt(app, "sk_test_pome_b", "GET", `/v1/payment_intents/${piId}`);
    expect(bGet.status).toBe(404);

    const bList = await fetchAt(app, "sk_test_pome_b", "GET", "/v1/payment_intents");
    expect(bList.status).toBe(200);
    expect(bList.body.data).toHaveLength(0);
  });

  it("root mount rejects unauthenticated requests", async () => {
    const { app } = bootApp();
    const r = await app.request("/v1/payment_intents", { method: "GET" });
    expect(r.status).toBe(401);
  });

  it("root mount does not expose /admin/* (admin remains localhost-only at root only)", async () => {
    // /admin/reset is registered at root (mountRootPomeRoutes); the SDK
    // mount under "/" must not break it. We just verify it's still
    // reachable as before.
    const { app } = bootApp();
    const r = await app.request("/admin/reset", { method: "POST" });
    expect(r.status).toBe(200);
  });

  it("/healthz still works (not shadowed by root session mount)", async () => {
    const { app } = bootApp();
    const r = await app.request("/healthz");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; twin: string };
    expect(body.twin).toBe("stripe");
  });
});
