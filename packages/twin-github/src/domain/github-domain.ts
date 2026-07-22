// file-size: GitHubDomain coordinator keeps seed/export plus shared row/git helpers; area modules own the public business operations.
// SPDX-License-Identifier: Apache-2.0
import type {
  BranchRow,
  CheckRunRow,
  CommitRow,
  CommitStatusRow,
  CollaboratorRow,
  FileRow,
  GitHubCloneDatabase,
  GitHubStateSeed,
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
import { defaultSeedState, parseSeed } from "../seed.js";
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
import { resetDatabase } from "../db.js";
import * as checks from "./checks.js";
import * as git from "./git.js";
import * as issues from "./issues.js";
import * as pulls from "./pulls.js";
import * as releases from "./releases.js";
import * as repos from "./repos.js";
import * as search from "./search.js";
import { commitIdentityKey, normalizePath } from "./helpers.js";
import type { FileChange, MutatingOptions, PageOptions, StateDeltaCallback } from "./types.js";

export type { FileChange, MutatingOptions, PageOptions, StateDeltaCallback } from "./types.js";

export class GitHubDomain {
  constructor(readonly db: GitHubCloneDatabase) {}


  seed(seed: GitHubStateSeed = defaultSeedState(), onDelta?: StateDeltaCallback) {
    const parsedSeed = parseSeed(seed);
    const before = this.summarizeRepositories();
    const tx = this.db.transaction(() => {
      resetDatabase(this.db);
      const users = new Set(parsedSeed.users?.map((user) => user.login) ?? []);
      for (const repo of parsedSeed.repositories) {
        users.add(repo.owner);
        for (const login of repo.collaborators ?? []) users.add(login);
        for (const issue of repo.issues ?? []) for (const login of issue.assignees ?? []) users.add(login);
      }
      users.add("pome-agent");
      for (const user of parsedSeed.users ?? []) {
        this.upsertUser(user.login, user.type ?? "User", user.name ?? "");
      }
      for (const login of users) {
        this.upsertUser(login, login === "acme" ? "Organization" : "User", login);
      }
      for (const repoSeed of parsedSeed.repositories) {
        const repo = this.insertRepository({
          owner: repoSeed.owner,
          name: repoSeed.name,
          description: repoSeed.description ?? "",
          private: repoSeed.private ?? false,
          defaultBranch: repoSeed.default_branch ?? "main",
          fork: false,
          parentFullName: null
        });
        for (const login of repoSeed.collaborators ?? []) this.addCollaborator(repo.id, login);
        this.addCollaborator(repo.id, "pome-agent");
        for (const label of repoSeed.labels ?? []) {
          this.createLabel(repo, label.name, label.color ?? "ededed", label.description ?? "");
        }
        this.createBranchInternal(repo, repo.default_branch, null);
        const files = repoSeed.files?.filter((file) => (file.branch ?? repo.default_branch) === repo.default_branch) ?? [];
        this.commitFiles(repo, repo.default_branch, "Initial seed commit", files, "pome-agent");
        const nonDefaultBranches = new Set((repoSeed.files ?? []).map((file) => file.branch ?? repo.default_branch).filter((branch) => branch !== repo.default_branch));
        for (const branch of nonDefaultBranches) {
          this.createBranch({ owner: repo.owner, repo: repo.name, branch, from_branch: repo.default_branch });
          const branchFiles = repoSeed.files?.filter((file) => (file.branch ?? repo.default_branch) === branch) ?? [];
          this.commitFiles(repo, branch, `Seed ${branch}`, branchFiles, "pome-agent");
        }
        for (const issue of repoSeed.issues ?? []) {
          const legacyAssignee = (issue as { assignee?: string | null }).assignee;
          const assignees = issue.assignees ?? (legacyAssignee ? [legacyAssignee] : []);
          const created = this.createIssue({ owner: repo.owner, repo: repo.name, title: issue.title, body: issue.body ?? "", labels: issue.labels ?? [], assignees });
          if (issue.number && issue.number !== created.number) {
            this.db.prepare("UPDATE issues SET number = ? WHERE repo_id = ? AND number = ?").run(issue.number, repo.id, created.number);
            this.bumpEntityCounter(repo.id, issue.number);
          }
          if (issue.state === "closed") this.updateIssue({ owner: repo.owner, repo: repo.name, issue_number: issue.number ?? created.number, state: "closed" });
        }
        for (const pull of repoSeed.pull_requests ?? []) {
          const createdPr = this.createPullRequest({ owner: repo.owner, repo: repo.name, title: pull.title, body: pull.body ?? "", head: pull.head, base: pull.base ?? repo.default_branch, actor: pull.author });
          const prNumber = (createdPr as { number: number }).number;
          // The PR row and its head branch don't change across seeded reviews /
          // statuses, so resolve the head SHA once rather than re-querying it on
          // every iteration (and in both blocks below).
          const seedsHead = (pull.reviews ?? []).length > 0 || (pull.statuses ?? []).length > 0;
          const prRow = seedsHead ? this.requirePullRequest(repo.id, prNumber) : null;
          const headRepo = prRow ? this.requireRepoById(prRow.head_repo_id) : null;
          const headSha = prRow && headRepo ? this.requireBranch(headRepo.id, prRow.head_ref).head_sha ?? "" : "";
          // Seed reviews directly into pull_request_reviews so we can record
          // the author and state honestly. Going through createPullRequestReview
          // would hardcode user_login = "pome-agent" and lose author identity.
          for (const review of pull.reviews ?? []) {
            users.add(review.author);
            this.upsertUser(review.author, "User", review.author);
            this.db.prepare("INSERT INTO pull_request_reviews (repo_id, pull_number, user_login, state, body, commit_sha, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
              repo.id,
              prNumber,
              review.author,
              // parseSeed defaults this to "APPROVED"; guard direct seed() callers
              // that pass a hand-built seed with no explicit review state.
              review.state ?? "APPROVED",
              review.body ?? "",
              headSha,
              nowIso()
            );
          }
          // Seed commit statuses on the PR head SHA. Same shape as
          // createStatus() so merge_pull_request's required-status check
          // sees the seeded value.
          if ((pull.statuses ?? []).length > 0 && headRepo) {
            for (const status of pull.statuses ?? []) {
              this.createStatus({
                owner: headRepo.owner,
                repo: headRepo.name,
                sha: headSha,
                state: status.state ?? "success",
                context: status.context ?? "ci/build",
                description: status.description ?? ""
              });
            }
          }
        }
      }
      this.audit("seed", null, { repositories: parsedSeed.repositories.length });
    });
    tx();
    onDelta?.({
      before: { repositories: before },
      after: { repositories: this.summarizeRepositories() }
    });
  }


  summarizeRepositories(): Array<{ owner: string; name: string }> {
    const rows = this.db.prepare("SELECT owner, name FROM repositories ORDER BY full_name ASC").all() as Array<{ owner: string; name: string }>;
    return rows;
  }


  exportState() {
    const repos = this.db.prepare("SELECT * FROM repositories ORDER BY full_name ASC").all() as RepoRow[];
    return {
      repositories: repos.map((repo) => ({
        ...repo,
        branches: this.listBranches(repo.id),
        files: this.db.prepare("SELECT * FROM files WHERE repo_id = ? ORDER BY branch, path").all(repo.id),
        labels: this.listLabels(repo.id),
        issues: this.listIssuesRows(repo.id).map((issue) => ({
          ...issue,
          labels: this.listIssueLabels(repo.id, issue.number),
          assignees: this.listIssueAssignees(repo.id, issue.number),
          comments: this.listIssueCommentRows(repo.id, issue.number)
        })),
        pull_requests: this.listPullRequestRows(repo.id).map((pull) => ({
          ...pull,
          files: this.listPullRequestFileRows(repo.id, pull.number),
          reviews: this.listPullRequestReviewRows(repo.id, pull.number),
          review_comments: this.listPullRequestReviewCommentRows(repo.id, pull.number)
        })),
        commit_statuses: this.db.prepare("SELECT * FROM commit_statuses WHERE repo_id = ? ORDER BY id ASC").all(repo.id),
        check_runs: this.db.prepare("SELECT * FROM check_runs WHERE repo_id = ? ORDER BY id ASC").all(repo.id)
      }))
    };
  }

  getRepository(input: { owner: string; repo: string }) {
    return repos.getRepository(this, input);
  }

  createRepository(input: { name: string; owner?: string; description?: string; private?: boolean }, onDelta?: StateDeltaCallback) {
    return repos.createRepository(this, input, onDelta);
  }

  forkRepository(input: { owner: string; repo: string; organization?: string }, onDelta?: StateDeltaCallback) {
    return repos.forkRepository(this, input, onDelta);
  }

  searchRepositories(input: { query?: string; q?: string } & PageOptions) {
    return search.searchRepositories(this, input);
  }

  searchUsers(input: { query?: string; q?: string } & PageOptions) {
    return search.searchUsers(this, input);
  }

  searchCode(input: { query?: string; q?: string; owner?: string; repo?: string } & PageOptions) {
    return search.searchCode(this, input);
  }

  searchCommits(input: { query?: string; q?: string; owner?: string; repo?: string } & PageOptions) {
    return search.searchCommits(this, input);
  }

  getFileContents(input: { owner: string; repo: string; path?: string; ref?: string }) {
    return git.getFileContents(this, input);
  }

  listCommits(input: { owner: string; repo: string; sha?: string } & PageOptions) {
    return git.listCommits(this, input);
  }

  createOrUpdateFile(input: { owner: string; repo: string; path: string; message: string; content: string; branch?: string; sha?: string; encoding?: string }, options: MutatingOptions = {}, onDelta?: StateDeltaCallback) {
    return git.createOrUpdateFile(this, input, options, onDelta);
  }

  pushFiles(input: { owner: string; repo: string; branch?: string; message: string; files: Array<{ path: string; content: string; encoding?: string }> }, options: MutatingOptions = {}, onDelta?: StateDeltaCallback) {
    return git.pushFiles(this, input, options, onDelta);
  }

  createBranch(input: { owner: string; repo: string; branch: string; from_branch?: string; sha?: string }, onDelta?: StateDeltaCallback) {
    return git.createBranch(this, input, onDelta);
  }

  createIssue(input: { owner: string; repo: string; title: string; body?: string; labels?: string[]; assignees?: string[] }, onDelta?: StateDeltaCallback) {
    return issues.createIssue(this, input, onDelta);
  }

  listIssues(input: { owner: string; repo: string; state?: "open" | "closed" | "all"; labels?: string; assignee?: string } & PageOptions) {
    return issues.listIssues(this, input);
  }

  searchIssues(input: { query?: string; q?: string; owner?: string; repo?: string; state?: "open" | "closed" | "all" } & PageOptions) {
    return search.searchIssues(this, input);
  }

  getIssue(input: { owner: string; repo: string; issue_number: number }) {
    return issues.getIssue(this, input);
  }

  updateIssue(input: { owner: string; repo: string; issue_number: number; title?: string; body?: string; state?: "open" | "closed"; labels?: string[]; assignees?: string[] }, onDelta?: StateDeltaCallback) {
    return issues.updateIssue(this, input, onDelta);
  }

  addIssueComment(input: { owner: string; repo: string; issue_number: number; body: string }, onDelta?: StateDeltaCallback) {
    return issues.addIssueComment(this, input, onDelta);
  }

  listIssueComments(input: { owner: string; repo: string; issue_number: number } & PageOptions) {
    return issues.listIssueComments(this, input);
  }

  listRepositoryLabels(input: { owner: string; repo: string }) {
    return issues.listRepositoryLabels(this, input);
  }

  createRepositoryLabel(input: { owner: string; repo: string; name: string; color?: string; description?: string }, onDelta?: StateDeltaCallback) {
    return issues.createRepositoryLabel(this, input, onDelta);
  }

  listIssueLabelsForIssue(input: { owner: string; repo: string; issue_number: number }) {
    return issues.listIssueLabelsForIssue(this, input);
  }

  addIssueLabels(input: { owner: string; repo: string; issue_number: number; labels: string[] }, onDelta?: StateDeltaCallback) {
    return issues.addIssueLabels(this, input, onDelta);
  }

  deleteIssueLabel(input: { owner: string; repo: string; issue_number: number; label: string }, onDelta?: StateDeltaCallback) {
    return issues.deleteIssueLabel(this, input, onDelta);
  }

  listCollaborators(input: { owner: string; repo: string }) {
    return repos.listCollaborators(this, input);
  }

  isCollaborator(input: { owner: string; repo: string; username: string }) {
    return repos.isCollaborator(this, input);
  }

  hasRepositoryPermission(input: { owner: string; repo: string; username: string; permissions: string[] }) {
    return repos.hasRepositoryPermission(this, input);
  }

  addAssignees(input: { owner: string; repo: string; issue_number: number; assignees: string[] }, onDelta?: StateDeltaCallback) {
    return issues.addAssignees(this, input, onDelta);
  }

  createPullRequest(input: { owner: string; repo: string; title: string; body?: string; head: string; base?: string; actor?: string }, onDelta?: StateDeltaCallback) {
    return pulls.createPullRequest(this, input, onDelta);
  }

  listPullRequests(input: { owner: string; repo: string; state?: "open" | "closed" | "all" } & PageOptions) {
    return pulls.listPullRequests(this, input);
  }

  getPullRequest(input: { owner: string; repo: string; pull_number: number }) {
    return pulls.getPullRequest(this, input);
  }

  getPullRequestFiles(input: { owner: string; repo: string; pull_number: number } & PageOptions) {
    return pulls.getPullRequestFiles(this, input);
  }

  getPullRequestReviews(input: { owner: string; repo: string; pull_number: number } & PageOptions) {
    return pulls.getPullRequestReviews(this, input);
  }

  createPullRequestReview(input: { owner: string; repo: string; pull_number: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string }, onDelta?: StateDeltaCallback) {
    return pulls.createPullRequestReview(this, input, onDelta);
  }

  getPullRequestComments(input: { owner: string; repo: string; pull_number: number } & PageOptions) {
    return pulls.getPullRequestComments(this, input);
  }

  getPullRequestStatus(input: { owner: string; repo: string; pull_number: number }) {
    return pulls.getPullRequestStatus(this, input);
  }

  mergePullRequest(input: { owner: string; repo: string; pull_number: number; commit_title?: string; commit_message?: string }, onDelta?: StateDeltaCallback) {
    return pulls.mergePullRequest(this, input, onDelta);
  }

  updatePullRequestBranch(input: { owner: string; repo: string; pull_number: number; expected_head_sha?: string }, onDelta?: StateDeltaCallback) {
    return pulls.updatePullRequestBranch(this, input, onDelta);
  }

  createStatus(input: { owner: string; repo: string; sha: string; state: "error" | "failure" | "pending" | "success"; context?: string; description?: string; target_url?: string }) {
    return checks.createStatus(this, input);
  }

  listBranchesForRepo(input: { owner: string; repo: string } & PageOptions) {
    return git.listBranchesForRepo(this, input);
  }

  getBranchByName(input: { owner: string; repo: string; branch: string }) {
    return git.getBranchByName(this, input);
  }

  deleteBranch(input: { owner: string; repo: string; branch: string }, onDelta?: StateDeltaCallback) {
    return git.deleteBranch(this, input, onDelta);
  }

  deleteFile(
    input: { owner: string; repo: string; path: string; message: string; sha: string; branch?: string },
    options: MutatingOptions = {},
    onDelta?: StateDeltaCallback
  ) {
    return git.deleteFile(this, input, options, onDelta);
  }

  getCommitWithFiles(input: { owner: string; repo: string; ref: string }) {
    return git.getCommitWithFiles(this, input);
  }

  compareCommits(input: { owner: string; repo: string; base: string; head: string }) {
    return git.compareCommits(this, input);
  }

  getPullRequestDiff(input: { owner: string; repo: string; pull_number: number }) {
    return pulls.getPullRequestDiff(this, input);
  }

  updatePullRequest(
    input: { owner: string; repo: string; pull_number: number; title?: string; body?: string; state?: "open" | "closed"; base?: string },
    onDelta?: StateDeltaCallback
  ) {
    return pulls.updatePullRequest(this, input, onDelta);
  }

  getPullRequestCommits(input: { owner: string; repo: string; pull_number: number } & PageOptions) {
    return pulls.getPullRequestCommits(this, input);
  }

  createPullRequestReviewComment(
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
    return pulls.createPullRequestReviewComment(this, input, options, onDelta);
  }

  addReplyToPullRequestComment(
    input: { owner: string; repo: string; pull_number: number; comment_id: number; body: string },
    options: MutatingOptions = {},
    onDelta?: StateDeltaCallback
  ) {
    return pulls.addReplyToPullRequestComment(this, input, options, onDelta);
  }

  updateIssueComment(input: { owner: string; repo: string; comment_id: number; body: string }, onDelta?: StateDeltaCallback) {
    return issues.updateIssueComment(this, input, onDelta);
  }

  deleteIssueComment(input: { owner: string; repo: string; comment_id: number }, onDelta?: StateDeltaCallback) {
    return issues.deleteIssueComment(this, input, onDelta);
  }

  listMilestones(input: { owner: string; repo: string; state?: "open" | "closed" | "all" } & PageOptions) {
    return issues.listMilestones(this, input);
  }

  createMilestone(
    input: { owner: string; repo: string; title: string; description?: string; due_on?: string; state?: "open" | "closed" },
    onDelta?: StateDeltaCallback
  ) {
    return issues.createMilestone(this, input, onDelta);
  }

  updateMilestone(
    input: { owner: string; repo: string; milestone_number: number; title?: string; description?: string; due_on?: string; state?: "open" | "closed" },
    onDelta?: StateDeltaCallback
  ) {
    return issues.updateMilestone(this, input, onDelta);
  }

  deleteMilestone(input: { owner: string; repo: string; milestone_number: number }, onDelta?: StateDeltaCallback) {
    return issues.deleteMilestone(this, input, onDelta);
  }

  createCommitStatus(
    input: { owner: string; repo: string; sha: string; state: "error" | "failure" | "pending" | "success"; context?: string; description?: string; target_url?: string },
    onDelta?: StateDeltaCallback
  ) {
    return checks.createCommitStatus(this, input, onDelta);
  }

  getCombinedStatusForRef(input: { owner: string; repo: string; ref: string }) {
    return checks.getCombinedStatusForRef(this, input);
  }

  createCheckRun(
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
    return checks.createCheckRun(this, input, onDelta);
  }

  listCheckRunsForRef(input: { owner: string; repo: string; ref: string } & PageOptions) {
    return checks.listCheckRunsForRef(this, input);
  }

  listTags(input: { owner: string; repo: string } & PageOptions) {
    return releases.listTags(this, input);
  }

  listReleases(input: { owner: string; repo: string } & PageOptions) {
    return releases.listReleases(this, input);
  }

  getLatestRelease(input: { owner: string; repo: string }) {
    return releases.getLatestRelease(this, input);
  }

  getReleaseByTag(input: { owner: string; repo: string; tag: string }) {
    return releases.getReleaseByTag(this, input);
  }

  getTag(input: { owner: string; repo: string; tag: string }) {
    return releases.getTag(this, input);
  }

  createRelease(
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
    return releases.createRelease(this, input, options, onDelta);
  }

  getMe(input: { actor?: string } = {}) {
    return repos.getMe(this, input);
  }

  addCollaboratorAction(
    input: { owner: string; repo: string; username: string; permission?: string; actor?: string },
    onDelta?: StateDeltaCallback
  ) {
    return repos.addCollaboratorAction(this, input, onDelta);
  }

  // ----- shared helpers (used by domain/* modules) -----


  latestCommitStatuses(repoId: number, sha: string) {
    const statuses = this.db.prepare("SELECT * FROM commit_statuses WHERE repo_id = ? AND sha = ? ORDER BY updated_at DESC, id DESC").all(repoId, sha) as CommitStatusRow[];
    const latestByContext = new Map<string, CommitStatusRow>();
    for (const status of statuses) {
      if (!latestByContext.has(status.context)) latestByContext.set(status.context, status);
    }
    return [...latestByContext.values()];
  }

  // ===== private helpers added for v2 hot paths ============================

  requireCommitOnRepo(repoId: number, sha: string) {
    const exists = this.db.prepare("SELECT 1 FROM commits WHERE repo_id = ? AND sha = ?").get(repoId, sha);
    if (!exists) notFound("No commit found for SHA");
  }


  resolveCommitByRef(repo: RepoRow, ref: string): CommitRow {
    // Try as SHA first.
    const byHash = this.db.prepare("SELECT * FROM commits WHERE repo_id = ? AND sha = ?").get(repo.id, ref) as CommitRow | undefined;
    if (byHash) return byHash;
    // Try as branch name.
    const branch = this.getBranch(repo.id, ref);
    if (branch?.head_sha) {
      const commit = this.db.prepare("SELECT * FROM commits WHERE repo_id = ? AND sha = ?").get(repo.id, branch.head_sha) as CommitRow | undefined;
      if (commit) return commit;
    }
    // Try as tag name.
    const tag = this.db.prepare("SELECT * FROM tags WHERE repo_id = ? AND name = ?").get(repo.id, ref) as TagRow | undefined;
    if (tag) {
      const commit = this.db.prepare("SELECT * FROM commits WHERE repo_id = ? AND sha = ?").get(repo.id, tag.commit_sha) as CommitRow | undefined;
      if (commit) return commit;
    }
    notFound("No commit found for ref");
  }


  resolveRefToSha(repo: RepoRow, ref: string): string {
    return this.resolveCommitByRef(repo, ref).sha;
  }


  commitAncestry(repoId: number, sha: string): CommitRow[] {
    const all = this.db.prepare("SELECT * FROM commits WHERE repo_id = ?").all(repoId) as CommitRow[];
    const bySha = new Map(all.map((commit) => [commit.sha, commit]));
    const out: CommitRow[] = [];
    const seen = new Set<string>();
    const MAX_DEPTH = 2000;
    let cursor: string | null = sha;
    while (cursor && out.length < MAX_DEPTH) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const commit = bySha.get(cursor);
      if (!commit) break;
      out.push(commit);
      cursor = commit.parent_sha;
    }
    return out;
  }


  findMergeBase(baseRepo: RepoRow, baseSha: string | null, headRepo: RepoRow, headSha: string | null): string | null {
    if (!baseSha || !headSha) return null;
    const headAncestry = this.commitAncestry(headRepo.id, headSha);
    const headShas = new Set(headAncestry.map((commit) => commit.sha));
    // Fork heads carry copies of the base commits with randomized SHAs
    // (copyForkCommits salts makeSha with a UUID), but the copy preserves
    // message/authors/tree_sha/created_at verbatim — match cross-repo
    // ancestry on that identity tuple. Returns the base-space SHA.
    const headKeys = baseRepo.id === headRepo.id ? null : new Set(headAncestry.map((commit) => commitIdentityKey(commit)));
    for (const commit of this.commitAncestry(baseRepo.id, baseSha)) {
      if (headShas.has(commit.sha)) return commit.sha;
      if (headKeys?.has(commitIdentityKey(commit))) return commit.sha;
    }
    return null;
  }

  /** File state (path → blob) as of a commit, reconstructed from file_versions. */
  fileStateAtCommit(repoId: number, sha: string | null): Map<string, { content: string; sha: string }> {
    const state = new Map<string, { content: string; sha: string }>();
    if (!sha) return state;
    const seen = new Set<string>();
    for (const commit of this.commitAncestry(repoId, sha)) {
      const versions = this.db.prepare("SELECT path, content, sha, status FROM file_versions WHERE repo_id = ? AND commit_sha = ?").all(repoId, commit.sha) as Array<{ path: string; content: string; sha: string; status: string }>;
      for (const version of versions) {
        if (seen.has(version.path)) continue;
        seen.add(version.path);
        if (version.status !== "removed") state.set(version.path, { content: version.content, sha: version.sha });
      }
    }
    return state;
  }

  /** Net base-branch changes since the merge base, skipping paths the head branch also touched (head wins). */
  mergeChangesFromBase(baseRepo: RepoRow, baseRef: string, headRepo: RepoRow, headRef: string, mergeBase: string | null): FileChange[] {
    const branchFiles = (repoId: number, branch: string) =>
      new Map((this.db.prepare("SELECT * FROM files WHERE repo_id = ? AND branch = ?").all(repoId, branch) as FileRow[]).map((file) => [file.path, file]));
    const baseNow = branchFiles(baseRepo.id, baseRef);
    const headNow = branchFiles(headRepo.id, headRef);
    const atMergeBase = this.fileStateAtCommit(baseRepo.id, mergeBase);
    const changes: FileChange[] = [];
    for (const path of new Set([...baseNow.keys(), ...atMergeBase.keys()])) {
      const current = baseNow.get(path);
      const original = atMergeBase.get(path);
      if (current?.sha === original?.sha) continue;
      if (headNow.get(path)?.sha !== original?.sha) continue;
      if (!current) changes.push({ path, content: "", delete: true });
      else changes.push({ path, content: current.content });
    }
    return changes;
  }


  commitsBetween(repoId: number, headSha: string, baseSha: string | null): CommitRow[] {
    const ancestry = this.commitAncestry(repoId, headSha);
    if (!baseSha) return ancestry;
    const stopIndex = ancestry.findIndex((commit) => commit.sha === baseSha);
    if (stopIndex === -1) return ancestry;
    return ancestry.slice(0, stopIndex);
  }


  computeCommitFiles(repo: RepoRow, commit: CommitRow): PullRequestFileRow[] {
    const versions = this.db.prepare("SELECT path, content, sha, status FROM file_versions WHERE repo_id = ? AND commit_sha = ?").all(repo.id, commit.sha) as Array<{ path: string; content: string; sha: string; status: "added" | "modified" | "removed" }>;
    return versions.map((version) => {
      const additions = version.status === "removed" ? 0 : version.content.split("\n").filter(Boolean).length || 1;
      const deletions = version.status === "added" ? 0 : version.content.split("\n").filter(Boolean).length || 0;
      return {
        repo_id: repo.id,
        pull_number: 0,
        filename: version.path,
        status: version.status,
        additions,
        deletions,
        changes: additions + deletions,
        blob_url: `https://github.com/${repo.full_name}/blob/${commit.sha}/${version.path}`,
        raw_url: `https://raw.githubusercontent.com/${repo.full_name}/${commit.sha}/${version.path}`,
        contents_url: `https://api.github.com/repos/${repo.full_name}/contents/${version.path}?ref=${commit.sha}`,
        patch: `@@ ${version.path} @@`
      };
    });
  }


  computeCompareFiles(repo: RepoRow, base: CommitRow, head: CommitRow): PullRequestFileRow[] {
    // Build path → latest version snapshot at each commit by walking ancestry
    // and folding file_versions. Used by /compare.
    const baseSnapshot = this.snapshotAtCommit(repo.id, base.sha);
    const headSnapshot = this.snapshotAtCommit(repo.id, head.sha);
    const paths = [...new Set([...baseSnapshot.keys(), ...headSnapshot.keys()])].sort();
    const rows: PullRequestFileRow[] = [];
    for (const path of paths) {
      const baseFile = baseSnapshot.get(path);
      const headFile = headSnapshot.get(path);
      if (baseFile?.sha === headFile?.sha) continue;
      const diff = linesChanged(baseFile?.content, headFile?.content ?? "");
      rows.push({
        repo_id: repo.id,
        pull_number: 0,
        filename: path,
        status: baseFile && headFile ? "modified" : headFile ? "added" : "removed",
        additions: diff.additions,
        deletions: headFile ? diff.deletions : (baseFile?.content.split("\n").length ?? 0),
        changes: diff.additions + diff.deletions,
        blob_url: `https://github.com/${repo.full_name}/blob/${head.sha}/${path}`,
        raw_url: `https://raw.githubusercontent.com/${repo.full_name}/${head.sha}/${path}`,
        contents_url: `https://api.github.com/repos/${repo.full_name}/contents/${path}?ref=${head.sha}`,
        patch: `@@ ${path} @@`
      });
    }
    return rows;
  }


  snapshotAtCommit(repoId: number, sha: string): Map<string, { content: string; sha: string }> {
    // Walk ancestry oldest → newest, folding file_versions per path. Removed rows clear the entry.
    const ancestry = this.commitAncestry(repoId, sha).reverse();
    const out = new Map<string, { content: string; sha: string }>();
    for (const commit of ancestry) {
      const versions = this.db.prepare("SELECT path, content, sha, status FROM file_versions WHERE repo_id = ? AND commit_sha = ?").all(repoId, commit.sha) as Array<{ path: string; content: string; sha: string; status: string }>;
      for (const version of versions) {
        if (version.status === "removed") out.delete(version.path);
        else out.set(version.path, { content: version.content, sha: version.sha });
      }
    }
    return out;
  }


  nextMilestoneNumber(repoId: number) {
    const row = this.db.prepare("SELECT COALESCE(MAX(number), 0) AS max FROM milestones WHERE repo_id = ?").get(repoId) as { max: number };
    return row.max + 1;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  insertRepository(input: { owner: string; name: string; description: string; private: boolean; defaultBranch: string; fork: boolean; parentFullName: string | null }) {
    const now = nowIso();
    this.db.prepare("INSERT INTO repositories (owner, name, full_name, description, private, default_branch, fork, parent_full_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      input.owner,
      input.name,
      `${input.owner}/${input.name}`,
      input.description,
      input.private ? 1 : 0,
      input.defaultBranch,
      input.fork ? 1 : 0,
      input.parentFullName,
      now,
      now
    );
    return this.requireRepo(input.owner, input.name);
  }


  copyForkCommits(source: RepoRow, fork: RepoRow) {
    const sourceCommits = this.db.prepare("SELECT * FROM commits WHERE repo_id = ?").all(source.id) as CommitRow[];
    const bySha = new Map(sourceCommits.map((commit) => [commit.sha, commit]));
    const copied = new Map<string, string>();

    const copyCommit = (commit: CommitRow): string => {
      const existing = copied.get(commit.sha);
      if (existing) return existing;

      const parent = commit.parent_sha ? bySha.get(commit.parent_sha) : undefined;
      const parentSha = parent ? copyCommit(parent) : null;
      const sha = makeSha(fork.full_name, commit.sha);
      copied.set(commit.sha, sha);
      this.db.prepare("INSERT INTO commits (sha, repo_id, message, author_login, committer_login, parent_sha, tree_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        sha,
        fork.id,
        commit.message,
        commit.author_login,
        commit.committer_login,
        parentSha,
        commit.tree_sha,
        commit.created_at
      );

      const versions = this.db.prepare("SELECT path, content, sha, status FROM file_versions WHERE repo_id = ? AND commit_sha = ?").all(source.id, commit.sha) as Array<{ path: string; content: string; sha: string; status: string }>;
      for (const version of versions) {
        this.db.prepare("INSERT INTO file_versions (commit_sha, repo_id, path, content, sha, status) VALUES (?, ?, ?, ?, ?, ?)").run(
          sha,
          fork.id,
          version.path,
          version.content,
          version.sha,
          version.status
        );
      }

      return sha;
    };

    for (const commit of sourceCommits) copyCommit(commit);
    return copied;
  }


  commitFiles(repo: RepoRow, branchName: string, message: string, files: FileChange[], actor: string): CommitRow {
    const branch = this.requireBranch(repo.id, branchName);
    const now = nowIso();
    const normalizedFiles = files.map((file) => ({ ...file, path: normalizePath(file.path) }));
    const existingPaths = (this.db.prepare("SELECT path FROM files WHERE repo_id = ? AND branch = ? ORDER BY path").all(repo.id, branchName) as Array<{ path: string }>).map((row) => row.path);
    const nextPaths = new Set(existingPaths);
    for (const file of normalizedFiles) {
      if (file.delete) nextPaths.delete(file.path);
      else nextPaths.add(file.path);
    }
    const sha = makeSha(repo.full_name, branchName, message, normalizedFiles, now);
    const commit: CommitRow = {
      sha,
      repo_id: repo.id,
      message,
      author_login: actor,
      committer_login: actor,
      parent_sha: branch.head_sha,
      tree_sha: treeSha([...nextPaths]),
      created_at: now
    };
    this.db.prepare("INSERT INTO commits (sha, repo_id, message, author_login, committer_login, parent_sha, tree_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      commit.sha,
      commit.repo_id,
      commit.message,
      commit.author_login,
      commit.committer_login,
      commit.parent_sha,
      commit.tree_sha,
      commit.created_at
    );
    for (const file of normalizedFiles) {
      const path = file.path;
      const existing = this.getFile(repo.id, branchName, path);
      if (file.delete) {
        if (!existing) validationFailed("files", "missing", path);
        this.db.prepare("INSERT INTO file_versions (commit_sha, repo_id, path, content, sha, status) VALUES (?, ?, ?, ?, ?, 'removed')").run(
          commit.sha,
          repo.id,
          path,
          existing.content,
          existing.sha
        );
        this.db.prepare("DELETE FROM files WHERE repo_id = ? AND branch = ? AND path = ?").run(repo.id, branchName, path);
        continue;
      }
      const sha = fileSha(file.content);
      this.db.prepare("INSERT INTO file_versions (commit_sha, repo_id, path, content, sha, status) VALUES (?, ?, ?, ?, ?, ?)").run(
        commit.sha,
        repo.id,
        path,
        file.content,
        sha,
        existing ? "modified" : "added"
      );
      this.db.prepare("INSERT INTO files (repo_id, branch, path, content, sha, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_id, branch, path) DO UPDATE SET content = excluded.content, sha = excluded.sha, size = excluded.size, updated_at = excluded.updated_at").run(
        repo.id,
        branchName,
        path,
        file.content,
        sha,
        Buffer.byteLength(file.content),
        now
      );
    }
    this.db.prepare("UPDATE branches SET head_sha = ?, updated_at = ? WHERE repo_id = ? AND name = ?").run(commit.sha, now, repo.id, branchName);
    this.db.prepare("UPDATE repositories SET updated_at = ? WHERE id = ?").run(now, repo.id);
    return commit;
  }


  calculatePullFiles(baseRepo: RepoRow, baseRef: string, headRepo: RepoRow, headRef: string): PullRequestFileRow[] {
    const baseFiles = new Map((this.db.prepare("SELECT * FROM files WHERE repo_id = ? AND branch = ?").all(baseRepo.id, baseRef) as FileRow[]).map((file) => [file.path, file]));
    const headFiles = new Map((this.db.prepare("SELECT * FROM files WHERE repo_id = ? AND branch = ?").all(headRepo.id, headRef) as FileRow[]).map((file) => [file.path, file]));
    const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
    const rows: PullRequestFileRow[] = [];
    for (const path of paths) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base?.sha === head?.sha) continue;
      const diff = linesChanged(base?.content, head?.content ?? "");
      rows.push({
        repo_id: baseRepo.id,
        pull_number: 0,
        filename: path,
        status: base && head ? "modified" : head ? "added" : "removed",
        additions: diff.additions,
        deletions: head ? diff.deletions : base?.content.split("\n").length ?? 0,
        changes: diff.additions + diff.deletions,
        blob_url: `https://github.com/${headRepo.full_name}/blob/${headRef}/${path}`,
        raw_url: `https://raw.githubusercontent.com/${headRepo.full_name}/${headRef}/${path}`,
        contents_url: `https://api.github.com/repos/${headRepo.full_name}/contents/${path}`,
        patch: `@@ ${path} @@`
      });
    }
    return rows;
  }


  replacePullFiles(repoId: number, pullNumber: number, files: PullRequestFileRow[]) {
    this.db.prepare("DELETE FROM pull_request_files WHERE repo_id = ? AND pull_number = ?").run(repoId, pullNumber);
    for (const file of files) {
      this.db.prepare("INSERT INTO pull_request_files (repo_id, pull_number, filename, status, additions, deletions, changes, blob_url, raw_url, contents_url, patch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        repoId,
        pullNumber,
        file.filename,
        file.status,
        file.additions,
        file.deletions,
        file.changes,
        file.blob_url,
        file.raw_url,
        file.contents_url,
        file.patch
      );
    }
  }

  // Single-PR GET (full PullRequest shape: keeps merged / commits / additions /
  // deletions / changed_files).
  serializePull(pr: PullRequestRow) {
    const baseRepo = this.requireRepoById(pr.base_repo_id);
    const headRepo = this.requireRepoById(pr.head_repo_id);
    const files = this.db.prepare("SELECT * FROM pull_request_files WHERE repo_id = ? AND pull_number = ?").all(pr.repo_id, pr.number) as PullRequestFileRow[];
    const headSha = this.getBranch(headRepo.id, pr.head_ref)?.head_sha ?? pr.head_sha;
    const baseSha = this.getBranch(baseRepo.id, pr.base_ref)?.head_sha ?? pr.base_sha;
    return pullRequestJson(pr, baseRepo, headRepo, 1, files.length, headSha, baseSha);
  }

  // LIST endpoint (leaner PullRequestSimple shape: drops the single-PR-only
  // diff-stat fields, matching real GitHub).
  serializePullSimple(pr: PullRequestRow) {
    const baseRepo = this.requireRepoById(pr.base_repo_id);
    const headRepo = this.requireRepoById(pr.head_repo_id);
    const headSha = this.getBranch(headRepo.id, pr.head_ref)?.head_sha ?? pr.head_sha;
    const baseSha = this.getBranch(baseRepo.id, pr.base_ref)?.head_sha ?? pr.base_sha;
    return pullRequestListJson(pr, baseRepo, headRepo, headSha, baseSha);
  }


  resolveHeadRef(baseRepo: RepoRow, head: string) {
    const [owner, ref] = head.includes(":") ? head.split(":", 2) : [baseRepo.owner, head];
    const repo = this.requireRepo(owner!, baseRepo.name);
    return { repo, ref: ref! };
  }


  listDirectory(repo: RepoRow, branch: string, path: string) {
    const prefix = path ? `${path}/` : "";
    const rows = this.db.prepare("SELECT * FROM files WHERE repo_id = ? AND branch = ? AND path LIKE ? ORDER BY path ASC").all(repo.id, branch, `${prefix}%`) as FileRow[];
    const seen = new Set<string>();
    const entries: unknown[] = [];
    for (const file of rows) {
      const rest = file.path.slice(prefix.length);
      const first = rest.split("/")[0]!;
      const childPath = prefix ? `${prefix}${first}` : first;
      if (seen.has(childPath)) continue;
      seen.add(childPath);
      entries.push(contentDirectoryEntryJson(childPath, repo, branch, rest.includes("/") ? undefined : file));
    }
    return entries;
  }


  createBranchInternal(repo: RepoRow, name: string, headSha: string | null) {
    const now = nowIso();
    this.db.prepare("INSERT INTO branches (repo_id, name, head_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(repo.id, name, headSha, now, now);
    return this.requireBranch(repo.id, name);
  }


  upsertUser(login: string, type: "User" | "Organization", name: string) {
    this.db.prepare("INSERT INTO users (login, type, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(login) DO UPDATE SET type = excluded.type, name = excluded.name").run(login, type, name, nowIso());
  }


  addCollaborator(repoId: number, login: string) {
    this.upsertUser(login, "User", login);
    this.db.prepare("INSERT OR IGNORE INTO collaborators (repo_id, login, permission) VALUES (?, ?, 'push')").run(repoId, login);
  }


  createLabel(repo: RepoRow, name: string, color: string, description: string) {
    this.db.prepare("INSERT OR IGNORE INTO labels (repo_id, name, color, description) VALUES (?, ?, ?, ?)").run(repo.id, name, color, description);
    return labelJson(this.getLabel(repo.id, name)!);
  }


  getRepo(owner: string, repo: string) {
    return this.db.prepare("SELECT * FROM repositories WHERE owner = ? AND name = ?").get(owner, repo) as RepoRow | undefined;
  }


  requireRepo(owner: string, repo: string) {
    return this.getRepo(owner, repo) ?? notFound("Not Found");
  }


  requireRepoById(repoId: number) {
    return (this.db.prepare("SELECT * FROM repositories WHERE id = ?").get(repoId) as RepoRow | undefined) ?? notFound("Not Found");
  }


  getBranch(repoId: number, name: string) {
    return this.db.prepare("SELECT * FROM branches WHERE repo_id = ? AND name = ?").get(repoId, name) as BranchRow | undefined;
  }


  requireBranch(repoId: number, name: string) {
    return this.getBranch(repoId, name) ?? notFound("Branch not found");
  }


  listBranches(repoId: number) {
    return this.db.prepare("SELECT * FROM branches WHERE repo_id = ? ORDER BY name ASC").all(repoId) as BranchRow[];
  }


  getFile(repoId: number, branch: string, path: string) {
    return this.db.prepare("SELECT * FROM files WHERE repo_id = ? AND branch = ? AND path = ?").get(repoId, branch, path) as FileRow | undefined;
  }


  getLabel(repoId: number, name: string) {
    return this.db.prepare("SELECT * FROM labels WHERE repo_id = ? AND name = ?").get(repoId, name) as LabelRow | undefined;
  }


  listLabels(repoId: number) {
    return this.db.prepare("SELECT * FROM labels WHERE repo_id = ? ORDER BY name ASC").all(repoId) as LabelRow[];
  }


  listIssuesRows(repoId: number) {
    return this.db.prepare("SELECT * FROM issues WHERE repo_id = ? ORDER BY number ASC").all(repoId) as IssueRow[];
  }


  requireIssue(repoId: number, number: number) {
    return (this.db.prepare("SELECT * FROM issues WHERE repo_id = ? AND number = ?").get(repoId, number) as IssueRow | undefined) ?? notFound("Issue not found");
  }


  listIssueLabels(repoId: number, issueNumber: number) {
    return this.db
      .prepare("SELECT labels.* FROM labels INNER JOIN issue_labels ON labels.repo_id = issue_labels.repo_id AND labels.name = issue_labels.label_name WHERE issue_labels.repo_id = ? AND issue_labels.issue_number = ? ORDER BY labels.name ASC")
      .all(repoId, issueNumber) as LabelRow[];
  }


  listIssueAssignees(repoId: number, issueNumber: number) {
    const rows = this.db.prepare("SELECT login FROM issue_assignees WHERE repo_id = ? AND issue_number = ? ORDER BY login ASC").all(repoId, issueNumber) as Array<{ login: string }>;
    return rows.map((row) => row.login);
  }


  issueCommentCount(repoId: number, issueNumber: number) {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM issue_comments WHERE repo_id = ? AND issue_number = ?").get(repoId, issueNumber) as { count: number };
    return row.count;
  }


  listIssueCommentRows(repoId: number, issueNumber: number) {
    return this.db.prepare("SELECT * FROM issue_comments WHERE repo_id = ? AND issue_number = ? ORDER BY id ASC").all(repoId, issueNumber) as IssueCommentRow[];
  }


  hasCollaborator(repoId: number, login: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM collaborators WHERE repo_id = ? AND login = ?").get(repoId, login));
  }


  listPullRequestRows(repoId: number) {
    return this.db.prepare("SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY number ASC").all(repoId) as PullRequestRow[];
  }


  listPullRequestFileRows(repoId: number, pullNumber: number) {
    return this.db.prepare("SELECT * FROM pull_request_files WHERE repo_id = ? AND pull_number = ? ORDER BY filename ASC").all(repoId, pullNumber) as PullRequestFileRow[];
  }


  listPullRequestReviewRows(repoId: number, pullNumber: number) {
    return this.db.prepare("SELECT * FROM pull_request_reviews WHERE repo_id = ? AND pull_number = ? ORDER BY submitted_at ASC").all(repoId, pullNumber) as PullRequestReviewRow[];
  }


  listPullRequestReviewCommentRows(repoId: number, pullNumber: number) {
    return this.db.prepare("SELECT * FROM pull_request_review_comments WHERE repo_id = ? AND pull_number = ? ORDER BY id ASC").all(repoId, pullNumber) as Array<{
      id: number;
      path: string;
      body: string;
      user_login: string;
      created_at: string;
      updated_at: string;
    }>;
  }


  requirePullRequest(repoId: number, number: number) {
    return (this.db.prepare("SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?").get(repoId, number) as PullRequestRow | undefined) ?? notFound("Pull request not found");
  }


  nextNumber(repoId: number) {
    this.db.prepare("UPDATE repositories SET entity_counter = entity_counter + 1 WHERE id = ?").run(repoId);
    const row = this.db.prepare("SELECT entity_counter AS next FROM repositories WHERE id = ?").get(repoId) as { next: number };
    return row.next;
  }


  bumpEntityCounter(repoId: number, number: number) {
    this.db.prepare("UPDATE repositories SET entity_counter = CASE WHEN entity_counter < ? THEN ? ELSE entity_counter END WHERE id = ?").run(number, number, repoId);
  }


  audit(action: string, repoFullName: string | null, payload: unknown) {
    this.db.prepare("INSERT INTO audit_log (ts, action, repo_full_name, payload_json) VALUES (?, ?, ?, ?)").run(nowIso(), action, repoFullName, JSON.stringify(payload));
  }

}
