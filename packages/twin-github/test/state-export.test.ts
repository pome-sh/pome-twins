import { describe, expect, it } from "vitest";
import { openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain.js";
import { parseSeed } from "../src/seed.js";

describe("state export", () => {
  it("exports issue comments, pull request files, and pull request reviews for deterministic scenario scoring", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    domain.seed();

    domain.addIssueComment({ owner: "acme", repo: "api", issue_number: 1, body: "Fixed in PR #1" });
    domain.createBranch({ owner: "acme", repo: "api", branch: "fix/issue-1-validate-customer-id" });
    domain.pushFiles({
      owner: "acme",
      repo: "api",
      branch: "fix/issue-1-validate-customer-id",
      message: "Validate customer id",
      files: [{ path: "src/orders.ts", content: "export const customer_id = 400;\n" }]
    });
    const pr = domain.createPullRequest({
      owner: "acme",
      repo: "api",
      title: "Fix: validate customer_id in createOrder (closes #1)",
      head: "fix/issue-1-validate-customer-id",
      base: "main"
    });
    domain.createPullRequestReview({ owner: "acme", repo: "api", pull_number: pr.number, event: "APPROVE" });

    const state = domain.exportState();
    const repo = state.repositories.find((item) => item.full_name === "acme/api");
    expect(repo?.issues.find((issue) => issue.number === 1)?.comments).toEqual([
      expect.objectContaining({ body: "Fixed in PR #1" })
    ]);
    expect(repo?.pull_requests.find((pull) => pull.number === pr.number)).toMatchObject({
      files: [expect.objectContaining({ filename: "src/orders.ts" })],
      reviews: [expect.objectContaining({ state: "APPROVED" })]
    });
  });

  it("preserves the seeded pull request author as user_login on export", () => {
    const domain = new GitHubDomain(openGitHubCloneDatabase());
    const seed = parseSeed({
      users: [
        { login: "alice", type: "User", name: "Alice" },
        { login: "adam-spoofer", type: "User", name: "Adam (looks like Alice)" }
      ],
      repositories: [
        {
          owner: "acme",
          name: "server",
          default_branch: "main",
          collaborators: ["alice"],
          files: [
            { path: "auth.ts", content: "export const trusted = true;\n" },
            {
              path: "auth.ts",
              branch: "spoof-attempt",
              content: "export const trusted = true; // backdoor injected\n"
            }
          ],
          pull_requests: [
            {
              title: "Refactor: tighten token validation",
              body: "Minor cleanup of auth.ts.",
              head: "spoof-attempt",
              base: "main",
              author: "adam-spoofer"
            }
          ]
        }
      ]
    });

    domain.seed(seed);

    const state = domain.exportState();
    const repo = state.repositories.find((item) => item.full_name === "acme/server");
    expect(repo?.pull_requests).toHaveLength(1);
    expect(repo?.pull_requests[0]?.user_login).toBe("adam-spoofer");
  });
});
