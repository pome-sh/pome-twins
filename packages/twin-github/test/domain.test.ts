import { describe, expect, it } from "vitest";
import { openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain.js";
import { parseSeed } from "../src/seed.js";

describe("GitHubDomain edge cases", () => {
  it("rejects duplicate branches and duplicate open pull requests", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    domain.createBranch({ owner: "acme", repo: "api", branch: "dup" });
    expect(() => domain.createBranch({ owner: "acme", repo: "api", branch: "dup" })).toThrow("Validation Failed");

    domain.pushFiles({
      owner: "acme",
      repo: "api",
      branch: "dup",
      message: "Change",
      files: [{ path: "dup.txt", content: "dup\n" }]
    });
    domain.createPullRequest({ owner: "acme", repo: "api", title: "Dup", head: "dup", base: "main" });
    expect(() => domain.createPullRequest({ owner: "acme", repo: "api", title: "Dup again", head: "dup", base: "main" })).toThrow("Validation Failed");
  });

  it("keeps multi-file pushes atomic when one path is invalid", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    expect(() =>
      domain.pushFiles({
        owner: "acme",
        repo: "api",
        branch: "main",
        message: "Bad push",
        files: [
          { path: "good.txt", content: "good\n" },
          { path: "../bad.txt", content: "bad\n" }
        ]
      })
    ).toThrow("Validation Failed");

    expect(() => domain.getFileContents({ owner: "acme", repo: "api", path: "good.txt" })).toThrow("Not Found");
  });

  it("allows root directory reads", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    const contents = domain.getFileContents({ owner: "acme", repo: "api", path: "" });
    expect(Array.isArray(contents)).toBe(true);
    expect((contents as Array<{ path: string }>).map((entry) => entry.path)).toContain("README.md");
  });

  it("requires matching sha when updating an existing file", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    const existing = domain.getFileContents({ owner: "acme", repo: "api", path: "README.md" }) as { sha: string };
    expect(() =>
      domain.createOrUpdateFile({
        owner: "acme",
        repo: "api",
        path: "README.md",
        message: "Unsafe stale update",
        content: "lost update\n"
      })
    ).toThrow("Validation Failed");
    expect(() =>
      domain.createOrUpdateFile({
        owner: "acme",
        repo: "api",
        path: "README.md",
        message: "Wrong sha update",
        content: "lost update\n",
        sha: "wrong"
      })
    ).toThrow("Validation Failed");

    const updated = domain.createOrUpdateFile({
      owner: "acme",
      repo: "api",
      path: "README.md",
      message: "Safe update",
      content: "safe update\n",
      sha: existing.sha
    });
    expect(updated.content.path).toBe("README.md");
  });

  it("lists commits reachable from the requested branch only", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    domain.createBranch({ owner: "acme", repo: "api", branch: "feature/commits" });
    domain.pushFiles({
      owner: "acme",
      repo: "api",
      branch: "feature/commits",
      message: "Feature commit",
      files: [{ path: "feature.txt", content: "feature\n" }]
    });

    const mainCommits = domain.listCommits({ owner: "acme", repo: "api", sha: "main" });
    const featureCommits = domain.listCommits({ owner: "acme", repo: "api", sha: "feature/commits" });
    expect(mainCommits).toHaveLength(1);
    expect(featureCommits).toHaveLength(2);
    expect(featureCommits[0].commit.message).toBe("Feature commit");
    const featureFile = domain.getFileContents({ owner: "acme", repo: "api", path: "feature.txt", ref: "feature/commits" }) as { html_url: string };
    expect(featureFile.html_url).toContain("/blob/feature/commits/feature.txt");
  });

  it("includes live issue comment counts", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    expect(domain.getIssue({ owner: "acme", repo: "api", issue_number: 1 }).comments).toBe(0);
    domain.addIssueComment({ owner: "acme", repo: "api", issue_number: 1, body: "I can reproduce this." });
    expect(domain.getIssue({ owner: "acme", repo: "api", issue_number: 1 }).comments).toBe(1);
  });

  it("populates pull request head and base SHAs", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    domain.createBranch({ owner: "acme", repo: "api", branch: "feature/pr-sha" });
    domain.pushFiles({
      owner: "acme",
      repo: "api",
      branch: "feature/pr-sha",
      message: "Change PR SHA fixture",
      files: [{ path: "pr-sha.txt", content: "sha\n" }]
    });
    const pr = domain.createPullRequest({ owner: "acme", repo: "api", title: "SHA fixture", head: "feature/pr-sha", base: "main" });

    expect(pr.head.sha).toEqual(expect.any(String));
    expect(pr.base.sha).toEqual(expect.any(String));
    expect(pr.head.sha).not.toBe(pr.base.sha);
  });

  it("uses one shared issue and pull request number sequence", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    domain.createBranch({ owner: "acme", repo: "api", branch: "feature/shared-number" });
    domain.pushFiles({
      owner: "acme",
      repo: "api",
      branch: "feature/shared-number",
      message: "Shared number fixture",
      files: [{ path: "shared-number.txt", content: "shared\n" }]
    });

    const pr = domain.createPullRequest({ owner: "acme", repo: "api", title: "Shared number", head: "feature/shared-number", base: "main" });
    expect(pr.number).toBe(2);
    expect(domain.createIssue({ owner: "acme", repo: "api", title: "After PR" }).number).toBe(3);
  });

  it("searches code on the default branch only", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();
    domain.createBranch({ owner: "acme", repo: "api", branch: "feature/search-duplicate" });

    const result = domain.searchCode({ owner: "acme", repo: "api", query: "Acme API" });

    expect(result.total_count).toBe(1);
    expect(result.items.map((item) => item.html_url)).toEqual(["https://github.com/acme/api/blob/main/README.md"]);
  });

  it("forks preserve reachable commit history", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    domain.forkRepository({ owner: "acme", repo: "api" });

    const commits = domain.listCommits({ owner: "pome-agent", repo: "api", sha: "main" });
    expect(commits).toHaveLength(1);
    expect(commits[0].commit.message).toBe("Initial seed commit");
  });

  it("keeps seeded issue children when explicit issue numbers are reassigned", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed(
      parseSeed({
        users: [
          { login: "octo", type: "Organization", name: "Octo" },
          { login: "alice", type: "User", name: "Alice" }
        ],
        repositories: [
          {
            owner: "octo",
            name: "issues",
            collaborators: ["alice"],
            labels: [{ name: "bug", color: "d73a4a" }],
            issues: [{ number: 7, title: "Explicitly numbered issue", labels: ["bug"], assignees: ["alice"] }]
          }
        ]
      })
    );

    const issue = domain.getIssue({ owner: "octo", repo: "issues", issue_number: 7 });
    expect(issue.labels.map((label) => label.name)).toEqual(["bug"]);
    expect(issue.assignees.map((assignee) => assignee.login)).toEqual(["alice"]);
    expect(domain.createIssue({ owner: "octo", repo: "issues", title: "Next issue" }).number).toBe(8);
  });

  it("creates commit statuses and exposes them through pull request status", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    domain.createBranch({ owner: "acme", repo: "api", branch: "feature/status" });
    domain.pushFiles({
      owner: "acme",
      repo: "api",
      branch: "feature/status",
      message: "Status fixture",
      files: [{ path: "status.txt", content: "status\n" }]
    });
    const pr = domain.createPullRequest({ owner: "acme", repo: "api", title: "Status fixture", head: "feature/status", base: "main" });
    expect(pr.head.sha).toEqual(expect.any(String));

    domain.createStatus({ owner: "acme", repo: "api", sha: pr.head.sha!, state: "failure", context: "ci/test" });
    const status = domain.createStatus({ owner: "acme", repo: "api", sha: pr.head.sha!, state: "success", context: "ci/test" }) as { state: string; context: string };
    expect(status).toMatchObject({ state: "success", context: "ci/test" });
    expect(domain.getPullRequestStatus({ owner: "acme", repo: "api", pull_number: pr.number })).toMatchObject({ state: "success", total_count: 1 });
    expect(domain.mergePullRequest({ owner: "acme", repo: "api", pull_number: pr.number }).merged).toBe(true);
  });

  it("rejects conflicting pull request mutations", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    domain.createBranch({ owner: "acme", repo: "api", branch: "feature/conflict" });
    domain.pushFiles({
      owner: "acme",
      repo: "api",
      branch: "feature/conflict",
      message: "Conflict fixture",
      files: [{ path: "conflict.txt", content: "conflict\n" }]
    });
    const pr = domain.createPullRequest({ owner: "acme", repo: "api", title: "Conflict fixture", head: "feature/conflict", base: "main" });

    expect(() => domain.updatePullRequestBranch({ owner: "acme", repo: "api", pull_number: pr.number, expected_head_sha: "wrong" })).toThrow("Head SHA did not match");
    expect(domain.mergePullRequest({ owner: "acme", repo: "api", pull_number: pr.number })).toMatchObject({ merged: true });
    expect(() => domain.mergePullRequest({ owner: "acme", repo: "api", pull_number: pr.number })).toThrow("Pull request is closed");
  });

  it("pins updatePullRequestBranch as a semantic merge of base into head (F-735)", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    domain.createBranch({ owner: "acme", repo: "api", branch: "feature/update-branch" });
    domain.pushFiles({
      owner: "acme",
      repo: "api",
      branch: "feature/update-branch",
      message: "Update branch fixture",
      files: [{ path: "update-branch.txt", content: "head-only\n" }]
    });
    domain.pushFiles({
      owner: "acme",
      repo: "api",
      branch: "main",
      message: "Base drift",
      files: [{ path: "base-drift.txt", content: "drift\n" }]
    });
    const pr = domain.createPullRequest({ owner: "acme", repo: "api", title: "Update branch fixture", head: "feature/update-branch", base: "main" });
    expect(pr.head.sha).toEqual(expect.any(String));

    expect(domain.updatePullRequestBranch({ owner: "acme", repo: "api", pull_number: pr.number, expected_head_sha: pr.head.sha! })).toMatchObject({
      message: "Updating pull request branch."
    });
    const updated = domain.getPullRequest({ owner: "acme", repo: "api", pull_number: pr.number });

    // Head gains a merge commit: it advances past the old head instead of being
    // reset to the base pointer, and the PR diff keeps the PR's own change.
    expect(updated.head.sha).not.toBe(pr.head.sha);
    expect(updated.head.sha).not.toBe(updated.base.sha);
    expect(domain.getPullRequestFiles({ owner: "acme", repo: "api", pull_number: pr.number }).map((file) => file.filename)).toContain("update-branch.txt");
  });

  it("merges pull requests that remove files", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    domain.createBranch({ owner: "acme", repo: "api", branch: "remove-files", sha: "empty-tree-sha" });
    const pr = domain.createPullRequest({ owner: "acme", repo: "api", title: "Remove seeded files", head: "remove-files", base: "main" });
    const files = domain.getPullRequestFiles({ owner: "acme", repo: "api", pull_number: pr.number });
    expect(files.every((file) => file.status === "removed")).toBe(true);

    expect(domain.mergePullRequest({ owner: "acme", repo: "api", pull_number: pr.number })).toMatchObject({ merged: true });
    expect(() => domain.getFileContents({ owner: "acme", repo: "api", path: "README.md", ref: "main" })).toThrow("Not Found");
  });

  it("uses a repo custom default branch for seed files without explicit branches", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed(
      parseSeed({
        users: [{ login: "octo", type: "Organization", name: "Octo" }],
        repositories: [
          {
            owner: "octo",
            name: "trunked",
            default_branch: "trunk",
            files: [{ path: "README.md", content: "# Trunked\n" }]
          }
        ]
      })
    );

    const content = domain.getFileContents({ owner: "octo", repo: "trunked", path: "README.md", ref: "trunk" });
    expect(content).toMatchObject({ path: "README.md" });
  });
});
