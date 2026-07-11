// SPDX-License-Identifier: Apache-2.0
// Guards F-647: the agent's auth is env-only — POME_AUTH_TOKEN wins, else a
// JWT is minted from TWIN_AUTH_SECRET, else a loud error naming both options.
// The agent must never probe the twin's on-disk secret (that server↔CLI
// internal path coupling is what broke the old quickstart, F-604). Run with
// `npm test`.
import { verify } from "hono/jwt";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAuthToken } from "../src/index.ts";

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("resolveAuthToken", () => {
  it("passes a pre-minted POME_AUTH_TOKEN through untouched", async () => {
    process.env.POME_AUTH_TOKEN = "pre-minted-token";
    process.env.TWIN_AUTH_SECRET = "x".repeat(64);
    await expect(resolveAuthToken()).resolves.toBe("pre-minted-token");
  });

  it("mints a standalone-session JWT from TWIN_AUTH_SECRET", async () => {
    delete process.env.POME_AUTH_TOKEN;
    const secret = "s".repeat(64);
    process.env.TWIN_AUTH_SECRET = secret;
    const token = await resolveAuthToken();
    const claims = await verify(token, secret, "HS256");
    // `pome twin start` serves the fixed session `/s/standalone`; the JWT
    // `sid` must match or the twin's auth middleware rejects with 401.
    expect(claims.sid).toBe("standalone");
    expect(claims.team_id).toBe("tm_local");
  });

  it("rejects a TWIN_AUTH_SECRET shorter than 32 chars", async () => {
    delete process.env.POME_AUTH_TOKEN;
    process.env.TWIN_AUTH_SECRET = "too-short";
    await expect(resolveAuthToken()).rejects.toThrow(/shorter than 32/);
  });

  it("fails loudly, naming both env options, when no auth is set", async () => {
    delete process.env.POME_AUTH_TOKEN;
    delete process.env.TWIN_AUTH_SECRET;
    await expect(resolveAuthToken()).rejects.toThrow(/POME_AUTH_TOKEN/);
    await expect(resolveAuthToken()).rejects.toThrow(/TWIN_AUTH_SECRET/);
  });
});
