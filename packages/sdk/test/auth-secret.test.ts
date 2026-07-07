// SPDX-License-Identifier: Apache-2.0
// Moved from packages/twin-slack/test (F-683): the secret-resolution
// mechanism is the engine's, so its unit coverage lives with the engine.
import { afterEach, describe, expect, it } from "vitest";
import { resolveAuthSecret } from "../src/auth.js";

describe("resolveAuthSecret", () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSecret = process.env.TWIN_AUTH_SECRET;

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
    else process.env.TWIN_AUTH_SECRET = prevSecret;
  });

  it("throws when NODE_ENV=production and secret missing", () => {
    delete process.env.TWIN_AUTH_SECRET;
    process.env.NODE_ENV = "production";
    expect(() => resolveAuthSecret()).toThrow(/TWIN_AUTH_SECRET required/);
  });

  it("returns dev fallback when secret missing outside production", () => {
    delete process.env.TWIN_AUTH_SECRET;
    delete process.env.NODE_ENV;
    expect(resolveAuthSecret()).toBe("dev-only-insecure-secret");
  });
});
