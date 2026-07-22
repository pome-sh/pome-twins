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


export function createIssue(domain: GitHubDomain, input: { owner: string; repo: string; title: string; body?: string; labels?: string[]; assignees?: string[] }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const issue = domain.transaction(() => {
    if (!input.title.trim()) validationFailed("title", "missing");
    for (const label of input.labels ?? []) if (!domain.getLabel(repo.id, label)) validationFailed("labels", "missing", label);
    for (const assignee of input.assignees ?? []) if (!domain.hasCollaborator(repo.id, assignee)) validationFailed("assignees", "invalid", assignee);
    const now = nowIso();
    const number = domain.nextNumber(repo.id);
    domain.db.prepare("INSERT INTO issues (repo_id, number, title, body, state, user_login, assignee_login, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, NULL)").run(
      repo.id,
      number,
      input.title,
      input.body ?? "",
      "pome-agent",
      input.assignees?.[0] ?? null,
      now,
      now
    );
    for (const label of input.labels ?? []) domain.db.prepare("INSERT OR IGNORE INTO issue_labels (repo_id, issue_number, label_name) VALUES (?, ?, ?)").run(repo.id, number, label);
    for (const assignee of input.assignees ?? []) domain.db.prepare("INSERT OR IGNORE INTO issue_assignees (repo_id, issue_number, login) VALUES (?, ?, ?)").run(repo.id, number, assignee);
    return domain.requireIssue(repo.id, number);
  });
  domain.audit("create_issue", repo.full_name, input);
  const labels = domain.listIssueLabels(repo.id, issue.number).map((label) => label.name);
  const assignees = domain.listIssueAssignees(repo.id, issue.number);
  onDelta?.({ before: null, after: issueState(issue, repo, labels, assignees) });
  return issueJson(issue, repo, domain.listIssueLabels(repo.id, issue.number), domain.listIssueAssignees(repo.id, issue.number), domain.issueCommentCount(repo.id, issue.number));
}


export function listIssues(domain: GitHubDomain, input: { owner: string; repo: string; state?: "open" | "closed" | "all"; labels?: string; assignee?: string } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let rows = domain.listIssuesRows(repo.id);
  if (input.state && input.state !== "all") rows = rows.filter((issue) => issue.state === input.state);
  if (input.labels) {
    const wanted = input.labels.split(",").map((label) => label.trim()).filter(Boolean);
    rows = rows.filter((issue) => {
      const names = domain.listIssueLabels(repo.id, issue.number).map((label) => label.name);
      return wanted.every((label) => names.includes(label));
    });
  }
  if (input.assignee) rows = rows.filter((issue) => domain.listIssueAssignees(repo.id, issue.number).includes(input.assignee!));
  return paginate(rows, input.page, input.per_page ?? input.perPage).map((issue) => issueJson(issue, repo, domain.listIssueLabels(repo.id, issue.number), domain.listIssueAssignees(repo.id, issue.number), domain.issueCommentCount(repo.id, issue.number)));
}


export function getIssue(domain: GitHubDomain, input: { owner: string; repo: string; issue_number: number }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const issue = domain.requireIssue(repo.id, input.issue_number);
  return issueJson(issue, repo, domain.listIssueLabels(repo.id, issue.number), domain.listIssueAssignees(repo.id, issue.number), domain.issueCommentCount(repo.id, issue.number));
}


export function updateIssue(domain: GitHubDomain, input: { owner: string; repo: string; issue_number: number; title?: string; body?: string; state?: "open" | "closed"; labels?: string[]; assignees?: string[] }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let before: Record<string, unknown> | null = null;
  domain.transaction(() => {
    const issue = domain.requireIssue(repo.id, input.issue_number);
    before = issueState(
      issue,
      repo,
      domain.listIssueLabels(repo.id, issue.number).map((label) => label.name),
      domain.listIssueAssignees(repo.id, issue.number)
    );
    for (const label of input.labels ?? []) if (!domain.getLabel(repo.id, label)) validationFailed("labels", "missing", label);
    for (const assignee of input.assignees ?? []) if (!domain.hasCollaborator(repo.id, assignee)) validationFailed("assignees", "invalid", assignee);
    const state = input.state ?? issue.state;
    const closedAt = state === "closed" && issue.state !== "closed" ? nowIso() : state === "open" ? null : issue.closed_at;
    domain.db.prepare("UPDATE issues SET title = ?, body = ?, state = ?, assignee_login = ?, updated_at = ?, closed_at = ? WHERE repo_id = ? AND number = ?").run(
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
      domain.db.prepare("DELETE FROM issue_labels WHERE repo_id = ? AND issue_number = ?").run(repo.id, issue.number);
      for (const label of input.labels) domain.db.prepare("INSERT INTO issue_labels (repo_id, issue_number, label_name) VALUES (?, ?, ?)").run(repo.id, issue.number, label);
    }
    if (input.assignees) {
      domain.db.prepare("DELETE FROM issue_assignees WHERE repo_id = ? AND issue_number = ?").run(repo.id, issue.number);
      for (const assignee of input.assignees) domain.db.prepare("INSERT INTO issue_assignees (repo_id, issue_number, login) VALUES (?, ?, ?)").run(repo.id, issue.number, assignee);
    }
  });
  domain.audit("update_issue", repo.full_name, input);
  const updated = domain.requireIssue(repo.id, input.issue_number);
  const afterLabels = domain.listIssueLabels(repo.id, updated.number).map((label) => label.name);
  const afterAssignees = domain.listIssueAssignees(repo.id, updated.number);
  onDelta?.({ before, after: issueState(updated, repo, afterLabels, afterAssignees) });
  return domain.getIssue(input);
}


export function addIssueComment(domain: GitHubDomain, input: { owner: string; repo: string; issue_number: number; body: string }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const comment = domain.transaction(() => {
    domain.requireIssue(repo.id, input.issue_number);
    if (!input.body.trim()) validationFailed("body", "missing");
    const now = nowIso();
    const result = domain.db.prepare("INSERT INTO issue_comments (repo_id, issue_number, body, user_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      repo.id,
      input.issue_number,
      input.body,
      "pome-agent",
      now,
      now
    );
    return domain.db.prepare("SELECT * FROM issue_comments WHERE id = ?").get(result.lastInsertRowid) as IssueCommentRow;
  });
  domain.audit("add_issue_comment", repo.full_name, input);
  onDelta?.({ before: null, after: issueCommentState(comment, repo) });
  return issueCommentJson(comment, repo);
}


export function listIssueComments(domain: GitHubDomain, input: { owner: string; repo: string; issue_number: number } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  domain.requireIssue(repo.id, input.issue_number);
  const rows = domain.listIssueCommentRows(repo.id, input.issue_number);
  return paginate(rows, input.page, input.per_page ?? input.perPage).map((comment) => issueCommentJson(comment, repo));
}


export function listRepositoryLabels(domain: GitHubDomain, input: { owner: string; repo: string }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  return domain.listLabels(repo.id).map(labelJson);
}


export function createRepositoryLabel(domain: GitHubDomain, input: { owner: string; repo: string; name: string; color?: string; description?: string }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  domain.transaction(() => {
    if (domain.getLabel(repo.id, input.name)) validationFailed("name", "already_exists", input.name);
    domain.createLabel(repo, input.name, input.color ?? "ededed", input.description ?? "");
  });
  domain.audit("create_label", repo.full_name, input);
  const created = domain.getLabel(repo.id, input.name)!;
  onDelta?.({ before: null, after: labelState(created, repo) });
  return labelJson(created);
}


export function listIssueLabelsForIssue(domain: GitHubDomain, input: { owner: string; repo: string; issue_number: number }) {
  const repo = domain.requireRepo(input.owner, input.repo);
  domain.requireIssue(repo.id, input.issue_number);
  return domain.listIssueLabels(repo.id, input.issue_number).map(labelJson);
}


export function addIssueLabels(domain: GitHubDomain, input: { owner: string; repo: string; issue_number: number; labels: string[] }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let before: Record<string, unknown> | null = null;
  domain.transaction(() => {
    domain.requireIssue(repo.id, input.issue_number);
    before = issueLabelsState(repo, input.issue_number, domain.listIssueLabels(repo.id, input.issue_number).map((label) => label.name));
    for (const label of input.labels) if (!domain.getLabel(repo.id, label)) validationFailed("labels", "missing", label);
    for (const label of input.labels) domain.db.prepare("INSERT OR IGNORE INTO issue_labels (repo_id, issue_number, label_name) VALUES (?, ?, ?)").run(repo.id, input.issue_number, label);
  });
  domain.audit("add_issue_labels", repo.full_name, input);
  const after = issueLabelsState(repo, input.issue_number, domain.listIssueLabels(repo.id, input.issue_number).map((label) => label.name));
  onDelta?.({ before, after });
  return domain.listIssueLabelsForIssue(input);
}


export function deleteIssueLabel(domain: GitHubDomain, input: { owner: string; repo: string; issue_number: number; label: string }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  domain.requireIssue(repo.id, input.issue_number);
  const before = issueLabelsState(repo, input.issue_number, domain.listIssueLabels(repo.id, input.issue_number).map((label) => label.name));
  const result = domain.db.prepare("DELETE FROM issue_labels WHERE repo_id = ? AND issue_number = ? AND label_name = ?").run(repo.id, input.issue_number, input.label);
  if (!result.changes) notFound("Label not found");
  domain.audit("delete_issue_label", repo.full_name, input);
  const after = issueLabelsState(repo, input.issue_number, domain.listIssueLabels(repo.id, input.issue_number).map((label) => label.name));
  onDelta?.({ before, after });
  return domain.listIssueLabelsForIssue(input);
}


export function addAssignees(domain: GitHubDomain, input: { owner: string; repo: string; issue_number: number; assignees: string[] }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let before: Record<string, unknown> | null = null;
  domain.transaction(() => {
    const issue = domain.requireIssue(repo.id, input.issue_number);
    before = issueAssigneesState(repo, issue.number, domain.listIssueAssignees(repo.id, issue.number));
    for (const assignee of input.assignees) if (!domain.hasCollaborator(repo.id, assignee)) validationFailed("assignees", "invalid", assignee);
    for (const assignee of input.assignees) domain.db.prepare("INSERT OR IGNORE INTO issue_assignees (repo_id, issue_number, login) VALUES (?, ?, ?)").run(repo.id, issue.number, assignee);
    const firstAssignee = input.assignees[0] ?? issue.assignee_login;
    domain.db.prepare("UPDATE issues SET assignee_login = ?, updated_at = ? WHERE repo_id = ? AND number = ?").run(firstAssignee, nowIso(), repo.id, issue.number);
  });
  domain.audit("add_assignees", repo.full_name, input);
  const after = issueAssigneesState(repo, input.issue_number, domain.listIssueAssignees(repo.id, input.issue_number));
  onDelta?.({ before, after });
  return domain.getIssue(input);
}

// Cluster D — issue comments deeper --------------------------------------

export function updateIssueComment(domain: GitHubDomain, input: { owner: string; repo: string; comment_id: number; body: string }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let before: Record<string, unknown> | null = null;
  const comment = domain.transaction(() => {
    const row = domain.db.prepare("SELECT * FROM issue_comments WHERE id = ? AND repo_id = ?").get(input.comment_id, repo.id) as IssueCommentRow | undefined;
    if (!row) notFound("Issue comment not found");
    before = issueCommentState(row, repo);
    if (!input.body.trim()) validationFailed("body", "missing");
    const now = nowIso();
    domain.db.prepare("UPDATE issue_comments SET body = ?, updated_at = ? WHERE id = ?").run(input.body, now, input.comment_id);
    return domain.db.prepare("SELECT * FROM issue_comments WHERE id = ?").get(input.comment_id) as IssueCommentRow;
  });
  domain.audit("update_issue_comment", repo.full_name, input);
  onDelta?.({ before, after: issueCommentState(comment, repo) });
  return issueCommentJson(comment, repo);
}


export function deleteIssueComment(domain: GitHubDomain, input: { owner: string; repo: string; comment_id: number }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let before: Record<string, unknown> | null = null;
  domain.transaction(() => {
    const row = domain.db.prepare("SELECT * FROM issue_comments WHERE id = ? AND repo_id = ?").get(input.comment_id, repo.id) as IssueCommentRow | undefined;
    if (!row) notFound("Issue comment not found");
    before = issueCommentState(row, repo);
    domain.db.prepare("DELETE FROM issue_comments WHERE id = ?").run(input.comment_id);
  });
  domain.audit("delete_issue_comment", repo.full_name, input);
  onDelta?.({ before, after: null });
  return { ok: true };
}

// Cluster E — milestones CRUD --------------------------------------------

export function listMilestones(domain: GitHubDomain, input: { owner: string; repo: string; state?: "open" | "closed" | "all" } & PageOptions) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let rows = domain.db.prepare("SELECT * FROM milestones WHERE repo_id = ? ORDER BY number ASC").all(repo.id) as MilestoneRow[];
  if (input.state && input.state !== "all") rows = rows.filter((milestone) => milestone.state === input.state);
  return paginate(rows, input.page, input.per_page ?? input.perPage).map((milestone) => milestoneJson(milestone, repo));
}


export function createMilestone(domain: GitHubDomain, 
  input: { owner: string; repo: string; title: string; description?: string; due_on?: string; state?: "open" | "closed" },
  onDelta?: StateDeltaCallback
) {
  const repo = domain.requireRepo(input.owner, input.repo);
  const milestone = domain.transaction(() => {
    if (!input.title.trim()) validationFailed("title", "missing");
    const duplicate = domain.db.prepare("SELECT number FROM milestones WHERE repo_id = ? AND title = ?").get(repo.id, input.title) as { number: number } | undefined;
    if (duplicate) validationFailed("title", "already_exists", input.title);
    const number = domain.nextMilestoneNumber(repo.id);
    const now = nowIso();
    const state = input.state ?? "open";
    domain.db.prepare("INSERT INTO milestones (repo_id, number, title, state, description, due_on, creator_login, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      repo.id,
      number,
      input.title,
      state,
      input.description ?? "",
      input.due_on ?? null,
      "pome-agent",
      now,
      now,
      state === "closed" ? now : null
    );
    return domain.db.prepare("SELECT * FROM milestones WHERE repo_id = ? AND number = ?").get(repo.id, number) as MilestoneRow;
  });
  domain.audit("create_milestone", repo.full_name, input);
  onDelta?.({ before: null, after: milestoneState(milestone, repo) });
  return milestoneJson(milestone, repo);
}


export function updateMilestone(domain: GitHubDomain, 
  input: { owner: string; repo: string; milestone_number: number; title?: string; description?: string; due_on?: string; state?: "open" | "closed" },
  onDelta?: StateDeltaCallback
) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let before: Record<string, unknown> | null = null;
  const milestone = domain.transaction(() => {
    const existing = domain.db.prepare("SELECT * FROM milestones WHERE repo_id = ? AND number = ?").get(repo.id, input.milestone_number) as MilestoneRow | undefined;
    if (!existing) notFound("Milestone not found");
    before = milestoneState(existing, repo);
    const nextTitle = input.title ?? existing.title;
    if (!nextTitle.trim()) validationFailed("title", "missing");
    if (nextTitle !== existing.title) {
      const duplicate = domain.db.prepare("SELECT number FROM milestones WHERE repo_id = ? AND title = ? AND number != ?").get(repo.id, nextTitle, existing.number) as { number: number } | undefined;
      if (duplicate) validationFailed("title", "already_exists", nextTitle);
    }
    const state = input.state ?? existing.state;
    const closedAt = state === "closed" && existing.state !== "closed" ? nowIso() : state === "open" ? null : existing.closed_at;
    const now = nowIso();
    domain.db.prepare("UPDATE milestones SET title = ?, description = ?, state = ?, due_on = ?, updated_at = ?, closed_at = ? WHERE repo_id = ? AND number = ?").run(
      nextTitle,
      input.description ?? existing.description,
      state,
      input.due_on ?? existing.due_on,
      now,
      closedAt,
      repo.id,
      existing.number
    );
    return domain.db.prepare("SELECT * FROM milestones WHERE repo_id = ? AND number = ?").get(repo.id, existing.number) as MilestoneRow;
  });
  domain.audit("update_milestone", repo.full_name, input);
  onDelta?.({ before, after: milestoneState(milestone, repo) });
  return milestoneJson(milestone, repo);
}


export function deleteMilestone(domain: GitHubDomain, input: { owner: string; repo: string; milestone_number: number }, onDelta?: StateDeltaCallback) {
  const repo = domain.requireRepo(input.owner, input.repo);
  let before: Record<string, unknown> | null = null;
  domain.transaction(() => {
    const existing = domain.db.prepare("SELECT * FROM milestones WHERE repo_id = ? AND number = ?").get(repo.id, input.milestone_number) as MilestoneRow | undefined;
    if (!existing) notFound("Milestone not found");
    before = milestoneState(existing, repo);
    domain.db.prepare("DELETE FROM milestones WHERE repo_id = ? AND number = ?").run(repo.id, input.milestone_number);
  });
  domain.audit("delete_milestone", repo.full_name, input);
  onDelta?.({ before, after: null });
  return { ok: true };
}

