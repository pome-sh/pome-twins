import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { listTools } from "../src/tools.js";
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

describe("MCP tool contract", () => {
  it("lists and executes all 62 GitHub twin tools", async () => {
    const app = createGitHubCloneApp();
    expect(listTools().map((tool) => tool.name)).toEqual([
      "search_repositories",
      "create_repository",
      "fork_repository",
      "get_repository",
      "search_code",
      "search_users",
      "get_file_contents",
      "list_commits",
      "create_or_update_file",
      "create_branch",
      "push_files",
      "get_issue",
      "update_issue",
      "search_issues",
      "list_issues",
      "add_issue_comment",
      "list_issue_comments",
      "create_issue",
      "list_repository_labels",
      "create_label",
      "list_issue_labels",
      "add_issue_labels",
      "remove_issue_label",
      "list_collaborators",
      "add_assignees",
      "get_pull_request",
      "get_pull_request_reviews",
      "create_pull_request_review",
      "get_pull_request_comments",
      "get_pull_request_files",
      "get_pull_request_status",
      "list_pull_requests",
      "merge_pull_request",
      "update_pull_request_branch",
      "create_pull_request",
      // v2 hot paths (FDRS-300)
      "list_branches",
      "get_branch",
      "delete_branch",
      "delete_file",
      "get_commit",
      "compare_commits",
      "get_pull_request_diff",
      "update_pull_request",
      "get_pull_request_commits",
      "create_pull_request_review_comment",
      "add_reply_to_pull_request_comment",
      "update_issue_comment",
      "delete_issue_comment",
      "list_milestones",
      "create_milestone",
      "update_milestone",
      "delete_milestone",
      "create_commit_status",
      "get_combined_status_for_ref",
      "create_check_run",
      "list_check_runs_for_ref",
      "list_tags",
      "list_releases",
      "get_latest_release",
      "create_release",
      "get_me",
      "add_collaborator"
    ]);

    await call(app, "search_repositories", { query: "acme" });
    await call(app, "create_repository", { owner: "qa", name: "repo" });
    await call(app, "fork_repository", { owner: "acme", repo: "api", organization: "forks" });
    await call(app, "get_repository", { owner: "acme", repo: "api" });
    await call(app, "search_code", { query: "handler" });
    await call(app, "search_users", { query: "alice" });
    await call(app, "get_file_contents", { owner: "acme", repo: "api", path: "README.md" });
    await call(app, "list_commits", { owner: "acme", repo: "api" });
    const created = await call(app, "create_or_update_file", { owner: "acme", repo: "api", path: "contract.txt", message: "Add contract", content: "ok\n" });
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "contract" });
    await call(app, "push_files", { owner: "acme", repo: "api", branch: "contract", message: "Change", files: [{ path: "contract.txt", content: "changed\n" }] });
    await call(app, "get_issue", { owner: "acme", repo: "api", issue_number: 1 });
    await call(app, "update_issue", { owner: "acme", repo: "api", issue_number: 1, state: "open" });
    await call(app, "search_issues", { query: "500" });
    await call(app, "list_issues", { owner: "acme", repo: "api", state: "all" });
    const issueComment = await call(app, "add_issue_comment", { owner: "acme", repo: "api", issue_number: 1, body: "contract comment" });
    await call(app, "list_issue_comments", { owner: "acme", repo: "api", issue_number: 1 });
    await call(app, "create_issue", { owner: "acme", repo: "api", title: "Contract issue" });
    await call(app, "list_repository_labels", { owner: "acme", repo: "api" });
    await call(app, "create_label", { owner: "acme", repo: "api", name: "contract", color: "ededed" });
    await call(app, "list_issue_labels", { owner: "acme", repo: "api", issue_number: 1 });
    await call(app, "add_issue_labels", { owner: "acme", repo: "api", issue_number: 1, labels: ["contract"] });
    await call(app, "remove_issue_label", { owner: "acme", repo: "api", issue_number: 1, label: "contract" });
    await call(app, "list_collaborators", { owner: "acme", repo: "api" });
    await call(app, "add_assignees", { owner: "acme", repo: "api", issue_number: 1, assignees: ["alice"] });
    const pr = await call(app, "create_pull_request", { owner: "acme", repo: "api", title: "Contract PR", head: "contract", base: "main" });
    await call(app, "get_pull_request", { owner: "acme", repo: "api", pull_number: pr.number });
    await call(app, "get_pull_request_reviews", { owner: "acme", repo: "api", pull_number: pr.number });
    await call(app, "create_pull_request_review", { owner: "acme", repo: "api", pull_number: pr.number, event: "COMMENT", body: "contract review" });
    await call(app, "get_pull_request_comments", { owner: "acme", repo: "api", pull_number: pr.number });
    await call(app, "get_pull_request_files", { owner: "acme", repo: "api", pull_number: pr.number });
    await call(app, "get_pull_request_status", { owner: "acme", repo: "api", pull_number: pr.number });
    await call(app, "list_pull_requests", { owner: "acme", repo: "api", state: "all" });
    await call(app, "update_pull_request_branch", { owner: "acme", repo: "api", pull_number: pr.number });
    await call(app, "merge_pull_request", { owner: "acme", repo: "api", pull_number: pr.number });

    // ===== v2 hot paths (FDRS-300) ======================================
    // Cluster A
    await call(app, "list_branches", { owner: "acme", repo: "api" });
    await call(app, "get_branch", { owner: "acme", repo: "api", branch: "main" });
    // Create a throwaway branch + file so delete_branch/delete_file have something to operate on.
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "scratch" });
    const scratch = await call(app, "create_or_update_file", { owner: "acme", repo: "api", branch: "scratch", path: "scratch.txt", message: "Scratch", content: "x\n" });
    await call(app, "delete_file", { owner: "acme", repo: "api", branch: "scratch", path: "scratch.txt", message: "Drop scratch", sha: scratch.content.sha });
    await call(app, "delete_branch", { owner: "acme", repo: "api", branch: "scratch" });
    // Cluster B
    const commits = await call(app, "list_commits", { owner: "acme", repo: "api" });
    const head = commits[0].sha;
    await call(app, "get_commit", { owner: "acme", repo: "api", ref: head });
    await call(app, "compare_commits", { owner: "acme", repo: "api", base: "main", head: "main" });
    await call(app, "get_pull_request_diff", { owner: "acme", repo: "api", pull_number: pr.number });
    // Cluster C — create a fresh open PR for update tests since the original was merged.
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "feature-2" });
    await call(app, "create_or_update_file", { owner: "acme", repo: "api", branch: "feature-2", path: "feature.ts", message: "Add feature", content: "export const ok = true;\n" });
    const pr2 = await call(app, "create_pull_request", { owner: "acme", repo: "api", title: "Feature 2", head: "feature-2", base: "main" });
    await call(app, "update_pull_request", { owner: "acme", repo: "api", pull_number: pr2.number, title: "Feature 2 (updated)" });
    await call(app, "get_pull_request_commits", { owner: "acme", repo: "api", pull_number: pr2.number });
    const inline = await call(app, "create_pull_request_review_comment", { owner: "acme", repo: "api", pull_number: pr2.number, body: "Nit", path: "feature.ts", line: 1 });
    await call(app, "add_reply_to_pull_request_comment", { owner: "acme", repo: "api", pull_number: pr2.number, comment_id: inline.id, body: "Fixed" });
    // Cluster D
    await call(app, "update_issue_comment", { owner: "acme", repo: "api", comment_id: issueComment.id, body: "updated" });
    await call(app, "delete_issue_comment", { owner: "acme", repo: "api", comment_id: issueComment.id });
    // Cluster E
    const milestone = await call(app, "create_milestone", { owner: "acme", repo: "api", title: "v1.0", description: "First release" });
    await call(app, "list_milestones", { owner: "acme", repo: "api" });
    await call(app, "update_milestone", { owner: "acme", repo: "api", milestone_number: milestone.number, state: "closed" });
    await call(app, "delete_milestone", { owner: "acme", repo: "api", milestone_number: milestone.number });
    // Cluster F
    await call(app, "create_commit_status", { owner: "acme", repo: "api", sha: head, state: "success", context: "ci/test" });
    await call(app, "get_combined_status_for_ref", { owner: "acme", repo: "api", ref: head });
    await call(app, "create_check_run", { owner: "acme", repo: "api", name: "lint", head_sha: head, status: "completed", conclusion: "success" });
    await call(app, "list_check_runs_for_ref", { owner: "acme", repo: "api", ref: head });
    // Cluster G
    await call(app, "create_release", { owner: "acme", repo: "api", tag_name: "v1.0.0", name: "First", body: "Initial release" });
    await call(app, "list_tags", { owner: "acme", repo: "api" });
    await call(app, "list_releases", { owner: "acme", repo: "api" });
    await call(app, "get_latest_release", { owner: "acme", repo: "api" });
    // Cluster H
    await call(app, "get_me", {});
    await call(app, "add_collaborator", { owner: "acme", repo: "api", username: "newbie", permission: "push" });
  });

  it("accepts camelCase pullNumber aliases for v2 PR tools", async () => {
    const app = createGitHubCloneApp();
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "camel-pr" });
    await call(app, "create_or_update_file", { owner: "acme", repo: "api", branch: "camel-pr", path: "camel.ts", message: "camel", content: "export const camel = true;\n" });
    const pr = await call(app, "create_pull_request", { owner: "acme", repo: "api", title: "Camel PR", head: "camel-pr", base: "main" });

    await call(app, "get_pull_request_diff", { owner: "acme", repo: "api", pullNumber: pr.number });
    await call(app, "update_pull_request", { owner: "acme", repo: "api", pullNumber: pr.number, title: "Camel PR updated" });
    await call(app, "get_pull_request_commits", { owner: "acme", repo: "api", pullNumber: pr.number });
    const inline = await call(app, "create_pull_request_review_comment", { owner: "acme", repo: "api", pullNumber: pr.number, body: "Nit", path: "camel.ts", line: 1 });
    await call(app, "add_reply_to_pull_request_comment", { owner: "acme", repo: "api", pullNumber: pr.number, commentId: inline.id, body: "Done" });
  });

  it("legacy MCP get_me returns the authenticated token identity", async () => {
    const app = createGitHubCloneApp();
    const aliceToken = await signTestToken({ login: "alice" });
    const me = await call(app, "get_me", {}, aliceToken);
    expect(me.login).toBe("alice");
  });

  it("legacy MCP add_collaborator uses the authenticated token identity as inviter", async () => {
    const app = createGitHubCloneApp();
    const aliceToken = await signTestToken({ login: "alice" });
    const result = await call(app, "add_collaborator", { owner: "acme", repo: "api", username: "invitee", permission: "push" }, aliceToken);
    expect(result.body.inviter.login).toBe("alice");
  });

  it("legacy MCP add_collaborator requires repository write access", async () => {
    const app = createGitHubCloneApp();
    const outsiderToken = await signTestToken({ login: "mallory" });
    await expect(call(app, "add_collaborator", { owner: "acme", repo: "api", username: "invitee", permission: "push" }, outsiderToken)).rejects.toThrow("403");
  });

  it("legacy MCP add_collaborator does not treat pending invitations as write access", async () => {
    const app = createGitHubCloneApp();
    await call(app, "add_collaborator", { owner: "acme", repo: "api", username: "pending-user", permission: "push" });
    const pendingToken = await signTestToken({ login: "pending-user" });

    await expect(call(app, "add_collaborator", { owner: "acme", repo: "api", username: "invitee", permission: "push" }, pendingToken)).rejects.toThrow("403");
  });

  it("legacy MCP merge_pull_request requires collaborator access", async () => {
    const app = createGitHubCloneApp();
    await call(app, "create_branch", { owner: "acme", repo: "api", branch: "outsider-merge" });
    await call(app, "create_or_update_file", { owner: "acme", repo: "api", branch: "outsider-merge", path: "outsider.ts", message: "outsider", content: "export const outsider = true;\n" });
    const pr = await call(app, "create_pull_request", { owner: "acme", repo: "api", title: "Outsider merge", head: "outsider-merge", base: "main" });
    const outsiderToken = await signTestToken({ login: "mallory" });

    await expect(call(app, "merge_pull_request", { owner: "acme", repo: "api", pull_number: pr.number }, outsiderToken)).rejects.toThrow("403");
  });
});

async function call(app: ReturnType<typeof createGitHubCloneApp>, tool: string, args: unknown, authToken = token) {
  const response = await app.request(`${base}/mcp/call`, withAuth(authToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, arguments: args })
  }));
  if (!response.ok) throw new Error(`${tool}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}
