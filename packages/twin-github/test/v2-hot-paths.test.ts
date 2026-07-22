// SPDX-License-Identifier: Apache-2.0
// FDRS-300 — v2 hot path expansion (27 endpoints).
// One describe block per cluster. Each endpoint has at minimum a happy-path
// case + one error/edge case (404/422/409/permission).

import { describe, expect, it } from "vitest";
import { openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain/index.js";

function freshDomain() {
  const domain = new GitHubDomain(openGitHubCloneDatabase());
  domain.seed();
  return domain;
}

// ----- Cluster A — branches & files -----------------------------------

describe("v2 / cluster A — branches & files", () => {
  describe("list_branches", () => {
    it("returns seeded branches", () => {
      const domain = freshDomain();
      domain.createBranch({ owner: "acme", repo: "api", branch: "feature-x" });
      const branches = domain.listBranchesForRepo({ owner: "acme", repo: "api" });
      const names = branches.map((branch) => branch.name);
      expect(names).toEqual(expect.arrayContaining(["main", "feature-x"]));
    });

    it("paginates", () => {
      const domain = freshDomain();
      for (let i = 0; i < 5; i += 1) {
        domain.createBranch({ owner: "acme", repo: "api", branch: `b${i}` });
      }
      const page1 = domain.listBranchesForRepo({ owner: "acme", repo: "api", per_page: 2 });
      const page2 = domain.listBranchesForRepo({ owner: "acme", repo: "api", per_page: 2, page: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0]!.name).not.toBe(page2[0]!.name);
    });
  });

  describe("get_branch", () => {
    it("returns one branch by name", () => {
      const domain = freshDomain();
      const branch = domain.getBranchByName({ owner: "acme", repo: "api", branch: "main" });
      expect(branch.name).toBe("main");
      expect(branch.commit.sha).toBeTruthy();
    });

    it("404s on unknown branch", () => {
      const domain = freshDomain();
      expect(() => domain.getBranchByName({ owner: "acme", repo: "api", branch: "nope" })).toThrow("Branch not found");
    });
  });

  describe("delete_branch", () => {
    it("removes the branch and its files", () => {
      const domain = freshDomain();
      domain.createBranch({ owner: "acme", repo: "api", branch: "scrap" });
      domain.createOrUpdateFile({ owner: "acme", repo: "api", branch: "scrap", path: "scrap.txt", message: "m", content: "x\n" });
      domain.deleteBranch({ owner: "acme", repo: "api", branch: "scrap" });
      expect(() => domain.getBranchByName({ owner: "acme", repo: "api", branch: "scrap" })).toThrow("Branch not found");
    });

    it("refuses to delete the default branch", () => {
      const domain = freshDomain();
      expect(() => domain.deleteBranch({ owner: "acme", repo: "api", branch: "main" })).toThrow("Validation Failed");
    });

    it("refuses to delete a branch backing an open PR", () => {
      const domain = freshDomain();
      domain.createBranch({ owner: "acme", repo: "api", branch: "open-pr" });
      domain.createOrUpdateFile({ owner: "acme", repo: "api", branch: "open-pr", path: "x.txt", message: "m", content: "x\n" });
      domain.createPullRequest({ owner: "acme", repo: "api", title: "open", head: "open-pr", base: "main" });
      expect(() => domain.deleteBranch({ owner: "acme", repo: "api", branch: "open-pr" })).toThrow("Validation Failed");
    });
  });

  describe("delete_file", () => {
    it("deletes the file and advances branch head", () => {
      const domain = freshDomain();
      const created = domain.createOrUpdateFile({ owner: "acme", repo: "api", path: "scratch.md", message: "m", content: "x\n" });
      const sha = (created.content as { sha: string }).sha;
      const result = domain.deleteFile({ owner: "acme", repo: "api", path: "scratch.md", message: "Drop", sha });
      expect(result.commit).toMatchObject({ sha: expect.any(String) });
      expect(() => domain.getFileContents({ owner: "acme", repo: "api", path: "scratch.md" })).toThrow("Not Found");
    });

    it("requires matching sha (optimistic locking)", () => {
      const domain = freshDomain();
      domain.createOrUpdateFile({ owner: "acme", repo: "api", path: "lock.md", message: "m", content: "x\n" });
      expect(() => domain.deleteFile({ owner: "acme", repo: "api", path: "lock.md", message: "stale", sha: "WRONG" })).toThrow("Validation Failed");
    });

    it("404s on missing file", () => {
      const domain = freshDomain();
      expect(() => domain.deleteFile({ owner: "acme", repo: "api", path: "ghost.md", message: "m", sha: "abc" })).toThrow("Not Found");
    });
  });
});

// ----- Cluster B — commits & diffs ------------------------------------

describe("v2 / cluster B — commits & diffs", () => {
  describe("get_commit", () => {
    it("resolves a commit by SHA", () => {
      const domain = freshDomain();
      const commits = domain.listCommits({ owner: "acme", repo: "api" });
      const head = (commits[0] as { sha: string }).sha;
      const commit = domain.getCommitWithFiles({ owner: "acme", repo: "api", ref: head });
      expect(commit.sha).toBe(head);
      expect(commit.stats).toMatchObject({ additions: expect.any(Number), deletions: expect.any(Number) });
    });

    it("resolves a commit by branch name", () => {
      const domain = freshDomain();
      const commit = domain.getCommitWithFiles({ owner: "acme", repo: "api", ref: "main" });
      expect(commit.sha).toBeTruthy();
    });

    it("404s on unknown ref", () => {
      const domain = freshDomain();
      expect(() => domain.getCommitWithFiles({ owner: "acme", repo: "api", ref: "nope-ref" })).toThrow("No commit found");
    });
  });

  describe("compare_commits", () => {
    it("returns identical for same ref", () => {
      const domain = freshDomain();
      const result = domain.compareCommits({ owner: "acme", repo: "api", base: "main", head: "main" });
      expect(result.status).toBe("identical");
      expect(result.ahead_by).toBe(0);
      expect(result.behind_by).toBe(0);
    });

    it("returns ahead when head has new commits past base", () => {
      const domain = freshDomain();
      const before = domain.listCommits({ owner: "acme", repo: "api" });
      const baseSha = (before[0] as { sha: string }).sha;
      domain.createOrUpdateFile({ owner: "acme", repo: "api", path: "new.txt", message: "advance", content: "new\n" });
      const result = domain.compareCommits({ owner: "acme", repo: "api", base: baseSha, head: "main" });
      expect(result.status).toBe("ahead");
      expect(result.ahead_by).toBeGreaterThan(0);
    });
  });

  describe("get_pull_request_diff", () => {
    it("returns a unified-diff envelope for a PR", () => {
      const domain = freshDomain();
      domain.createBranch({ owner: "acme", repo: "api", branch: "diff-branch" });
      domain.createOrUpdateFile({ owner: "acme", repo: "api", branch: "diff-branch", path: "added.ts", message: "m", content: "yes\n" });
      const pr = domain.createPullRequest({ owner: "acme", repo: "api", title: "Diff", head: "diff-branch", base: "main" });
      const result = domain.getPullRequestDiff({ owner: "acme", repo: "api", pull_number: pr.number });
      expect(result.diff).toContain("added.ts");
      expect(result.diff).toContain("diff --git");
    });

    it("404s on unknown PR", () => {
      const domain = freshDomain();
      expect(() => domain.getPullRequestDiff({ owner: "acme", repo: "api", pull_number: 9999 })).toThrow("Pull request not found");
    });
  });
});

// ----- Cluster C — PR deeper ------------------------------------------

describe("v2 / cluster C — pull requests deeper", () => {
  function makeOpenPr(domain: GitHubDomain) {
    domain.createBranch({ owner: "acme", repo: "api", branch: "c-branch" });
    domain.createOrUpdateFile({ owner: "acme", repo: "api", branch: "c-branch", path: "file.ts", message: "m", content: "1\n" });
    return domain.createPullRequest({ owner: "acme", repo: "api", title: "C", head: "c-branch", base: "main" });
  }

  describe("update_pull_request", () => {
    it("updates title/body", () => {
      const domain = freshDomain();
      const pr = makeOpenPr(domain) as { number: number };
      const updated = domain.updatePullRequest({ owner: "acme", repo: "api", pull_number: pr.number, title: "New title", body: "new body" });
      expect(updated.title).toBe("New title");
      expect(updated.body).toBe("new body");
    });

    it("recomputes PR files on base change", () => {
      const domain = freshDomain();
      domain.createBranch({ owner: "acme", repo: "api", branch: "alt-base" });
      const pr = makeOpenPr(domain) as { number: number };
      const updated = domain.updatePullRequest({ owner: "acme", repo: "api", pull_number: pr.number, base: "alt-base" });
      expect(updated.base.ref).toBe("alt-base");
    });

    it("422 on unknown base", () => {
      const domain = freshDomain();
      const pr = makeOpenPr(domain) as { number: number };
      expect(() => domain.updatePullRequest({ owner: "acme", repo: "api", pull_number: pr.number, base: "ghost-branch" })).toThrow("Branch not found");
    });
  });

  describe("get_pull_request_commits", () => {
    it("lists commits between base and head", () => {
      const domain = freshDomain();
      const pr = makeOpenPr(domain) as { number: number };
      const commits = domain.getPullRequestCommits({ owner: "acme", repo: "api", pull_number: pr.number });
      expect(commits.length).toBeGreaterThan(0);
    });
  });

  describe("create_pull_request_review_comment", () => {
    it("creates an inline comment on a PR file", () => {
      const domain = freshDomain();
      const pr = makeOpenPr(domain) as { number: number };
      const comment = domain.createPullRequestReviewComment({ owner: "acme", repo: "api", pull_number: pr.number, body: "Nit", path: "file.ts", line: 1 });
      expect(comment.body).toBe("Nit");
      expect(comment.path).toBe("file.ts");
      expect(comment.line).toBe(1);
    });

    it("validates comment line numbers against the target file, not the change count", () => {
      const domain = freshDomain();
      const baseContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
      const headContent = `${Array.from({ length: 19 }, (_, i) => `line ${i + 1}`).join("\n")}\nchanged line 20\n`;
      domain.createOrUpdateFile({ owner: "acme", repo: "api", path: "long.ts", message: "base", content: baseContent });
      domain.createBranch({ owner: "acme", repo: "api", branch: "long-branch" });
      const existing = domain.getFileContents({ owner: "acme", repo: "api", ref: "long-branch", path: "long.ts" }) as { sha: string };
      domain.createOrUpdateFile({ owner: "acme", repo: "api", branch: "long-branch", path: "long.ts", message: "head", content: headContent, sha: existing.sha });
      const pr = domain.createPullRequest({ owner: "acme", repo: "api", title: "Long", head: "long-branch", base: "main" }) as { number: number };
      const comment = domain.createPullRequestReviewComment({ owner: "acme", repo: "api", pull_number: pr.number, body: "Deep nit", path: "long.ts", line: 20 });
      expect(comment.line).toBe(20);
      expect(() => domain.createPullRequestReviewComment({ owner: "acme", repo: "api", pull_number: pr.number, body: "x", path: "long.ts", line: 21 })).toThrow("Validation Failed");
    });

    it("422 if path is not part of the PR", () => {
      const domain = freshDomain();
      const pr = makeOpenPr(domain) as { number: number };
      expect(() => domain.createPullRequestReviewComment({ owner: "acme", repo: "api", pull_number: pr.number, body: "x", path: "not-in-pr.ts", line: 1 })).toThrow("Validation Failed");
    });

    it("rejects missing line, invalid line, and unknown commit anchors", () => {
      const domain = freshDomain();
      const pr = makeOpenPr(domain) as { number: number };
      expect(() => domain.createPullRequestReviewComment({ owner: "acme", repo: "api", pull_number: pr.number, body: "x", path: "file.ts" })).toThrow("Validation Failed");
      expect(() => domain.createPullRequestReviewComment({ owner: "acme", repo: "api", pull_number: pr.number, body: "x", path: "file.ts", line: 999 })).toThrow("Validation Failed");
      expect(() => domain.createPullRequestReviewComment({ owner: "acme", repo: "api", pull_number: pr.number, body: "x", path: "file.ts", line: 1, commit_id: "deadbeef" })).toThrow("Validation Failed");
    });
  });

  describe("add_reply_to_pull_request_comment", () => {
    it("creates a reply inheriting path/line/side", () => {
      const domain = freshDomain();
      const pr = makeOpenPr(domain) as { number: number };
      const parent = domain.createPullRequestReviewComment({ owner: "acme", repo: "api", pull_number: pr.number, body: "Nit", path: "file.ts", line: 1, side: "RIGHT" });
      const reply = domain.addReplyToPullRequestComment({ owner: "acme", repo: "api", pull_number: pr.number, comment_id: parent.id, body: "Fixed" });
      expect(reply.body).toBe("Fixed");
      expect(reply.path).toBe("file.ts");
      expect(reply.in_reply_to_id).toBe(parent.id);
      expect(reply.side).toBe("RIGHT");
    });

    it("404s when the parent comment doesn't exist", () => {
      const domain = freshDomain();
      const pr = makeOpenPr(domain) as { number: number };
      expect(() => domain.addReplyToPullRequestComment({ owner: "acme", repo: "api", pull_number: pr.number, comment_id: 99999, body: "x" })).toThrow("Review comment not found");
    });
  });
});

// ----- Cluster D — issue comments deeper ------------------------------

describe("v2 / cluster D — issue comments deeper", () => {
  describe("update_issue_comment", () => {
    it("updates the body and bumps updated_at", () => {
      const domain = freshDomain();
      const comment = domain.addIssueComment({ owner: "acme", repo: "api", issue_number: 1, body: "first" });
      const updated = domain.updateIssueComment({ owner: "acme", repo: "api", comment_id: comment.id, body: "second" });
      expect(updated.body).toBe("second");
    });

    it("404s on unknown comment_id", () => {
      const domain = freshDomain();
      expect(() => domain.updateIssueComment({ owner: "acme", repo: "api", comment_id: 9999, body: "x" })).toThrow("Issue comment not found");
    });
  });

  describe("delete_issue_comment", () => {
    it("removes the comment", () => {
      const domain = freshDomain();
      const comment = domain.addIssueComment({ owner: "acme", repo: "api", issue_number: 1, body: "tmp" });
      domain.deleteIssueComment({ owner: "acme", repo: "api", comment_id: comment.id });
      expect(() => domain.updateIssueComment({ owner: "acme", repo: "api", comment_id: comment.id, body: "x" })).toThrow("Issue comment not found");
    });

    it("404s on unknown comment_id", () => {
      const domain = freshDomain();
      expect(() => domain.deleteIssueComment({ owner: "acme", repo: "api", comment_id: 9999 })).toThrow("Issue comment not found");
    });
  });
});

// ----- Cluster E — milestones CRUD ------------------------------------

describe("v2 / cluster E — milestones", () => {
  describe("create_milestone / list_milestones", () => {
    it("creates and lists milestones", () => {
      const domain = freshDomain();
      const m = domain.createMilestone({ owner: "acme", repo: "api", title: "v1", description: "first" });
      expect(m.title).toBe("v1");
      expect(m.state).toBe("open");
      const list = domain.listMilestones({ owner: "acme", repo: "api" });
      expect(list.find((row: { title: string }) => row.title === "v1")).toBeTruthy();
    });

    it("422 on duplicate title", () => {
      const domain = freshDomain();
      domain.createMilestone({ owner: "acme", repo: "api", title: "v2" });
      expect(() => domain.createMilestone({ owner: "acme", repo: "api", title: "v2" })).toThrow("Validation Failed");
    });

    it("state filter narrows by open/closed", () => {
      const domain = freshDomain();
      const a = domain.createMilestone({ owner: "acme", repo: "api", title: "alpha" });
      const b = domain.createMilestone({ owner: "acme", repo: "api", title: "beta" });
      domain.updateMilestone({ owner: "acme", repo: "api", milestone_number: b.number, state: "closed" });
      const open = domain.listMilestones({ owner: "acme", repo: "api", state: "open" });
      const closed = domain.listMilestones({ owner: "acme", repo: "api", state: "closed" });
      expect(open.map((m: { title: string }) => m.title)).toContain("alpha");
      expect(closed.map((m: { title: string }) => m.title)).toContain("beta");
      void a;
    });
  });

  describe("update_milestone", () => {
    it("updates fields and sets closed_at on close", () => {
      const domain = freshDomain();
      const m = domain.createMilestone({ owner: "acme", repo: "api", title: "soon" });
      const updated = domain.updateMilestone({ owner: "acme", repo: "api", milestone_number: m.number, state: "closed", description: "wrapped" });
      expect(updated.state).toBe("closed");
      expect(updated.description).toBe("wrapped");
      expect(updated.closed_at).toBeTruthy();
    });

    it("404s on unknown milestone", () => {
      const domain = freshDomain();
      expect(() => domain.updateMilestone({ owner: "acme", repo: "api", milestone_number: 999, state: "closed" })).toThrow("Milestone not found");
    });

    it("rejects blank and duplicate titles", () => {
      const domain = freshDomain();
      const alpha = domain.createMilestone({ owner: "acme", repo: "api", title: "alpha" });
      domain.createMilestone({ owner: "acme", repo: "api", title: "beta" });
      expect(() => domain.updateMilestone({ owner: "acme", repo: "api", milestone_number: alpha.number, title: "  " })).toThrow("Validation Failed");
      expect(() => domain.updateMilestone({ owner: "acme", repo: "api", milestone_number: alpha.number, title: "beta" })).toThrow("Validation Failed");
    });
  });

  describe("delete_milestone", () => {
    it("removes the milestone", () => {
      const domain = freshDomain();
      const m = domain.createMilestone({ owner: "acme", repo: "api", title: "gone" });
      domain.deleteMilestone({ owner: "acme", repo: "api", milestone_number: m.number });
      expect(() => domain.updateMilestone({ owner: "acme", repo: "api", milestone_number: m.number, state: "closed" })).toThrow("Milestone not found");
    });
  });
});

// ----- Cluster F — commit status + checks -----------------------------

describe("v2 / cluster F — commit status + checks", () => {
  function head(domain: GitHubDomain) {
    const commits = domain.listCommits({ owner: "acme", repo: "api" }) as Array<{ sha: string }>;
    return commits[0]!.sha;
  }

  describe("create_commit_status", () => {
    it("creates a commit status on a real commit", () => {
      const domain = freshDomain();
      const sha = head(domain);
      const row = domain.createCommitStatus({ owner: "acme", repo: "api", sha, state: "success", context: "ci/lint" });
      expect(row.state).toBe("success");
      expect(row.context).toBe("ci/lint");
    });

    it("404 if the SHA isn't in the repo", () => {
      const domain = freshDomain();
      expect(() => domain.createCommitStatus({ owner: "acme", repo: "api", sha: "deadbeef", state: "success" })).toThrow("No commit found");
    });
  });

  describe("get_combined_status_for_ref", () => {
    it("returns the combined GitHub-rule state", () => {
      const domain = freshDomain();
      const sha = head(domain);
      domain.createCommitStatus({ owner: "acme", repo: "api", sha, state: "success", context: "ci/test" });
      domain.createCommitStatus({ owner: "acme", repo: "api", sha, state: "pending", context: "ci/build" });
      const combined = domain.getCombinedStatusForRef({ owner: "acme", repo: "api", ref: sha });
      expect(combined.state).toBe("pending");
      const failing = domain.createCommitStatus({ owner: "acme", repo: "api", sha, state: "failure", context: "ci/integration" });
      const failed = domain.getCombinedStatusForRef({ owner: "acme", repo: "api", ref: sha });
      expect(failed.state).toBe("failure");
      void failing;
    });

    it("returns pending when there are zero recorded statuses (matches GitHub)", () => {
      const domain = freshDomain();
      const sha = head(domain);
      const combined = domain.getCombinedStatusForRef({ owner: "acme", repo: "api", ref: sha });
      expect(combined.state).toBe("pending");
    });

    it("uses only the latest status per context", () => {
      const domain = freshDomain();
      const sha = head(domain);
      domain.createCommitStatus({ owner: "acme", repo: "api", sha, state: "failure", context: "ci/test" });
      domain.createCommitStatus({ owner: "acme", repo: "api", sha, state: "success", context: "ci/test" });
      const combined = domain.getCombinedStatusForRef({ owner: "acme", repo: "api", ref: sha });
      expect(combined.state).toBe("success");
      expect(combined.total_count).toBe(1);
      expect(combined.statuses).toHaveLength(1);
    });
  });

  describe("create_check_run", () => {
    it("creates a check run on a real SHA", () => {
      const domain = freshDomain();
      const sha = head(domain);
      const run = domain.createCheckRun({ owner: "acme", repo: "api", name: "lint", head_sha: sha, status: "completed", conclusion: "success" });
      expect(run.name).toBe("lint");
      expect(run.status).toBe("completed");
      expect(run.conclusion).toBe("success");
    });

    it("422 when status=completed but no conclusion", () => {
      const domain = freshDomain();
      const sha = head(domain);
      expect(() => domain.createCheckRun({ owner: "acme", repo: "api", name: "lint", head_sha: sha, status: "completed" })).toThrow("Validation Failed");
    });

    it("rejects conclusion and completed_at unless status is completed", () => {
      const domain = freshDomain();
      const sha = head(domain);
      expect(() => domain.createCheckRun({ owner: "acme", repo: "api", name: "lint", head_sha: sha, status: "queued", conclusion: "success" })).toThrow("Validation Failed");
      expect(() => domain.createCheckRun({ owner: "acme", repo: "api", name: "lint", head_sha: sha, status: "in_progress", completed_at: "2026-01-01T00:00:00Z" })).toThrow("Validation Failed");
    });

    it("404 when head_sha is not in the repo", () => {
      const domain = freshDomain();
      expect(() => domain.createCheckRun({ owner: "acme", repo: "api", name: "lint", head_sha: "deadbeef" })).toThrow("No commit found");
    });
  });

  describe("list_check_runs_for_ref", () => {
    it("returns check runs for a SHA", () => {
      const domain = freshDomain();
      const sha = head(domain);
      domain.createCheckRun({ owner: "acme", repo: "api", name: "lint", head_sha: sha });
      domain.createCheckRun({ owner: "acme", repo: "api", name: "test", head_sha: sha });
      const list = domain.listCheckRunsForRef({ owner: "acme", repo: "api", ref: sha });
      expect(list.total_count).toBe(2);
      expect(list.check_runs.map((row: { name: string }) => row.name)).toEqual(expect.arrayContaining(["lint", "test"]));
    });
  });
});

// ----- Cluster G — tags & releases ------------------------------------

describe("v2 / cluster G — tags & releases", () => {
  describe("create_release / list_tags", () => {
    it("auto-creates a tag and lists it", () => {
      const domain = freshDomain();
      domain.createRelease({ owner: "acme", repo: "api", tag_name: "v0.1.0", name: "First" });
      const tags = domain.listTags({ owner: "acme", repo: "api" });
      expect(tags.map((tag: { name: string }) => tag.name)).toContain("v0.1.0");
    });

    it("422 on duplicate tag", () => {
      const domain = freshDomain();
      domain.createRelease({ owner: "acme", repo: "api", tag_name: "v0.2.0" });
      expect(() => domain.createRelease({ owner: "acme", repo: "api", tag_name: "v0.2.0" })).toThrow("Validation Failed");
    });
  });

  describe("list_releases / get_latest_release", () => {
    it("latest skips drafts and prereleases", () => {
      const domain = freshDomain();
      domain.createRelease({ owner: "acme", repo: "api", tag_name: "v1.0.0", name: "Stable" });
      domain.createRelease({ owner: "acme", repo: "api", tag_name: "v1.0.1-rc1", name: "RC", prerelease: true });
      domain.createRelease({ owner: "acme", repo: "api", tag_name: "v1.0.2-draft", name: "Draft", draft: true });
      const latest = domain.getLatestRelease({ owner: "acme", repo: "api" });
      expect(latest.tag_name).toBe("v1.0.0");
      const all = domain.listReleases({ owner: "acme", repo: "api" });
      expect(all).toHaveLength(3);
    });

    it("404 if there is no published release", () => {
      const domain = freshDomain();
      expect(() => domain.getLatestRelease({ owner: "acme", repo: "api" })).toThrow("Not Found");
    });
  });
});

// ----- Cluster H — identity & collaborators ---------------------------

describe("v2 / cluster H — identity & collaborators", () => {
  describe("get_me", () => {
    it("returns the JWT-claimed login (defaults to pome-agent)", () => {
      const domain = freshDomain();
      const me = domain.getMe();
      expect(me.login).toBe("pome-agent");
      const meAlice = domain.getMe({ actor: "alice" });
      expect(meAlice.login).toBe("alice");
    });
  });

  describe("add_collaborator", () => {
    it("creates an invitation envelope for a new user", () => {
      const domain = freshDomain();
      const result = domain.addCollaboratorAction({ owner: "acme", repo: "api", username: "outsider" });
      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({ invitee: expect.objectContaining({ login: "outsider" }) });
    });

    it("returns 204 for an existing collaborator", () => {
      const domain = freshDomain();
      const result = domain.addCollaboratorAction({ owner: "acme", repo: "api", username: "alice" });
      expect(result.status).toBe(204);
    });

    it("updates permission for an existing collaborator without duplicating rows", () => {
      const domain = freshDomain();
      const result = domain.addCollaboratorAction({ owner: "acme", repo: "api", username: "alice", permission: "admin" });
      expect(result.status).toBe(204);
      const rows = domain.db.prepare("SELECT permission FROM collaborators WHERE repo_id = (SELECT id FROM repositories WHERE full_name = ?) AND login = ?").all("acme/api", "alice") as Array<{ permission: string }>;
      expect(rows).toEqual([{ permission: "admin" }]);
    });
  });
});
