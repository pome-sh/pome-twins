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


export function getRepository(domain: GitHubDomain, input: { owner: string; repo: string }) {
  return repoJson(domain.requireRepo(input.owner, input.repo));
}


export function createRepository(domain: GitHubDomain, input: { name: string; owner?: string; description?: string; private?: boolean }, onDelta?: StateDeltaCallback) {
  const owner = input.owner ?? "pome-agent";
  const repo = domain.transaction(() => {
    domain.upsertUser(owner, "Organization", owner);
    if (domain.getRepo(owner, input.name)) validationFailed("name", "already_exists", input.name);
    const created = domain.insertRepository({
      owner,
      name: input.name,
      description: input.description ?? "",
      private: input.private ?? false,
      defaultBranch: "main",
      fork: false,
      parentFullName: null
    });
    domain.addCollaborator(created.id, "pome-agent");
    domain.createBranchInternal(created, "main", null);
    domain.commitFiles(created, "main", "Initial commit", [{ path: "README.md", content: `# ${input.name}\n` }], "pome-agent");
    return created;
  });
  domain.audit("create_repository", repo.full_name, input);
  const final = domain.requireRepo(owner, input.name);
  onDelta?.({ before: null, after: repoState(final) });
  return repoJson(final);
}


export function forkRepository(domain: GitHubDomain, input: { owner: string; repo: string; organization?: string }, onDelta?: StateDeltaCallback) {
  const source = domain.requireRepo(input.owner, input.repo);
  const owner = input.organization ?? "pome-agent";
  const fork = domain.transaction(() => {
    domain.upsertUser(owner, owner === input.organization ? "Organization" : "User", owner);
    if (domain.getRepo(owner, source.name)) validationFailed("name", "already_exists", source.name);
    const created = domain.insertRepository({
      owner,
      name: source.name,
      description: source.description,
      private: Boolean(source.private),
      defaultBranch: source.default_branch,
      fork: true,
      parentFullName: source.full_name
    });
    domain.addCollaborator(created.id, "pome-agent");
    const commitShaMap = domain.copyForkCommits(source, created);
    for (const branch of domain.listBranches(source.id)) {
      domain.createBranchInternal(created, branch.name, branch.head_sha ? commitShaMap.get(branch.head_sha) ?? null : null);
      const files = domain.db.prepare("SELECT * FROM files WHERE repo_id = ? AND branch = ?").all(source.id, branch.name) as FileRow[];
      for (const file of files) {
        domain.db.prepare("INSERT INTO files (repo_id, branch, path, content, sha, size, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
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
  domain.audit("fork_repository", fork.full_name, input);
  onDelta?.({ before: null, after: repoState(fork) });
  return repoJson(fork);
}


export function listCollaborators(domain: GitHubDomain, input: { owner: string; repo: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const rows = domain.db.prepare("SELECT login FROM collaborators WHERE repo_id = ? ORDER BY login ASC").all(repo.id) as Array<{ login: string }>;
  return rows.map((row) => userJson(row.login));
}


export function isCollaborator(domain: GitHubDomain, input: { owner: string; repo: string; username: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  return domain.hasCollaborator(repo.id, input.username);
}


export function hasRepositoryPermission(domain: GitHubDomain, input: { owner: string; repo: string; username: string; permissions: string[] }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const row = domain.db.prepare("SELECT permission, invitation_state FROM collaborators WHERE repo_id = ? AND login = ?").get(repo.id, input.username) as Pick<CollaboratorRow, "permission" | "invitation_state"> | undefined;
  return Boolean(row && row.invitation_state === "accepted" && input.permissions.includes(row.permission));
}

// Cluster H — identity & collaborators -----------------------------------

export function getMe(domain: GitHubDomain, input: { actor?: string } = {}) {
  const login = input.actor ?? "pome-agent";
  return authenticatedUserJson(login);
}


export function addCollaboratorAction(domain: GitHubDomain, 
  input: { owner: string; repo: string; username: string; permission?: string; actor?: string },
  onDelta?: StateDeltaCallback
) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let invitationState: "pending" | "accepted" = "accepted";
  let alreadyCollaborator = false;
  let beforeState: Record<string, unknown> | null = null;
  let afterState: Record<string, unknown> | null = null;
  domain.transaction(() => {
    if (!input.username.trim()) validationFailed("username", "missing");
    const existing = domain.db.prepare("SELECT * FROM collaborators WHERE repo_id = ? AND login = ?").get(repo.id, input.username) as CollaboratorRow | undefined;
    if (existing) {
      alreadyCollaborator = true;
      invitationState = (existing.invitation_state as "pending" | "accepted") ?? "accepted";
      beforeState = collaboratorAddState(repo, input.username, invitationState, existing.permission);
      const nextPermission = input.permission ?? existing.permission;
      if (input.permission && input.permission !== existing.permission) {
        domain.db.prepare("UPDATE collaborators SET permission = ? WHERE repo_id = ? AND login = ?").run(input.permission, repo.id, input.username);
      }
      afterState = collaboratorAddState(repo, input.username, invitationState, nextPermission);
      return;
    }
    const isSeededUser = Boolean(domain.db.prepare("SELECT 1 FROM users WHERE login = ?").get(input.username));
    invitationState = isSeededUser ? "accepted" : "pending";
    domain.upsertUser(input.username, "User", input.username);
    domain.db.prepare("INSERT INTO collaborators (repo_id, login, permission, invitation_state) VALUES (?, ?, ?, ?)").run(
      repo.id,
      input.username,
      input.permission ?? "push",
      invitationState
    );
    afterState = collaboratorAddState(repo, input.username, invitationState, input.permission ?? "push");
  });
  domain.audit("add_collaborator", repo.full_name, input);
  onDelta?.({ before: beforeState, after: afterState });
  if (alreadyCollaborator && invitationState === "accepted") {
    // GitHub returns 204 for "already a collaborator". We surface the same via `status`.
    return { status: 204, body: null };
  }
  return {
    status: 201,
    body: {
      id: stableNumericId(`${repo.full_name}:invite:${input.username}`),
      node_id: `RI_${stableNumericId(`${repo.full_name}:invite:${input.username}`)}`,
      repository: repoJson(repo),
      invitee: userJson(input.username),
      inviter: userJson(input.actor ?? "pome-agent"),
      permissions: input.permission ?? "push",
      created_at: nowIso(),
      expired: false,
      url: `https://api.github.com/repos/${repo.full_name}/invitations/${input.username}`,
      html_url: `https://github.com/${repo.full_name}/invitations`
    }
  };
}

