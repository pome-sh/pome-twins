// SPDX-License-Identifier: Apache-2.0
// FDRS-300 — defensive error paths and edge cases for v2 hot paths.
// Targets uncovered branches (malformed JSON, missing required params, etc.).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubCloneApp } from "../src/twin.js";
import { openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain/index.js";
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

describe("v2 error paths — REST envelope", () => {
  it("returns 400 with a JSON-parse envelope on malformed body", async () => {
    const app = createGitHubCloneApp();
    const response = await app.request(`${base}/repos/acme/api/milestones`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "this-is-not-json{"
    }));
    expect(response.status).toBe(400);
    const body = await response.json() as { message: string };
    expect(body.message).toBe("Problems parsing JSON");
  });

  it("returns 422 on Zod validation failure with structured errors", async () => {
    const app = createGitHubCloneApp();
    const response = await app.request(`${base}/repos/acme/api/milestones`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}) // missing required title
    }));
    expect(response.status).toBe(422);
    const body = await response.json() as { errors: Array<{ field: string }> };
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("PUT /collaborators with no body uses defaults (push)", async () => {
    const app = createGitHubCloneApp();
    const response = await app.request(`${base}/repos/acme/api/collaborators/anon`, withAuth(token, {
      method: "PUT"
    }));
    expect(response.status).toBe(201);
  });

  it("returns 501 for unsupported routes (sanity check on catchall)", async () => {
    const app = createGitHubCloneApp();
    const response = await app.request(`${base}/some/totally/made/up/path`, withAuth(token));
    expect(response.status).toBe(501);
    // FDRS-431: the 'unsupported' envelope lives under `_twin.*`, matching
    // twin-slack / twin-stripe. No bare top-level `fidelity` key (clean cutover).
    const body = await response.json() as {
      fidelity?: unknown;
      _twin: { fidelity: string; supported_surfaces: string[] };
    };
    expect(body.fidelity).toBeUndefined();
    expect(body._twin.fidelity).toBe("unsupported");
    expect(Array.isArray(body._twin.supported_surfaces)).toBe(true);
  });
});

describe("v2 error paths — domain invariants", () => {
  it("rejects empty review comment body", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();
    domain.createBranch({ owner: "acme", repo: "api", branch: "x" });
    domain.createOrUpdateFile({ owner: "acme", repo: "api", branch: "x", path: "a.ts", message: "m", content: "1\n" });
    const pr = domain.createPullRequest({ owner: "acme", repo: "api", title: "X", head: "x", base: "main" }) as { number: number };
    expect(() => domain.createPullRequestReviewComment({ owner: "acme", repo: "api", pull_number: pr.number, body: "   ", path: "a.ts" })).toThrow("Validation Failed");
  });

  it("rejects empty issue comment update body", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();
    const comment = domain.addIssueComment({ owner: "acme", repo: "api", issue_number: 1, body: "ok" });
    expect(() => domain.updateIssueComment({ owner: "acme", repo: "api", comment_id: comment.id, body: "  " })).toThrow("Validation Failed");
  });

  it("rejects empty milestone title", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();
    expect(() => domain.createMilestone({ owner: "acme", repo: "api", title: "  " })).toThrow("Validation Failed");
  });

  it("rejects empty release tag", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();
    expect(() => domain.createRelease({ owner: "acme", repo: "api", tag_name: "  " })).toThrow("Validation Failed");
  });

  it("rejects empty check_run name", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();
    const commits = domain.listCommits({ owner: "acme", repo: "api" }) as Array<{ sha: string }>;
    expect(() => domain.createCheckRun({ owner: "acme", repo: "api", name: "  ", head_sha: commits[0]!.sha })).toThrow("Validation Failed");
  });

  it("rejects add_collaborator with empty username", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();
    expect(() => domain.addCollaboratorAction({ owner: "acme", repo: "api", username: "  " })).toThrow("Validation Failed");
  });

  it("compare_commits 404s on unknown ref", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();
    expect(() => domain.compareCommits({ owner: "acme", repo: "api", base: "bogus", head: "main" })).toThrow("No commit found");
  });

  it("create_release auto-creates tag from default branch when target_commitish omitted", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();
    const release = domain.createRelease({ owner: "acme", repo: "api", tag_name: "v9.9.9" });
    expect(release.target_commitish).toBe("main");
  });

  it("can resolve a commit by tag", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();
    domain.createRelease({ owner: "acme", repo: "api", tag_name: "v1.2.3" });
    const commit = domain.getCommitWithFiles({ owner: "acme", repo: "api", ref: "v1.2.3" });
    expect(commit.sha).toBeTruthy();
  });

  it("on-disk file persistence + reopen works (rough migration check)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pome-twin-github-"));
    const path = join(dir, "github.sqlite");
    const db = openGitHubCloneDatabase(path);
    try {
      const domain = new GitHubDomain(db);
      domain.seed();
      domain.createMilestone({ owner: "acme", repo: "api", title: "persisted" });
      db.close();

      const reopened = openGitHubCloneDatabase(path);
      try {
        const reopenedDomain = new GitHubDomain(reopened);
        expect(reopenedDomain.listMilestones({ owner: "acme", repo: "api" }).map((m: { title: string }) => m.title)).toEqual(["persisted"]);
      } finally {
        reopened.close();
      }
    } finally {
      // The engine's TwinDatabase surface has no `open` flag; close() on an
      // already-closed handle is the safe no-op equivalent.
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
