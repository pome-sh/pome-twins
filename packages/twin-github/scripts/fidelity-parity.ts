// SPDX-License-Identifier: Apache-2.0
//
// fidelity:parity — declarative parity scenario for twin-github (F-730).
// The runner lives in @pome-sh/sdk/parity; this file is scenario data only:
// an ordered, stateful chain that exercises every MCP tool in
// fidelity.inventory.json against the seeded acme/api world, plus the
// loud-501 REST probe and optional read-only live-shape probes via `gh api`
// (set GITHUB_PARITY_REPO=owner/repo).

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadFidelityInventory, runParityCli, type ParityStep } from "@pome-sh/sdk/parity";
import { createGitHubCloneApp } from "../src/twin.js";
import { listTools } from "../src/tools.js";

const repo = { owner: "acme", repo: "api" };

const steps: ParityStep[] = [
  // Reads against the seeded world
  { tool: "search_repositories", arguments: { query: "acme" } },
  { tool: "get_repository", arguments: { ...repo } },
  { tool: "search_code", arguments: { query: "handler" } },
  { tool: "search_users", arguments: { query: "alice" } },
  { tool: "get_file_contents", arguments: { ...repo, path: "README.md" } },
  { tool: "list_commits", arguments: { ...repo } },
  { tool: "list_branches", arguments: { ...repo } },
  {
    tool: "get_branch",
    arguments: { ...repo, branch: "main" },
    capture: (body, state) => {
      state.mainSha = (body as { commit?: { sha?: string } }).commit?.sha;
    },
  },
  // Repositories + branches + files
  { tool: "create_repository", arguments: { owner: "qa", name: "parity" } },
  { tool: "fork_repository", arguments: { ...repo, organization: "forks" } },
  { tool: "create_or_update_file", arguments: { ...repo, path: "parity.txt", message: "Add parity", content: "ok\n" } },
  { tool: "create_branch", arguments: { ...repo, branch: "parity" } },
  { tool: "push_files", arguments: { ...repo, branch: "parity", message: "Change parity", files: [{ path: "parity.txt", content: "changed\n" }] } },
  // Advance main past the branch point so update_pull_request_branch has work
  {
    tool: "create_or_update_file",
    arguments: { ...repo, path: "delete-me.txt", message: "Add delete-me", content: "bye\n" },
    capture: (body, state) => {
      state.deleteMeSha = (body as { content?: { sha?: string } }).content?.sha;
    },
  },
  { tool: "delete_file", arguments: (state) => ({ ...repo, path: "delete-me.txt", message: "Remove delete-me", sha: state.deleteMeSha }) },
  { tool: "get_commit", arguments: { ...repo, ref: "main" } },
  { tool: "compare_commits", arguments: { ...repo, base: "main", head: "parity" } },
  // Issues + comments
  { tool: "get_issue", arguments: { ...repo, issue_number: 1 } },
  { tool: "update_issue", arguments: { ...repo, issue_number: 1, state: "open" } },
  { tool: "search_issues", arguments: { query: "500" } },
  { tool: "list_issues", arguments: { ...repo, state: "all" } },
  {
    tool: "add_issue_comment",
    arguments: { ...repo, issue_number: 1, body: "Parity comment" },
    capture: (body, state) => {
      state.issueCommentId = (body as { id?: number }).id;
    },
  },
  { tool: "list_issue_comments", arguments: { ...repo, issue_number: 1 } },
  { tool: "update_issue_comment", arguments: (state) => ({ ...repo, comment_id: state.issueCommentId, body: "Parity comment (edited)" }) },
  { tool: "delete_issue_comment", arguments: (state) => ({ ...repo, comment_id: state.issueCommentId }) },
  { tool: "create_issue", arguments: { ...repo, title: "Parity issue" } },
  // Labels
  { tool: "list_repository_labels", arguments: { ...repo } },
  { tool: "create_label", arguments: { ...repo, name: "parity-label", color: "ededed" } },
  { tool: "list_issue_labels", arguments: { ...repo, issue_number: 1 } },
  { tool: "add_issue_labels", arguments: { ...repo, issue_number: 1, labels: ["parity-label"] } },
  { tool: "remove_issue_label", arguments: { ...repo, issue_number: 1, label: "parity-label" } },
  // Collaborators + identity
  { tool: "list_collaborators", arguments: { ...repo } },
  { tool: "add_assignees", arguments: { ...repo, issue_number: 1, assignees: ["alice"] } },
  { tool: "add_collaborator", arguments: { ...repo, username: "bob" } },
  { tool: "get_me" },
  // Milestones
  { tool: "list_milestones", arguments: { ...repo } },
  {
    tool: "create_milestone",
    arguments: { ...repo, title: "Parity milestone" },
    capture: (body, state) => {
      state.milestoneNumber = (body as { number?: number }).number;
    },
  },
  { tool: "update_milestone", arguments: (state) => ({ ...repo, milestone_number: state.milestoneNumber, description: "Parity milestone (updated)" }) },
  { tool: "delete_milestone", arguments: (state) => ({ ...repo, milestone_number: state.milestoneNumber }) },
  // Commit statuses + check runs (against the pre-branch main head)
  { tool: "create_commit_status", arguments: (state) => ({ ...repo, sha: state.mainSha, state: "success", context: "parity" }) },
  { tool: "get_combined_status_for_ref", arguments: { ...repo, ref: "main" } },
  { tool: "create_check_run", arguments: (state) => ({ ...repo, name: "parity-check", head_sha: state.mainSha, status: "completed", conclusion: "success" }) },
  { tool: "list_check_runs_for_ref", arguments: { ...repo, ref: "main" } },
  // Pull request chain
  {
    tool: "create_pull_request",
    arguments: { ...repo, title: "Parity PR", head: "parity", base: "main" },
    capture: (body, state) => {
      state.pullNumber = (body as { number?: number }).number;
    },
  },
  { tool: "get_pull_request", arguments: (state) => ({ ...repo, pull_number: state.pullNumber }) },
  { tool: "get_pull_request_reviews", arguments: (state) => ({ ...repo, pull_number: state.pullNumber }) },
  { tool: "create_pull_request_review", arguments: (state) => ({ ...repo, pull_number: state.pullNumber, event: "APPROVE" }) },
  {
    tool: "create_pull_request_review_comment",
    arguments: (state) => ({ ...repo, pull_number: state.pullNumber, body: "Inline parity", path: "parity.txt", line: 1 }),
    capture: (body, state) => {
      state.reviewCommentId = (body as { id?: number }).id;
    },
  },
  { tool: "add_reply_to_pull_request_comment", arguments: (state) => ({ ...repo, pull_number: state.pullNumber, comment_id: state.reviewCommentId, body: "Parity reply" }) },
  { tool: "get_pull_request_comments", arguments: (state) => ({ ...repo, pull_number: state.pullNumber }) },
  { tool: "get_pull_request_files", arguments: (state) => ({ ...repo, pull_number: state.pullNumber }) },
  { tool: "get_pull_request_status", arguments: (state) => ({ ...repo, pull_number: state.pullNumber }) },
  { tool: "get_pull_request_diff", arguments: (state) => ({ ...repo, pull_number: state.pullNumber }) },
  { tool: "get_pull_request_commits", arguments: (state) => ({ ...repo, pull_number: state.pullNumber }) },
  { tool: "list_pull_requests", arguments: { ...repo, state: "all" } },
  { tool: "update_pull_request", arguments: (state) => ({ ...repo, pull_number: state.pullNumber, title: "Parity PR (renamed)" }) },
  { tool: "update_pull_request_branch", arguments: (state) => ({ ...repo, pull_number: state.pullNumber }) },
  { tool: "merge_pull_request", arguments: (state) => ({ ...repo, pull_number: state.pullNumber }) },
  { tool: "delete_branch", arguments: { ...repo, branch: "parity" } },
  // Tags + releases
  { tool: "create_release", arguments: { ...repo, tag_name: "v0.0.1-parity", name: "Parity release" } },
  { tool: "list_tags", arguments: { ...repo } },
  { tool: "list_releases", arguments: { ...repo } },
  { tool: "get_latest_release", arguments: { ...repo } },
  // M5 hot gaps (F-735)
  { tool: "get_release_by_tag", arguments: { ...repo, tag: "v0.0.1-parity" } },
  { tool: "get_tag", arguments: { ...repo, tag: "v0.0.1-parity" } },
  { tool: "search_commits", arguments: { query: "parity" } },
];

function liveGitHubProbes(): unknown[] {
  const sandboxRepo = process.env.GITHUB_PARITY_REPO;
  if (!sandboxRepo) {
    return [{ real_github: "skipped", reason: "set GITHUB_PARITY_REPO=owner/repo to compare read-only live shapes with gh api" }];
  }
  const endpoints = [
    `repos/${sandboxRepo}`,
    `repos/${sandboxRepo}/contents/README.md`,
    `repos/${sandboxRepo}/issues?state=open&per_page=1`,
    `search/repositories?q=repo:${sandboxRepo}`,
  ];
  return endpoints.map((endpoint) => {
    const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8" });
    return {
      real_github_endpoint: endpoint,
      status: result.status === 0 ? 200 : "gh-error",
      stderr: result.status === 0 ? undefined : result.stderr.trim().slice(0, 400),
    };
  });
}

await runParityCli({
  app: createGitHubCloneApp(),
  twin: "github",
  inventory: loadFidelityInventory(join(import.meta.dirname, "..", "fidelity.inventory.json")),
  liveToolNames: listTools().map((tool) => tool.name),
  steps,
  claims: { team_id: "tm_fidelity", login: "pome-agent" },
  restProbes: [
    { surface: "unsupported-rest", path: "/repos/acme/api/actions/runs", status: 501, expectUnsupportedEnvelope: true },
  ],
  live: async () => liveGitHubProbes(),
});
