// SPDX-License-Identifier: Apache-2.0
// Admin-gate coverage for twin-github (F-682): the gate MECHANISM (token
// mode, loopback socket check, production fail-closed) is the engine's and
// is covered by the sdk + contract suites; what this file pins is the
// github-shaped 403 {message: "Forbidden"} envelope — the gate's default —
// rendered through the real app.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";

describe("admin gate — token mode renders the github envelope", () => {
  beforeEach(() => {
    process.env.TWIN_ADMIN_TOKEN = "super-secret-admin-token";
  });
  afterEach(() => {
    delete process.env.TWIN_ADMIN_TOKEN;
  });

  it("rejects missing X-Admin-Token with the Forbidden message", async () => {
    const app = createGitHubCloneApp();
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("Forbidden");
  });

  it("rejects wrong X-Admin-Token", async () => {
    const app = createGitHubCloneApp();
    const res = await app.request("/admin/reset", {
      method: "POST",
      headers: { "X-Admin-Token": "wrong" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe("Forbidden");
  });

  it("accepts the correct X-Admin-Token (case-insensitive header)", async () => {
    const app = createGitHubCloneApp();
    const res = await app.request("/admin/reset", {
      method: "POST",
      headers: { "x-admin-token": "super-secret-admin-token" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("admin gate — fallback (no TWIN_ADMIN_TOKEN)", () => {
  beforeEach(() => {
    delete process.env.TWIN_ADMIN_TOKEN;
  });

  it("allows in-process requests (no client ip) outside production", async () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const app = createGitHubCloneApp();
      const res = await app.request("/admin/reset", { method: "POST" });
      expect(res.status).toBe(200);
    } finally {
      if (prev !== undefined) process.env.NODE_ENV = prev;
    }
  });

  it("rejects in-process requests with unknown client ip in production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const app = createGitHubCloneApp();
      const res = await app.request("/admin/reset", { method: "POST" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { message: string }).message).toBe("Forbidden");
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
