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
import { contentLineCount, normalizePath } from "./helpers.js";
import type { FileChange, MutatingOptions, PageOptions, StateDeltaCallback } from "./types.js";


export function createPullRequest(domain: GitHubDomain, input: { owner: string; repo: string; title: string; body?: string; head: string; base?: string; actor?: string }, onDelta?: StateDeltaCallback) {
  const baseRepo = domain.requireRepo(input.owner, input.repo);
  const baseRef = input.base ?? baseRepo.default_branch;
  const number = domain.transaction(() => {
    if (input.head === baseRef || input.head === `${input.owner}:${baseRef}`) validationFailed("head", "invalid", input.head);
    const { repo: headRepo, ref: headRef } = domain.resolveHeadRef(baseRepo, input.head);
    const baseBranch = domain.requireBranch(baseRepo.id, baseRef);
    const headBranch = domain.requireBranch(headRepo.id, headRef);
    const duplicate = domain.db.prepare("SELECT * FROM pull_requests WHERE repo_id = ? AND state = 'open' AND head_repo_id = ? AND head_ref = ? AND base_ref = ?").get(
      baseRepo.id,
      headRepo.id,
      headRef,
      baseRef
    );
    if (duplicate) validationFailed("head", "already_exists", input.head);
    const files = domain.calculatePullFiles(baseRepo, baseRef, headRepo, headRef);
    if (files.length === 0) validationFailed("head", "missing_commits", input.head);
    const now = nowIso();
    const pullNumber = domain.nextNumber(baseRepo.id);
    domain.db.prepare("INSERT INTO pull_requests (repo_id, number, title, body, state, user_login, head_repo_id, head_ref, head_sha, base_repo_id, base_ref, base_sha, merged, merge_commit_sha, created_at, updated_at, closed_at, merged_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL, NULL)").run(
      baseRepo.id,
      pullNumber,
      input.title,
      input.body ?? "",
      input.actor ?? "pome-agent",
      headRepo.id,
      headRef,
      headBranch.head_sha,
      baseRepo.id,
      baseRef,
      baseBranch.head_sha,
      now,
      now
    );
    domain.replacePullFiles(baseRepo.id, pullNumber, files);
    return pullNumber;
  });
  domain.audit("create_pull_request", baseRepo.full_name, input);
  const createdRow = domain.requirePullRequest(baseRepo.id, number);
  onDelta?.({ before: null, after: pullRequestState(createdRow, baseRepo) });
  return domain.getPullRequest({ owner: input.owner, repo: input.repo, pull_number: number });
}


export function listPullRequests(domain: GitHubDomain, input: { owner: string; repo: string; state?: "open" | "closed" | "all" } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let rows = domain.listPullRequestRows(repo.id);
  if (input.state && input.state !== "all") rows = rows.filter((pr) => pr.state === input.state);
  return paginate(rows, input.page, input.per_page ?? input.perPage).map((pr) => domain.serializePullSimple(pr));
}


export function getPullRequest(domain: GitHubDomain, input: { owner: string; repo: string; pull_number: number }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const pr = domain.requirePullRequest(repo.id, input.pull_number);
  return domain.serializePull(pr);
}


export function getPullRequestFiles(domain: GitHubDomain, input: { owner: string; repo: string; pull_number: number } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  domain.requirePullRequest(repo.id, input.pull_number);
  const rows = domain.listPullRequestFileRows(repo.id, input.pull_number);
  return paginate(rows, input.page, input.per_page ?? input.perPage).map(pullRequestFileJson);
}


export function getPullRequestReviews(domain: GitHubDomain, input: { owner: string; repo: string; pull_number: number } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  domain.requirePullRequest(repo.id, input.pull_number);
  const rows = domain.listPullRequestReviewRows(repo.id, input.pull_number);
  return paginate(rows, input.page, input.per_page ?? input.perPage).map((review) => reviewJson(review, repo));
}


export function createPullRequestReview(domain: GitHubDomain, input: { owner: string; repo: string; pull_number: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const review = domain.transaction(() => {
    const pr = domain.requirePullRequest(repo.id, input.pull_number);
    if (pr.state !== "open") conflict("Pull request is closed");
    const state = input.event === "APPROVE" ? "APPROVED" : input.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
    const headSha = domain.requireBranch(pr.head_repo_id, pr.head_ref).head_sha;
    const result = domain.db.prepare("INSERT INTO pull_request_reviews (repo_id, pull_number, user_login, state, body, commit_sha, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      repo.id,
      pr.number,
      "pome-agent",
      state,
      input.body ?? "",
      headSha,
      nowIso()
    );
    return domain.db.prepare("SELECT * FROM pull_request_reviews WHERE id = ?").get(result.lastInsertRowid) as PullRequestReviewRow;
  });
  domain.audit("create_pull_request_review", repo.full_name, input);
  onDelta?.({ before: null, after: pullRequestReviewState(review, repo) });
  return reviewJson(review, repo);
}


export function getPullRequestComments(domain: GitHubDomain, input: { owner: string; repo: string; pull_number: number } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  domain.requirePullRequest(repo.id, input.pull_number);
  const rows = domain.listPullRequestReviewCommentRows(repo.id, input.pull_number);
  return paginate(rows, input.page, input.per_page ?? input.perPage).map((comment) => ({
    id: comment.id,
    path: comment.path,
    body: comment.body,
    user: userJson(comment.user_login),
    created_at: comment.created_at,
    updated_at: comment.updated_at
  }));
}


export function getPullRequestStatus(domain: GitHubDomain, input: { owner: string; repo: string; pull_number: number }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const pr = domain.requirePullRequest(repo.id, input.pull_number);
  const head = domain.requireBranch(pr.head_repo_id, pr.head_ref);
  const statuses = head.head_sha ? domain.latestCommitStatuses(pr.head_repo_id, head.head_sha) : [];
  return combinedStatusJson(domain.requireRepoById(pr.head_repo_id), head.head_sha ?? "", statuses);
}


export function mergePullRequest(domain: GitHubDomain, input: { owner: string; repo: string; pull_number: number; commit_title?: string; commit_message?: string }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let before: Record<string, unknown> | null = null;
  const commit = domain.transaction(() => {
    const pr = domain.requirePullRequest(repo.id, input.pull_number);
    before = pullRequestState(pr, repo);
    if (pr.state !== "open") conflict("Pull request is closed");
    if (pr.merged) conflict("Pull request already merged");
    const status = domain.getPullRequestStatus(input);
    if ((status as { state: string }).state === "failure") conflict("Required status check failed");
    const headRepo = domain.requireRepoById(pr.head_repo_id);
    const files = domain.listPullRequestFileRows(repo.id, pr.number);
    const changes = files.map((file) => {
      if (file.status === "removed") return { path: file.filename, content: "", delete: true };
      const source = domain.getFile(headRepo.id, pr.head_ref, file.filename);
      if (!source) validationFailed("files", "missing", file.filename);
      return { path: file.filename, content: source.content };
    });
    const mergedCommit = domain.commitFiles(repo, pr.base_ref, input.commit_title ?? `Merge pull request #${pr.number}`, changes, "pome-agent");
    const now = nowIso();
    domain.db.prepare("UPDATE pull_requests SET state = 'closed', merged = 1, merge_commit_sha = ?, updated_at = ?, closed_at = ?, merged_at = ? WHERE repo_id = ? AND number = ?").run(
      mergedCommit.sha,
      now,
      now,
      now,
      repo.id,
      pr.number
    );
    return mergedCommit;
  });
  domain.audit("merge_pull_request", repo.full_name, input);
  const merged = domain.requirePullRequest(repo.id, input.pull_number);
  onDelta?.({ before, after: pullRequestState(merged, repo) });
  return { sha: commit.sha, merged: true, message: "Pull Request successfully merged" };
}


export function updatePullRequestBranch(domain: GitHubDomain, input: { owner: string; repo: string; pull_number: number; expected_head_sha?: string }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let before: Record<string, unknown> | null = null;
  const pullNumber = domain.transaction(() => {
    const pr = domain.requirePullRequest(repo.id, input.pull_number);
    before = pullRequestState(pr, repo);
    if (pr.state !== "open") conflict("Pull request is closed");
    const headRepo = domain.requireRepoById(pr.head_repo_id);
    const headBranch = domain.requireBranch(headRepo.id, pr.head_ref);
    if (input.expected_head_sha && headBranch.head_sha !== input.expected_head_sha) conflict("Head SHA did not match");
    const baseBranch = domain.requireBranch(repo.id, pr.base_ref);
    // Semantic merge (F-735): merge base into head with a real merge commit
    // instead of resetting the head pointer to the base head. No-op when the
    // head branch already contains the base head (GitHub returns 422 there;
    // documented deviation).
    const mergeBase = domain.findMergeBase(repo, baseBranch.head_sha, headRepo, headBranch.head_sha);
    if (baseBranch.head_sha === mergeBase) return pr.number;
    const changes = domain.mergeChangesFromBase(repo, pr.base_ref, headRepo, pr.head_ref, mergeBase);
    // Single-parent commit model: a previous merge is invisible to the
    // ancestry walk, so "base already merged" surfaces as an empty change
    // set. Merge commits are only created when they change files on head.
    if (changes.length === 0) return pr.number;
    const mergeCommit = domain.commitFiles(headRepo, pr.head_ref, `Merge branch '${pr.base_ref}' into ${pr.head_ref}`, changes, "pome-agent");
    domain.db.prepare("UPDATE pull_requests SET head_sha = ?, updated_at = ? WHERE repo_id = ? AND number = ?").run(mergeCommit.sha, nowIso(), repo.id, pr.number);
    domain.replacePullFiles(repo.id, pr.number, domain.calculatePullFiles(repo, pr.base_ref, headRepo, pr.head_ref));
    return pr.number;
  });
  domain.audit("update_pull_request_branch", repo.full_name, input);
  const updated = domain.requirePullRequest(repo.id, pullNumber);
  onDelta?.({ before, after: pullRequestState(updated, repo) });
  return { message: "Updating pull request branch.", url: `https://api.github.com/repos/${repo.full_name}/pulls/${pullNumber}/update-branch` };
}


export function getPullRequestDiff(domain: GitHubDomain, input: { owner: string; repo: string; pull_number: number }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  domain.requirePullRequest(repo.id, input.pull_number);
  const files = domain.listPullRequestFileRows(repo.id, input.pull_number);
  return { diff: pullRequestDiffText(files) };
}

// Cluster C — pull requests deeper ---------------------------------------

export function updatePullRequest(domain: GitHubDomain, 
  input: { owner: string; repo: string; pull_number: number; title?: string; body?: string; state?: "open" | "closed"; base?: string },
  onDelta?: StateDeltaCallback
) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let before: Record<string, unknown> | null = null;
  domain.transaction(() => {
    const pr = domain.requirePullRequest(repo.id, input.pull_number);
    before = pullRequestState(pr, repo);
    if (pr.merged && (input.state === "open" || (input.base !== undefined && input.base !== pr.base_ref))) {
      conflict("Cannot reopen or rebase a merged pull request");
    }
    const nextBase = input.base ?? pr.base_ref;
    if (nextBase !== pr.base_ref) domain.requireBranch(repo.id, nextBase);
    const nextState = input.state ?? pr.state;
    const closedAt = nextState === "closed" && pr.state !== "closed" ? nowIso() : nextState === "open" ? null : pr.closed_at;
    const now = nowIso();
    domain.db.prepare("UPDATE pull_requests SET title = ?, body = ?, state = ?, base_ref = ?, updated_at = ?, closed_at = ? WHERE repo_id = ? AND number = ?").run(
      input.title ?? pr.title,
      input.body ?? pr.body,
      nextState,
      nextBase,
      now,
      closedAt,
      repo.id,
      pr.number
    );
    if (nextBase !== pr.base_ref) {
      const headRepo = domain.requireRepoById(pr.head_repo_id);
      domain.replacePullFiles(repo.id, pr.number, domain.calculatePullFiles(repo, nextBase, headRepo, pr.head_ref));
      const baseBranch = domain.requireBranch(repo.id, nextBase);
      domain.db.prepare("UPDATE pull_requests SET base_sha = ? WHERE repo_id = ? AND number = ?").run(baseBranch.head_sha, repo.id, pr.number);
    }
  });
  domain.audit("update_pull_request", repo.full_name, input);
  const updated = domain.requirePullRequest(repo.id, input.pull_number);
  onDelta?.({ before, after: pullRequestState(updated, repo) });
  return domain.getPullRequest({ owner: input.owner, repo: input.repo, pull_number: input.pull_number });
}


export function getPullRequestCommits(domain: GitHubDomain, input: { owner: string; repo: string; pull_number: number } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const pr = domain.requirePullRequest(repo.id, input.pull_number);
  const headRepo = domain.requireRepoById(pr.head_repo_id);
  const headSha = domain.getBranch(headRepo.id, pr.head_ref)?.head_sha ?? pr.head_sha;
  const baseSha = domain.getBranch(repo.id, pr.base_ref)?.head_sha ?? pr.base_sha;
  const commits = headSha ? domain.commitsBetween(headRepo.id, headSha, baseSha) : [];
  // GitHub returns oldest-first for PR commits — reverse the ancestry walk.
  const ordered = [...commits].reverse();
  return paginate(ordered, input.page, input.per_page ?? input.perPage).map((commit) => commitJson(commit, headRepo));
}


export function createPullRequestReviewComment(domain: GitHubDomain, 
  input: {
    owner: string;
    repo: string;
    pull_number: number;
    body: string;
    path: string;
    line?: number;
    side?: "LEFT" | "RIGHT";
    commit_id?: string;
  },
  options: MutatingOptions = {},
  onDelta?: StateDeltaCallback
) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const comment = domain.transaction(() => {
    const pr = domain.requirePullRequest(repo.id, input.pull_number);
    if (!input.body.trim()) validationFailed("body", "missing");
    if (!input.line) validationFailed("line", "missing");
    const path = normalizePath(input.path);
    const prFile = domain.listPullRequestFileRows(repo.id, pr.number).find((file) => file.filename === path);
    if (!prFile) validationFailed("path", "not_in_pr", path);
    const side = input.side ?? "RIGHT";
    const headRepo = domain.requireRepoById(pr.head_repo_id);
    const targetRepo = side === "LEFT" ? domain.requireRepoById(pr.base_repo_id) : headRepo;
    const targetRef = side === "LEFT" ? pr.base_ref : pr.head_ref;
    const targetFile = domain.getFile(targetRepo.id, targetRef, path);
    if (!targetFile || input.line > contentLineCount(targetFile.content)) validationFailed("line", "invalid", input.line);
    const headSha = domain.getBranch(pr.head_repo_id, pr.head_ref)?.head_sha ?? pr.head_sha;
    const baseSha = domain.getBranch(repo.id, pr.base_ref)?.head_sha ?? pr.base_sha;
    const commits = headSha ? domain.commitsBetween(headRepo.id, headSha, baseSha) : [];
    const commitSha = input.commit_id ?? headSha;
    if (!commitSha || !commits.some((commit) => commit.sha === commitSha)) {
      validationFailed("commit_id", "invalid", input.commit_id ?? commitSha ?? "");
    }
    const now = nowIso();
    const result = domain.db.prepare("INSERT INTO pull_request_review_comments (repo_id, pull_number, path, body, user_login, created_at, updated_at, line, side, commit_sha, in_reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)").run(
      repo.id,
      pr.number,
      path,
      input.body,
      options.actor ?? "pome-agent",
      now,
      now,
      input.line ?? null,
      side,
      commitSha
    );
    return domain.db.prepare("SELECT * FROM pull_request_review_comments WHERE id = ?").get(result.lastInsertRowid) as PullRequestReviewCommentRow;
  });
  domain.audit("create_pull_request_review_comment", repo.full_name, input);
  onDelta?.({ before: null, after: pullRequestReviewCommentState(comment, repo) });
  return pullRequestReviewCommentJson(comment, repo);
}


export function addReplyToPullRequestComment(domain: GitHubDomain, 
  input: { owner: string; repo: string; pull_number: number; comment_id: number; body: string },
  options: MutatingOptions = {},
  onDelta?: StateDeltaCallback
) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const reply = domain.transaction(() => {
    const pr = domain.requirePullRequest(repo.id, input.pull_number);
    const parent = domain.db.prepare("SELECT * FROM pull_request_review_comments WHERE id = ? AND repo_id = ? AND pull_number = ?").get(input.comment_id, repo.id, pr.number) as PullRequestReviewCommentRow | undefined;
    if (!parent) notFound("Review comment not found");
    if (!input.body.trim()) validationFailed("body", "missing");
    const now = nowIso();
    const result = domain.db.prepare("INSERT INTO pull_request_review_comments (repo_id, pull_number, path, body, user_login, created_at, updated_at, line, side, commit_sha, in_reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      repo.id,
      pr.number,
      parent.path,
      input.body,
      options.actor ?? "pome-agent",
      now,
      now,
      parent.line,
      parent.side,
      parent.commit_sha,
      parent.id
    );
    return domain.db.prepare("SELECT * FROM pull_request_review_comments WHERE id = ?").get(result.lastInsertRowid) as PullRequestReviewCommentRow;
  });
  domain.audit("add_reply_to_pull_request_comment", repo.full_name, input);
  onDelta?.({ before: null, after: pullRequestReviewCommentState(reply, repo) });
  return pullRequestReviewCommentJson(reply, repo);
}

