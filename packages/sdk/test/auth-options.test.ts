// SPDX-License-Identifier: Apache-2.0
//
// Engine auth option tests (F-681, spec = F-712 [DECISION] rows 2–9).
// Mechanism lives in the engine; each twin's intended differences are
// explicit `defineTwin()` auth options, never forks. Each row's pinned
// behavior is exercised here with the real middleware on a real Hono app.
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PROVIDER_SHAPED_TEAM_ID,
  bearerAuth,
  formTokenResolver,
  mintProviderToken,
  queryTokenResolver,
  type BearerAuthOptions,
} from "../src/auth.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

function sessionApp(options?: BearerAuthOptions) {
  const app = new Hono();
  const session = new Hono();
  session.use("*", bearerAuth(options));
  session.get("/whoami", (c) => c.json(c.get("session" as never) as Record<string, unknown>));
  app.route("/s/:sid", session);
  return app;
}

const path = `/s/${TEST_SID}/whoami`;

describe("unauthorized(kind) envelope hook (rows 2 + 6)", () => {
  const slackish: BearerAuthOptions = {
    unauthorized: (kind) => ({
      status: 401,
      body: { ok: false, error: kind === "no_token" ? "not_authed" : kind === "expired" ? "token_expired" : "invalid_auth" },
    }),
  };

  it("classifies a missing token as no_token", async () => {
    const res = await sessionApp(slackish).request(path);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "not_authed" });
  });

  it("classifies a garbage token as invalid", async () => {
    const res = await sessionApp(slackish).request(path, withAuth("garbage"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_auth" });
  });

  it("classifies an expired JWT as expired (engine-side classification)", async () => {
    const expired = await signTestToken({ expSeconds: -60 });
    const res = await sessionApp(slackish).request(path, withAuth(expired));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "token_expired" });
  });

  it("defaults to the frozen github-shaped envelope, expired included (github wire: Bad credentials)", async () => {
    const expired = await signTestToken({ expSeconds: -60 });
    const res = await sessionApp().request(path, withAuth(expired));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Bad credentials", documentation_url: "" });
  });
});

describe("raw bearer pin (row 4)", () => {
  it("rejects a prefix-less bearer by default (github/slack pin)", async () => {
    const token = await signTestToken();
    const res = await sessionApp().request(path, { headers: { Authorization: token } });
    expect(res.status).toBe(401);
  });

  it("accepts a prefix-less bearer and case-insensitive 'bearer' when allowRawBearer is set (stripe pin)", async () => {
    const token = await signTestToken();
    const raw = await sessionApp({ allowRawBearer: true }).request(path, {
      headers: { Authorization: token },
    });
    expect(raw.status).toBe(200);
    const lower = await sessionApp({ allowRawBearer: true }).request(path, {
      headers: { Authorization: `bearer ${token}` },
    });
    expect(lower.status).toBe(200);
  });
});

describe("sid mismatch pin (row 5)", () => {
  it("defaults to the frozen 401 Forbidden envelope", async () => {
    const other = await signTestToken({ sid: "other-sid" });
    const res = await sessionApp().request(path, withAuth(other));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Forbidden", documentation_url: "" });
  });

  it("renders the twin's pinned mismatch envelope (stripe: 403)", async () => {
    const other = await signTestToken({ sid: "other-sid" });
    const res = await sessionApp({
      sidMismatch: () => ({ status: 403, body: { error: { code: "forbidden", message: "Session id mismatch." } } }),
    }).request(path, withAuth(other));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
  });
});

describe("token resolvers (row 3)", () => {
  const resolvers: BearerAuthOptions = {
    tokenResolvers: [queryTokenResolver("token"), formTokenResolver("token")],
  };

  it("accepts ?token= in the query string", async () => {
    const token = await signTestToken();
    const res = await sessionApp(resolvers).request(`${path}?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
  });

  it("accepts token= in a form-encoded body", async () => {
    const app = new Hono();
    const session = new Hono();
    session.use("*", bearerAuth(resolvers));
    session.post("/act", (c) => c.json({ ok: true }));
    app.route("/s/:sid", session);
    const token = await signTestToken();
    const res = await app.request(`/s/${TEST_SID}/act`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    expect(res.status).toBe(200);
  });

  it("still prefers the Authorization header when present", async () => {
    const token = await signTestToken();
    const res = await sessionApp(resolvers).request(`${path}?token=garbage`, withAuth(token));
    expect(res.status).toBe(200);
  });
});

describe("provider-shaped tokens in the middleware (rows 1 + 7)", () => {
  const options: BearerAuthOptions = {
    providerToken: { provider: "slack", prefixes: ["xoxb-pome-", "xoxp-pome-"] },
    providerSession: () => ({ login: "pome-agent" }),
  };

  it("authenticates a minted provider token and marks the session provider-shaped", async () => {
    const token = mintProviderToken(
      { provider: "slack", prefixes: ["xoxb-pome-"] },
      { sid: TEST_SID, secret: TEST_AUTH_SECRET }
    );
    const res = await sessionApp(options).request(path, withAuth(token));
    expect(res.status).toBe(200);
    const session = (await res.json()) as Record<string, unknown>;
    expect(session.sid).toBe(TEST_SID);
    expect(session.team_id).toBe(PROVIDER_SHAPED_TEAM_ID);
    expect(session.login).toBe("pome-agent");
  });

  it("rejects a provider token for another session via the mismatch envelope", async () => {
    const token = mintProviderToken(
      { provider: "slack", prefixes: ["xoxb-pome-"] },
      { sid: "other-sid", secret: TEST_AUTH_SECRET }
    );
    const res = await sessionApp(options).request(path, withAuth(token));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Forbidden", documentation_url: "" });
  });
});

describe("resolveCredential hook (row 8)", () => {
  it("resolves a DB-backed credential before JWT verification", async () => {
    const res = await sessionApp({
      resolveCredential: (token) =>
        token === "sk_test_pome_known" ? { sid: TEST_SID, account_id: "acct_1", via: "api_key" } : undefined,
    }).request(path, { headers: { Authorization: "Bearer sk_test_pome_known" } });
    expect(res.status).toBe(200);
    const session = (await res.json()) as Record<string, unknown>;
    expect(session.account_id).toBe("acct_1");
  });

  it("falls through to JWT when the hook returns undefined", async () => {
    const token = await signTestToken();
    const res = await sessionApp({ resolveCredential: () => undefined }).request(path, withAuth(token));
    expect(res.status).toBe(200);
  });

  it("enforces the path-sid match on hook-resolved sessions", async () => {
    const res = await sessionApp({
      resolveCredential: () => ({ sid: "other-sid" }),
    }).request(path, { headers: { Authorization: "Bearer sk_test_pome_known" } });
    expect(res.status).toBe(401);
  });
});

describe("mount mode (row 9)", () => {
  it("requirePathSid=false trusts the bearer alone on sid-less mounts (stripe /v1)", async () => {
    const app = new Hono();
    const v1 = new Hono();
    v1.use("*", bearerAuth({ requirePathSid: false, allowRawBearer: true }));
    v1.get("/charges", (c) => c.json(c.get("session" as never) as Record<string, unknown>));
    app.route("/v1", v1);
    const token = await signTestToken();
    const res = await app.request("/v1/charges", { headers: { Authorization: token } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sid: string }).sid).toBe(TEST_SID);
  });

  it("still enforces the match when a path sid IS present", async () => {
    const other = await signTestToken({ sid: "other-sid" });
    const res = await sessionApp({ requirePathSid: false }).request(path, withAuth(other));
    expect(res.status).toBe(401);
  });
});

describe("session extras (row 7)", () => {
  it("copies declared extra claims into the session via sessionExtras", async () => {
    const token = await signTestToken();
    // _authHelper signs {sid, team_id, exp}; extras hook derives login.
    const res = await sessionApp({
      sessionExtras: (claims) => ({ login: `user-of-${claims.team_id as string}` }),
    }).request(path, withAuth(token));
    expect(res.status).toBe(200);
    const session = (await res.json()) as Record<string, unknown>;
    expect(session.login).toBe("user-of-tm_test");
  });
});
