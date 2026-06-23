// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createTwinStripeApp } from "../src/app.js";
import { openTwinStripeDatabase } from "../src/db.js";
import { applySeed, defaultSeed, DEFAULT_API_KEY, DEFAULT_SID } from "../src/seed.js";
import { mintTestApiKey } from "./_authHelper.js";

describe("api key auth (Stripe SDK shape)", () => {
  it("Bearer sk_test_pome_default resolves to sid=default", async () => {
    const db = openTwinStripeDatabase(":memory:");
    applySeed(db, defaultSeed());
    const app = createTwinStripeApp({ db });
    // Hit the per-session pome health route — bearerAuth runs against it.
    const res = await app.request(`/s/${DEFAULT_SID}/_pome/health`, {
      headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` }
    });
    expect(res.status).toBe(200);
  });

  it("rejects an unknown api key", async () => {
    const app = createTwinStripeApp();
    const res = await app.request(`/s/${DEFAULT_SID}/_pome/health`, {
      headers: { Authorization: "Bearer sk_test_pome_unknownkey" }
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects an api key whose sid doesn't match the path", async () => {
    const db = openTwinStripeDatabase(":memory:");
    const minted = mintTestApiKey(db, { sid: "alice" });
    const app = createTwinStripeApp({ db });
    const res = await app.request(`/s/bob/_pome/health`, {
      headers: { Authorization: `Bearer ${minted.key}` }
    });
    expect(res.status).toBe(403);
  });

  it("rejects a revoked api key", async () => {
    const db = openTwinStripeDatabase(":memory:");
    const minted = mintTestApiKey(db, { sid: "alice" });
    db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE key = ?`).run(
      new Date().toISOString(),
      minted.key
    );
    const app = createTwinStripeApp({ db });
    const res = await app.request(`/s/alice/_pome/health`, {
      headers: { Authorization: `Bearer ${minted.key}` }
    });
    expect(res.status).toBe(401);
  });
});
