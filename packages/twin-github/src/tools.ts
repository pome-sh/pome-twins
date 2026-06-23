// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { StateDelta } from "@pome-sh/shared-types";
import type { GitHubDomain } from "./domain.js";
import { TwinError, validationFailed } from "./errors.js";

const pageShape = {
  page: z.coerce.number().int().positive().optional(),
  per_page: z.coerce.number().int().positive().optional(),
  perPage: z.coerce.number().int().positive().optional()
};

const ownerRepo = {
  owner: z.string().min(1),
  repo: z.string().min(1)
};

const prNumber = {
  pull_number: z.coerce.number().int().positive().optional(),
  pullNumber: z.coerce.number().int().positive().optional()
};

export type ToolExecutionOptions = { actor?: string };

const issueNumber = {
  issue_number: z.coerce.number().int().positive(),
  issueNumber: z.coerce.number().int().positive().optional()
};

function normalizeIssueNumber<T extends { issue_number?: number; issueNumber?: number }>(input: T) {
  return { ...input, issue_number: input.issue_number ?? input.issueNumber! };
}

function normalizePullNumber<T extends { pull_number?: number; pullNumber?: number }>(input: T) {
  return { ...input, pull_number: input.pull_number ?? input.pullNumber! };
}

function normalizeCommentId<T extends { comment_id?: number; commentId?: number }>(input: T) {
  return { ...input, comment_id: input.comment_id ?? input.commentId! };
}

function normalizeMilestoneNumber<T extends { milestone_number?: number; milestoneNumber?: number }>(input: T) {
  return { ...input, milestone_number: input.milestone_number ?? input.milestoneNumber! };
}

function normalizeHeadSha<T extends { head_sha?: string; headSha?: string }>(input: T) {
  return { ...input, head_sha: input.head_sha ?? input.headSha! };
}

function normalizeTagName<T extends { tag_name?: string; tagName?: string }>(input: T) {
  return { ...input, tag_name: input.tag_name ?? input.tagName! };
}

export const toolDefinitions = [
  {
    name: "search_repositories",
    description: "Search local repositories by name or description.",
    schema: z.object({ query: z.string().optional(), q: z.string().optional(), ...pageShape })
  },
  {
    name: "create_repository",
    description: "Create a repository with an initial README and main branch.",
    schema: z.object({ name: z.string().min(1), owner: z.string().min(1).optional(), description: z.string().optional(), private: z.boolean().optional() })
  },
  {
    name: "fork_repository",
    description: "Fork a repository into the current user or an organization.",
    schema: z.object({ ...ownerRepo, organization: z.string().min(1).optional() })
  },
  {
    name: "get_repository",
    description: "Get one repository.",
    schema: z.object({ ...ownerRepo })
  },
  {
    name: "search_code",
    description: "Search files in the local GitHub twin.",
    schema: z.object({ query: z.string().optional(), q: z.string().optional(), owner: z.string().optional(), repo: z.string().optional(), ...pageShape })
  },
  {
    name: "search_users",
    description: "Search seeded users and organizations.",
    schema: z.object({ query: z.string().optional(), q: z.string().optional(), ...pageShape })
  },
  {
    name: "get_file_contents",
    description: "Read a file or directory from a repository branch.",
    schema: z.object({ ...ownerRepo, path: z.string().optional(), ref: z.string().optional() })
  },
  {
    name: "list_commits",
    description: "List commits for a repository.",
    schema: z.object({ ...ownerRepo, sha: z.string().optional(), ...pageShape })
  },
  {
    name: "create_or_update_file",
    description: "Create or update one file and advance the branch head atomically.",
    schema: z.object({ ...ownerRepo, path: z.string().min(1), message: z.string().min(1), content: z.string(), branch: z.string().optional(), sha: z.string().optional(), encoding: z.enum(["utf-8", "base64"]).optional() })
  },
  {
    name: "create_branch",
    description: "Create a branch from an existing branch or SHA.",
    schema: z.object({ ...ownerRepo, branch: z.string().min(1), from_branch: z.string().optional(), sha: z.string().optional() })
  },
  {
    name: "push_files",
    description: "Push multiple files in a single commit.",
    schema: z.object({ ...ownerRepo, branch: z.string().optional(), message: z.string().min(1), files: z.array(z.object({ path: z.string().min(1), content: z.string(), encoding: z.enum(["utf-8", "base64"]).optional() })).min(1) })
  },
  {
    name: "get_issue",
    description: "Get one issue.",
    schema: z.object({ ...ownerRepo, issue_number: z.coerce.number().int().positive().optional(), issueNumber: z.coerce.number().int().positive().optional() }).refine((value) => value.issue_number ?? value.issueNumber, "issue_number is required")
  },
  {
    name: "update_issue",
    description: "Update an issue title, body, state, labels, or assignees.",
    schema: z.object({ ...ownerRepo, issue_number: z.coerce.number().int().positive().optional(), issueNumber: z.coerce.number().int().positive().optional(), title: z.string().optional(), body: z.string().optional(), state: z.enum(["open", "closed"]).optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional() }).refine((value) => value.issue_number ?? value.issueNumber, "issue_number is required")
  },
  {
    name: "search_issues",
    description: "Search all local issues.",
    schema: z.object({ query: z.string().optional(), q: z.string().optional(), state: z.enum(["open", "closed", "all"]).optional(), ...pageShape })
  },
  {
    name: "list_issues",
    description: "List repository issues with common filters.",
    schema: z.object({ ...ownerRepo, state: z.enum(["open", "closed", "all"]).optional(), labels: z.string().optional(), assignee: z.string().optional(), ...pageShape })
  },
  {
    name: "add_issue_comment",
    description: "Add an issue comment.",
    schema: z.object({ ...ownerRepo, issue_number: z.coerce.number().int().positive().optional(), issueNumber: z.coerce.number().int().positive().optional(), body: z.string().min(1) }).refine((value) => value.issue_number ?? value.issueNumber, "issue_number is required")
  },
  {
    name: "list_issue_comments",
    description: "List comments on an issue.",
    schema: z.object({ ...ownerRepo, issue_number: z.coerce.number().int().positive().optional(), issueNumber: z.coerce.number().int().positive().optional(), ...pageShape }).refine((value) => value.issue_number ?? value.issueNumber, "issue_number is required")
  },
  {
    name: "create_issue",
    description: "Create an issue.",
    schema: z.object({ ...ownerRepo, title: z.string().min(1), body: z.string().optional(), labels: z.array(z.string()).optional(), assignees: z.array(z.string()).optional() })
  },
  {
    name: "list_repository_labels",
    description: "List labels defined on a repository.",
    schema: z.object({ ...ownerRepo })
  },
  {
    name: "create_label",
    description: "Create a repository label.",
    schema: z.object({ ...ownerRepo, name: z.string().min(1), color: z.string().default("ededed"), description: z.string().default("") })
  },
  {
    name: "list_issue_labels",
    description: "List labels applied to an issue.",
    schema: z.object({ ...ownerRepo, issue_number: z.coerce.number().int().positive().optional(), issueNumber: z.coerce.number().int().positive().optional() }).refine((value) => value.issue_number ?? value.issueNumber, "issue_number is required")
  },
  {
    name: "add_issue_labels",
    description: "Apply one or more labels to an issue.",
    schema: z.object({ ...ownerRepo, issue_number: z.coerce.number().int().positive().optional(), issueNumber: z.coerce.number().int().positive().optional(), labels: z.array(z.string().min(1)).min(1) }).refine((value) => value.issue_number ?? value.issueNumber, "issue_number is required")
  },
  {
    name: "remove_issue_label",
    description: "Remove one label from an issue.",
    schema: z.object({ ...ownerRepo, issue_number: z.coerce.number().int().positive().optional(), issueNumber: z.coerce.number().int().positive().optional(), label: z.string().min(1) }).refine((value) => value.issue_number ?? value.issueNumber, "issue_number is required")
  },
  {
    name: "list_collaborators",
    description: "List repository collaborators.",
    schema: z.object({ ...ownerRepo })
  },
  {
    name: "add_assignees",
    description: "Add assignees to an issue.",
    schema: z.object({ ...ownerRepo, issue_number: z.coerce.number().int().positive().optional(), issueNumber: z.coerce.number().int().positive().optional(), assignees: z.array(z.string().min(1)).min(1) }).refine((value) => value.issue_number ?? value.issueNumber, "issue_number is required")
  },
  {
    name: "get_pull_request",
    description: "Get one pull request.",
    schema: z.object({ ...ownerRepo, pull_number: z.coerce.number().int().positive().optional(), pullNumber: z.coerce.number().int().positive().optional() }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "get_pull_request_reviews",
    description: "List pull request reviews.",
    schema: z.object({ ...ownerRepo, pull_number: z.coerce.number().int().positive().optional(), pullNumber: z.coerce.number().int().positive().optional(), ...pageShape }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "create_pull_request_review",
    description: "Create a pull request review.",
    schema: z.object({ ...ownerRepo, pull_number: z.coerce.number().int().positive().optional(), pullNumber: z.coerce.number().int().positive().optional(), event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string().optional() }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "get_pull_request_comments",
    description: "List review comments on a pull request.",
    schema: z.object({ ...ownerRepo, pull_number: z.coerce.number().int().positive().optional(), pullNumber: z.coerce.number().int().positive().optional(), ...pageShape }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "get_pull_request_files",
    description: "List files changed by a pull request.",
    schema: z.object({ ...ownerRepo, pull_number: z.coerce.number().int().positive().optional(), pullNumber: z.coerce.number().int().positive().optional(), ...pageShape }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "get_pull_request_status",
    description: "Get combined status for a pull request head commit.",
    schema: z.object({ ...ownerRepo, pull_number: z.coerce.number().int().positive().optional(), pullNumber: z.coerce.number().int().positive().optional() }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "list_pull_requests",
    description: "List repository pull requests.",
    schema: z.object({ ...ownerRepo, state: z.enum(["open", "closed", "all"]).optional(), ...pageShape })
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request using simplified local merge semantics.",
    schema: z.object({ ...ownerRepo, pull_number: z.coerce.number().int().positive().optional(), pullNumber: z.coerce.number().int().positive().optional(), commit_title: z.string().optional(), commit_message: z.string().optional() }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "update_pull_request_branch",
    description: "Update a PR branch from its base branch.",
    schema: z.object({ ...ownerRepo, pull_number: z.coerce.number().int().positive().optional(), pullNumber: z.coerce.number().int().positive().optional(), expected_head_sha: z.string().optional() }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "create_pull_request",
    description: "Create a pull request from a head branch to a base branch.",
    schema: z.object({ ...ownerRepo, title: z.string().min(1), body: z.string().optional(), head: z.string().min(1), base: z.string().optional() })
  },
  // ===== v2 hot paths (FDRS-300) ==========================================
  // Cluster A — branches & files
  {
    name: "list_branches",
    description: "List branches for a repository.",
    schema: z.object({ ...ownerRepo, ...pageShape })
  },
  {
    name: "get_branch",
    description: "Get one branch by name.",
    schema: z.object({ ...ownerRepo, branch: z.string().min(1) })
  },
  {
    name: "delete_branch",
    description: "Delete a branch (cannot delete the default branch or a branch backing an open PR).",
    schema: z.object({ ...ownerRepo, branch: z.string().min(1) })
  },
  {
    name: "delete_file",
    description: "Delete one file and advance the branch head atomically.",
    schema: z.object({ ...ownerRepo, path: z.string().min(1), message: z.string().min(1), sha: z.string().min(1), branch: z.string().optional() })
  },
  // Cluster B — commits & diffs
  {
    name: "get_commit",
    description: "Get one commit with its file changes and stats.",
    schema: z.object({ ...ownerRepo, ref: z.string().min(1) })
  },
  {
    name: "compare_commits",
    description: "Compare two commits, branches, or tags. Returns ahead/behind/identical/diverged.",
    schema: z.object({ ...ownerRepo, base: z.string().min(1), head: z.string().min(1) })
  },
  {
    name: "get_pull_request_diff",
    description: "Get a unified-diff-style text representation of a pull request.",
    schema: z.object({ ...ownerRepo, ...prNumber }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  // Cluster C — PR deeper
  {
    name: "update_pull_request",
    description: "Update a pull request title, body, state, or base branch.",
    schema: z.object({ ...ownerRepo, ...prNumber, title: z.string().optional(), body: z.string().optional(), state: z.enum(["open", "closed"]).optional(), base: z.string().optional() }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "get_pull_request_commits",
    description: "List commits on a pull request, oldest first.",
    schema: z.object({ ...ownerRepo, ...prNumber, ...pageShape }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "create_pull_request_review_comment",
    description: "Create an inline review comment on a pull request at a file path and line.",
    schema: z.object({ ...ownerRepo, ...prNumber, body: z.string().min(1), path: z.string().min(1), line: z.coerce.number().int().positive(), side: z.enum(["LEFT", "RIGHT"]).optional(), commit_id: z.string().optional(), commitId: z.string().optional() }).refine((value) => value.pull_number ?? value.pullNumber, "pull_number is required")
  },
  {
    name: "add_reply_to_pull_request_comment",
    description: "Reply to an existing pull request review comment.",
    schema: z.object({ ...ownerRepo, ...prNumber, comment_id: z.coerce.number().int().positive().optional(), commentId: z.coerce.number().int().positive().optional(), body: z.string().min(1) }).refine((value) => (value.pull_number ?? value.pullNumber) && (value.comment_id ?? value.commentId), "pull_number and comment_id are required")
  },
  // Cluster D — issue comments deeper
  {
    name: "update_issue_comment",
    description: "Update the body of an existing issue comment.",
    schema: z.object({ ...ownerRepo, comment_id: z.coerce.number().int().positive().optional(), commentId: z.coerce.number().int().positive().optional(), body: z.string().min(1) }).refine((value) => value.comment_id ?? value.commentId, "comment_id is required")
  },
  {
    name: "delete_issue_comment",
    description: "Delete an issue comment by ID.",
    schema: z.object({ ...ownerRepo, comment_id: z.coerce.number().int().positive().optional(), commentId: z.coerce.number().int().positive().optional() }).refine((value) => value.comment_id ?? value.commentId, "comment_id is required")
  },
  // Cluster E — milestones
  {
    name: "list_milestones",
    description: "List milestones for a repository.",
    schema: z.object({ ...ownerRepo, state: z.enum(["open", "closed", "all"]).optional(), ...pageShape })
  },
  {
    name: "create_milestone",
    description: "Create a milestone.",
    schema: z.object({ ...ownerRepo, title: z.string().min(1), description: z.string().optional(), due_on: z.string().optional(), dueOn: z.string().optional(), state: z.enum(["open", "closed"]).optional() })
  },
  {
    name: "update_milestone",
    description: "Update a milestone.",
    schema: z.object({ ...ownerRepo, milestone_number: z.coerce.number().int().positive().optional(), milestoneNumber: z.coerce.number().int().positive().optional(), title: z.string().optional(), description: z.string().optional(), due_on: z.string().optional(), dueOn: z.string().optional(), state: z.enum(["open", "closed"]).optional() }).refine((value) => value.milestone_number ?? value.milestoneNumber, "milestone_number is required")
  },
  {
    name: "delete_milestone",
    description: "Delete a milestone.",
    schema: z.object({ ...ownerRepo, milestone_number: z.coerce.number().int().positive().optional(), milestoneNumber: z.coerce.number().int().positive().optional() }).refine((value) => value.milestone_number ?? value.milestoneNumber, "milestone_number is required")
  },
  // Cluster F — status + checks
  {
    name: "create_commit_status",
    description: "Create a commit status (pending/success/failure/error) on a commit SHA.",
    schema: z.object({ ...ownerRepo, sha: z.string().min(1), state: z.enum(["error", "failure", "pending", "success"]), context: z.string().optional(), description: z.string().optional(), target_url: z.string().optional(), targetUrl: z.string().optional() })
  },
  {
    name: "get_combined_status_for_ref",
    description: "Get the combined status for a ref (SHA, branch, or tag).",
    schema: z.object({ ...ownerRepo, ref: z.string().min(1) })
  },
  {
    name: "create_check_run",
    description: "Create a check run on a commit SHA.",
    schema: z.object({ ...ownerRepo, name: z.string().min(1), head_sha: z.string().min(1).optional(), headSha: z.string().min(1).optional(), status: z.enum(["queued", "in_progress", "completed"]).optional(), conclusion: z.enum(["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "skipped", "stale"]).optional(), details_url: z.string().optional(), detailsUrl: z.string().optional(), external_id: z.string().optional(), externalId: z.string().optional(), output: z.object({ title: z.string().optional(), summary: z.string().optional() }).optional(), started_at: z.string().optional(), startedAt: z.string().optional(), completed_at: z.string().optional(), completedAt: z.string().optional() }).refine((value) => value.head_sha ?? value.headSha, "head_sha is required")
  },
  {
    name: "list_check_runs_for_ref",
    description: "List check runs for a ref (SHA, branch, or tag).",
    schema: z.object({ ...ownerRepo, ref: z.string().min(1), ...pageShape })
  },
  // Cluster G — tags & releases
  {
    name: "list_tags",
    description: "List tags for a repository, most recent first.",
    schema: z.object({ ...ownerRepo, ...pageShape })
  },
  {
    name: "list_releases",
    description: "List releases for a repository, most recent first.",
    schema: z.object({ ...ownerRepo, ...pageShape })
  },
  {
    name: "get_latest_release",
    description: "Get the latest published (non-draft, non-prerelease) release.",
    schema: z.object({ ...ownerRepo })
  },
  {
    name: "create_release",
    description: "Create a release. Auto-creates the tag if it doesn't exist.",
    schema: z.object({ ...ownerRepo, tag_name: z.string().min(1).optional(), tagName: z.string().min(1).optional(), target_commitish: z.string().optional(), targetCommitish: z.string().optional(), name: z.string().optional(), body: z.string().optional(), draft: z.boolean().optional(), prerelease: z.boolean().optional() }).refine((value) => value.tag_name ?? value.tagName, "tag_name is required")
  },
  // Cluster H — identity & collaborators
  {
    name: "get_me",
    description: "Get the authenticated user.",
    schema: z.object({})
  },
  {
    name: "add_collaborator",
    description: "Add a collaborator to a repository. Returns 201 + invitation envelope for new users, 204 when already a collaborator.",
    schema: z.object({ ...ownerRepo, username: z.string().min(1), permission: z.enum(["pull", "push", "admin", "maintain", "triage"]).optional() })
  }
] as const;

export type ToolName = (typeof toolDefinitions)[number]["name"];

export function listTools() {
  return toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: z.toJSONSchema(tool.schema)
  }));
}

// MCP wire format (Streamable HTTP, real JSON-RPC) uses camelCase
// `inputSchema`. Legacy custom routes (`/mcp/tools`) keep the snake_case
// `input_schema` they shipped with — do not change `listTools()`.
export function listToolsForMcp() {
  return toolDefinitions.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema)
  }));
}

const MUTATING_TOOL_NAMES = new Set<string>([
  "create_repository",
  "fork_repository",
  "create_or_update_file",
  "create_branch",
  "push_files",
  "update_issue",
  "add_issue_comment",
  "create_label",
  "add_issue_labels",
  "remove_issue_label",
  "add_assignees",
  "create_issue",
  "create_pull_request_review",
  "merge_pull_request",
  "update_pull_request_branch",
  "create_pull_request",
  // v2 hot paths (FDRS-300)
  "delete_branch",
  "delete_file",
  "update_pull_request",
  "create_pull_request_review_comment",
  "add_reply_to_pull_request_comment",
  "update_issue_comment",
  "delete_issue_comment",
  "create_milestone",
  "update_milestone",
  "delete_milestone",
  "create_commit_status",
  "create_check_run",
  "create_release",
  "add_collaborator"
]);

export function isMutatingTool(name: string) {
  return MUTATING_TOOL_NAMES.has(name);
}

export function executeTool(
  domain: GitHubDomain,
  name: string,
  input: unknown,
  onDelta?: (delta: StateDelta) => void,
  options: ToolExecutionOptions = {}
) {
  const definition = toolDefinitions.find((tool) => tool.name === name);
  if (!definition) {
    validationFailed("tool", "invalid", name);
  }
  const parsed = definition.schema.parse(input) as any;
  switch (name as ToolName) {
    case "search_repositories":
      return domain.searchRepositories(parsed);
    case "create_repository":
      return domain.createRepository(parsed, onDelta);
    case "fork_repository":
      return domain.forkRepository(parsed, onDelta);
    case "get_repository":
      return domain.getRepository(parsed);
    case "search_code":
      return domain.searchCode(parsed);
    case "search_users":
      return domain.searchUsers(parsed);
    case "get_file_contents":
      return domain.getFileContents(parsed);
    case "list_commits":
      return domain.listCommits(parsed);
    case "create_or_update_file":
      return domain.createOrUpdateFile(parsed, { actor: options.actor }, onDelta);
    case "create_branch":
      return domain.createBranch(parsed, onDelta);
    case "push_files":
      return domain.pushFiles(parsed, { actor: options.actor }, onDelta);
    case "get_issue":
      return domain.getIssue(normalizeIssueNumber(parsed));
    case "update_issue":
      return domain.updateIssue(normalizeIssueNumber(parsed), onDelta);
    case "search_issues":
      return domain.searchIssues(parsed);
    case "list_issues":
      return domain.listIssues(parsed);
    case "add_issue_comment":
      return domain.addIssueComment(normalizeIssueNumber(parsed), onDelta);
    case "list_issue_comments":
      return domain.listIssueComments(normalizeIssueNumber(parsed));
    case "create_issue":
      return domain.createIssue(parsed, onDelta);
    case "list_repository_labels":
      return domain.listRepositoryLabels(parsed);
    case "create_label":
      return domain.createRepositoryLabel(parsed, onDelta);
    case "list_issue_labels":
      return domain.listIssueLabelsForIssue(normalizeIssueNumber(parsed));
    case "add_issue_labels":
      return domain.addIssueLabels(normalizeIssueNumber(parsed), onDelta);
    case "remove_issue_label":
      return domain.deleteIssueLabel(normalizeIssueNumber(parsed), onDelta);
    case "list_collaborators":
      return domain.listCollaborators(parsed);
    case "add_assignees":
      return domain.addAssignees(normalizeIssueNumber(parsed), onDelta);
    case "get_pull_request":
      return domain.getPullRequest(normalizePullNumber(parsed));
    case "get_pull_request_reviews":
      return domain.getPullRequestReviews(normalizePullNumber(parsed));
    case "create_pull_request_review":
      return domain.createPullRequestReview(normalizePullNumber(parsed), onDelta);
    case "get_pull_request_comments":
      return domain.getPullRequestComments(normalizePullNumber(parsed));
    case "get_pull_request_files":
      return domain.getPullRequestFiles(normalizePullNumber(parsed));
    case "get_pull_request_status":
      return domain.getPullRequestStatus(normalizePullNumber(parsed));
    case "list_pull_requests":
      return domain.listPullRequests(parsed);
    case "merge_pull_request":
      if (!options.actor || !domain.hasRepositoryPermission({ owner: parsed.owner, repo: parsed.repo, username: options.actor, permissions: ["push", "maintain", "admin"] })) {
        throw new TwinError("Must have push access to the repository to merge pull requests.", 403);
      }
      return domain.mergePullRequest(normalizePullNumber(parsed), onDelta);
    case "update_pull_request_branch":
      return domain.updatePullRequestBranch(normalizePullNumber(parsed), onDelta);
    case "create_pull_request":
      return domain.createPullRequest({ ...parsed, actor: parsed.actor ?? options.actor }, onDelta);
    // ===== v2 hot paths (FDRS-300) ========================================
    case "list_branches":
      return domain.listBranchesForRepo(parsed);
    case "get_branch":
      return domain.getBranchByName(parsed);
    case "delete_branch":
      return domain.deleteBranch(parsed, onDelta);
    case "delete_file":
      return domain.deleteFile(parsed, { actor: options.actor }, onDelta);
    case "get_commit":
      return domain.getCommitWithFiles(parsed);
    case "compare_commits":
      return domain.compareCommits(parsed);
    case "get_pull_request_diff":
      return domain.getPullRequestDiff(normalizePullNumber(parsed));
    case "update_pull_request":
      return domain.updatePullRequest(normalizePullNumber(parsed), onDelta);
    case "get_pull_request_commits":
      return domain.getPullRequestCommits(normalizePullNumber(parsed));
    case "create_pull_request_review_comment": {
      const merged = normalizePullNumber(parsed);
      const commitId = merged.commit_id ?? merged.commitId;
      return domain.createPullRequestReviewComment({ ...merged, commit_id: commitId }, { actor: options.actor }, onDelta);
    }
    case "add_reply_to_pull_request_comment":
      return domain.addReplyToPullRequestComment(normalizeCommentId(normalizePullNumber(parsed)), { actor: options.actor }, onDelta);
    case "update_issue_comment":
      return domain.updateIssueComment(normalizeCommentId(parsed), onDelta);
    case "delete_issue_comment":
      return domain.deleteIssueComment(normalizeCommentId(parsed), onDelta);
    case "list_milestones":
      return domain.listMilestones(parsed);
    case "create_milestone": {
      const dueOn = parsed.due_on ?? parsed.dueOn;
      return domain.createMilestone({ ...parsed, due_on: dueOn }, onDelta);
    }
    case "update_milestone": {
      const merged = normalizeMilestoneNumber(parsed);
      const dueOn = merged.due_on ?? merged.dueOn;
      return domain.updateMilestone({ ...merged, due_on: dueOn }, onDelta);
    }
    case "delete_milestone":
      return domain.deleteMilestone(normalizeMilestoneNumber(parsed), onDelta);
    case "create_commit_status": {
      const targetUrl = parsed.target_url ?? parsed.targetUrl;
      return domain.createCommitStatus({ ...parsed, target_url: targetUrl }, onDelta);
    }
    case "get_combined_status_for_ref":
      return domain.getCombinedStatusForRef(parsed);
    case "create_check_run": {
      const merged = normalizeHeadSha(parsed);
      return domain.createCheckRun({
        ...merged,
        details_url: merged.details_url ?? merged.detailsUrl,
        external_id: merged.external_id ?? merged.externalId,
        started_at: merged.started_at ?? merged.startedAt,
        completed_at: merged.completed_at ?? merged.completedAt
      }, onDelta);
    }
    case "list_check_runs_for_ref":
      return domain.listCheckRunsForRef(parsed);
    case "list_tags":
      return domain.listTags(parsed);
    case "list_releases":
      return domain.listReleases(parsed);
    case "get_latest_release":
      return domain.getLatestRelease(parsed);
    case "create_release": {
      const merged = normalizeTagName(parsed);
      return domain.createRelease({
        ...merged,
        target_commitish: merged.target_commitish ?? merged.targetCommitish
      }, { actor: options.actor }, onDelta);
    }
    case "get_me":
      return domain.getMe({ actor: options.actor });
    case "add_collaborator":
      if (!options.actor || !domain.hasRepositoryPermission({ ...parsed, username: options.actor, permissions: ["push", "maintain", "admin"] })) {
        throw new TwinError("Must have push access to the repository to add collaborators.", 403);
      }
      return domain.addCollaboratorAction({ ...parsed, actor: options.actor }, onDelta);
  }
}
