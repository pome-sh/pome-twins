// SPDX-License-Identifier: Apache-2.0
// Admin-gate coverage for twin-slack (F-683): the gate MECHANISM (token
// mode, loopback socket check, production fail-closed) is the engine's and
// is covered by the sdk + contract suites; what this file pins is the
// slack-declared SHAPE — the frozen 403 {ok:false, error:"restricted_action"}
// envelope wired through `admin.forbidden` in the twin manifest.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { defaultSeedState } from "../src/seed.js";

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return createSlackTwinApp({ db, domain, runId: "admin" });
}

describe("admin gate — token mode renders the slack envelope", () => {
  beforeEach(() => {
    process.env.TWIN_ADMIN_TOKEN = "super-secret-admin-token";
  });
  afterEach(() => {
    delete process.env.TWIN_ADMIN_TOKEN;
  });

  it("rejects missing X-Admin-Token with restricted_action", async () => {
    const app = freshApp();
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("restricted_action");
  });

  it("rejects wrong X-Admin-Token", async () => {
    const app = freshApp();
    const res = await app.request("/admin/reset", {
      method: "POST",
      headers: { "X-Admin-Token": "wrong" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("restricted_action");
  });

  it("accepts the correct X-Admin-Token (case-insensitive header)", async () => {
    const app = freshApp();
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
      const app = freshApp();
      const res = await app.request("/admin/reset", { method: "POST" });
      expect(res.status).toBe(200);
    } finally {
      if (prev !== undefined) process.env.NODE_ENV = prev;
    }
  });

  it("rejects unknown-peer requests in production with restricted_action", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const app = freshApp();
      const res = await app.request("/admin/reset", { method: "POST" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("restricted_action");
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});
