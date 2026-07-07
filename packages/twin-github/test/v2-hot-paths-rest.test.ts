// SPDX-License-Identifier: Apache-2.0
// FDRS-300 — REST surface integration tests for the 27 v2 hot-path endpoints.
// Goes through the real Hono app, asserts HTTP status codes match GitHub
// expectations, and confirms mutations are persisted in follow-up reads.

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

function app() {
  return createGitHubCloneApp();
}

async function jsonReq(
  app: ReturnType<typeof createGitHubCloneApp>,
  method: string,
  path: string,
  body?: unknown,
  authToken = token
) {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.request(`${base}${path}`, withAuth(authToken, init));
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: response.status, body: parsed };
}

// ----- Cluster A — branches & files -----------------------------------

describe("REST / cluster A — branches & files", () => {
  it("GET /branches lists; GET /branches/:name returns one; DELETE /git/refs/heads/:branch removes", async () => {
    const a = app();
    await jsonReq(a, "POST", "/repos/acme/api/git/refs", { ref: "refs/heads/feature/scratch" });
    const list = await jsonReq(a, "GET", "/repos/acme/api/branches");
    expect(list.status).toBe(200);
    expect((list.body as Array<{ name: string }>).map((b) => b.name)).toEqual(expect.arrayContaining(["main", "feature/scratch"]));

    const one = await jsonReq(a, "GET", "/repos/acme/api/branches/feature/scratch");
    expect(one.status).toBe(200);
    expect((one.body as { name: string }).name).toBe("feature/scratch");

    const removed = await jsonReq(a, "DELETE", "/repos/acme/api/git/refs/heads/feature/scratch");
    expect(removed.status).toBe(204);

    const gone = await jsonReq(a, "GET", "/repos/acme/api/branches/feature/scratch");
    expect(gone.status).toBe(404);
  });

  it("DELETE /contents/:path requires sha and clears the file", async () => {
    const a = app();
    const aliceToken = await signTestToken({ login: "alice" });
    const put = await jsonReq(a, "PUT", "/repos/acme/api/contents/del.txt", { message: "add", content: "x\n" }, aliceToken);
    expect(put.status).toBe(201);
    const sha = (put.body as { content: { sha: string } }).content.sha;
    const stale = await jsonReq(a, "DELETE", "/repos/acme/api/contents/del.txt", { message: "drop", sha: "WRONG" }, aliceToken);
    expect(stale.status).toBe(422);
    const removed = await jsonReq(a, "DELETE", "/repos/acme/api/contents/del.txt", { message: "drop", sha }, aliceToken);
    expect(removed.status).toBe(200);
    const gone = await jsonReq(a, "GET", "/repos/acme/api/contents/del.txt");
    expect(gone.status).toBe(404);
    const commits = await jsonReq(a, "GET", "/repos/acme/api/commits");
    expect((commits.body as Array<{ commit: { message: string }; author: { login: string } }>)[0]).toMatchObject({
      commit: { message: "drop" },
      author: { login: "alice" }
    });

    const recreate = await jsonReq(a, "PUT", "/repos/acme/api/contents/del.txt", { message: "re-add", content: "y\n" }, aliceToken);
    expect(recreate.status).toBe(201);
  });

  it("DELETE default branch returns 422", async () => {
    const a = app();
    const response = await jsonReq(a, "DELETE", "/repos/acme/api/git/refs/heads/main");
    expect(response.status).toBe(422);
  });
});

// ----- Cluster B — commits & diffs ------------------------------------

describe("REST / cluster B — commits & diffs", () => {
  it("GET /commits/:ref returns commit + stats", async () => {
    const a = app();
    const commits = await jsonReq(a, "GET", "/repos/acme/api/commits");
    const head = (commits.body as Array<{ sha: string }>)[0]!.sha;
    const response = await jsonReq(a, "GET", `/repos/acme/api/commits/${head}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ sha: head, stats: expect.any(Object) });
  });

  it("PUT /contents returns 201 on create and 200 on update (FDRS-596)", async () => {
    const a = app();
    const create = await jsonReq(a, "PUT", "/repos/acme/api/contents/newfile.ts", { message: "add", content: "1\n" });
    expect(create.status).toBe(201);
    const sha = (create.body as { content: { sha: string } }).content.sha;
    const update = await jsonReq(a, "PUT", "/repos/acme/api/contents/newfile.ts", { message: "update", content: "2\n", sha });
    expect(update.status).toBe(200);

    const seeded = await jsonReq(a, "GET", "/repos/acme/api/contents/README.md");
    const seededSha = (seeded.body as { sha: string }).sha;
    const seededUpdate = await jsonReq(a, "PUT", "/repos/acme/api/contents/README.md", {
      message: "update seeded file",
      content: "# Acme API\n\nUpdated.\n",
      sha: seededSha
    });
    expect(seededUpdate.status).toBe(200);
  });

  it("GET /compare/:base...:head returns status + commits", async () => {
    const a = app();
    const before = await jsonReq(a, "GET", "/repos/acme/api/commits");
    const baseSha = (before.body as Array<{ sha: string }>)[0]!.sha;
    await jsonReq(a, "PUT", "/repos/acme/api/contents/advance.txt", { message: "advance", content: "x\n" });
    const response = await jsonReq(a, "GET", `/repos/acme/api/compare/${baseSha}...main`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ahead", ahead_by: expect.any(Number) });
  });

  it("GET /pulls/:n/diff returns the unified-diff envelope", async () => {
    const a = app();
    await jsonReq(a, "POST", "/repos/acme/api/git/refs", { ref: "refs/heads/diff-rest" });
    await jsonReq(a, "PUT", "/repos/acme/api/contents/diff.ts?branch=diff-rest", { message: "m", content: "x\n", branch: "diff-rest" });
    const pr = await jsonReq(a, "POST", "/repos/acme/api/pulls", { title: "Diff REST", head: "diff-rest", base: "main" });
    const number = (pr.body as { number: number }).number;
    const response = await jsonReq(a, "GET", `/repos/acme/api/pulls/${number}/diff`);
    expect(response.status).toBe(200);
    expect((response.body as { diff: string }).diff).toContain("diff --git");
  });

  it("GET /compare/:base...:head with bad format returns 422", async () => {
    const a = app();
    const response = await jsonReq(a, "GET", "/repos/acme/api/compare/no-dots");
    expect(response.status).toBe(422);
  });
});

// ----- Cluster C — PR deeper ------------------------------------------

describe("REST / cluster C — pull requests deeper", () => {
  async function openPr(a: ReturnType<typeof createGitHubCloneApp>) {
    await jsonReq(a, "POST", "/repos/acme/api/git/refs", { ref: "refs/heads/cr-rest" });
    await jsonReq(a, "PUT", "/repos/acme/api/contents/cr.ts", { message: "m", content: "1\n", branch: "cr-rest" });
    const pr = await jsonReq(a, "POST", "/repos/acme/api/pulls", { title: "CR", head: "cr-rest", base: "main" });
    return (pr.body as { number: number }).number;
  }

  it("PATCH /pulls/:n updates title", async () => {
    const a = app();
    const n = await openPr(a);
    const response = await jsonReq(a, "PATCH", `/repos/acme/api/pulls/${n}`, { title: "New" });
    expect(response.status).toBe(200);
    expect((response.body as { title: string }).title).toBe("New");
  });

  // FDRS-453 — real GitHub returns the leaner "pull request simple" shape from
  // the LIST endpoint and the full PullRequest only from the single-PR GET.
  // The single-PR-only fields are merged / commits / additions / deletions /
  // changed_files. Lock the list-vs-single shape difference so the twin tracks
  // GitHub's documented schemas.
  const singlePrOnlyFields = ["merged", "commits", "additions", "deletions", "changed_files"] as const;

  it("GET /pulls (LIST) omits the single-PR-only fields", async () => {
    const a = app();
    const n = await openPr(a);
    const response = await jsonReq(a, "GET", "/repos/acme/api/pulls");
    expect(response.status).toBe(200);
    const list = response.body as Array<Record<string, unknown>>;
    const item = list.find((pr) => pr.number === n);
    expect(item).toBeDefined();
    for (const field of singlePrOnlyFields) {
      expect(item).not.toHaveProperty(field);
    }
    // The leaner shape keeps the rest of the PR fields intact.
    expect(item).toMatchObject({ number: n, state: "open", title: "CR" });
    expect(item).toHaveProperty("head");
    expect(item).toHaveProperty("base");
    expect(item).toHaveProperty("merge_commit_sha");
  });

  it("GET /pulls/:n (single) keeps the single-PR-only fields", async () => {
    const a = app();
    const n = await openPr(a);
    const response = await jsonReq(a, "GET", `/repos/acme/api/pulls/${n}`);
    expect(response.status).toBe(200);
    const item = response.body as Record<string, unknown>;
    for (const field of singlePrOnlyFields) {
      expect(item).toHaveProperty(field);
    }
    expect(item).toMatchObject({ number: n, state: "open", title: "CR", merged: false });
  });

  it("GET /pulls/:n/commits lists commits", async () => {
    const a = app();
    const n = await openPr(a);
    const response = await jsonReq(a, "GET", `/repos/acme/api/pulls/${n}/commits`);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  it("POST /pulls/:n/comments creates inline + reply", async () => {
    const a = app();
    const n = await openPr(a);
    const parent = await jsonReq(a, "POST", `/repos/acme/api/pulls/${n}/comments`, { body: "Nit", path: "cr.ts", line: 1 });
    expect(parent.status).toBe(201);
    const parentId = (parent.body as { id: number }).id;
    const reply = await jsonReq(a, "POST", `/repos/acme/api/pulls/${n}/comments/${parentId}/replies`, { body: "Fixed" });
    expect(reply.status).toBe(201);
    expect((reply.body as { in_reply_to_id: number }).in_reply_to_id).toBe(parentId);
  });
});

// ----- Cluster D — issue comments deeper ------------------------------

describe("REST / cluster D — issue comments deeper", () => {
  it("PATCH then DELETE /issues/comments/:id", async () => {
    const a = app();
    const created = await jsonReq(a, "POST", "/repos/acme/api/issues/1/comments", { body: "first" });
    expect(created.status).toBe(201);
    const id = (created.body as { id: number }).id;
    const patched = await jsonReq(a, "PATCH", `/repos/acme/api/issues/comments/${id}`, { body: "second" });
    expect(patched.status).toBe(200);
    expect((patched.body as { body: string }).body).toBe("second");
    const removed = await jsonReq(a, "DELETE", `/repos/acme/api/issues/comments/${id}`);
    expect(removed.status).toBe(204);
    const gone = await jsonReq(a, "PATCH", `/repos/acme/api/issues/comments/${id}`, { body: "x" });
    expect(gone.status).toBe(404);
  });
});

// ----- Cluster E — milestones -----------------------------------------

describe("REST / cluster E — milestones", () => {
  it("full CRUD lifecycle", async () => {
    const a = app();
    const created = await jsonReq(a, "POST", "/repos/acme/api/milestones", { title: "v1", description: "first" });
    expect(created.status).toBe(201);
    const number = (created.body as { number: number }).number;

    const list = await jsonReq(a, "GET", "/repos/acme/api/milestones");
    expect((list.body as Array<{ title: string }>).map((m) => m.title)).toContain("v1");

    const patched = await jsonReq(a, "PATCH", `/repos/acme/api/milestones/${number}`, { state: "closed" });
    expect((patched.body as { state: string }).state).toBe("closed");

    const removed = await jsonReq(a, "DELETE", `/repos/acme/api/milestones/${number}`);
    expect(removed.status).toBe(204);
  });

  it("filters list by state", async () => {
    const a = app();
    await jsonReq(a, "POST", "/repos/acme/api/milestones", { title: "alpha" });
    const beta = await jsonReq(a, "POST", "/repos/acme/api/milestones", { title: "beta" });
    const betaNumber = (beta.body as { number: number }).number;
    await jsonReq(a, "PATCH", `/repos/acme/api/milestones/${betaNumber}`, { state: "closed" });

    const open = await jsonReq(a, "GET", "/repos/acme/api/milestones?state=open");
    const closed = await jsonReq(a, "GET", "/repos/acme/api/milestones?state=closed");
    expect((open.body as Array<{ title: string }>).map((m) => m.title)).toContain("alpha");
    expect((closed.body as Array<{ title: string }>).map((m) => m.title)).toContain("beta");
  });
});

// ----- Cluster F — commit status + checks -----------------------------

describe("REST / cluster F — commit status + checks", () => {
  async function head(a: ReturnType<typeof createGitHubCloneApp>) {
    const commits = await jsonReq(a, "GET", "/repos/acme/api/commits");
    return (commits.body as Array<{ sha: string }>)[0]!.sha;
  }

  it("POST /statuses/:sha then GET /commits/:ref/status", async () => {
    const a = app();
    const sha = await head(a);
    const created = await jsonReq(a, "POST", `/repos/acme/api/statuses/${sha}`, { state: "success", context: "ci/test" });
    expect(created.status).toBe(201);
    const combined = await jsonReq(a, "GET", `/repos/acme/api/commits/${sha}/status`);
    expect((combined.body as { state: string }).state).toBe("success");
  });

  it("POST /check-runs then GET /commits/:ref/check-runs", async () => {
    const a = app();
    const sha = await head(a);
    const created = await jsonReq(a, "POST", "/repos/acme/api/check-runs", { name: "lint", head_sha: sha, status: "completed", conclusion: "success" });
    expect(created.status).toBe(201);
    const list = await jsonReq(a, "GET", `/repos/acme/api/commits/${sha}/check-runs`);
    expect((list.body as { total_count: number }).total_count).toBe(1);
  });

  it("POST /check-runs without conclusion when status=completed returns 422", async () => {
    const a = app();
    const sha = await head(a);
    const response = await jsonReq(a, "POST", "/repos/acme/api/check-runs", { name: "lint", head_sha: sha, status: "completed" });
    expect(response.status).toBe(422);
  });
});

// ----- Cluster G — tags & releases ------------------------------------

describe("REST / cluster G — tags & releases", () => {
  it("POST /releases auto-creates the tag", async () => {
    const a = app();
    const created = await jsonReq(a, "POST", "/repos/acme/api/releases", { tag_name: "v0.1.0", name: "First" });
    expect(created.status).toBe(201);
    const tags = await jsonReq(a, "GET", "/repos/acme/api/tags");
    expect((tags.body as Array<{ name: string }>).map((t) => t.name)).toContain("v0.1.0");
  });

  it("GET /releases/latest skips drafts/prereleases; 404 when none", async () => {
    const a = app();
    const empty = await jsonReq(a, "GET", "/repos/acme/api/releases/latest");
    expect(empty.status).toBe(404);
    await jsonReq(a, "POST", "/repos/acme/api/releases", { tag_name: "v1.0.0", name: "Stable" });
    await jsonReq(a, "POST", "/repos/acme/api/releases", { tag_name: "v1.0.1-rc", name: "RC", prerelease: true });
    const latest = await jsonReq(a, "GET", "/repos/acme/api/releases/latest");
    expect((latest.body as { tag_name: string }).tag_name).toBe("v1.0.0");
  });

  it("POST /releases on duplicate tag returns 422", async () => {
    const a = app();
    await jsonReq(a, "POST", "/repos/acme/api/releases", { tag_name: "v0.5.0" });
    const dup = await jsonReq(a, "POST", "/repos/acme/api/releases", { tag_name: "v0.5.0" });
    expect(dup.status).toBe(422);
  });
});

// ----- Cluster H — identity & collaborators ---------------------------

describe("REST / cluster H — identity & collaborators", () => {
  it("GET /user returns the authenticated user", async () => {
    const a = app();
    const response = await jsonReq(a, "GET", "/user");
    expect(response.status).toBe(200);
    expect((response.body as { login: string }).login).toBe("pome-agent");
  });

  it("PUT /collaborators/:username 201 for new user, 204 for existing", async () => {
    const a = app();
    const created = await jsonReq(a, "PUT", "/repos/acme/api/collaborators/newbie", { permission: "push" });
    expect(created.status).toBe(201);
    const existing = await jsonReq(a, "PUT", "/repos/acme/api/collaborators/alice", {});
    expect(existing.status).toBe(204);
  });

  it("PUT /collaborators requires push access", async () => {
    const a = app();
    const outsiderToken = await signTestToken({ login: "mallory" });
    const response = await jsonReq(a, "PUT", "/repos/acme/api/collaborators/anon", { permission: "push" }, outsiderToken);
    expect(response.status).toBe(403);
  });
});
