import { beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import { mintProviderToken } from "@pome-sh/sdk/server";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState } from "../src/seed.js";
import { signTestToken, TEST_AUTH_SECRET, TEST_SID } from "./_authHelper.js";

// Token minting goes through the engine (F-712 row 10): the per-twin
// signSlackProviderToken died with the F-683 port.
const SLACK_TOKEN_SPEC = { provider: "slack", prefixes: ["xoxb-pome-", "xoxp-pome-"] } as const;
function signSlackProviderToken(
  sid: string,
  secret: string,
  prefix: "xoxb" | "xoxp" = "xoxb",
  exp?: number
) {
  return mintProviderToken(SLACK_TOKEN_SPEC, { sid, secret, prefix: `${prefix}-pome-`, exp });
}

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
});

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return createSlackTwinApp({ db, domain, runId: "auth-test" });
}

describe("auth middleware", () => {
  it("rejects missing Authorization header", async () => {
    const app = freshApp();
    const res = await app.request(`/s/${TEST_SID}/auth.test`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("not_authed");
  });

  it("rejects malformed bearer token", async () => {
    const app = freshApp();
    const res = await app.request(`/s/${TEST_SID}/auth.test`, {
      headers: { Authorization: "Bearer garbage" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects expired tokens", async () => {
    const app = freshApp();
    const expired = await sign(
      { sid: TEST_SID, team_id: "tm_test", exp: Math.floor(Date.now() / 1000) - 60 },
      TEST_AUTH_SECRET
    );
    const res = await app.request(`/s/${TEST_SID}/auth.test`, { headers: { Authorization: `Bearer ${expired}` } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("token_expired");
  });

  it("rejects sid mismatch", async () => {
    const app = freshApp();
    const tokenForOther = await signTestToken({ sid: "wrong-session" });
    const res = await app.request(`/s/${TEST_SID}/auth.test`, {
      headers: { Authorization: `Bearer ${tokenForOther}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts xoxb-pome provider-shape token", async () => {
    const app = freshApp();
    const token = signSlackProviderToken(TEST_SID, TEST_AUTH_SECRET, "xoxb");
    const res = await app.request(`/s/${TEST_SID}/auth.test`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("accepts xoxp-pome provider-shape token", async () => {
    const app = freshApp();
    const token = signSlackProviderToken(TEST_SID, TEST_AUTH_SECRET, "xoxp");
    const res = await app.request(`/s/${TEST_SID}/auth.test`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("rejects provider-shape token with wrong sig", async () => {
    const app = freshApp();
    const goodToken = signSlackProviderToken(TEST_SID, TEST_AUTH_SECRET, "xoxb");
    const tampered = goodToken.replace(/_(.+)$/, "_AAAAAAAAAAAAAAAAAAAAAA");
    const res = await app.request(`/s/${TEST_SID}/auth.test`, { headers: { Authorization: `Bearer ${tampered}` } });
    expect(res.status).toBe(401);
  });

  it("accepts provider token when session id contains hyphens (underscore delimiter)", async () => {
    const app = freshApp();
    const sid = "session-with-hyphens";
    const token = signSlackProviderToken(sid, TEST_AUTH_SECRET, "xoxb");
    const res = await app.request(`/s/${sid}/auth.test`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_id: string };
    expect(body.user_id).toBe("U_PRIMARY");
  });

  it("rejects JWT with unknown login claim", async () => {
    const app = freshApp();
    const token = await signTestToken({ login: "mallory" });
    const res = await app.request(`/s/${TEST_SID}/auth.test`, { headers: { Authorization: `Bearer ${token}` } });
    // Domain error inside an endpoint handler — Slack returns 200 + {ok:false, error}.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("user_not_found");
  });

  it("rejects provider-shape token with sid mismatch", async () => {
    const app = freshApp();
    const otherSidToken = signSlackProviderToken("different-sid", TEST_AUTH_SECRET);
    const res = await app.request(`/s/${TEST_SID}/auth.test`, {
      headers: { Authorization: `Bearer ${otherSidToken}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts xoxb-pome token with exp segment", async () => {
    const app = freshApp();
    const exp = Math.floor(Date.now() / 1000) + 600;
    const token = signSlackProviderToken(TEST_SID, TEST_AUTH_SECRET, "xoxb", exp);
    // Shape: xoxb-pome-<base64url(sid)>_<exp_seconds>_<sig>. The exp is digits-only
    // so the new shape is unambiguously identifiable.
    expect(token).toMatch(/^xoxb-pome-[A-Za-z0-9_-]+_\d+_[A-Za-z0-9_-]+$/);
    const res = await app.request(`/s/${TEST_SID}/auth.test`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("rejects expired xoxb-pome token (exp shape)", async () => {
    const app = freshApp();
    const exp = Math.floor(Date.now() / 1000) - 60;
    const token = signSlackProviderToken(TEST_SID, TEST_AUTH_SECRET, "xoxb", exp);
    const res = await app.request(`/s/${TEST_SID}/auth.test`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("accepts ?token= query string fallback", async () => {
    const app = freshApp();
    const token = await signTestToken();
    const res = await app.request(`/s/${TEST_SID}/auth.test?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
  });

  it("accepts token=<jwt> in form-encoded POST body", async () => {
    const app = freshApp();
    const token = await signTestToken();
    const form = new URLSearchParams({ token, channel: "C_GENERAL", text: "hi-form-auth" });
    const res = await app.request(`/s/${TEST_SID}/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("rejects exp-shape token signed without exp in HMAC payload", async () => {
    const app = freshApp();
    // Build a token that looks 4-segment but the sig is the legacy 3-segment sig.
    const exp = Math.floor(Date.now() / 1000) + 600;
    const legacy = signSlackProviderToken(TEST_SID, TEST_AUTH_SECRET, "xoxb");
    const [prefix, _pome, rest] = legacy.split("-");
    void _pome;
    const [sidB64, legacySig] = rest!.split("_");
    const forged = `${prefix}-pome-${sidB64}_${exp}_${legacySig}`;
    const res = await app.request(`/s/${TEST_SID}/auth.test`, { headers: { Authorization: `Bearer ${forged}` } });
    expect(res.status).toBe(401);
  });
});
