import { describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../../src/twin/githubCloneAdapter.js";

describe("GitHub twin app", () => {
  it("responds to the health check", async () => {
    const app = (await createGitHubCloneApp()) as {
      request: (url: string, init?: RequestInit) => Promise<Response> | Response;
    };
    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      twin: "github",
      fidelity: "semantic"
    });
  });
});
