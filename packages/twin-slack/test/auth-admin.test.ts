import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requireAdminAuth, localhostOnly } from "../src/auth.js";

function mountWithRemote(remote: string | undefined) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const env = (c.env ?? {}) as { incoming?: { socket?: { remoteAddress?: string } } };
    if (remote !== undefined) env.incoming = { socket: { remoteAddress: remote } };
    c.env = env;
    await next();
  });
  app.use("*", requireAdminAuth());
  app.post("/admin/reset", (c) => c.json({ ok: true }));
  return app;
}

describe("requireAdminAuth — token mode", () => {
  beforeEach(() => {
    process.env.TWIN_ADMIN_TOKEN = "super-secret-admin-token";
  });
  afterEach(() => {
    delete process.env.TWIN_ADMIN_TOKEN;
  });

  it("rejects missing X-Admin-Token", async () => {
    const app = mountWithRemote("127.0.0.1");
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("restricted_action");
  });

  it("rejects wrong X-Admin-Token", async () => {
    const app = mountWithRemote("127.0.0.1");
    const res = await app.request("/admin/reset", {
      method: "POST",
      headers: { "X-Admin-Token": "wrong" },
    });
    expect(res.status).toBe(403);
  });

  it("accepts correct X-Admin-Token even from non-local remote", async () => {
    const app = mountWithRemote("8.8.8.8");
    const res = await app.request("/admin/reset", {
      method: "POST",
      headers: { "X-Admin-Token": "super-secret-admin-token" },
    });
    expect(res.status).toBe(200);
  });

  it("accepts lowercase x-admin-token header", async () => {
    const app = mountWithRemote("127.0.0.1");
    const res = await app.request("/admin/reset", {
      method: "POST",
      headers: { "x-admin-token": "super-secret-admin-token" },
    });
    expect(res.status).toBe(200);
  });
});

describe("requireAdminAuth — fallback (no TWIN_ADMIN_TOKEN)", () => {
  beforeEach(() => {
    delete process.env.TWIN_ADMIN_TOKEN;
  });

  it("returns 403 for non-local remoteAddress", async () => {
    const app = mountWithRemote("203.0.113.1");
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("restricted_action");
  });

  it("allows request when remoteAddress is loopback", async () => {
    const app = mountWithRemote("127.0.0.1");
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("allows request when remoteAddress is unknown in non-production", async () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const app = mountWithRemote(undefined);
      const res = await app.request("/admin/reset", { method: "POST" });
      expect(res.status).toBe(200);
    } finally {
      if (prev !== undefined) process.env.NODE_ENV = prev;
    }
  });

  it("rejects request when remoteAddress is unknown in production", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const app = mountWithRemote(undefined);
      const res = await app.request("/admin/reset", { method: "POST" });
      expect(res.status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

describe("localhostOnly back-compat alias", () => {
  it("is identical to requireAdminAuth", () => {
    expect(localhostOnly).toBe(requireAdminAuth);
  });
});
