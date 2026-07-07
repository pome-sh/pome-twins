import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

describe("bearer auth + /s/:sid path prefix", () => {
  it("rejects missing Authorization header", async () => {
    const app = createGitHubCloneApp();
    const response = await app.request(`/s/${TEST_SID}/repos/acme/api`);
    expect(response.status).toBe(401);
  });

  it("rejects bad signature", async () => {
    const app = createGitHubCloneApp();
    const bad = await sign({ sid: TEST_SID, team_id: "tm_x", exp: Math.floor(Date.now() / 1000) + 3600 }, "wrong-secret");
    const response = await app.request(`/s/${TEST_SID}/repos/acme/api`, withAuth(bad));
    expect(response.status).toBe(401);
  });

  it("rejects expired token", async () => {
    const app = createGitHubCloneApp();
    const expired = await signTestToken({ expSeconds: -10 });
    const response = await app.request(`/s/${TEST_SID}/repos/acme/api`, withAuth(expired));
    expect(response.status).toBe(401);
  });

  it("rejects sid mismatch (claim sid != path sid)", async () => {
    const app = createGitHubCloneApp();
    const token = await signTestToken({ sid: "abc" });
    const response = await app.request(`/s/xyz/repos/acme/api`, withAuth(token));
    expect(response.status).toBe(401);
  });

  it("accepts a valid token whose sid matches the path", async () => {
    const app = createGitHubCloneApp();
    const token = await signTestToken();
    const response = await app.request(`/s/${TEST_SID}/repos/acme/api`, withAuth(token));
    expect(response.status).toBe(200);
  });

  it("serves /healthz at root with no auth", async () => {
    const app = createGitHubCloneApp();
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, twin: "github" });
  });

  it("serves /admin/seed at root for in-process callers (treated as localhost)", async () => {
    const app = createGitHubCloneApp();
    const response = await app.request("/admin/reset", { method: "POST" });
    expect(response.status).toBe(200);
  });
});
