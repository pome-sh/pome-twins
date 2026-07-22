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
import { normalizePath } from "./helpers.js";
import type { FileChange, MutatingOptions, PageOptions, StateDeltaCallback } from "./types.js";


export function getFileContents(domain: GitHubDomain, input: { owner: string; repo: string; path?: string; ref?: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const branch = input.ref ?? repo.default_branch;
  domain.requireBranch(repo.id, branch);
  const path = normalizePath(input.path ?? "");
  const direct = domain.getFile(repo.id, branch, path);
  if (direct) return contentFileJson(direct, repo);
  const children = domain.listDirectory(repo, branch, path);
  if (children.length === 0) notFound("Not Found");
  return children;
}


export function listCommits(domain: GitHubDomain, input: { owner: string; repo: string; sha?: string } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const branch = input.sha ?? repo.default_branch;
  const branchRow = domain.requireBranch(repo.id, branch);
  const allRows = domain.db.prepare("SELECT * FROM commits WHERE repo_id = ?").all(repo.id) as CommitRow[];
  const bySha = new Map(allRows.map((commit) => [commit.sha, commit]));
  const rows: CommitRow[] = [];
  for (let sha = branchRow.head_sha; sha; ) {
    const commit = bySha.get(sha);
    if (!commit) break;
    rows.push(commit);
    sha = commit.parent_sha;
  }
  return paginate(rows, input.page, input.per_page ?? input.perPage).map((commit) => commitJson(commit, repo));
}


export function createOrUpdateFile(domain: GitHubDomain, input: { owner: string; repo: string; path: string; message: string; content: string; branch?: string; sha?: string; encoding?: string }, options: MutatingOptions = {}, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const branch = input.branch ?? repo.default_branch;
  let before: Record<string, unknown> | null = null;
  let afterFile: FileRow | null = null;
  const result = domain.transaction(() => {
    domain.requireBranch(repo.id, branch);
    const path = normalizePath(input.path);
    const existing = domain.getFile(repo.id, branch, path);
    before = existing ? fileState(existing, repo) : null;
    if (existing && !input.sha) validationFailed("sha", "missing", path);
    if (existing && input.sha !== existing.sha) validationFailed("sha", "invalid", input.sha);
    const content = input.encoding === "base64" ? Buffer.from(input.content, "base64").toString("utf8") : input.content;
    const commit = domain.commitFiles(repo, branch, input.message, [{ path, content }], options.actor ?? "pome-agent");
    const file = domain.getFile(repo.id, branch, path)!;
    afterFile = file;
    return { content: contentFileJson(file, repo), commit: commitJson(commit, repo) };
  });
  domain.audit("create_or_update_file", repo.full_name, { ...input, content: "[redacted]" });
  onDelta?.({ before, after: afterFile ? fileState(afterFile, repo) : null });
  return result;
}


export function pushFiles(domain: GitHubDomain, input: { owner: string; repo: string; branch?: string; message: string; files: Array<{ path: string; content: string; encoding?: string }> }, options: MutatingOptions = {}, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const branch = input.branch ?? repo.default_branch;
  domain.requireBranch(repo.id, branch);
  if (input.files.length === 0) validationFailed("files", "missing");
  const paths = new Set<string>();
  const files = input.files.map((file) => {
    const path = normalizePath(file.path);
    if (paths.has(path)) validationFailed("files.path", "duplicate", path);
    paths.add(path);
    return { path, content: file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content };
  });
  const beforeFiles = files.map((file) => {
    const existing = domain.getFile(repo.id, branch, file.path);
    return { path: file.path, sha: existing?.sha ?? null };
  });
  const commit = domain.transaction(() => domain.commitFiles(repo, branch, input.message, files, options.actor ?? "pome-agent"));
  domain.audit("push_files", repo.full_name, { ...input, files: files.map((file) => file.path) });
  const afterFiles = files.map((file) => {
    const updated = domain.getFile(repo.id, branch, file.path)!;
    return { path: file.path, sha: updated.sha };
  });
  onDelta?.({
    before: { repo: repo.full_name, branch, files: beforeFiles },
    after: { repo: repo.full_name, branch, files: afterFiles, commit_sha: commit.sha }
  });
  return { commit: commitJson(commit, repo), files: files.map((file) => contentFileJson(domain.getFile(repo.id, branch, file.path)!, repo)) };
}


export function createBranch(domain: GitHubDomain, input: { owner: string; repo: string; branch: string; from_branch?: string; sha?: string }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const branch = domain.transaction(() => {
    if (domain.getBranch(repo.id, input.branch)) validationFailed("branch", "already_exists", input.branch);
    const source = input.sha
      ? { head_sha: input.sha }
      : domain.requireBranch(repo.id, input.from_branch ?? repo.default_branch);
    const created = domain.createBranchInternal(repo, input.branch, source.head_sha);
    if (!input.sha) {
      const sourceBranch = input.from_branch ?? repo.default_branch;
      const files = domain.db.prepare("SELECT * FROM files WHERE repo_id = ? AND branch = ?").all(repo.id, sourceBranch) as FileRow[];
      for (const file of files) {
        domain.db.prepare("INSERT INTO files (repo_id, branch, path, content, sha, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          repo.id,
          input.branch,
          file.path,
          file.content,
          file.sha,
          file.size,
          nowIso()
        );
      }
    }
    return created;
  });
  domain.audit("create_branch", repo.full_name, input);
  onDelta?.({ before: null, after: branchState(branch, repo) });
  return branchJson(branch, repo);
}

// ===== v2 hot paths (FDRS-300) ==========================================
// Cluster A — branches & files -------------------------------------------

export function listBranchesForRepo(domain: GitHubDomain, input: { owner: string; repo: string } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const rows = domain.listBranches(repo.id);
  return paginate(rows, input.page, input.per_page ?? input.perPage).map((branch) => branchJson(branch, repo));
}


export function getBranchByName(domain: GitHubDomain, input: { owner: string; repo: string; branch: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const branch = domain.requireBranch(repo.id, input.branch);
  return branchJson(branch, repo);
}


export function deleteBranch(domain: GitHubDomain, input: { owner: string; repo: string; branch: string }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let before: Record<string, unknown> | null = null;
  domain.transaction(() => {
    const branch = domain.requireBranch(repo.id, input.branch);
    if (input.branch === repo.default_branch) {
      validationFailed("branch", "default_branch", input.branch);
    }
    // Mirror GitHub: if any open PR references this branch as head, 422.
    const headPr = domain.db.prepare("SELECT number FROM pull_requests WHERE state = 'open' AND head_repo_id = ? AND head_ref = ?").get(repo.id, input.branch) as { number: number } | undefined;
    if (headPr) validationFailed("branch", "open_pull_request", input.branch);
    before = branchState(branch, repo);
    domain.db.prepare("DELETE FROM files WHERE repo_id = ? AND branch = ?").run(repo.id, input.branch);
    domain.db.prepare("DELETE FROM branches WHERE repo_id = ? AND name = ?").run(repo.id, input.branch);
  });
  domain.audit("delete_branch", repo.full_name, input);
  onDelta?.({ before, after: null });
  return { ok: true };
}


export function deleteFile(domain: GitHubDomain, 
  input: { owner: string; repo: string; path: string; message: string; sha: string; branch?: string },
  options: MutatingOptions = {},
  onDelta?: StateDeltaCallback
) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const branch = input.branch ?? repo.default_branch;
  let before: Record<string, unknown> | null = null;
  const commit = domain.transaction(() => {
    domain.requireBranch(repo.id, branch);
    const path = normalizePath(input.path);
    const existing = domain.getFile(repo.id, branch, path);
    if (!existing) notFound("Not Found");
    if (!input.sha) validationFailed("sha", "missing", path);
    if (input.sha !== existing.sha) validationFailed("sha", "invalid", input.sha);
    before = fileState(existing, repo);
    return domain.commitFiles(repo, branch, input.message, [{ path, content: "", delete: true }], options.actor ?? "pome-agent");
  });
  domain.audit("delete_file", repo.full_name, { ...input });
  onDelta?.({ before, after: null });
  return {
    content: null,
    commit: commitJson(commit, repo)
  };
}

// Cluster B — commits & diffs --------------------------------------------

export function getCommitWithFiles(domain: GitHubDomain, input: { owner: string; repo: string; ref: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const commit = domain.resolveCommitByRef(repo, input.ref);
  const files = domain.computeCommitFiles(repo, commit);
  return commitWithFilesJson(commit, repo, files);
}


export function compareCommits(domain: GitHubDomain, input: { owner: string; repo: string; base: string; head: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const baseCommit = domain.resolveCommitByRef(repo, input.base);
  const headCommit = domain.resolveCommitByRef(repo, input.head);
  if (baseCommit.sha === headCommit.sha) {
    return compareCommitsJson(repo, baseCommit, headCommit, [], [], "identical", 0, 0);
  }
  const headAncestry = domain.commitAncestry(repo.id, headCommit.sha);
  const baseAncestry = domain.commitAncestry(repo.id, baseCommit.sha);
  const headSet = new Set(headAncestry.map((commit) => commit.sha));
  const baseSet = new Set(baseAncestry.map((commit) => commit.sha));
  const aheadCommits = headAncestry.filter((commit) => !baseSet.has(commit.sha));
  const behindCommits = baseAncestry.filter((commit) => !headSet.has(commit.sha));
  const status: "ahead" | "behind" | "identical" | "diverged" =
    aheadCommits.length > 0 && behindCommits.length > 0
      ? "diverged"
      : aheadCommits.length > 0
        ? "ahead"
        : behindCommits.length > 0
          ? "behind"
          : "identical";
  const files = domain.computeCompareFiles(repo, baseCommit, headCommit);
  // GitHub returns commits in reverse chronological order excluding the base.
  const commits = [...aheadCommits].reverse();
  return compareCommitsJson(repo, baseCommit, headCommit, commits, files, status, aheadCommits.length, behindCommits.length);
}

