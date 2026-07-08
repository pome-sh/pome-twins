// SPDX-License-Identifier: Apache-2.0
// Closes a coverage gap on pre-existing REST routes that domain.test.ts
// exercises through the domain class directly. Hitting the actual HTTP
// handlers ensures the arrow-function bodies inside app.ts route to the
// right domain calls.

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

async function req(app: ReturnType<typeof createGitHubCloneApp>, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.request(`${base}${path}`, withAuth(token, init));
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: response.status, body: parsed };
}

describe("v1 REST coverage — existing surface end-to-end", () => {
  it("PR review/merge/update-branch via REST", async () => {
    const app = createGitHubCloneApp();
    await req(app, "POST", "/repos/acme/api/git/refs", { ref: "refs/heads/feat-cov" });
    await req(app, "PUT", "/repos/acme/api/contents/feat.ts?branch=feat-cov", { message: "m", content: "1\n", branch: "feat-cov" });
    const pr = await req(app, "POST", "/repos/acme/api/pulls", { title: "Cov", head: "feat-cov", base: "main" });
    const n = (pr.body as { number: number }).number;

    const review = await req(app, "POST", `/repos/acme/api/pulls/${n}/reviews`, { event: "APPROVE", body: "looks ok" });
    expect(review.status).toBe(201);

    const updateBranch = await req(app, "PUT", `/repos/acme/api/pulls/${n}/update-branch`, {});
    expect(updateBranch.status).toBe(200);

    const merged = await req(app, "PUT", `/repos/acme/api/pulls/${n}/merge`, {});
    expect(merged.status).toBe(200);
  });

  it("issue assignees via REST", async () => {
    const app = createGitHubCloneApp();
    const response = await req(app, "POST", "/repos/acme/api/issues/1/assignees", { assignees: ["alice"] });
    expect(response.status).toBe(201);
  });

  it("collaborators 204 + 404", async () => {
    const app = createGitHubCloneApp();
    const okResp = await req(app, "GET", "/repos/acme/api/collaborators/alice");
    expect(okResp.status).toBe(204);
    const missingResp = await req(app, "GET", "/repos/acme/api/collaborators/nobody-xyz");
    expect(missingResp.status).toBe(404);
  });

  it("merge without push access returns 403", async () => {
    process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
    const noLoginToken = await signTestToken({ login: null });
    const app = createGitHubCloneApp();
    await req(app, "POST", "/repos/acme/api/git/refs", { ref: "refs/heads/no-push" });
    await req(app, "PUT", "/repos/acme/api/contents/np.ts?branch=no-push", { message: "m", content: "1\n", branch: "no-push" });
    const pr = await req(app, "POST", "/repos/acme/api/pulls", { title: "NoPush", head: "no-push", base: "main" });
    const n = (pr.body as { number: number }).number;
    const response = await app.request(`${base}/repos/acme/api/pulls/${n}/merge`, withAuth(noLoginToken, {
      method: "PUT",
      headers: { "content-type": "application/json" }
    }));
    expect(response.status).toBe(403);
  });
});
