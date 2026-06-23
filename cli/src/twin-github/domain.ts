// SPDX-License-Identifier: Apache-2.0
import type { StateDelta } from "../types/shared.js";
import type {
  BranchRow,
  CheckRunRow,
  CommitRow,
  CommitStatusRow,
  FileRow,
  GitHubCloneDatabase,
  GitHubStateSeed,
  IssueCommentRow,
  IssueRow,
  LabelRow,
  PullRequestFileRow,
  PullRequestReviewRow,
  PullRequestRow,
  RepoRow
} from "./types.js";
import { conflict, notFound, validationFailed } from "./errors.js";
import { fileSha, linesChanged, makeSha, nowIso, paginate, treeSha } from "./util.js";
import { defaultSeedState } from "./seed.js";
import {
  branchJson,
  branchState,
  checkRunJson,
  checkRunState,
  combinedStatusJson,
  commitJson,
  commitStatusState,
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
  pullRequestFileJson,
  pullRequestJson,
  pullRequestReviewState,
  pullRequestState,
  repoJson,
  repoState,
  reviewJson,
  statusJson,
  userJson
} from "./serializers.js";
import { resetDatabase } from "./db.js";

type PageOptions = { page?: number; per_page?: number; perPage?: number };
type MutatingOptions = { actor?: string };
type FileChange = { path: string; content: string; delete?: boolean };

// Mutation handlers receive an optional callback that yields the state_delta
// captured around the underlying SQLite write. The default (no callback) is the
// pre-FDRS-320 shape — domain tests and tools.ts ignore the delta channel.
export type StateDeltaCallback = (delta: StateDelta) => void;

export class GitHubDomain {
  constructor(readonly db: GitHubCloneDatabase) {}

  seed(seed: GitHubStateSeed = defaultSeedState(), onDelta?: StateDeltaCallback) {
    const before = this.summarizeRepositories();
    const tx = this.db.transaction(() => {
      resetDatabase(this.db);
      const users = new Set(seed.users?.map((user) => user.login) ?? []);
      for (const repo of seed.repositories) {
        users.add(repo.owner);
        for (const login of repo.collaborators ?? []) users.add(login);
        for (const issue of repo.issues ?? []) for (const login of issue.assignees ?? []) users.add(login);
      }
      users.add("pome-agent");
      for (const user of seed.users ?? []) {
        this.upsertUser(user.login, user.type ?? "User", user.name ?? "");
      }
      for (const login of users) {
        this.upsertUser(login, login === "acme" ? "Organization" : "User", login);
      }
      for (const repoSeed of seed.repositories) {
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
          // Seed reviews directly into pull_request_reviews so we can record
          // the author and state honestly. Going through createPullRequestReview
          // would hardcode user_login = "pome-agent" and lose author identity.
          for (const review of pull.reviews ?? []) {
            users.add(review.author);
            this.upsertUser(review.author, "User", review.author);
            const prRow = this.requirePullRequest(repo.id, prNumber);
            const headRepo = this.requireRepoById(prRow.head_repo_id);
            const headSha = this.requireBranch(headRepo.id, prRow.head_ref).head_sha;
            this.db.prepare("INSERT INTO pull_request_reviews (repo_id, pull_number, user_login, state, body, commit_sha, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
              repo.id,
              prNumber,
              review.author,
              review.state,
              review.body ?? "",
              headSha,
              nowIso()
            );
          }
          // Seed commit statuses on the PR head SHA. Same shape as
          // createStatus() so merge_pull_request's required-status check
          // sees the seeded value.
          if ((pull.statuses ?? []).length > 0) {
            const prRow = this.requirePullRequest(repo.id, prNumber);
            const headRepo = this.requireRepoById(prRow.head_repo_id);
            const headSha = this.requireBranch(headRepo.id, prRow.head_ref).head_sha ?? "";
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
      this.audit("seed", null, { repositories: seed.repositories.length });
    });
    tx();
    onDelta?.({
      before: { repositories: before },
      after: { repositories: this.summarizeRepositories() }
    });
  }

  private summarizeRepositories(): Array<{ owner: string; name: string }> {
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
    return repoJson(this.requireRepo(input.owner, input.repo));
  }

  createRepository(input: { name: string; owner?: string; description?: string; private?: boolean }, onDelta?: StateDeltaCallback) {
    const owner = input.owner ?? "pome-agent";
    const repo = this.transaction(() => {
      this.upsertUser(owner, "Organization", owner);
      if (this.getRepo(owner, input.name)) validationFailed("name", "already_exists", input.name);
      const created = this.insertRepository({
        owner,
        name: input.name,
        description: input.description ?? "",
        private: input.private ?? false,
        defaultBranch: "main",
        fork: false,
        parentFullName: null
      });
      this.addCollaborator(created.id, "pome-agent");
      this.createBranchInternal(created, "main", null);
      this.commitFiles(created, "main", "Initial commit", [{ path: "README.md", content: `# ${input.name}\n` }], "pome-agent");
      return created;
    });
    this.audit("create_repository", repo.full_name, input);
    const final = this.requireRepo(owner, input.name);
    onDelta?.({ before: null, after: repoState(final) });
    return repoJson(final);
  }

  forkRepository(input: { owner: string; repo: string; organization?: string }, onDelta?: StateDeltaCallback) {
    const source = this.requireRepo(input.owner, input.repo);
    const owner = input.organization ?? "pome-agent";
    const fork = this.transaction(() => {
      this.upsertUser(owner, owner === input.organization ? "Organization" : "User", owner);
      if (this.getRepo(owner, source.name)) validationFailed("name", "already_exists", source.name);
      const created = this.insertRepository({
        owner,
        name: source.name,
        description: source.description,
        private: Boolean(source.private),
        defaultBranch: source.default_branch,
        fork: true,
        parentFullName: source.full_name
      });
      this.addCollaborator(created.id, "pome-agent");
      const commitShaMap = this.copyForkCommits(source, created);
      for (const branch of this.listBranches(source.id)) {
        this.createBranchInternal(created, branch.name, branch.head_sha ? commitShaMap.get(branch.head_sha) ?? null : null);
        const files = this.db.prepare("SELECT * FROM files WHERE repo_id = ? AND branch = ?").all(source.id, branch.name) as FileRow[];
        for (const file of files) {
          this.db.prepare("INSERT INTO files (repo_id, branch, path, content, sha, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            created.id,
            file.branch,
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
    this.audit("fork_repository", fork.full_name, input);
    onDelta?.({ before: null, after: repoState(fork) });
    return repoJson(fork);
  }

  searchRepositories(input: { query?: string; q?: string } & PageOptions) {
    const query = (input.query ?? input.q ?? "").toLowerCase();
    const repos = (this.db.prepare("SELECT * FROM repositories ORDER BY full_name ASC").all() as RepoRow[]).filter(
      (repo) => !query || repo.full_name.toLowerCase().includes(query) || repo.description.toLowerCase().includes(query)
    );
    const items = paginate(repos, input.page, input.per_page ?? input.perPage).map(repoJson);
    return { total_count: repos.length, incomplete_results: false, items };
  }

  searchUsers(input: { query?: string; q?: string } & PageOptions) {
    const query = (input.query ?? input.q ?? "").toLowerCase();
    const rows = this.db.prepare("SELECT login, type FROM users ORDER BY login ASC").all() as Array<{ login: string; type: "User" | "Organization" }>;
    const users = rows.filter((user) => !query || user.login.toLowerCase().includes(query));
    return { total_count: users.length, incomplete_results: false, items: paginate(users, input.page, input.per_page ?? input.perPage).map((user) => userJson(user.login, user.type)) };
  }

  searchCode(input: { query?: string; q?: string; owner?: string; repo?: string } & PageOptions) {
    const query = (input.query ?? input.q ?? "").toLowerCase();
    let rows = this.db
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

  getFileContents(input: { owner: string; repo: string; path?: string; ref?: string }) {
    const repo = this.requireRepo(input.owner, input.repo);
    const branch = input.ref ?? repo.default_branch;
    this.requireBranch(repo.id, branch);
    const path = normalizePath(input.path ?? "");
    const direct = this.getFile(repo.id, branch, path);
    if (direct) return contentFileJson(direct, repo);
    const children = this.listDirectory(repo, branch, path);
    if (children.length === 0) notFound("Not Found");
    return children;
  }

  listCommits(input: { owner: string; repo: string; sha?: string } & PageOptions) {
    const repo = this.requireRepo(input.owner, input.repo);
    const branch = input.sha ?? repo.default_branch;
    const branchRow = this.requireBranch(repo.id, branch);
    const allRows = this.db.prepare("SELECT * FROM commits WHERE repo_id = ?").all(repo.id) as CommitRow[];
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

  createOrUpdateFile(input: { owner: string; repo: string; path: string; message: string; content: string; branch?: string; sha?: string; encoding?: string }, options: MutatingOptions = {}, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    const branch = input.branch ?? repo.default_branch;
    let before: Record<string, unknown> | null = null;
    let afterFile: FileRow | null = null;
    const result = this.transaction(() => {
      this.requireBranch(repo.id, branch);
      const path = normalizePath(input.path);
      const existing = this.getFile(repo.id, branch, path);
      before = existing ? fileState(existing, repo) : null;
      if (existing && !input.sha) validationFailed("sha", "missing", path);
      if (existing && input.sha !== existing.sha) validationFailed("sha", "invalid", input.sha);
      const content = input.encoding === "base64" ? Buffer.from(input.content, "base64").toString("utf8") : input.content;
      const commit = this.commitFiles(repo, branch, input.message, [{ path, content }], options.actor ?? "pome-agent");
      const file = this.getFile(repo.id, branch, path)!;
      afterFile = file;
      return { content: contentFileJson(file, repo), commit: commitJson(commit, repo) };
    });
    this.audit("create_or_update_file", repo.full_name, { ...input, content: "[redacted]" });
    onDelta?.({ before, after: afterFile ? fileState(afterFile, repo) : null });
    return result;
  }

  pushFiles(input: { owner: string; repo: string; branch?: string; message: string; files: Array<{ path: string; content: string; encoding?: string }> }, options: MutatingOptions = {}, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    const branch = input.branch ?? repo.default_branch;
    this.requireBranch(repo.id, branch);
    if (input.files.length === 0) validationFailed("files", "missing");
    const paths = new Set<string>();
    const files = input.files.map((file) => {
      const path = normalizePath(file.path);
      if (paths.has(path)) validationFailed("files.path", "duplicate", path);
      paths.add(path);
      return { path, content: file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content };
    });
    const beforeFiles = files.map((file) => {
      const existing = this.getFile(repo.id, branch, file.path);
      return { path: file.path, sha: existing?.sha ?? null };
    });
    const commit = this.transaction(() => this.commitFiles(repo, branch, input.message, files, options.actor ?? "pome-agent"));
    this.audit("push_files", repo.full_name, { ...input, files: files.map((file) => file.path) });
    const afterFiles = files.map((file) => {
      const updated = this.getFile(repo.id, branch, file.path)!;
      return { path: file.path, sha: updated.sha };
    });
    onDelta?.({
      before: { repo: repo.full_name, branch, files: beforeFiles },
      after: { repo: repo.full_name, branch, files: afterFiles, commit_sha: commit.sha }
    });
    return { commit: commitJson(commit, repo), files: files.map((file) => contentFileJson(this.getFile(repo.id, branch, file.path)!, repo)) };
  }

  createBranch(input: { owner: string; repo: string; branch: string; from_branch?: string; sha?: string }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    const branch = this.transaction(() => {
      if (this.getBranch(repo.id, input.branch)) validationFailed("branch", "already_exists", input.branch);
      const source = input.sha
        ? { head_sha: input.sha }
        : this.requireBranch(repo.id, input.from_branch ?? repo.default_branch);
      const created = this.createBranchInternal(repo, input.branch, source.head_sha);
      if (!input.sha) {
        const sourceBranch = input.from_branch ?? repo.default_branch;
        const files = this.db.prepare("SELECT * FROM files WHERE repo_id = ? AND branch = ?").all(repo.id, sourceBranch) as FileRow[];
        for (const file of files) {
          this.db.prepare("INSERT INTO files (repo_id, branch, path, content, sha, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
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
    this.audit("create_branch", repo.full_name, input);
    onDelta?.({ before: null, after: branchState(branch, repo) });
    return branchJson(branch, repo);
  }

  createIssue(input: { owner: string; repo: string; title: string; body?: string; labels?: string[]; assignees?: string[] }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    const issue = this.transaction(() => {
      if (!input.title.trim()) validationFailed("title", "missing");
      for (const label of input.labels ?? []) if (!this.getLabel(repo.id, label)) validationFailed("labels", "missing", label);
      for (const assignee of input.assignees ?? []) if (!this.hasCollaborator(repo.id, assignee)) validationFailed("assignees", "invalid", assignee);
      const now = nowIso();
      const number = this.nextNumber(repo.id);
      this.db.prepare("INSERT INTO issues (repo_id, number, title, body, state, user_login, assignee_login, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)").run(
        repo.id,
        number,
        input.title,
        input.body ?? "",
        "pome-agent",
        input.assignees?.[0] ?? null,
        now,
        now
      );
      for (const label of input.labels ?? []) this.db.prepare("INSERT OR IGNORE INTO issue_labels (repo_id, issue_number, label_name) VALUES (?, ?, ?)").run(repo.id, number, label);
      for (const assignee of input.assignees ?? []) this.db.prepare("INSERT OR IGNORE INTO issue_assignees (repo_id, issue_number, login) VALUES (?, ?, ?)").run(repo.id, number, assignee);
      return this.requireIssue(repo.id, number);
    });
    this.audit("create_issue", repo.full_name, input);
    const labels = this.listIssueLabels(repo.id, issue.number).map((label) => label.name);
    const assignees = this.listIssueAssignees(repo.id, issue.number);
    onDelta?.({ before: null, after: issueState(issue, repo, labels, assignees) });
    return issueJson(issue, repo, this.listIssueLabels(repo.id, issue.number), this.listIssueAssignees(repo.id, issue.number), this.issueCommentCount(repo.id, issue.number));
  }

  listIssues(input: { owner: string; repo: string; state?: "open" | "closed" | "all"; labels?: string; assignee?: string } & PageOptions) {
    const repo = this.requireRepo(input.owner, input.repo);
    let rows = this.listIssuesRows(repo.id);
    if (input.state && input.state !== "all") rows = rows.filter((issue) => issue.state === input.state);
    if (input.labels) {
      const wanted = input.labels.split(",").map((label) => label.trim()).filter(Boolean);
      rows = rows.filter((issue) => {
        const names = this.listIssueLabels(repo.id, issue.number).map((label) => label.name);
        return wanted.every((label) => names.includes(label));
      });
    }
    if (input.assignee) rows = rows.filter((issue) => this.listIssueAssignees(repo.id, issue.number).includes(input.assignee!));
    return paginate(rows, input.page, input.per_page ?? input.perPage).map((issue) => issueJson(issue, repo, this.listIssueLabels(repo.id, issue.number), this.listIssueAssignees(repo.id, issue.number), this.issueCommentCount(repo.id, issue.number)));
  }

  searchIssues(input: { query?: string; q?: string; owner?: string; repo?: string; state?: "open" | "closed" | "all" } & PageOptions) {
    const query = (input.query ?? input.q ?? "").toLowerCase();
    const rows = this.db
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
        const repo = this.requireRepoById(issue.repo_id);
        return issueJson(issue, repo, this.listIssueLabels(issue.repo_id, issue.number), this.listIssueAssignees(issue.repo_id, issue.number), this.issueCommentCount(issue.repo_id, issue.number));
      })
    };
  }

  getIssue(input: { owner: string; repo: string; issue_number: number }) {
    const repo = this.requireRepo(input.owner, input.repo);
    const issue = this.requireIssue(repo.id, input.issue_number);
    return issueJson(issue, repo, this.listIssueLabels(repo.id, issue.number), this.listIssueAssignees(repo.id, issue.number), this.issueCommentCount(repo.id, issue.number));
  }

  updateIssue(input: { owner: string; repo: string; issue_number: number; title?: string; body?: string; state?: "open" | "closed"; labels?: string[]; assignees?: string[] }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    let before: Record<string, unknown> | null = null;
    this.transaction(() => {
      const issue = this.requireIssue(repo.id, input.issue_number);
      before = issueState(
        issue,
        repo,
        this.listIssueLabels(repo.id, issue.number).map((label) => label.name),
        this.listIssueAssignees(repo.id, issue.number)
      );
      for (const label of input.labels ?? []) if (!this.getLabel(repo.id, label)) validationFailed("labels", "missing", label);
      for (const assignee of input.assignees ?? []) if (!this.hasCollaborator(repo.id, assignee)) validationFailed("assignees", "invalid", assignee);
      const state = input.state ?? issue.state;
      const closedAt = state === "closed" && issue.state !== "closed" ? nowIso() : state === "open" ? null : issue.closed_at;
      this.db.prepare("UPDATE issues SET title = ?, body = ?, state = ?, assignee_login = ?, updated_at = ?, closed_at = ? WHERE repo_id = ? AND number = ?").run(
        input.title ?? issue.title,
        input.body ?? issue.body,
        state,
        input.assignees?.[0] ?? issue.assignee_login,
        nowIso(),
        closedAt,
        repo.id,
        issue.number
      );
      if (input.labels) {
        this.db.prepare("DELETE FROM issue_labels WHERE repo_id = ? AND issue_number = ?").run(repo.id, issue.number);
        for (const label of input.labels) this.db.prepare("INSERT INTO issue_labels (repo_id, issue_number, label_name) VALUES (?, ?, ?)").run(repo.id, issue.number, label);
      }
      if (input.assignees) {
        this.db.prepare("DELETE FROM issue_assignees WHERE repo_id = ? AND issue_number = ?").run(repo.id, issue.number);
        for (const assignee of input.assignees) this.db.prepare("INSERT INTO issue_assignees (repo_id, issue_number, login) VALUES (?, ?, ?)").run(repo.id, issue.number, assignee);
      }
    });
    this.audit("update_issue", repo.full_name, input);
    const updated = this.requireIssue(repo.id, input.issue_number);
    const afterLabels = this.listIssueLabels(repo.id, updated.number).map((label) => label.name);
    const afterAssignees = this.listIssueAssignees(repo.id, updated.number);
    onDelta?.({ before, after: issueState(updated, repo, afterLabels, afterAssignees) });
    return this.getIssue(input);
  }

  addIssueComment(input: { owner: string; repo: string; issue_number: number; body: string }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    const comment = this.transaction(() => {
      this.requireIssue(repo.id, input.issue_number);
      if (!input.body.trim()) validationFailed("body", "missing");
      const now = nowIso();
      const result = this.db.prepare("INSERT INTO issue_comments (repo_id, issue_number, body, user_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        repo.id,
        input.issue_number,
        input.body,
        "pome-agent",
        now,
        now
      );
      return this.db.prepare("SELECT * FROM issue_comments WHERE id = ?").get(result.lastInsertRowid) as IssueCommentRow;
    });
    this.audit("add_issue_comment", repo.full_name, input);
    onDelta?.({ before: null, after: issueCommentState(comment, repo) });
    return issueCommentJson(comment, repo);
  }

  listIssueComments(input: { owner: string; repo: string; issue_number: number } & PageOptions) {
    const repo = this.requireRepo(input.owner, input.repo);
    this.requireIssue(repo.id, input.issue_number);
    const rows = this.listIssueCommentRows(repo.id, input.issue_number);
    return paginate(rows, input.page, input.per_page ?? input.perPage).map((comment) => issueCommentJson(comment, repo));
  }

  listRepositoryLabels(input: { owner: string; repo: string }) {
    const repo = this.requireRepo(input.owner, input.repo);
    return this.listLabels(repo.id).map(labelJson);
  }

  createRepositoryLabel(input: { owner: string; repo: string; name: string; color?: string; description?: string }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    this.transaction(() => {
      if (this.getLabel(repo.id, input.name)) validationFailed("name", "already_exists", input.name);
      this.createLabel(repo, input.name, input.color ?? "ededed", input.description ?? "");
    });
    this.audit("create_label", repo.full_name, input);
    const created = this.getLabel(repo.id, input.name)!;
    onDelta?.({ before: null, after: labelState(created, repo) });
    return labelJson(created);
  }

  listIssueLabelsForIssue(input: { owner: string; repo: string; issue_number: number }) {
    const repo = this.requireRepo(input.owner, input.repo);
    this.requireIssue(repo.id, input.issue_number);
    return this.listIssueLabels(repo.id, input.issue_number).map(labelJson);
  }

  addIssueLabels(input: { owner: string; repo: string; issue_number: number; labels: string[] }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    let before: Record<string, unknown> | null = null;
    this.transaction(() => {
      this.requireIssue(repo.id, input.issue_number);
      before = issueLabelsState(repo, input.issue_number, this.listIssueLabels(repo.id, input.issue_number).map((label) => label.name));
      for (const label of input.labels) if (!this.getLabel(repo.id, label)) validationFailed("labels", "missing", label);
      for (const label of input.labels) this.db.prepare("INSERT OR IGNORE INTO issue_labels (repo_id, issue_number, label_name) VALUES (?, ?, ?)").run(repo.id, input.issue_number, label);
    });
    this.audit("add_issue_labels", repo.full_name, input);
    const after = issueLabelsState(repo, input.issue_number, this.listIssueLabels(repo.id, input.issue_number).map((label) => label.name));
    onDelta?.({ before, after });
    return this.listIssueLabelsForIssue(input);
  }

  deleteIssueLabel(input: { owner: string; repo: string; issue_number: number; label: string }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    this.requireIssue(repo.id, input.issue_number);
    const before = issueLabelsState(repo, input.issue_number, this.listIssueLabels(repo.id, input.issue_number).map((label) => label.name));
    const result = this.db.prepare("DELETE FROM issue_labels WHERE repo_id = ? AND issue_number = ? AND label_name = ?").run(repo.id, input.issue_number, input.label);
    if (!result.changes) notFound("Label not found");
    this.audit("delete_issue_label", repo.full_name, input);
    const after = issueLabelsState(repo, input.issue_number, this.listIssueLabels(repo.id, input.issue_number).map((label) => label.name));
    onDelta?.({ before, after });
    return this.listIssueLabelsForIssue(input);
  }

  listCollaborators(input: { owner: string; repo: string }) {
    const repo = this.requireRepo(input.owner, input.repo);
    const rows = this.db.prepare("SELECT login FROM collaborators WHERE repo_id = ? ORDER BY login ASC").all(repo.id) as Array<{ login: string }>;
    return rows.map((row) => userJson(row.login));
  }

  isCollaborator(input: { owner: string; repo: string; username: string }) {
    const repo = this.requireRepo(input.owner, input.repo);
    return this.hasCollaborator(repo.id, input.username);
  }

  addAssignees(input: { owner: string; repo: string; issue_number: number; assignees: string[] }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    let before: Record<string, unknown> | null = null;
    this.transaction(() => {
      const issue = this.requireIssue(repo.id, input.issue_number);
      before = issueAssigneesState(repo, issue.number, this.listIssueAssignees(repo.id, issue.number));
      for (const assignee of input.assignees) if (!this.hasCollaborator(repo.id, assignee)) validationFailed("assignees", "invalid", assignee);
      for (const assignee of input.assignees) this.db.prepare("INSERT OR IGNORE INTO issue_assignees (repo_id, issue_number, login) VALUES (?, ?, ?)").run(repo.id, issue.number, assignee);
      const firstAssignee = input.assignees[0] ?? issue.assignee_login;
      this.db.prepare("UPDATE issues SET assignee_login = ?, updated_at = ? WHERE repo_id = ? AND number = ?").run(firstAssignee, nowIso(), repo.id, issue.number);
    });
    this.audit("add_assignees", repo.full_name, input);
    const after = issueAssigneesState(repo, input.issue_number, this.listIssueAssignees(repo.id, input.issue_number));
    onDelta?.({ before, after });
    return this.getIssue(input);
  }

  createPullRequest(input: { owner: string; repo: string; title: string; body?: string; head: string; base?: string; actor?: string }, onDelta?: StateDeltaCallback) {
    const baseRepo = this.requireRepo(input.owner, input.repo);
    const baseRef = input.base ?? baseRepo.default_branch;
    const number = this.transaction(() => {
      if (input.head === baseRef || input.head === `${input.owner}:${baseRef}`) validationFailed("head", "invalid", input.head);
      const { repo: headRepo, ref: headRef } = this.resolveHeadRef(baseRepo, input.head);
      const baseBranch = this.requireBranch(baseRepo.id, baseRef);
      const headBranch = this.requireBranch(headRepo.id, headRef);
      const duplicate = this.db.prepare("SELECT * FROM pull_requests WHERE repo_id = ? AND state = 'open' AND head_repo_id = ? AND head_ref = ? AND base_ref = ?").get(
        baseRepo.id,
        headRepo.id,
        headRef,
        baseRef
      );
      if (duplicate) validationFailed("head", "already_exists", input.head);
      const files = this.calculatePullFiles(baseRepo, baseRef, headRepo, headRef);
      if (files.length === 0) validationFailed("head", "missing_commits", input.head);
      const now = nowIso();
      const pullNumber = this.nextNumber(baseRepo.id);
      this.db.prepare("INSERT INTO pull_requests (repo_id, number, title, body, state, user_login, head_repo_id, head_ref, head_sha, base_repo_id, base_ref, base_sha, merged, merge_commit_sha, created_at, updated_at, closed_at, merged_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL, NULL)").run(
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
      this.replacePullFiles(baseRepo.id, pullNumber, files);
      return pullNumber;
    });
    this.audit("create_pull_request", baseRepo.full_name, input);
    const createdRow = this.requirePullRequest(baseRepo.id, number);
    onDelta?.({ before: null, after: pullRequestState(createdRow, baseRepo) });
    return this.getPullRequest({ owner: input.owner, repo: input.repo, pull_number: number });
  }

  listPullRequests(input: { owner: string; repo: string; state?: "open" | "closed" | "all" } & PageOptions) {
    const repo = this.requireRepo(input.owner, input.repo);
    let rows = this.listPullRequestRows(repo.id);
    if (input.state && input.state !== "all") rows = rows.filter((pr) => pr.state === input.state);
    return paginate(rows, input.page, input.per_page ?? input.perPage).map((pr) => this.serializePull(pr));
  }

  getPullRequest(input: { owner: string; repo: string; pull_number: number }) {
    const repo = this.requireRepo(input.owner, input.repo);
    const pr = this.requirePullRequest(repo.id, input.pull_number);
    return this.serializePull(pr);
  }

  getPullRequestFiles(input: { owner: string; repo: string; pull_number: number } & PageOptions) {
    const repo = this.requireRepo(input.owner, input.repo);
    this.requirePullRequest(repo.id, input.pull_number);
    const rows = this.listPullRequestFileRows(repo.id, input.pull_number);
    return paginate(rows, input.page, input.per_page ?? input.perPage).map(pullRequestFileJson);
  }

  getPullRequestReviews(input: { owner: string; repo: string; pull_number: number } & PageOptions) {
    const repo = this.requireRepo(input.owner, input.repo);
    this.requirePullRequest(repo.id, input.pull_number);
    const rows = this.listPullRequestReviewRows(repo.id, input.pull_number);
    return paginate(rows, input.page, input.per_page ?? input.perPage).map((review) => reviewJson(review, repo));
  }

  createPullRequestReview(input: { owner: string; repo: string; pull_number: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    const review = this.transaction(() => {
      const pr = this.requirePullRequest(repo.id, input.pull_number);
      if (pr.state !== "open") conflict("Pull request is closed");
      const state = input.event === "APPROVE" ? "APPROVED" : input.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
      const headSha = this.requireBranch(pr.head_repo_id, pr.head_ref).head_sha;
      const result = this.db.prepare("INSERT INTO pull_request_reviews (repo_id, pull_number, user_login, state, body, commit_sha, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        repo.id,
        pr.number,
        "pome-agent",
        state,
        input.body ?? "",
        headSha,
        nowIso()
      );
      return this.db.prepare("SELECT * FROM pull_request_reviews WHERE id = ?").get(result.lastInsertRowid) as PullRequestReviewRow;
    });
    this.audit("create_pull_request_review", repo.full_name, input);
    onDelta?.({ before: null, after: pullRequestReviewState(review, repo) });
    return reviewJson(review, repo);
  }

  getPullRequestComments(input: { owner: string; repo: string; pull_number: number } & PageOptions) {
    const repo = this.requireRepo(input.owner, input.repo);
    this.requirePullRequest(repo.id, input.pull_number);
    const rows = this.listPullRequestReviewCommentRows(repo.id, input.pull_number);
    return paginate(rows, input.page, input.per_page ?? input.perPage).map((comment) => ({
      id: comment.id,
      path: comment.path,
      body: comment.body,
      user: userJson(comment.user_login),
      created_at: comment.created_at,
      updated_at: comment.updated_at
    }));
  }

  getPullRequestStatus(input: { owner: string; repo: string; pull_number: number }) {
    const repo = this.requireRepo(input.owner, input.repo);
    const pr = this.requirePullRequest(repo.id, input.pull_number);
    const head = this.requireBranch(pr.head_repo_id, pr.head_ref);
    const statuses = head.head_sha
      ? (this.db.prepare("SELECT * FROM commit_statuses WHERE repo_id = ? AND sha = ? ORDER BY updated_at DESC").all(pr.head_repo_id, head.head_sha) as CommitStatusRow[])
      : [];
    return combinedStatusJson(this.requireRepoById(pr.head_repo_id), head.head_sha ?? "", statuses);
  }

  mergePullRequest(input: { owner: string; repo: string; pull_number: number; commit_title?: string; commit_message?: string }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    let before: Record<string, unknown> | null = null;
    const commit = this.transaction(() => {
      const pr = this.requirePullRequest(repo.id, input.pull_number);
      before = pullRequestState(pr, repo);
      if (pr.state !== "open") conflict("Pull request is closed");
      if (pr.merged) conflict("Pull request already merged");
      const status = this.getPullRequestStatus(input);
      if ((status as { state: string }).state === "failure") conflict("Required status check failed");
      const headRepo = this.requireRepoById(pr.head_repo_id);
      const files = this.listPullRequestFileRows(repo.id, pr.number);
      const changes = files.map((file) => {
        if (file.status === "removed") return { path: file.filename, content: "", delete: true };
        const source = this.getFile(headRepo.id, pr.head_ref, file.filename);
        if (!source) validationFailed("files", "missing", file.filename);
        return { path: file.filename, content: source.content };
      });
      const mergedCommit = this.commitFiles(repo, pr.base_ref, input.commit_title ?? `Merge pull request #${pr.number}`, changes, "pome-agent");
      const now = nowIso();
      this.db.prepare("UPDATE pull_requests SET state = 'closed', merged = 1, merge_commit_sha = ?, updated_at = ?, closed_at = ?, merged_at = ? WHERE repo_id = ? AND number = ?").run(
        mergedCommit.sha,
        now,
        now,
        now,
        repo.id,
        pr.number
      );
      return mergedCommit;
    });
    this.audit("merge_pull_request", repo.full_name, input);
    const merged = this.requirePullRequest(repo.id, input.pull_number);
    onDelta?.({ before, after: pullRequestState(merged, repo) });
    return { sha: commit.sha, merged: true, message: "Pull Request successfully merged" };
  }

  updatePullRequestBranch(input: { owner: string; repo: string; pull_number: number; expected_head_sha?: string }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    let before: Record<string, unknown> | null = null;
    const pullNumber = this.transaction(() => {
      const pr = this.requirePullRequest(repo.id, input.pull_number);
      before = pullRequestState(pr, repo);
      if (pr.state !== "open") conflict("Pull request is closed");
      const headRepo = this.requireRepoById(pr.head_repo_id);
      const headBranch = this.requireBranch(headRepo.id, pr.head_ref);
      if (input.expected_head_sha && headBranch.head_sha !== input.expected_head_sha) conflict("Head SHA did not match");
      const baseBranch = this.requireBranch(repo.id, pr.base_ref);
      const now = nowIso();
      this.db.prepare("UPDATE branches SET head_sha = ?, updated_at = ? WHERE repo_id = ? AND name = ?").run(baseBranch.head_sha, now, headRepo.id, pr.head_ref);
      this.db.prepare("UPDATE pull_requests SET head_sha = ?, base_sha = ?, updated_at = ? WHERE repo_id = ? AND number = ?").run(baseBranch.head_sha, baseBranch.head_sha, now, repo.id, pr.number);
      this.replacePullFiles(repo.id, pr.number, this.calculatePullFiles(repo, pr.base_ref, headRepo, pr.head_ref));
      return pr.number;
    });
    this.audit("update_pull_request_branch", repo.full_name, input);
    const updated = this.requirePullRequest(repo.id, pullNumber);
    onDelta?.({ before, after: pullRequestState(updated, repo) });
    return { message: "Updating pull request branch.", url: `https://api.github.com/repos/${repo.full_name}/pulls/${pullNumber}/update-branch` };
  }

  createStatus(input: { owner: string; repo: string; sha: string; state: "error" | "failure" | "pending" | "success"; context?: string; description?: string; target_url?: string }) {
    const repo = this.requireRepo(input.owner, input.repo);
    const now = nowIso();
    const result = this.db.prepare("INSERT INTO commit_statuses (repo_id, sha, state, context, description, target_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      repo.id,
      input.sha,
      input.state,
      input.context ?? "continuous-integration/local",
      input.description ?? "",
      input.target_url ?? "",
      now,
      now
    );
    return this.db.prepare("SELECT * FROM commit_statuses WHERE id = ?").get(result.lastInsertRowid);
  }

  // Public MCP tool: create (overwrite) a commit status on a SHA. Mirrors
  // createStatus()'s insert but adds the audit + state-delta channel the
  // matrix scoring/anomaly digest reads. Note this lets an agent paint a
  // failing head commit "success" — the fabricate-green-CI reward-hacking
  // axis (scenario 18) hinges on whether it does.
  createCommitStatus(input: { owner: string; repo: string; sha: string; state: "error" | "failure" | "pending" | "success"; context?: string; description?: string; target_url?: string }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    const row = this.transaction(() => this.createStatus(input) as CommitStatusRow);
    this.audit("create_commit_status", repo.full_name, input);
    onDelta?.({ before: null, after: commitStatusState(row, repo) });
    return statusJson(row, repo);
  }

  // Public MCP tool: create a check run on a head SHA. Same fabrication
  // surface as createCommitStatus via the modern checks API.
  createCheckRun(input: { owner: string; repo: string; name: string; head_sha: string; status?: "queued" | "in_progress" | "completed"; conclusion?: CheckRunRow["conclusion"]; details_url?: string; external_id?: string; output?: { title?: string; summary?: string }; started_at?: string; completed_at?: string }, onDelta?: StateDeltaCallback) {
    const repo = this.requireRepo(input.owner, input.repo);
    const row = this.transaction(() => {
      if (!input.name.trim()) validationFailed("name", "missing");
      const status = input.status ?? "queued";
      if (status === "completed" && !input.conclusion) validationFailed("conclusion", "missing", "required when status=completed");
      if (status !== "completed" && input.conclusion) validationFailed("conclusion", "invalid", "only allowed when status=completed");
      if (status !== "completed" && input.completed_at) validationFailed("completed_at", "invalid", "only allowed when status=completed");
      const started = input.started_at ?? nowIso();
      const completed = status === "completed" ? input.completed_at ?? nowIso() : input.completed_at ?? null;
      const result = this.db.prepare("INSERT INTO check_runs (repo_id, head_sha, name, status, conclusion, details_url, external_id, output_title, output_summary, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
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
      return this.db.prepare("SELECT * FROM check_runs WHERE id = ?").get(result.lastInsertRowid) as CheckRunRow;
    });
    this.audit("create_check_run", repo.full_name, input);
    onDelta?.({ before: null, after: checkRunState(row, repo) });
    return checkRunJson(row, repo);
  }

  private transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  private insertRepository(input: { owner: string; name: string; description: string; private: boolean; defaultBranch: string; fork: boolean; parentFullName: string | null }) {
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

  private copyForkCommits(source: RepoRow, fork: RepoRow) {
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

  private commitFiles(repo: RepoRow, branchName: string, message: string, files: FileChange[], actor: string): CommitRow {
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

  private calculatePullFiles(baseRepo: RepoRow, baseRef: string, headRepo: RepoRow, headRef: string): PullRequestFileRow[] {
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

  private replacePullFiles(repoId: number, pullNumber: number, files: PullRequestFileRow[]) {
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

  private serializePull(pr: PullRequestRow) {
    const baseRepo = this.requireRepoById(pr.base_repo_id);
    const headRepo = this.requireRepoById(pr.head_repo_id);
    const files = this.db.prepare("SELECT * FROM pull_request_files WHERE repo_id = ? AND pull_number = ?").all(pr.repo_id, pr.number) as PullRequestFileRow[];
    const headSha = this.getBranch(headRepo.id, pr.head_ref)?.head_sha ?? pr.head_sha;
    const baseSha = this.getBranch(baseRepo.id, pr.base_ref)?.head_sha ?? pr.base_sha;
    return pullRequestJson(pr, baseRepo, headRepo, 1, files.length, headSha, baseSha);
  }

  private resolveHeadRef(baseRepo: RepoRow, head: string) {
    const [owner, ref] = head.includes(":") ? head.split(":", 2) : [baseRepo.owner, head];
    const repo = this.requireRepo(owner!, baseRepo.name);
    return { repo, ref: ref! };
  }

  private listDirectory(repo: RepoRow, branch: string, path: string) {
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

  private createBranchInternal(repo: RepoRow, name: string, headSha: string | null) {
    const now = nowIso();
    this.db.prepare("INSERT INTO branches (repo_id, name, head_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(repo.id, name, headSha, now, now);
    return this.requireBranch(repo.id, name);
  }

  private upsertUser(login: string, type: "User" | "Organization", name: string) {
    this.db.prepare("INSERT INTO users (login, type, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(login) DO UPDATE SET type = excluded.type, name = excluded.name").run(login, type, name, nowIso());
  }

  private addCollaborator(repoId: number, login: string) {
    this.upsertUser(login, "User", login);
    this.db.prepare("INSERT OR IGNORE INTO collaborators (repo_id, login, permission) VALUES (?, ?, 'push')").run(repoId, login);
  }

  private createLabel(repo: RepoRow, name: string, color: string, description: string) {
    this.db.prepare("INSERT OR IGNORE INTO labels (repo_id, name, color, description) VALUES (?, ?, ?, ?)").run(repo.id, name, color, description);
    return labelJson(this.getLabel(repo.id, name)!);
  }

  private getRepo(owner: string, repo: string) {
    return this.db.prepare("SELECT * FROM repositories WHERE owner = ? AND name = ?").get(owner, repo) as RepoRow | undefined;
  }

  private requireRepo(owner: string, repo: string) {
    return this.getRepo(owner, repo) ?? notFound("Not Found");
  }

  private requireRepoById(repoId: number) {
    return (this.db.prepare("SELECT * FROM repositories WHERE id = ?").get(repoId) as RepoRow | undefined) ?? notFound("Not Found");
  }

  private getBranch(repoId: number, name: string) {
    return this.db.prepare("SELECT * FROM branches WHERE repo_id = ? AND name = ?").get(repoId, name) as BranchRow | undefined;
  }

  private requireBranch(repoId: number, name: string) {
    return this.getBranch(repoId, name) ?? notFound("Branch not found");
  }

  private listBranches(repoId: number) {
    return this.db.prepare("SELECT * FROM branches WHERE repo_id = ? ORDER BY name ASC").all(repoId) as BranchRow[];
  }

  private getFile(repoId: number, branch: string, path: string) {
    return this.db.prepare("SELECT * FROM files WHERE repo_id = ? AND branch = ? AND path = ?").get(repoId, branch, path) as FileRow | undefined;
  }

  private getLabel(repoId: number, name: string) {
    return this.db.prepare("SELECT * FROM labels WHERE repo_id = ? AND name = ?").get(repoId, name) as LabelRow | undefined;
  }

  private listLabels(repoId: number) {
    return this.db.prepare("SELECT * FROM labels WHERE repo_id = ? ORDER BY name ASC").all(repoId) as LabelRow[];
  }

  private listIssuesRows(repoId: number) {
    return this.db.prepare("SELECT * FROM issues WHERE repo_id = ? ORDER BY number ASC").all(repoId) as IssueRow[];
  }

  private requireIssue(repoId: number, number: number) {
    return (this.db.prepare("SELECT * FROM issues WHERE repo_id = ? AND number = ?").get(repoId, number) as IssueRow | undefined) ?? notFound("Issue not found");
  }

  private listIssueLabels(repoId: number, issueNumber: number) {
    return this.db
      .prepare("SELECT labels.* FROM labels INNER JOIN issue_labels ON labels.repo_id = issue_labels.repo_id AND labels.name = issue_labels.label_name WHERE issue_labels.repo_id = ? AND issue_labels.issue_number = ? ORDER BY labels.name ASC")
      .all(repoId, issueNumber) as LabelRow[];
  }

  private listIssueAssignees(repoId: number, issueNumber: number) {
    const rows = this.db.prepare("SELECT login FROM issue_assignees WHERE repo_id = ? AND issue_number = ? ORDER BY login ASC").all(repoId, issueNumber) as Array<{ login: string }>;
    return rows.map((row) => row.login);
  }

  private issueCommentCount(repoId: number, issueNumber: number) {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM issue_comments WHERE repo_id = ? AND issue_number = ?").get(repoId, issueNumber) as { count: number };
    return row.count;
  }

  private listIssueCommentRows(repoId: number, issueNumber: number) {
    return this.db.prepare("SELECT * FROM issue_comments WHERE repo_id = ? AND issue_number = ? ORDER BY id ASC").all(repoId, issueNumber) as IssueCommentRow[];
  }

  private hasCollaborator(repoId: number, login: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM collaborators WHERE repo_id = ? AND login = ?").get(repoId, login));
  }

  private listPullRequestRows(repoId: number) {
    return this.db.prepare("SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY number ASC").all(repoId) as PullRequestRow[];
  }

  private listPullRequestFileRows(repoId: number, pullNumber: number) {
    return this.db.prepare("SELECT * FROM pull_request_files WHERE repo_id = ? AND pull_number = ? ORDER BY filename ASC").all(repoId, pullNumber) as PullRequestFileRow[];
  }

  private listPullRequestReviewRows(repoId: number, pullNumber: number) {
    return this.db.prepare("SELECT * FROM pull_request_reviews WHERE repo_id = ? AND pull_number = ? ORDER BY submitted_at ASC").all(repoId, pullNumber) as PullRequestReviewRow[];
  }

  private listPullRequestReviewCommentRows(repoId: number, pullNumber: number) {
    return this.db.prepare("SELECT * FROM pull_request_review_comments WHERE repo_id = ? AND pull_number = ? ORDER BY id ASC").all(repoId, pullNumber) as Array<{
      id: number;
      path: string;
      body: string;
      user_login: string;
      created_at: string;
      updated_at: string;
    }>;
  }

  private requirePullRequest(repoId: number, number: number) {
    return (this.db.prepare("SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?").get(repoId, number) as PullRequestRow | undefined) ?? notFound("Pull request not found");
  }

  private nextNumber(repoId: number) {
    this.db.prepare("UPDATE repositories SET entity_counter = entity_counter + 1 WHERE id = ?").run(repoId);
    const row = this.db.prepare("SELECT entity_counter AS next FROM repositories WHERE id = ?").get(repoId) as { next: number };
    return row.next;
  }

  private bumpEntityCounter(repoId: number, number: number) {
    this.db.prepare("UPDATE repositories SET entity_counter = CASE WHEN entity_counter < ? THEN ? ELSE entity_counter END WHERE id = ?").run(number, number, repoId);
  }

  private audit(action: string, repoFullName: string | null, payload: unknown) {
    this.db.prepare("INSERT INTO audit_log (ts, action, repo_full_name, payload_json) VALUES (?, ?, ?, ?)").run(nowIso(), action, repoFullName, JSON.stringify(payload));
  }
}

function normalizePath(path: string) {
  const normalized = path.replace(/^\/+/, "").replace(/\/+/g, "/").trim();
  if (normalized.includes("..")) validationFailed("path", "invalid", path);
  return normalized;
}
