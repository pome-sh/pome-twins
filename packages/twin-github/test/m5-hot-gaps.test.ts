// SPDX-License-Identifier: Apache-2.0
// M5 hot-gap fills (F-735): search_commits, get_release_by_tag, get_tag at
// semantic tier, plus the update_pull_request_branch shape→semantic upgrade
// (real merge commit of base into head instead of a branch-pointer reset).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain.js";
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
const repo = { owner: "acme", repo: "api" };

async function req(app: ReturnType<typeof createGitHubCloneApp>, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.request(`${base}${path}`, withAuth(token, init));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function mcp(app: ReturnType<typeof createGitHubCloneApp>, tool: string, args: unknown) {
  const response = await app.request(`${base}/mcp/call`, withAuth(token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, arguments: args })
  }));
  return { status: response.status, body: await response.json() as any };
}

function seededDomain() {
  const domain = new GitHubDomain(openGitHubCloneDatabase());
  domain.seed();
  return domain;
}

describe("search_commits", () => {
  it("matches commits on the default branch by message substring", () => {
    const domain = seededDomain();
    domain.createOrUpdateFile({ ...repo, path: "notes.txt", message: "Fix flaky parser", content: "ok\n" });

    const result = domain.searchCommits({ q: "flaky" });
    expect(result.incomplete_results).toBe(false);
    expect(result.total_count).toBe(1);
    expect(result.items[0]).toMatchObject({
      sha: expect.any(String),
      commit: { message: "Fix flaky parser" },
      repository: { full_name: "acme/api" }
    });
  });

  it("scopes results with owner/repo qualifiers", () => {
    const domain = seededDomain();
    domain.createRepository({ owner: "qa", name: "other" });
    domain.createOrUpdateFile({ owner: "qa", repo: "other", path: "a.txt", message: "Fix flaky parser", content: "x\n" });
    domain.createOrUpdateFile({ ...repo, path: "b.txt", message: "Fix flaky parser", content: "y\n" });

    const scoped = domain.searchCommits({ q: "flaky", owner: "acme", repo: "api" });
    expect(scoped.total_count).toBe(1);
    expect(scoped.items[0].repository.full_name).toBe("acme/api");
  });

  it("is exposed over REST and MCP", async () => {
    const app = createGitHubCloneApp();
    await req(app, "PUT", "/repos/acme/api/contents/notes.txt", { message: "Fix flaky parser", content: "b2sK", branch: "main" });

    const rest = await req(app, "GET", "/search/commits?q=flaky");
    expect(rest.status).toBe(200);
    expect(rest.body.total_count).toBe(1);

    const tool = await mcp(app, "search_commits", { query: "flaky" });
    expect(tool.status).toBe(200);
    expect(tool.body.total_count).toBe(1);
  });
});

describe("get_release_by_tag and get_tag", () => {
  it("returns a release by its tag name", () => {
    const domain = seededDomain();
    domain.createRelease({ ...repo, tag_name: "v1.2.3", name: "Release 1.2.3" });

    expect(domain.getReleaseByTag({ ...repo, tag: "v1.2.3" })).toMatchObject({ tag_name: "v1.2.3", name: "Release 1.2.3" });
    expect(() => domain.getReleaseByTag({ ...repo, tag: "v9.9.9" })).toThrow("Not Found");
  });

  it("returns a tag by name with its commit sha", () => {
    const domain = seededDomain();
    domain.createRelease({ ...repo, tag_name: "v1.2.3" });

    expect(domain.getTag({ ...repo, tag: "v1.2.3" })).toMatchObject({
      name: "v1.2.3",
      commit: { sha: expect.any(String) }
    });
    expect(() => domain.getTag({ ...repo, tag: "nope" })).toThrow("Not Found");
  });

  it("resolves tags containing slashes over REST", async () => {
    const app = createGitHubCloneApp();
    await mcp(app, "create_release", { ...repo, tag_name: "release/2026-07" });

    const rest = await req(app, "GET", "/repos/acme/api/releases/tags/release/2026-07");
    expect(rest.status).toBe(200);
    expect(rest.body.tag_name).toBe("release/2026-07");
  });

  it("exposes get_release_by_tag over REST and both over MCP", async () => {
    const app = createGitHubCloneApp();
    await mcp(app, "create_release", { ...repo, tag_name: "v1.2.3", name: "Release 1.2.3" });

    const rest = await req(app, "GET", "/repos/acme/api/releases/tags/v1.2.3");
    expect(rest.status).toBe(200);
    expect(rest.body.tag_name).toBe("v1.2.3");
    expect((await req(app, "GET", "/repos/acme/api/releases/tags/v9.9.9")).status).toBe(404);

    const release = await mcp(app, "get_release_by_tag", { ...repo, tag: "v1.2.3" });
    expect(release.status).toBe(200);
    expect(release.body.tag_name).toBe("v1.2.3");

    const tag = await mcp(app, "get_tag", { ...repo, tag: "v1.2.3" });
    expect(tag.status).toBe(200);
    expect(tag.body.name).toBe("v1.2.3");
  });
});

describe("named cold surfaces (F-729 ruling)", () => {
  // Rubric rule 4 (ENDPOINT-TIERS.md): named cold rows must return the
  // documented loud-501 envelope, test-backed. These pin the catch-all for
  // the surfaces the F-729 ruling named cold on twin-github.
  it.each([
    "/repos/acme/api/actions/runs",
    "/repos/acme/api/git/trees/abc123",
    "/orgs/acme/teams",
    "/repos/acme/api/issues/1/sub_issues",
    "/orgs/acme/issue-types"
  ])("%s returns the loud 501 unsupported envelope", async (path) => {
    const app = createGitHubCloneApp();
    const response = await req(app, "GET", path);
    expect(response.status).toBe(501);
    expect(response.body._twin.fidelity).toBe("unsupported");
  });
});

describe("update_pull_request_branch (semantic merge)", () => {
  function prWithDriftedBase(domain: GitHubDomain) {
    domain.createBranch({ ...repo, branch: "feature/merge" });
    domain.pushFiles({ ...repo, branch: "feature/merge", message: "Head work", files: [{ path: "head-only.txt", content: "head\n" }] });
    domain.pushFiles({ ...repo, branch: "main", message: "Base drift", files: [{ path: "base-drift.txt", content: "drift\n" }] });
    return domain.createPullRequest({ ...repo, title: "Merge fixture", head: "feature/merge", base: "main" });
  }

  it("creates a merge commit on head that brings in base changes and preserves history", () => {
    const domain = seededDomain();
    const pr = prWithDriftedBase(domain);
    const oldHeadSha = pr.head.sha!;

    expect(domain.updatePullRequestBranch({ ...repo, pull_number: pr.number, expected_head_sha: oldHeadSha })).toMatchObject({
      message: "Updating pull request branch."
    });

    const headCommits = domain.listCommits({ ...repo, sha: "feature/merge" });
    expect(headCommits[0].commit.message).toBe("Merge branch 'main' into feature/merge");
    expect(headCommits[0].parents[0].sha).toBe(oldHeadSha);

    const updated = domain.getPullRequest({ ...repo, pull_number: pr.number });
    expect(updated.head.sha).toBe(headCommits[0].sha);
    expect(updated.head.sha).not.toBe(oldHeadSha);

    // Base drift is now present on the head branch...
    expect(domain.getFileContents({ ...repo, path: "base-drift.txt", ref: "feature/merge" })).toMatchObject({ path: "base-drift.txt" });
    // ...so the PR diff shows only the PR's own change again.
    const files = domain.getPullRequestFiles({ ...repo, pull_number: pr.number }).map((file) => file.filename);
    expect(files).toContain("head-only.txt");
    expect(files).not.toContain("base-drift.txt");
  });

  it("keeps the head version of paths the pull request itself changed", () => {
    const domain = seededDomain();
    domain.createBranch({ ...repo, branch: "feature/conflict-merge" });
    domain.pushFiles({ ...repo, branch: "feature/conflict-merge", message: "Head edit", files: [{ path: "shared.txt", content: "head version\n" }] });
    domain.pushFiles({ ...repo, branch: "main", message: "Base edit", files: [{ path: "shared.txt", content: "base version\n" }] });
    const pr = domain.createPullRequest({ ...repo, title: "Conflicting merge", head: "feature/conflict-merge", base: "main" });
    const oldHeadSha = pr.head.sha!;

    domain.updatePullRequestBranch({ ...repo, pull_number: pr.number });

    // Head wins on the conflicting path, so there is nothing to merge: the
    // call no-ops (no merge commit) and head keeps its version.
    expect(domain.getPullRequest({ ...repo, pull_number: pr.number }).head.sha).toBe(oldHeadSha);
    const file = domain.getFileContents({ ...repo, path: "shared.txt", ref: "feature/conflict-merge" }) as { content: string };
    expect(Buffer.from(file.content, "base64").toString("utf8")).toBe("head version\n");
  });

  it("skips paths deleted on both sides instead of replaying the delete", () => {
    const domain = seededDomain();
    const seeded = domain.getFileContents({ ...repo, path: "README.md" }) as { sha: string };
    domain.createBranch({ ...repo, branch: "feature/both-delete" });
    domain.pushFiles({ ...repo, branch: "feature/both-delete", message: "Head work", files: [{ path: "head-only.txt", content: "head\n" }] });
    domain.deleteFile({ ...repo, branch: "feature/both-delete", path: "README.md", message: "Head delete", sha: seeded.sha });
    domain.deleteFile({ ...repo, branch: "main", path: "README.md", message: "Base delete", sha: seeded.sha });
    const pr = domain.createPullRequest({ ...repo, title: "Both delete", head: "feature/both-delete", base: "main" });

    expect(domain.updatePullRequestBranch({ ...repo, pull_number: pr.number })).toMatchObject({
      message: "Updating pull request branch."
    });
    expect(() => domain.getFileContents({ ...repo, path: "README.md", ref: "feature/both-delete" })).toThrow("Not Found");
  });

  it("merges base into a fork head across remapped commit SHAs", () => {
    const domain = seededDomain();
    domain.forkRepository({ ...repo, organization: "forks" });
    // The PR's own change: delete a file on the fork head.
    const forkReadme = domain.getFileContents({ owner: "forks", repo: "api", path: "README.md" }) as { sha: string };
    domain.deleteFile({ owner: "forks", repo: "api", branch: "main", path: "README.md", message: "Fork delete", sha: forkReadme.sha });
    domain.pushFiles({ ...repo, branch: "main", message: "Base drift", files: [{ path: "fork-drift.txt", content: "drift\n" }] });
    const pr = domain.createPullRequest({ ...repo, title: "Fork merge", head: "forks:main", base: "main" });
    const oldHeadSha = pr.head.sha!;

    domain.updatePullRequestBranch({ ...repo, pull_number: pr.number });
    const forkCommits = domain.listCommits({ owner: "forks", repo: "api", sha: "main" });
    expect(forkCommits[0].commit.message).toBe("Merge branch 'main' into main");
    expect(forkCommits[0].parents[0].sha).toBe(oldHeadSha);
    expect(domain.getFileContents({ owner: "forks", repo: "api", path: "fork-drift.txt", ref: "main" })).toMatchObject({ path: "fork-drift.txt" });
    // A real merge base is found across the fork's remapped SHA space, so the
    // file the PR deleted is NOT resurrected from base.
    expect(() => domain.getFileContents({ owner: "forks", repo: "api", path: "README.md", ref: "main" })).toThrow("Not Found");

    // ...and a second call with no new base commits is a no-op, not another merge.
    const headAfterFirst = domain.getPullRequest({ ...repo, pull_number: pr.number }).head.sha;
    domain.updatePullRequestBranch({ ...repo, pull_number: pr.number });
    expect(domain.getPullRequest({ ...repo, pull_number: pr.number }).head.sha).toBe(headAfterFirst);
  });

  it("no-ops when the base branch has not advanced", () => {
    const domain = seededDomain();
    domain.createBranch({ ...repo, branch: "feature/up-to-date" });
    domain.pushFiles({ ...repo, branch: "feature/up-to-date", message: "Head work", files: [{ path: "utd.txt", content: "x\n" }] });
    const pr = domain.createPullRequest({ ...repo, title: "Up to date", head: "feature/up-to-date", base: "main" });
    const oldHeadSha = pr.head.sha!;

    expect(domain.updatePullRequestBranch({ ...repo, pull_number: pr.number })).toMatchObject({
      message: "Updating pull request branch."
    });
    expect(domain.getPullRequest({ ...repo, pull_number: pr.number }).head.sha).toBe(oldHeadSha);
  });
});
