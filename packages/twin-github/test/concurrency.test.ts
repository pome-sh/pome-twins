import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;

describe("race condition regression coverage", () => {
  it("allows only one concurrent repository create for the same owner/name", async () => {
    const app = createGitHubCloneApp();
    const create = () => app.request(`${base}/mcp/call`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "create_repository", arguments: { owner: "race", name: "dupe" } })
    }));

    const statuses = (await Promise.all([create(), create()])).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 422]);
  });

  it("allows only one open pull request for the same head/base pair", async () => {
    const app = createGitHubCloneApp();
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "race-pr" });
    await call(app, "push_files", {
      owner: "acme",
      repo: "api",
      branch: "race-pr",
      message: "Race PR",
      files: [{ path: "race-pr.txt", content: "race\n" }]
    });

    const create = () => app.request(`${base}/mcp/call`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "create_pull_request",
        arguments: { owner: "acme", repo: "api", title: "Race PR", head: "race-pr", base: "main" }
      })
    }));

    const statuses = (await Promise.all([create(), create()])).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 422]);
    const pulls = await call(app, "list_pull_requests", { owner: "acme", repo: "api", state: "all" });
    expect(pulls).toHaveLength(1);
  });
});

async function call(app: ReturnType<typeof createGitHubCloneApp>, tool: string, args: unknown) {
  const response = await app.request(`${base}/mcp/call`, withAuth(token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, arguments: args })
  }));
  if (!response.ok) throw new Error(`${tool}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}
