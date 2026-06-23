// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import type { StateDelta } from "../types/shared.js";
import type { GitHubDomain } from "./domain.js";
import { validationFailed } from "./errors.js";

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
  pull_number: z.coerce.number().int().positive(),
  pullNumber: z.coerce.number().int().positive().optional()
};

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

function normalizeHeadSha<T extends { head_sha?: string; headSha?: string }>(input: T) {
  return { ...input, head_sha: input.head_sha ?? input.headSha! };
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
  {
    name: "create_commit_status",
    description: "Create a commit status (pending/success/failure/error) on a commit SHA.",
    schema: z.object({ ...ownerRepo, sha: z.string().min(1), state: z.enum(["error", "failure", "pending", "success"]), context: z.string().optional(), description: z.string().optional(), target_url: z.string().optional(), targetUrl: z.string().optional() })
  },
  {
    name: "create_check_run",
    description: "Create a check run on a commit SHA.",
    schema: z.object({ ...ownerRepo, name: z.string().min(1), head_sha: z.string().min(1).optional(), headSha: z.string().min(1).optional(), status: z.enum(["queued", "in_progress", "completed"]).optional(), conclusion: z.enum(["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "skipped", "stale"]).optional(), details_url: z.string().optional(), detailsUrl: z.string().optional(), external_id: z.string().optional(), externalId: z.string().optional(), output: z.object({ title: z.string().optional(), summary: z.string().optional() }).optional(), started_at: z.string().optional(), startedAt: z.string().optional(), completed_at: z.string().optional(), completedAt: z.string().optional() }).refine((value) => value.head_sha ?? value.headSha, "head_sha is required")
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
  "create_commit_status",
  "create_check_run"
]);

export function isMutatingTool(name: string) {
  return MUTATING_TOOL_NAMES.has(name);
}

export function executeTool(
  domain: GitHubDomain,
  name: string,
  input: unknown,
  onDelta?: (delta: StateDelta) => void
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
      return domain.createOrUpdateFile(parsed, {}, onDelta);
    case "create_branch":
      return domain.createBranch(parsed, onDelta);
    case "push_files":
      return domain.pushFiles(parsed, {}, onDelta);
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
      return domain.mergePullRequest(normalizePullNumber(parsed), onDelta);
    case "update_pull_request_branch":
      return domain.updatePullRequestBranch(normalizePullNumber(parsed), onDelta);
    case "create_pull_request":
      return domain.createPullRequest(parsed, onDelta);
    case "create_commit_status":
      return domain.createCommitStatus({ ...parsed, target_url: parsed.target_url ?? parsed.targetUrl }, onDelta);
    case "create_check_run": {
      const merged = normalizeHeadSha(parsed);
      return domain.createCheckRun(
        {
          ...merged,
          details_url: merged.details_url ?? merged.detailsUrl,
          external_id: merged.external_id ?? merged.externalId,
          started_at: merged.started_at ?? merged.startedAt,
          completed_at: merged.completed_at ?? merged.completedAt
        },
        onDelta
      );
    }
  }
}
