// SPDX-License-Identifier: Apache-2.0
import type {
  BranchRow,
  CheckRunRow,
  CommitRow,
  CommitStatusRow,
  CollaboratorRow,
  FileRow,
  IssueCommentRow,
  IssueRow,
  LabelRow,
  MilestoneRow,
  PullRequestFileRow,
  PullRequestReviewCommentRow,
  PullRequestReviewRow,
  PullRequestRow,
  ReleaseRow,
  RepoRow,
  TagRow,
} from "../types.js";
import { conflict, notFound, validationFailed } from "../errors.js";
import { fileSha, linesChanged, makeSha, nowIso, paginate, stableNumericId, treeSha } from "../util.js";
import {
  authenticatedUserJson,
  branchJson,
  branchState,
  checkRunJson,
  checkRunState,
  collaboratorAddState,
  combinedStatusJson,
  commitJson,
  commitWithFilesJson,
  compareCommitsJson,
  contentDirectoryEntryJson,
  contentFileJson,
  fileState,
  issueAssigneesState,
  issueCommentJson,
  issueCommentState,
  issueJson,
  issueLabelsState,
  issueState,
  labelJson,
  labelState,
  milestoneJson,
  milestoneState,
  pullRequestDiffText,
  pullRequestFileJson,
  pullRequestJson,
  pullRequestListJson,
  pullRequestReviewCommentJson,
  pullRequestReviewCommentState,
  pullRequestReviewState,
  pullRequestState,
  releaseJson,
  releaseState,
  repoJson,
  repoState,
  reviewJson,
  statusJson,
  tagJson,
  userJson,
} from "../serializers.js";
import type { GitHubDomain } from "./github-domain.js";
import type { FileChange, MutatingOptions, PageOptions, StateDeltaCallback } from "./types.js";


export function searchRepositories(domain: GitHubDomain, input: { query?: string; q?: string } & PageOptions) {
  const query = (input.query ?? input.q ?? "").toLowerCase();
  const repos = (domain.db.prepare("SELECT * FROM repositories ORDER BY full_name ASC").all() as RepoRow[]).filter(
    (repo) => !query || repo.full_name.toLowerCase().includes(query) || repo.description.toLowerCase().includes(query)
  );
  const items = paginate(repos, input.page, input.per_page ?? input.perPage).map(repoJson);
  return { total_count: repos.length, incomplete_results: false, items };
}


export function searchUsers(domain: GitHubDomain, input: { query?: string; q?: string } & PageOptions) {
  const query = (input.query ?? input.q ?? "").toLowerCase();
  const rows = domain.db.prepare("SELECT login, type FROM users ORDER BY login ASC").all() as Array<{ login: string; type: "User" | "Organization" }>;
  const users = rows.filter((user) => !query || user.login.toLowerCase().includes(query));
  return { total_count: users.length, incomplete_results: false, items: paginate(users, input.page, input.per_page ?? input.perPage).map((user) => userJson(user.login, user.type)) };
}


export function searchCode(domain: GitHubDomain, input: { query?: string; q?: string; owner?: string; repo?: string } & PageOptions) {
  const query = (input.query ?? input.q ?? "").toLowerCase();
  let rows = domain.db
    .prepare(
      "SELECT files.*, repositories.owner, repositories.name, repositories.full_name, repositories.description, repositories.private, repositories.default_branch, repositories.fork, repositories.parent_full_name, repositories.entity_counter, repositories.created_at, repositories.updated_at FROM files INNER JOIN repositories ON files.repo_id = repositories.id WHERE files.branch = repositories.default_branch ORDER BY repositories.full_name, files.path"
    )
    .all() as Array<FileRow & RepoRow>;
  if (input.owner) rows = rows.filter((row) => row.owner === input.owner);
  if (input.repo) rows = rows.filter((row) => row.name === input.repo);
  rows = rows.filter((row) => !query || row.path.toLowerCase().includes(query) || row.content.toLowerCase().includes(query));
  return {
    total_count: rows.length,
    incomplete_results: false,
    items: paginate(rows, input.page, input.per_page ?? input.perPage).map((row) => ({
      name: row.path.split("/").at(-1),
      path: row.path,
      sha: row.sha,
      url: `https://api.github.com/repos/${row.full_name}/contents/${row.path}`,
      git_url: `https://api.github.com/repos/${row.full_name}/git/blobs/${row.sha}`,
      html_url: `https://github.com/${row.full_name}/blob/${row.branch}/${row.path}`,
      repository: repoJson(row)
    }))
  };
}


export function searchCommits(domain: GitHubDomain, input: { query?: string; q?: string; owner?: string; repo?: string } & PageOptions) {
  const query = (input.query ?? input.q ?? "").toLowerCase();
  let repos = domain.db.prepare("SELECT * FROM repositories ORDER BY full_name ASC").all() as RepoRow[];
  if (input.owner) repos = repos.filter((repo) => repo.owner === input.owner);
  if (input.repo) repos = repos.filter((repo) => repo.name === input.repo);
  const matches: Array<{ commit: CommitRow; repo: RepoRow }> = [];
  for (const repo of repos) {
    const branch = domain.db.prepare("SELECT * FROM branches WHERE repo_id = ? AND name = ?").get(repo.id, repo.default_branch) as BranchRow | undefined;
    if (!branch?.head_sha) continue;
    for (const commit of domain.commitAncestry(repo.id, branch.head_sha)) {
      if (!query || commit.message.toLowerCase().includes(query) || commit.author_login.toLowerCase().includes(query)) matches.push({ commit, repo });
    }
  }
  return {
    total_count: matches.length,
    incomplete_results: false,
    items: paginate(matches, input.page, input.per_page ?? input.perPage).map(({ commit, repo }) => ({ ...commitJson(commit, repo), repository: repoJson(repo), score: 1 }))
  };
}


export function searchIssues(domain: GitHubDomain, input: { query?: string; q?: string; owner?: string; repo?: string; state?: "open" | "closed" | "all" } & PageOptions) {
  const query = (input.query ?? input.q ?? "").toLowerCase();
  const rows = domain.db
    .prepare(
      "SELECT issues.*, repositories.owner, repositories.name, repositories.full_name, repositories.description, repositories.private, repositories.default_branch, repositories.fork, repositories.parent_full_name, repositories.entity_counter, repositories.created_at AS repo_created_at, repositories.updated_at AS repo_updated_at FROM issues INNER JOIN repositories ON issues.repo_id = repositories.id ORDER BY issues.updated_at DESC"
    )
    .all() as Array<IssueRow & { owner: string; name: string; full_name: string; description: string; private: 0 | 1; default_branch: string; fork: 0 | 1; parent_full_name: string | null; entity_counter: number; repo_created_at: string; repo_updated_at: string }>;
  let filtered = rows.filter((issue) => !query || issue.title.toLowerCase().includes(query) || issue.body.toLowerCase().includes(query) || issue.full_name.toLowerCase().includes(query));
  if (input.owner) filtered = filtered.filter((issue) => issue.owner === input.owner);
  if (input.repo) filtered = filtered.filter((issue) => issue.name === input.repo);
  if (input.state && input.state !== "all") filtered = filtered.filter((issue) => issue.state === input.state);
  return {
    total_count: filtered.length,
    incomplete_results: false,
    items: paginate(filtered, input.page, input.per_page ?? input.perPage).map((issue) => {
      const repo = domain.requireRepoById(issue.repo_id);
      return issueJson(issue, repo, domain.listIssueLabels(issue.repo_id, issue.number), domain.listIssueAssignees(issue.repo_id, issue.number), domain.issueCommentCount(issue.repo_id, issue.number));
    })
  };
}

