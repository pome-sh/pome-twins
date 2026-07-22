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

// Cluster G — tags & releases --------------------------------------------

export function listTags(domain: GitHubDomain, input: { owner: string; repo: string } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const rows = domain.db.prepare("SELECT * FROM tags WHERE repo_id = ? ORDER BY created_at DESC").all(repo.id) as TagRow[];
  return paginate(rows, input.page, input.per_page ?? input.perPage).map((tag) => tagJson(tag, repo));
}


export function listReleases(domain: GitHubDomain, input: { owner: string; repo: string } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const rows = domain.db.prepare("SELECT * FROM releases WHERE repo_id = ? ORDER BY created_at DESC").all(repo.id) as ReleaseRow[];
  return paginate(rows, input.page, input.per_page ?? input.perPage).map((release) => releaseJson(release, repo));
}


export function getLatestRelease(domain: GitHubDomain, input: { owner: string; repo: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const row = domain.db.prepare("SELECT * FROM releases WHERE repo_id = ? AND draft = 0 AND prerelease = 0 AND published_at IS NOT NULL ORDER BY published_at DESC LIMIT 1").get(repo.id) as ReleaseRow | undefined;
  if (!row) notFound("Not Found");
  return releaseJson(row, repo);
}


export function getReleaseByTag(domain: GitHubDomain, input: { owner: string; repo: string; tag: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const row = domain.db.prepare("SELECT * FROM releases WHERE repo_id = ? AND tag_name = ?").get(repo.id, input.tag) as ReleaseRow | undefined;
  if (!row) notFound("Not Found");
  return releaseJson(row, repo);
}


export function getTag(domain: GitHubDomain, input: { owner: string; repo: string; tag: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const row = domain.db.prepare("SELECT * FROM tags WHERE repo_id = ? AND name = ?").get(repo.id, input.tag) as TagRow | undefined;
  if (!row) notFound("Not Found");
  return tagJson(row, repo);
}


export function createRelease(domain: GitHubDomain, 
  input: {
    owner: string;
    repo: string;
    tag_name: string;
    target_commitish?: string;
    name?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
  },
  options: MutatingOptions = {},
  onDelta?: StateDeltaCallback
) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const release = domain.transaction(() => {
    if (!input.tag_name.trim()) validationFailed("tag_name", "missing");
    const existingRelease = domain.db.prepare("SELECT id FROM releases WHERE repo_id = ? AND tag_name = ?").get(repo.id, input.tag_name) as { id: number } | undefined;
    if (existingRelease) validationFailed("tag_name", "already_exists", input.tag_name);
    const target = input.target_commitish ?? repo.default_branch;
    let tag = domain.db.prepare("SELECT * FROM tags WHERE repo_id = ? AND name = ?").get(repo.id, input.tag_name) as TagRow | undefined;
    if (!tag) {
      // Auto-create tag from target_commitish (branch name or SHA).
      const sha = domain.resolveRefToSha(repo, target);
      const now = nowIso();
      domain.db.prepare("INSERT INTO tags (repo_id, name, commit_sha, created_at) VALUES (?, ?, ?, ?)").run(repo.id, input.tag_name, sha, now);
      tag = { repo_id: repo.id, name: input.tag_name, commit_sha: sha, created_at: now };
    }
    const draft = input.draft ? 1 : 0;
    const prerelease = input.prerelease ? 1 : 0;
    const now = nowIso();
    const result = domain.db.prepare("INSERT INTO releases (repo_id, tag_name, target_commitish, name, body, draft, prerelease, author_login, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      repo.id,
      input.tag_name,
      target,
      input.name ?? null,
      input.body ?? "",
      draft,
      prerelease,
      options.actor ?? "pome-agent",
      now,
      draft ? null : now
    );
    return domain.db.prepare("SELECT * FROM releases WHERE id = ?").get(result.lastInsertRowid) as ReleaseRow;
  });
  domain.audit("create_release", repo.full_name, input);
  onDelta?.({ before: null, after: releaseState(release, repo) });
  return releaseJson(release, repo);
}

