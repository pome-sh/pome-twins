// SPDX-License-Identifier: Apache-2.0
//
// Engine gaps surfaced by the F-684 stripe port (the largest twin, and the
// only one with a root SDK-compat mount). Written test-first per the pilot
// rule: gaps are fixed in the engine, never by re-adding per-twin harness
// code.
//
//   1. `mountSessionAtRoot` — stripe's frozen F3 surface: the same session
//      router answers at the root path (`/v1/*`), bearer alone resolves the
//      session (auth `requirePathSid: false`), root `/healthz` + `/admin/*`
//      stay first-match, and unknown root paths hit the twin's 401 auth wall.
//   2. `sessionHealthz: false` — stripe has NO per-session /healthz (frozen
//      per-twin difference: the path falls to the 501 catch-all).
//   3. `state` hook receives the authenticated session — stripe's state
//      export is account-scoped (`domain.exportState(session.account_id)`).
//   4. `pomeHealth` extras hook — stripe's frozen `/s/:sid/_pome/health`
//      shape carries implementation/tthw_seconds/runtime/recorder extras
//      instead of the engine default `{version, fidelity}`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTwin } from "../src/index.js";
import { createApp } from "../src/server.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;
beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken({ extra: { account_id: `acct_${TEST_SID}` } });
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

function rootMountTwin() {
  return defineTwin({
    id: "rooty",
    version: "0.0.1",
    fidelity: { default: "semantic" },
    domain: () => ({ things: ["a", "b"] }),
    mountSessionAtRoot: true,
    sessionHealthz: false,
    auth: {
      requirePathSid: false,
      allowRawBearer: true,
      unauthorized: () => ({ status: 401, body: { error: { code: "unauthorized" } } }),
      sidMismatch: () => ({ status: 403, body: { error: { code: "forbidden" } } }),
      sessionExtras: (claims) => ({
        account_id: typeof claims.account_id === "string" ? claims.account_id : `acct_${claims.sid}`,
      }),
    },
    state: ({ domain, session }) => ({
      things: domain.things,
      scoped_to: session ? String(session.account_id) : null,
    }),
    pomeHealth: ({ recorder }) => ({
      implementation: "rooty_clone",
      fidelity: "semantic",
      recorder: { events: recorder.events().length, dropped: 0 },
    }),
    admin: {
      reset: () => ({ ok: true }),
    },
    unsupported: () => ({ status: 501, body: { error: { code: "endpoint_not_supported" } } }),
    tools: [
      {
        name: "list_things",
        description: "List things.",
        schema: z.object({}),
        handler: (domain) => ({ things: domain.things }),
        mutation: false,
      },
    ],
    routes: (app, { domain, recorder }) => {
      app.get(
        "/v1/things",
        recorder.handle({ mutation: false }, () => ({ status: 200, body: { things: domain.things } }))
      );
    },
  });
}

describe("mountSessionAtRoot (F-684 gap 1)", () => {
  it("serves the same session routes at the root path with bearer-only auth", async () => {
    const app = createApp(rootMountTwin());
    const viaSid = await app.request(`/s/${TEST_SID}/v1/things`, withAuth(token));
    const viaRoot = await app.request("/v1/things", withAuth(token));
    expect(viaSid.status).toBe(200);
    expect(viaRoot.status).toBe(200);
    expect(await viaRoot.json()).toEqual(await viaSid.json());
  });

  it("keeps root /healthz and /admin/* first-match (not shadowed by the session mount)", async () => {
    const app = createApp(rootMountTwin());
    const healthz = await app.request("/healthz");
    expect(healthz.status).toBe(200);
    expect(((await healthz.json()) as { twin: string }).twin).toBe("rooty");
    const reset = await app.request("/admin/reset", { method: "POST" });
    expect(reset.status).toBe(200);
  });

  it("unknown ROOT route without a token answers the twin's 401 auth wall", async () => {
    const app = createApp(rootMountTwin());
    const res = await app.request("/definitely-not-a-route");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("stays off by default: unknown root routes 404 when mountSessionAtRoot is unset", async () => {
    const twin = defineTwin({
      id: "nomount",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [],
    });
    const app = createApp(twin);
    const res = await app.request("/definitely-not-a-route");
    expect(res.status).toBe(404);
  });
});

describe("sessionHealthz: false (F-684 gap 2)", () => {
  it("GET /s/:sid/healthz falls to the 501 unsupported catch-all", async () => {
    const app = createApp(rootMountTwin());
    const res = await app.request(`/s/${TEST_SID}/healthz`, withAuth(token));
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("endpoint_not_supported");
  });

  it("defaults to the engine 200 {ok, sid} when unset", async () => {
    const twin = defineTwin({
      id: "healthy",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [],
    });
    const app = createApp(twin);
    const res = await app.request(`/s/${TEST_SID}/healthz`, withAuth(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sid: TEST_SID });
  });
});

describe("state hook receives the session (F-684 gap 3)", () => {
  it("passes the bearer-resolved session so state can be account-scoped", async () => {
    const app = createApp(rootMountTwin());
    const res = await app.request(`/s/${TEST_SID}/_pome/state`, withAuth(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scoped_to: string };
    expect(body.scoped_to).toBe(`acct_${TEST_SID}`);
  });
});

describe("pomeHealth extras hook (F-684 gap 4)", () => {
  it("overrides the default {version, fidelity} extras and can read the recorder", async () => {
    const app = createApp(rootMountTwin());
    // Generate one recorded event first so the recorder count is non-zero.
    await app.request(`/s/${TEST_SID}/v1/things`, withAuth(token));
    const res = await app.request(`/s/${TEST_SID}/_pome/health`, withAuth(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.twin).toBe("rooty");
    expect(body.implementation).toBe("rooty_clone");
    expect(body.fidelity).toBe("semantic");
    expect(body.version).toBeUndefined();
    expect((body.recorder as { events: number }).events).toBeGreaterThanOrEqual(1);
  });

  it("keeps the engine default extras when unset", async () => {
    const twin = defineTwin({
      id: "plain",
      version: "9.9.9",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [],
    });
    const app = createApp(twin);
    const res = await app.request(`/s/${TEST_SID}/_pome/health`, withAuth(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, twin: "plain", version: "9.9.9", fidelity: "semantic" });
  });
});
