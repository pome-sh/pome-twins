import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openGitHubCloneDatabase } from "../src/db.js";
import { GitHubDomain } from "../src/domain/index.js";
import { parseSeed } from "../src/seed.js";
import { createGitHubCloneApp } from "../src/twin.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

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

describe("state export determinism (F-682)", () => {
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

  it("determinism: same seed + same ops => same state (timestamps + shas modulo)", async () => {
    const run = async () => {
      const db = openGitHubCloneDatabase(":memory:");
      const domain = new GitHubDomain(db);
      domain.seed();
      const app = createGitHubCloneApp({ db });

      domain.createBranch({ owner: "acme", repo: "api", branch: "det/check" });
      domain.pushFiles({
        owner: "acme",
        repo: "api",
        branch: "det/check",
        message: "Deterministic change",
        files: [{ path: "det.txt", content: "same bytes every run\n" }]
      });
      const pr = domain.createPullRequest({
        owner: "acme",
        repo: "api",
        title: "det: check state export",
        head: "det/check",
        base: "main"
      });
      domain.addIssueComment({ owner: "acme", repo: "api", issue_number: 1, body: "det comment" });
      domain.createPullRequestReview({ owner: "acme", repo: "api", pull_number: pr.number, event: "APPROVE" });

      const res = await app.request(`/s/${TEST_SID}/_pome/state`, withAuth(token));
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    // Wall-clock audit columns and fabricated shas (makeSha salts with a
    // random UUID) are the only intentionally-nondeterministic fields; the
    // remaining export must be identical across runs.
    const strip = (s: string) =>
      s
        .replace(/"[a-z_]+_at":("[^"]*"|null)/g, '"<at>":"<ts>"')
        .replace(/[0-9a-f]{40}/g, "<sha>");
    expect(strip(JSON.stringify(await run()))).toBe(strip(JSON.stringify(await run())));
  });
});
