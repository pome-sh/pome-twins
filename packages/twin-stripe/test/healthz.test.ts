// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createTwinStripeApp } from "../src/app.js";

describe("/healthz", () => {
  it("returns 200 with the snapshot probe shape", async () => {
    const app = createTwinStripeApp();
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      twin: "stripe",
      implementation: "stripe_clone",
      fidelity: "semantic"
    });
    expect(typeof body.tools).toBe("number");
    expect(typeof body.tthw_seconds).toBe("number");
    expect(body.tthw_seconds as number).toBeGreaterThanOrEqual(0);
    expect(body.runtime).toMatchObject({
      package: "@pome-sh/twin-stripe",
      version: expect.any(String),
      git_sha: expect.any(String),
      build_time: expect.any(String)
    });
  });

  it("requires no auth", async () => {
    const app = createTwinStripeApp();
    const response = await app.request("/healthz", {
      headers: { Authorization: "Bearer not-a-real-token" }
    });
    expect(response.status).toBe(200);
  });
});
