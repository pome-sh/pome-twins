import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
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

async function json(response: Response) {
  return (await response.json()) as any;
}

describe("github_clone app", () => {
  it("serves health, admin reset, and all MCP tool definitions", async () => {
    const app = createGitHubCloneApp();

    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      runtime: {
        package: "@pome-sh/twin-github",
        version: expect.any(String),
        git_sha: expect.any(String),
        build_time: expect.any(String)
      }
    });
    expect((await app.request("/admin/reset", { method: "POST" })).status).toBe(200);

    const tools = await json(await app.request(`${base}/mcp/tools`, withAuth(token)));
    expect(tools.tools).toHaveLength(65);
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toContain("create_pull_request");
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toContain("create_label");
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toContain("list_branches");
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toContain("create_release");
    expect(tools.tools.map((tool: { name: string }) => tool.name)).toContain("get_me");
  });

  it("exposes /s/:sid/healthz under bearer auth and rejects sid mismatch", async () => {
    const app = createGitHubCloneApp();

    const ok = await app.request(`${base}/healthz`, withAuth(token));
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ ok: true, sid: TEST_SID });

    const noAuth = await app.request(`${base}/healthz`);
    expect(noAuth.status).toBe(401);

    const wrongSidToken = await signTestToken({ sid: "different-sid" });
    const mismatch = await app.request(`${base}/healthz`, withAuth(wrongSidToken));
    expect(mismatch.status).toBe(401);
  });

  it("accepts a GitHub PAT-shaped fake token scoped to the session", async () => {
    const app = createGitHubCloneApp();
    const fakePat = providerToken("github", TEST_SID);
    const response = await app.request(`${base}/repos/acme/api`, withAuth(fakePat));
    expect(response.status).toBe(200);
  });

  it("runs a file, branch, pull request, review, and merge flow through MCP", async () => {
    const app = createGitHubCloneApp();

    await expect(call(app, "create_branch", { owner: "acme", repo: "api", branch: "feature/order-fix" })).resolves.toMatchObject({
      name: "feature/order-fix"
    });
    await expect(call(app, "push_files", {
      owner: "acme",
      repo: "api",
      branch: "feature/order-fix",
      message: "Fix order handling",
      files: [{ path: "src/orders.ts", content: "export const fixed = true;\n" }]
    })).resolves.toHaveProperty("commit.sha");

    const pr = await call(app, "create_pull_request", {
      owner: "acme",
      repo: "api",
      title: "Fix order handling",
      head: "feature/order-fix",
      base: "main"
    });
    expect(pr.number).toBe(2);

    const files = await call(app, "get_pull_request_files", { owner: "acme", repo: "api", pull_number: pr.number });
    expect(files.map((file: { filename: string }) => file.filename)).toContain("src/orders.ts");

    const review = await call(app, "create_pull_request_review", {
      owner: "acme",
      repo: "api",
      pull_number: pr.number,
      event: "APPROVE",
      body: "Looks good."
    });
    expect(review.state).toBe("APPROVED");

    const merge = await call(app, "merge_pull_request", { owner: "acme", repo: "api", pull_number: pr.number });
    expect(merge).toMatchObject({ merged: true });

    const content = await call(app, "get_file_contents", { owner: "acme", repo: "api", path: "src/orders.ts", ref: "main" });
    expect(content.path).toBe("src/orders.ts");
  });

  it("uses GitHub-shaped REST responses and errors", async () => {
    const app = createGitHubCloneApp();

    const repo = await app.request(`${base}/repos/acme/api`, withAuth(token));
    expect(repo.status).toBe(200);

    const missing = await app.request(`${base}/repos/acme/api/contents/nope.txt`, withAuth(token));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ message: "Not Found", documentation_url: "https://docs.github.com/rest" });

    const invalidNumber = await app.request(`${base}/repos/acme/api/issues/not-a-number`, withAuth(token));
    expect(invalidNumber.status).toBe(422);
    await expect(invalidNumber.json()).resolves.toMatchObject({ message: "Validation Failed" });

    const collaborator = await app.request(`${base}/repos/acme/api/collaborators/alice`, withAuth(token));
    expect(collaborator.status).toBe(204);
    expect(await collaborator.text()).toBe("");

    const nonCollaborator = await app.request(`${base}/repos/acme/api/collaborators/not-a-collab`, withAuth(token));
    expect(nonCollaborator.status).toBe(404);
    await expect(nonCollaborator.json()).resolves.toMatchObject({ message: "Not Found" });

    const issue = await app.request(`${base}/repos/acme/api/issues`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "REST issue", labels: ["bug"] })
    }));
    expect(issue.status).toBe(201);
    expect((await json(issue)).labels[0].name).toBe("bug");
  });

  it("documents standalone single-tenant state sharing across session ids", async () => {
    const app = createGitHubCloneApp();
    const otherSid = "other-session";
    const otherToken = await signTestToken({ sid: otherSid });

    const created = await call(app, "create_issue", {
      owner: "acme",
      repo: "api",
      title: "Visible across local sessions"
    });

    const state = await json(await app.request(`/s/${otherSid}/_pome/state`, withAuth(otherToken)));
    const repo = state.repositories.find((item: { full_name: string }) => item.full_name === "acme/api");

    expect(repo?.issues.map((issue: { number: number }) => issue.number)).toContain(created.number);
  });
});

async function call(app: ReturnType<typeof createGitHubCloneApp>, tool: string, args: unknown) {
  const response = await app.request(`${base}/mcp/call`, withAuth(token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, arguments: args })
  }));
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<any>;
}

function providerToken(provider: "github", sid: string) {
  const encodedSid = Buffer.from(sid, "utf8").toString("base64url");
  const sig = createHmac("sha256", TEST_AUTH_SECRET)
    .update(`${provider}:${sid}`)
    .digest("base64url")
    .slice(0, 22);
  return `github_pat_pome_${encodedSid}_${sig}`;
}
