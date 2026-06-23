import { describe, expect, it } from "vitest";
import { createGitHubTwinApp } from "../../src/twin/github/app.js";

describe("GitHub twin app", () => {
  it("responds to the health check", async () => {
    const app = createGitHubTwinApp();
    const response = await app.request("http://pome.local/_pome/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      twin: "github",
      fidelity: "semantic"
    });
  });
});
