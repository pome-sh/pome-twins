// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTwinStripeApp } from "../src/app.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

describe("bearer auth (JWT path)", () => {
  it("rejects a missing Authorization header", async () => {
    const app = createTwinStripeApp();
    const res = await app.request(`/s/${TEST_SID}/_pome/health`);
    expect(res.status).toBe(401);
  });

  it("rejects a bad signature", async () => {
    const app = createTwinStripeApp();
    const bad = await sign(
      { sid: TEST_SID, exp: Math.floor(Date.now() / 1000) + 3600 },
      "wrong-secret"
    );
    const res = await app.request(`/s/${TEST_SID}/_pome/health`, withAuth(bad));
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const app = createTwinStripeApp();
    const expired = await signTestToken({ expSeconds: -10 });
    const res = await app.request(`/s/${TEST_SID}/_pome/health`, withAuth(expired));
    expect(res.status).toBe(401);
  });

  it("rejects sid mismatch with 403 (claim sid != path sid)", async () => {
    const app = createTwinStripeApp();
    const token = await signTestToken({ sid: "abc" });
    const res = await app.request(`/s/xyz/_pome/health`, withAuth(token));
    expect(res.status).toBe(403);
  });

  it("accepts a valid token whose sid matches the path", async () => {
    const app = createTwinStripeApp();
    const token = await signTestToken();
    const res = await app.request(`/s/${TEST_SID}/_pome/health`, withAuth(token));
    expect(res.status).toBe(200);
  });

  it("accepts a bare JWT (no Bearer prefix) for twin-github MCP backwards compat", async () => {
    const app = createTwinStripeApp();
    const token = await signTestToken();
    const res = await app.request(`/s/${TEST_SID}/_pome/health`, {
      headers: { Authorization: token }
    });
    expect(res.status).toBe(200);
  });

  it("accepts a Stripe-shaped fake API key scoped to the session", async () => {
    const app = createTwinStripeApp();
    const res = await app.request(`/s/${TEST_SID}/_pome/health`, withAuth(stripeProviderKey(TEST_SID)));
    expect(res.status).toBe(200);
  });
});

function stripeProviderKey(sid: string) {
  const encodedSid = Buffer.from(sid, "utf8").toString("base64url");
  const sig = createHmac("sha256", TEST_AUTH_SECRET)
    .update(`stripe:${sid}`)
    .digest("base64url")
    .slice(0, 22);
  return `sk_test_pome_${encodedSid}_${sig}`;
}
