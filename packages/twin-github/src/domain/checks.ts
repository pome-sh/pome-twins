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


export function createStatus(domain: GitHubDomain, input: { owner: string; repo: string; sha: string; state: "error" | "failure" | "pending" | "success"; context?: string; description?: string; target_url?: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const now = nowIso();
  const result = domain.db.prepare("INSERT INTO commit_statuses (repo_id, sha, state, context, description, target_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    repo.id,
    input.sha,
    input.state,
    input.context ?? "continuous-integration/local",
    input.description ?? "",
    input.target_url ?? "",
    now,
    now
  );
  return domain.db.prepare("SELECT * FROM commit_statuses WHERE id = ?").get(result.lastInsertRowid);
}

// Cluster F — commit status + checks -------------------------------------

export function createCommitStatus(domain: GitHubDomain, 
  input: { owner: string; repo: string; sha: string; state: "error" | "failure" | "pending" | "success"; context?: string; description?: string; target_url?: string },
  onDelta?: StateDeltaCallback
) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const row = domain.transaction(() => {
    domain.requireCommitOnRepo(repo.id, input.sha);
    const now = nowIso();
    const result = domain.db.prepare("INSERT INTO commit_statuses (repo_id, sha, state, context, description, target_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      repo.id,
      input.sha,
      input.state,
      input.context ?? "default",
      input.description ?? "",
      input.target_url ?? "",
      now,
      now
    );
    return domain.db.prepare("SELECT * FROM commit_statuses WHERE id = ?").get(result.lastInsertRowid) as CommitStatusRow;
  });
  domain.audit("create_commit_status", repo.full_name, input);
  onDelta?.({
    before: null,
    after: { repo: repo.full_name, id: row.id, sha: row.sha, state: row.state, context: row.context }
  });
  return statusJson(row, repo);
}


export function getCombinedStatusForRef(domain: GitHubDomain, input: { owner: string; repo: string; ref: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const sha = domain.resolveRefToSha(repo, input.ref);
  return combinedStatusJson(repo, sha, domain.latestCommitStatuses(repo.id, sha));
}


export function createCheckRun(domain: GitHubDomain, 
  input: {
    owner: string;
    repo: string;
    name: string;
    head_sha: string;
    status?: "queued" | "in_progress" | "completed";
    conclusion?: CheckRunRow["conclusion"];
    details_url?: string;
    external_id?: string;
    output?: { title?: string; summary?: string };
    started_at?: string;
    completed_at?: string;
  },
  onDelta?: StateDeltaCallback
) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const row = domain.transaction(() => {
    if (!input.name.trim()) validationFailed("name", "missing");
    domain.requireCommitOnRepo(repo.id, input.head_sha);
    const status = input.status ?? "queued";
    if (status === "completed" && !input.conclusion) {
      validationFailed("conclusion", "missing", "required when status=completed");
    }
    if (status !== "completed" && input.conclusion) {
      validationFailed("conclusion", "invalid", "only allowed when status=completed");
    }
    if (status !== "completed" && input.completed_at) {
      validationFailed("completed_at", "invalid", "only allowed when status=completed");
    }
    const started = input.started_at ?? nowIso();
    const completed = status === "completed" ? input.completed_at ?? nowIso() : input.completed_at ?? null;
    const result = domain.db.prepare("INSERT INTO check_runs (repo_id, head_sha, name, status, conclusion, details_url, external_id, output_title, output_summary, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      repo.id,
      input.head_sha,
      input.name,
      status,
      input.conclusion ?? null,
      input.details_url ?? "",
      input.external_id ?? "",
      input.output?.title ?? null,
      input.output?.summary ?? null,
      started,
      completed
    );
    return domain.db.prepare("SELECT * FROM check_runs WHERE id = ?").get(result.lastInsertRowid) as CheckRunRow;
  });
  domain.audit("create_check_run", repo.full_name, input);
  onDelta?.({ before: null, after: checkRunState(row, repo) });
  return checkRunJson(row, repo);
}


export function listCheckRunsForRef(domain: GitHubDomain, input: { owner: string; repo: string; ref: string } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const sha = domain.resolveRefToSha(repo, input.ref);
  const rows = domain.db.prepare("SELECT * FROM check_runs WHERE repo_id = ? AND head_sha = ? ORDER BY started_at DESC").all(repo.id, sha) as CheckRunRow[];
  const paged = paginate(rows, input.page, input.per_page ?? input.perPage);
  return {
    total_count: rows.length,
    check_runs: paged.map((run) => checkRunJson(run, repo))
  };
}

