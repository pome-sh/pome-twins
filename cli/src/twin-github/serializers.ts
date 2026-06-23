// SPDX-License-Identifier: Apache-2.0
import type {
  BranchRow,
  CheckRunRow,
  CommitRow,
  CommitStatusRow,
  FileRow,
  IssueCommentRow,
  IssueRow,
  LabelRow,
  PullRequestFileRow,
  PullRequestReviewRow,
  PullRequestRow,
  RepoRow
} from "./types.js";
import { encodeContent, stableNumericId } from "./util.js";

// state_delta serializers — produce plain Record<string, unknown> shapes for the
// RecorderEvent.state_delta {before, after} channel. SQLite 0/1 booleans are
// normalized; internal counters that aren't part of the entity identity (e.g.
// auto-increment ids on join rows) are dropped. Per the shared-types schema in
// recorder-events.ts, the shape is opaque (Record<string, unknown>) — these
// helpers exist to keep all twin-github mutation handlers emitting a consistent
// per-entity shape rather than ad-hoc objects.

export function repoState(repo: RepoRow): Record<string, unknown> {
  return {
    owner: repo.owner,
    name: repo.name,
    full_name: repo.full_name,
    description: repo.description,
    private: Boolean(repo.private),
    default_branch: repo.default_branch,
    fork: Boolean(repo.fork),
    parent_full_name: repo.parent_full_name,
    created_at: repo.created_at,
    updated_at: repo.updated_at
  };
}

export function branchState(branch: BranchRow, repo: RepoRow): Record<string, unknown> {
  return {
    repo: repo.full_name,
    name: branch.name,
    head_sha: branch.head_sha,
    created_at: branch.created_at,
    updated_at: branch.updated_at
  };
}

export function fileState(file: FileRow, repo: RepoRow): Record<string, unknown> {
  return {
    repo: repo.full_name,
    branch: file.branch,
    path: file.path,
    content: file.content,
    sha: file.sha,
    size: file.size,
    updated_at: file.updated_at
  };
}

export function issueState(
  issue: IssueRow,
  repo: RepoRow,
  labels: string[],
  assignees: string[]
): Record<string, unknown> {
  return {
    repo: repo.full_name,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user_login: issue.user_login,
    assignee_login: issue.assignee_login,
    labels,
    assignees,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at
  };
}

export function issueCommentState(comment: IssueCommentRow, repo: RepoRow): Record<string, unknown> {
  return {
    repo: repo.full_name,
    id: comment.id,
    issue_number: comment.issue_number,
    body: comment.body,
    user_login: comment.user_login,
    created_at: comment.created_at,
    updated_at: comment.updated_at
  };
}

export function labelState(label: LabelRow, repo: RepoRow): Record<string, unknown> {
  return {
    repo: repo.full_name,
    name: label.name,
    color: label.color,
    description: label.description
  };
}

export function issueLabelsState(
  repo: RepoRow,
  issueNumber: number,
  labels: string[]
): Record<string, unknown> {
  return { repo: repo.full_name, issue_number: issueNumber, labels };
}

export function issueAssigneesState(
  repo: RepoRow,
  issueNumber: number,
  assignees: string[]
): Record<string, unknown> {
  return { repo: repo.full_name, issue_number: issueNumber, assignees };
}

export function pullRequestState(pr: PullRequestRow, repo: RepoRow): Record<string, unknown> {
  return {
    repo: repo.full_name,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    user_login: pr.user_login,
    head_ref: pr.head_ref,
    head_sha: pr.head_sha,
    base_ref: pr.base_ref,
    base_sha: pr.base_sha,
    merged: Boolean(pr.merged),
    merge_commit_sha: pr.merge_commit_sha,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    merged_at: pr.merged_at
  };
}

export function pullRequestReviewState(review: PullRequestReviewRow, repo: RepoRow): Record<string, unknown> {
  return {
    repo: repo.full_name,
    pull_number: review.pull_number,
    id: review.id,
    user_login: review.user_login,
    state: review.state,
    body: review.body,
    commit_sha: review.commit_sha,
    submitted_at: review.submitted_at
  };
}

export function userJson(login: string, type: "User" | "Organization" = "User") {
  return {
    login,
    id: stableNumericId(login),
    node_id: `U_${stableNumericId(login)}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${stableNumericId(login)}?v=4`,
    html_url: `https://github.com/${login}`,
    type,
    site_admin: false
  };
}

export function repoJson(repo: RepoRow) {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.full_name,
    owner: userJson(repo.owner, "Organization"),
    private: Boolean(repo.private),
    html_url: `https://github.com/${repo.full_name}`,
    description: repo.description,
    fork: Boolean(repo.fork),
    parent: repo.parent_full_name ? { full_name: repo.parent_full_name } : undefined,
    url: `https://api.github.com/repos/${repo.full_name}`,
    contents_url: `https://api.github.com/repos/${repo.full_name}/contents/{+path}`,
    issues_url: `https://api.github.com/repos/${repo.full_name}/issues{/number}`,
    pulls_url: `https://api.github.com/repos/${repo.full_name}/pulls{/number}`,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at
  };
}

export function branchJson(branch: BranchRow, repo: RepoRow) {
  return {
    name: branch.name,
    commit: {
      sha: branch.head_sha,
      url: branch.head_sha ? `https://api.github.com/repos/${repo.full_name}/commits/${branch.head_sha}` : null
    },
    protected: false
  };
}

export function commitJson(commit: CommitRow, repo: RepoRow) {
  return {
    sha: commit.sha,
    node_id: `C_${commit.sha}`,
    commit: {
      author: {
        name: commit.author_login,
        email: `${commit.author_login}@example.local`,
        date: commit.created_at
      },
      committer: {
        name: commit.committer_login,
        email: `${commit.committer_login}@example.local`,
        date: commit.created_at
      },
      message: commit.message,
      tree: {
        sha: commit.tree_sha,
        url: `https://api.github.com/repos/${repo.full_name}/git/trees/${commit.tree_sha}`
      },
      url: `https://api.github.com/repos/${repo.full_name}/git/commits/${commit.sha}`
    },
    url: `https://api.github.com/repos/${repo.full_name}/commits/${commit.sha}`,
    html_url: `https://github.com/${repo.full_name}/commit/${commit.sha}`,
    author: userJson(commit.author_login),
    committer: userJson(commit.committer_login),
    parents: commit.parent_sha
      ? [{ sha: commit.parent_sha, url: `https://api.github.com/repos/${repo.full_name}/commits/${commit.parent_sha}` }]
      : []
  };
}

export function contentFileJson(file: FileRow, repo: RepoRow) {
  return {
    type: "file",
    encoding: "base64",
    size: file.size,
    name: file.path.split("/").at(-1) ?? file.path,
    path: file.path,
    content: encodeContent(file.content),
    sha: file.sha,
    url: `https://api.github.com/repos/${repo.full_name}/contents/${file.path}`,
    git_url: `https://api.github.com/repos/${repo.full_name}/git/blobs/${file.sha}`,
    html_url: `https://github.com/${repo.full_name}/blob/${file.branch}/${file.path}`,
    download_url: `https://raw.githubusercontent.com/${repo.full_name}/${file.branch}/${file.path}`
  };
}

export function contentDirectoryEntryJson(path: string, repo: RepoRow, branch: string, file?: FileRow) {
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  const isFile = Boolean(file);
  return {
    type: isFile ? "file" : "dir",
    size: file?.size ?? 0,
    name,
    path,
    sha: file?.sha ?? `dir_${stableNumericId(`${repo.full_name}:${branch}:${path}`)}`,
    url: `https://api.github.com/repos/${repo.full_name}/contents/${path}`,
    git_url: isFile ? `https://api.github.com/repos/${repo.full_name}/git/blobs/${file!.sha}` : null,
    html_url: `https://github.com/${repo.full_name}/${isFile ? "blob" : "tree"}/${branch}/${path}`,
    download_url: isFile ? `https://raw.githubusercontent.com/${repo.full_name}/${branch}/${path}` : null
  };
}

export function labelJson(label: LabelRow) {
  return {
    id: stableNumericId(label.name),
    node_id: `LA_${stableNumericId(label.name)}`,
    url: `https://api.github.com/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description
  };
}

export function issueJson(issue: IssueRow, repo: RepoRow, labels: LabelRow[] = [], assignees: string[] = [], comments = 0) {
  return {
    id: stableNumericId(`${repo.full_name}#${issue.number}`),
    node_id: `I_${stableNumericId(`${repo.full_name}#${issue.number}`)}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(issue.user_login),
    labels: labels.map(labelJson),
    assignee: issue.assignee_login ? userJson(issue.assignee_login) : null,
    assignees: assignees.map((login) => userJson(login)),
    comments,
    html_url: `https://github.com/${repo.full_name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.full_name}`,
    labels_url: `https://api.github.com/repos/${repo.full_name}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://api.github.com/repos/${repo.full_name}/issues/${issue.number}/comments`,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at
  };
}

export function issueCommentJson(comment: IssueCommentRow, repo: RepoRow) {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(comment.user_login),
    html_url: `https://github.com/${repo.full_name}/issues/${comment.issue_number}#issuecomment-${comment.id}`,
    issue_url: `https://api.github.com/repos/${repo.full_name}/issues/${comment.issue_number}`,
    created_at: comment.created_at,
    updated_at: comment.updated_at
  };
}

export function pullRequestJson(pr: PullRequestRow, baseRepo: RepoRow, headRepo: RepoRow, commits = 1, changedFiles = 0, headSha: string | null = null, baseSha: string | null = null) {
  return {
    id: stableNumericId(`${baseRepo.full_name}/pull/${pr.number}`),
    node_id: `PR_${stableNumericId(`${baseRepo.full_name}/pull/${pr.number}`)}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    body: pr.body,
    user: userJson(pr.user_login),
    html_url: `https://github.com/${baseRepo.full_name}/pull/${pr.number}`,
    url: `https://api.github.com/repos/${baseRepo.full_name}/pulls/${pr.number}`,
    issue_url: `https://api.github.com/repos/${baseRepo.full_name}/issues/${pr.number}`,
    commits_url: `https://api.github.com/repos/${baseRepo.full_name}/pulls/${pr.number}/commits`,
    review_comments_url: `https://api.github.com/repos/${baseRepo.full_name}/pulls/${pr.number}/comments`,
    review_comment_url: `https://api.github.com/repos/${baseRepo.full_name}/pulls/comments{/number}`,
    comments_url: `https://api.github.com/repos/${baseRepo.full_name}/issues/${pr.number}/comments`,
    statuses_url: `https://api.github.com/repos/${headRepo.full_name}/statuses/{sha}`,
    head: {
      label: `${headRepo.owner}:${pr.head_ref}`,
      ref: pr.head_ref,
      sha: headSha,
      repo: repoJson(headRepo),
      user: userJson(headRepo.owner, "Organization")
    },
    base: {
      label: `${baseRepo.owner}:${pr.base_ref}`,
      ref: pr.base_ref,
      sha: baseSha,
      repo: repoJson(baseRepo),
      user: userJson(baseRepo.owner, "Organization")
    },
    merged: Boolean(pr.merged),
    merge_commit_sha: pr.merge_commit_sha,
    draft: false,
    commits,
    additions: 0,
    deletions: 0,
    changed_files: changedFiles,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    merged_at: pr.merged_at
  };
}

export function pullRequestFileJson(file: PullRequestFileRow) {
  return {
    sha: `file_${stableNumericId(file.filename)}`,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: file.blob_url,
    raw_url: file.raw_url,
    contents_url: file.contents_url,
    patch: file.patch
  };
}

export function reviewJson(review: PullRequestReviewRow, repo: RepoRow) {
  return {
    id: review.id,
    node_id: `PRR_${review.id}`,
    user: userJson(review.user_login),
    body: review.body,
    state: review.state,
    html_url: `https://github.com/${repo.full_name}/pull/${review.pull_number}#pullrequestreview-${review.id}`,
    pull_request_url: `https://api.github.com/repos/${repo.full_name}/pulls/${review.pull_number}`,
    commit_id: review.commit_sha,
    submitted_at: review.submitted_at
  };
}

export function statusJson(status: CommitStatusRow, repo: RepoRow) {
  return {
    id: status.id,
    node_id: `ST_${status.id}`,
    state: status.state,
    description: status.description,
    target_url: status.target_url,
    context: status.context,
    created_at: status.created_at,
    updated_at: status.updated_at,
    url: `https://api.github.com/repos/${repo.full_name}/statuses/${status.sha}`
  };
}

export function commitStatusState(status: CommitStatusRow, repo: RepoRow): Record<string, unknown> {
  return {
    repo: repo.full_name,
    id: status.id,
    sha: status.sha,
    state: status.state,
    context: status.context,
    description: status.description,
    target_url: status.target_url
  };
}

export function checkRunJson(run: CheckRunRow, repo: RepoRow) {
  return {
    id: run.id,
    node_id: `CR_${run.id}`,
    head_sha: run.head_sha,
    external_id: run.external_id,
    url: `https://api.github.com/repos/${repo.full_name}/check-runs/${run.id}`,
    html_url: `https://github.com/${repo.full_name}/runs/${run.id}`,
    details_url: run.details_url,
    status: run.status,
    conclusion: run.conclusion,
    started_at: run.started_at,
    completed_at: run.completed_at,
    output: {
      title: run.output_title,
      summary: run.output_summary,
      text: null,
      annotations_count: 0,
      annotations_url: `https://api.github.com/repos/${repo.full_name}/check-runs/${run.id}/annotations`
    },
    name: run.name,
    check_suite: null,
    app: null,
    pull_requests: []
  };
}

export function checkRunState(run: CheckRunRow, repo: RepoRow): Record<string, unknown> {
  return {
    repo: repo.full_name,
    id: run.id,
    head_sha: run.head_sha,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    details_url: run.details_url,
    external_id: run.external_id,
    output_title: run.output_title,
    output_summary: run.output_summary,
    started_at: run.started_at,
    completed_at: run.completed_at
  };
}

export function combinedStatusJson(repo: RepoRow, sha: string, statuses: CommitStatusRow[]) {
  // GitHub's combined status keeps only the most recent status per context — a
  // later `success` on the same context overrides an earlier `failure`. Dedupe
  // by context keeping the highest id (newest) before rolling up the state, so
  // the twin mirrors that override semantics rather than letting a stale
  // failure row outvote a fresh success.
  const latestByContext = new Map<string, CommitStatusRow>();
  for (const status of [...statuses].sort((a, b) => a.id - b.id)) {
    latestByContext.set(status.context, status);
  }
  const latest = [...latestByContext.values()];
  const state = latest.some((status) => status.state === "failure" || status.state === "error")
    ? "failure"
    : latest.some((status) => status.state === "pending")
      ? "pending"
      : "success";
  return {
    state,
    sha,
    total_count: latest.length,
    statuses: latest.map((status) => statusJson(status, repo)),
    repository: repoJson(repo),
    commit_url: `https://api.github.com/repos/${repo.full_name}/commits/${sha}`,
    url: `https://api.github.com/repos/${repo.full_name}/commits/${sha}/status`
  };
}
