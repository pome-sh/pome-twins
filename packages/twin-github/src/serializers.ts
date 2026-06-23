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
  MilestoneRow,
  PullRequestFileRow,
  PullRequestReviewCommentRow,
  PullRequestReviewRow,
  PullRequestRow,
  ReleaseRow,
  RepoRow,
  TagRow
} from "./types.js";
import type {
  AuthenticatedUser,
  CheckRun,
  CombinedStatus,
  Commit,
  CommitComparison,
  CommitWithFiles,
  ContentDirectoryEntry,
  ContentFile,
  DeepPartial,
  DiffEntry,
  Issue,
  IssueComment,
  Label,
  Milestone,
  PullRequest,
  PullRequestReview,
  PullRequestSimple,
  Release,
  Repository,
  ReviewComment,
  ShortBranch,
  SimpleUser,
  Status,
  Tag
} from "./upstream-types.js";
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
  } satisfies DeepPartial<SimpleUser>;
}

export function repoJson(repo: RepoRow) {
  // `parent` is NOT a field of the upstream `repository` schema (it lives on the
  // richer `full-repository` schema). The twin intentionally emits a minimal
  // hypermedia parent reference — `{ full_name }` — rather than a full nested
  // repository object (FDRS-451 hypermedia subset exemption). Held outside the
  // `satisfies` anchor so the rest of the literal stays strictly spec-checked,
  // then re-attached via a typed spread; the cast documents the deliberate
  // divergence without weakening any other field's guard.
  const parentRef: { parent?: { full_name: string } } = repo.parent_full_name
    ? { parent: { full_name: repo.parent_full_name } }
    : {};
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
    url: `https://api.github.com/repos/${repo.full_name}`,
    contents_url: `https://api.github.com/repos/${repo.full_name}/contents/{+path}`,
    issues_url: `https://api.github.com/repos/${repo.full_name}/issues{/number}`,
    pulls_url: `https://api.github.com/repos/${repo.full_name}/pulls{/number}`,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    ...parentRef
  } satisfies DeepPartial<Repository>;
}

export function branchJson(branch: BranchRow, repo: RepoRow) {
  return {
    name: branch.name,
    commit: {
      // Upstream `short-branch.commit.sha` is a non-null string; the twin emits
      // an empty string (rather than null) when head_sha is unresolved.
      sha: (branch.head_sha ?? "") as string,
      // Upstream `commit.url` is a required non-null string; the twin surfaces
      // null in the pre-resolution state (no commit seeded yet). Intentional
      // twin behavior — narrow the null away for the type anchor only
      // (FDRS-454: a faithful twin may surface a pre-resolution null), runtime
      // value unchanged.
      url: (branch.head_sha ? `https://api.github.com/repos/${repo.full_name}/commits/${branch.head_sha}` : null) as string
    },
    protected: false
  } satisfies DeepPartial<ShortBranch>;
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
      : [],
    comments_url: `https://api.github.com/repos/${repo.full_name}/commits/${commit.sha}/comments`
  } satisfies DeepPartial<Commit>;
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
    download_url: `https://raw.githubusercontent.com/${repo.full_name}/${file.branch}/${file.path}`,
    _links: {
      git: file.sha ? `https://api.github.com/repos/${repo.full_name}/git/blobs/${file.sha}` : null,
      html: `https://github.com/${repo.full_name}/blob/${file.branch}/${file.path}`,
      self: `https://api.github.com/repos/${repo.full_name}/contents/${file.path}`
    }
  } satisfies DeepPartial<ContentFile>;
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
    // `git_url` is a hypermedia link relation (key ends in `_url`). On a directory
    // entry the twin has no git blob to point at; rather than emit `git_url: null`
    // (a string→null type-changed against real GitHub's blob URL on files), omit the
    // key entirely on directories so the field-removed direction is covered by the
    // categorical hypermedia exemption (FDRS-451) — a faithful twin returning a
    // SUBSET of GitHub's link relations, not drift (FDRS-454).
    ...(isFile ? { git_url: `https://api.github.com/repos/${repo.full_name}/git/blobs/${file!.sha}` } : {}),
    html_url: `https://github.com/${repo.full_name}/${isFile ? "blob" : "tree"}/${branch}/${path}`,
    download_url: isFile ? `https://raw.githubusercontent.com/${repo.full_name}/${branch}/${path}` : null
    // `_links` is intentionally omitted — the categorical hypermedia subset
    // exemption (FDRS-451); DeepPartial makes it optional so omission is legal.
    // The upstream `content-directory` schema is an ARRAY of entries; this
    // serializer emits one entry, so it anchors against the element type.
  } satisfies DeepPartial<ContentDirectoryEntry>[number];
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
  } satisfies DeepPartial<Label>;
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
  } satisfies DeepPartial<Issue>;
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
  } satisfies DeepPartial<IssueComment>;
}

// The fields real GitHub returns ONLY from the single-PR GET
// (`GET /repos/:o/:r/pulls/:n`, the full PullRequest schema) and NOT from the
// LIST endpoint (`GET /repos/:o/:r/pulls`, the leaner "pull request simple"
// shape). The list serializer omits these; the detail serializer keeps them.
// See https://docs.github.com/en/rest/pulls/pulls — PullRequestSimple vs
// PullRequest.
function pullRequestSimpleJson(pr: PullRequestRow, baseRepo: RepoRow, headRepo: RepoRow, headSha: string | null = null, baseSha: string | null = null) {
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
      // Upstream merge-base `sha` is a non-null string; the twin emits null when
      // the head SHA is unresolved (no commits seeded yet). Intentional twin
      // behavior — narrow the null away for the type anchor only (FDRS-454:
      // faithful twin may surface a pre-resolution null), runtime value unchanged.
      sha: headSha as string,
      repo: repoJson(headRepo),
      user: userJson(headRepo.owner, "Organization")
    },
    base: {
      label: `${baseRepo.owner}:${pr.base_ref}`,
      ref: pr.base_ref,
      // See head.sha note above — same pre-resolution null exemption.
      sha: baseSha as string,
      repo: repoJson(baseRepo),
      user: userJson(baseRepo.owner, "Organization")
    },
    merge_commit_sha: pr.merge_commit_sha,
    draft: false,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    merged_at: pr.merged_at
  } satisfies DeepPartial<PullRequestSimple>;
}

// LIST serializer (`GET /repos/:o/:r/pulls`) — the leaner PullRequestSimple
// shape. Does not include merged / commits / additions / deletions /
// changed_files (those are single-PR-only).
export function pullRequestListJson(pr: PullRequestRow, baseRepo: RepoRow, headRepo: RepoRow, headSha: string | null = null, baseSha: string | null = null) {
  return pullRequestSimpleJson(pr, baseRepo, headRepo, headSha, baseSha);
}

// Single-PR serializer (`GET /repos/:o/:r/pulls/:n`) — the full PullRequest
// shape, which extends PullRequestSimple with the diff-stat fields.
export function pullRequestJson(pr: PullRequestRow, baseRepo: RepoRow, headRepo: RepoRow, commits = 1, changedFiles = 0, headSha: string | null = null, baseSha: string | null = null) {
  const simple = pullRequestSimpleJson(pr, baseRepo, headRepo, headSha, baseSha);
  return {
    ...simple,
    merged: Boolean(pr.merged),
    commits,
    additions: 0,
    deletions: 0,
    changed_files: changedFiles
  } satisfies DeepPartial<PullRequest>;
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
  } satisfies DeepPartial<DiffEntry>;
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
  } satisfies DeepPartial<PullRequestReview>;
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
  } satisfies DeepPartial<Status>;
}

export function combinedStatusJson(repo: RepoRow, sha: string, statuses: CommitStatusRow[]) {
  // GitHub's deterministic combined-status rule: any failure/error wins,
  // else any pending → pending, else success. When there are zero statuses
  // GitHub returns state="pending" (not "success") — match exactly.
  const state = statuses.length === 0
    ? "pending"
    : statuses.some((status) => status.state === "failure" || status.state === "error")
      ? "failure"
      : statuses.some((status) => status.state === "pending")
        ? "pending"
        : "success";
  return {
    state,
    sha,
    total_count: statuses.length,
    statuses: statuses.map((status) => statusJson(status, repo)),
    repository: repoJson(repo),
    commit_url: `https://api.github.com/repos/${repo.full_name}/commits/${sha}`,
    url: `https://api.github.com/repos/${repo.full_name}/commits/${sha}/status`
  } satisfies DeepPartial<CombinedStatus>;
}

// ----- v2 hot-path serializers (FDRS-300) --------------------------------

export function milestoneJson(milestone: MilestoneRow, repo: RepoRow, openIssues = 0, closedIssues = 0) {
  return {
    id: stableNumericId(`${repo.full_name}/milestone/${milestone.number}`),
    node_id: `MI_${stableNumericId(`${repo.full_name}/milestone/${milestone.number}`)}`,
    number: milestone.number,
    title: milestone.title,
    description: milestone.description,
    state: milestone.state,
    creator: userJson(milestone.creator_login),
    open_issues: openIssues,
    closed_issues: closedIssues,
    due_on: milestone.due_on,
    created_at: milestone.created_at,
    updated_at: milestone.updated_at,
    closed_at: milestone.closed_at,
    html_url: `https://github.com/${repo.full_name}/milestone/${milestone.number}`,
    url: `https://api.github.com/repos/${repo.full_name}/milestones/${milestone.number}`,
    labels_url: `https://api.github.com/repos/${repo.full_name}/milestones/${milestone.number}/labels`
  } satisfies DeepPartial<Milestone>;
}

export function milestoneState(milestone: MilestoneRow, repo: RepoRow): Record<string, unknown> {
  return {
    repo: repo.full_name,
    number: milestone.number,
    title: milestone.title,
    description: milestone.description,
    state: milestone.state,
    due_on: milestone.due_on,
    creator_login: milestone.creator_login,
    created_at: milestone.created_at,
    updated_at: milestone.updated_at,
    closed_at: milestone.closed_at
  };
}

export function tagJson(tag: TagRow, repo: RepoRow) {
  return {
    name: tag.name,
    commit: {
      sha: tag.commit_sha,
      url: `https://api.github.com/repos/${repo.full_name}/commits/${tag.commit_sha}`
    },
    zipball_url: `https://api.github.com/repos/${repo.full_name}/zipball/refs/tags/${tag.name}`,
    tarball_url: `https://api.github.com/repos/${repo.full_name}/tarball/refs/tags/${tag.name}`,
    node_id: `T_${stableNumericId(`${repo.full_name}/tag/${tag.name}`)}`
  } satisfies DeepPartial<Tag>;
}

export function releaseJson(release: ReleaseRow, repo: RepoRow) {
  return {
    id: release.id,
    node_id: `RE_${release.id}`,
    tag_name: release.tag_name,
    target_commitish: release.target_commitish,
    name: release.name,
    body: release.body,
    draft: Boolean(release.draft),
    prerelease: Boolean(release.prerelease),
    author: userJson(release.author_login),
    created_at: release.created_at,
    published_at: release.published_at,
    html_url: `https://github.com/${repo.full_name}/releases/tag/${release.tag_name}`,
    url: `https://api.github.com/repos/${repo.full_name}/releases/${release.id}`,
    assets_url: `https://api.github.com/repos/${repo.full_name}/releases/${release.id}/assets`,
    upload_url: `https://uploads.github.com/repos/${repo.full_name}/releases/${release.id}/assets{?name,label}`,
    tarball_url: `https://api.github.com/repos/${repo.full_name}/tarball/${release.tag_name}`,
    zipball_url: `https://api.github.com/repos/${repo.full_name}/zipball/${release.tag_name}`,
    assets: []
  } satisfies DeepPartial<Release>;
}

export function releaseState(release: ReleaseRow, repo: RepoRow): Record<string, unknown> {
  return {
    repo: repo.full_name,
    id: release.id,
    tag_name: release.tag_name,
    target_commitish: release.target_commitish,
    name: release.name,
    body: release.body,
    draft: Boolean(release.draft),
    prerelease: Boolean(release.prerelease),
    author_login: release.author_login,
    created_at: release.created_at,
    published_at: release.published_at
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
    // The twin's `conclusion` column carries the full GitHub check-run
    // conclusion vocabulary including `"stale"`, but the pinned
    // @octokit/openapi-types version's `check-run.conclusion` enum predates
    // `"stale"`. The twin faithfully emits a real upstream value; narrow it to
    // the schema's declared union for the type anchor only (FDRS-454: twin
    // tracks live GitHub, not a lagging spec snapshot), runtime value unchanged.
    conclusion: run.conclusion as CheckRun["conclusion"],
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
  } satisfies DeepPartial<CheckRun>;
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

export function pullRequestReviewCommentJson(comment: PullRequestReviewCommentRow, repo: RepoRow) {
  return {
    id: comment.id,
    node_id: `PRC_${comment.id}`,
    pull_request_review_id: null,
    diff_hunk: "",
    path: comment.path,
    // `position` is the one location field the upstream schema declares
    // nullable (`number | null`); all the sibling line/position fields below
    // are non-null in the schema. The twin's row column is `number | null`, so
    // for the non-null schema fields we narrow the row's pre-resolution null
    // away for the type anchor only (FDRS-454: a faithful twin may surface a
    // pre-resolution null on a not-yet-positioned comment), runtime unchanged.
    position: comment.line,
    original_position: comment.line as number,
    // `commit_sha` row column is `string | null`; schema commit ids are
    // non-null strings (FDRS-454 pre-resolution null narrow).
    commit_id: comment.commit_sha as string,
    original_commit_id: comment.commit_sha as string,
    in_reply_to_id: comment.in_reply_to_id as number,
    user: userJson(comment.user_login),
    body: comment.body,
    side: comment.side ?? "RIGHT",
    line: comment.line as number,
    original_line: comment.line as number,
    start_line: null,
    original_start_line: null,
    start_side: null,
    html_url: `https://github.com/${repo.full_name}/pull/${comment.pull_number}#discussion_r${comment.id}`,
    pull_request_url: `https://api.github.com/repos/${repo.full_name}/pulls/${comment.pull_number}`,
    url: `https://api.github.com/repos/${repo.full_name}/pulls/comments/${comment.id}`,
    created_at: comment.created_at,
    updated_at: comment.updated_at
  } satisfies DeepPartial<ReviewComment>;
}

export function pullRequestReviewCommentState(
  comment: PullRequestReviewCommentRow,
  repo: RepoRow
): Record<string, unknown> {
  return {
    repo: repo.full_name,
    pull_number: comment.pull_number,
    id: comment.id,
    path: comment.path,
    body: comment.body,
    user_login: comment.user_login,
    line: comment.line,
    side: comment.side,
    commit_sha: comment.commit_sha,
    in_reply_to_id: comment.in_reply_to_id,
    created_at: comment.created_at,
    updated_at: comment.updated_at
  };
}

export function commitWithFilesJson(commit: CommitRow, repo: RepoRow, files: PullRequestFileRow[]) {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    ...commitJson(commit, repo),
    stats: { additions, deletions, total: additions + deletions },
    files: files.map(pullRequestFileJson)
  } satisfies DeepPartial<CommitWithFiles>;
}

export function compareCommitsJson(
  baseRepo: RepoRow,
  base: CommitRow,
  head: CommitRow,
  commits: CommitRow[],
  files: PullRequestFileRow[],
  status: "ahead" | "behind" | "identical" | "diverged",
  aheadBy: number,
  behindBy: number
) {
  return {
    url: `https://api.github.com/repos/${baseRepo.full_name}/compare/${base.sha}...${head.sha}`,
    html_url: `https://github.com/${baseRepo.full_name}/compare/${base.sha}...${head.sha}`,
    permalink_url: `https://github.com/${baseRepo.full_name}/compare/${base.sha.slice(0, 7)}...${head.sha.slice(0, 7)}`,
    diff_url: `https://github.com/${baseRepo.full_name}/compare/${base.sha}...${head.sha}.diff`,
    patch_url: `https://github.com/${baseRepo.full_name}/compare/${base.sha}...${head.sha}.patch`,
    base_commit: commitJson(base, baseRepo),
    merge_base_commit: commitJson(base, baseRepo),
    status,
    ahead_by: aheadBy,
    behind_by: behindBy,
    total_commits: commits.length,
    commits: commits.map((commit) => commitJson(commit, baseRepo)),
    files: files.map(pullRequestFileJson)
  } satisfies DeepPartial<CommitComparison>;
}

export function authenticatedUserJson(login: string) {
  return {
    ...userJson(login, "User"),
    name: login,
    email: `${login}@example.local`,
    bio: null,
    company: null,
    blog: null,
    location: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z"
  } satisfies DeepPartial<AuthenticatedUser>;
}

export function collaboratorAddState(repo: RepoRow, login: string, invitation: "pending" | "accepted", permission: string): Record<string, unknown> {
  return {
    repo: repo.full_name,
    login,
    invitation_state: invitation,
    permission
  };
}

// Used by get_pull_request_diff — agents pass a unified diff to LLMs. Our
// simplified diff renders one hunk per file with the GitHub-shaped @@ header.
export function pullRequestDiffText(files: PullRequestFileRow[]): string {
  const blocks = files.map((file) => {
    const header = `diff --git a/${file.filename} b/${file.filename}`;
    const status = file.status === "added"
      ? `new file mode 100644\n--- /dev/null\n+++ b/${file.filename}`
      : file.status === "removed"
        ? `deleted file mode 100644\n--- a/${file.filename}\n+++ /dev/null`
        : `--- a/${file.filename}\n+++ b/${file.filename}`;
    const hunkHeader = `@@ -0,${file.deletions || 0} +0,${file.additions || 0} @@`;
    return `${header}\n${status}\n${hunkHeader}\n${file.patch || ""}`.trim();
  });
  return blocks.join("\n");
}
