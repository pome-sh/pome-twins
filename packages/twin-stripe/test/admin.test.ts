// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createTwinStripeApp } from "../src/app.js";
import { openTwinStripeDatabase } from "../src/db.js";
import { DEFAULT_API_KEY, applySeed, defaultSeed } from "../src/seed.js";

describe("/admin/* — localhost-only state controls", () => {
  it("POST /admin/reset returns 200 in-process and re-seeds the default api key", async () => {
    const db = openTwinStripeDatabase(":memory:");
    applySeed(db, defaultSeed());
    const app = createTwinStripeApp({ db });

    // Wipe the default key, then reset and confirm it returns.
    db.prepare(`DELETE FROM api_keys`).run();
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const row = db
      .prepare(`SELECT key FROM api_keys WHERE key = ?`)
      .get(DEFAULT_API_KEY) as { key: string } | undefined;
    expect(row?.key).toBe(DEFAULT_API_KEY);
  });

  it("POST /admin/seed accepts a custom seed payload", async () => {
    const app = createTwinStripeApp();
    const res = await app.request("/admin/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_keys: [{ key: "sk_test_pome_alice", sid: "alice" }]
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; api_keys: number; failure_injection: number };
    expect(body).toEqual({ ok: true, api_keys: 1, failure_injection: 0 });
  });

  it("POST /admin/seed with no body falls back to default seed", async () => {
    const app = createTwinStripeApp();
    const res = await app.request("/admin/seed", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; api_keys: number };
    expect(body.ok).toBe(true);
    expect(body.api_keys).toBeGreaterThanOrEqual(1);
  });

  it("rejects non-localhost callers via remote address heuristic", async () => {
    const app = createTwinStripeApp();
    // Hono's request() bypass passes no socket info; simulate a remote
    // address by constructing an env object Hono surfaces to middleware.
    const res = await app.fetch(
      new Request("http://localhost/admin/reset", { method: "POST" }),
      { incoming: { socket: { remoteAddress: "203.0.113.4" } } } as unknown as object
    );
    expect(res.status).toBe(403);
  });
});
