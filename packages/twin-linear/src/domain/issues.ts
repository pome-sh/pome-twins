// SPDX-License-Identifier: Apache-2.0
import { badUserInput } from "../errors.js";
import type { LinearIssue } from "../types.js";
import { appendIssueRelations, type IssueRelationAppendInput } from "./issue-relations.js";
import { assertBody, assertTitle, normalizePriority } from "./normalize.js";
import type { ActorContext, LinearDomain } from "./linear-domain.js";
import { mapIssue, type IssueRow } from "./rows.js";
import { emitWebhook, issueWebhookPayload } from "./webhooks.js";

export type IssueCreateInput = {
  teamId: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  estimate?: number | null;
  stateId?: string | null;
  assigneeId?: string | null;
  delegateId?: string | null;
  labelIds?: string[] | null;
  projectId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  createAsUser?: string | null;
  displayIconUrl?: string | null;
  dueDate?: string | null;
} & IssueRelationAppendInput;

export type IssueUpdateInput = {
  title?: string;
  description?: string | null;
  priority?: number | null;
  estimate?: number | null;
  stateId?: string | null;
  assigneeId?: string | null;
  delegateId?: string | null;
  labelIds?: string[] | null;
  projectId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
  archivedAt?: string | null;
  dueDate?: string | null;
} & IssueRelationAppendInput;

/** SQL-backed issue list filters (refs resolved before the query runs). */
export type IssueListFilter = {
  team?: string;
  assignee?: string;
  creator?: string;
  state?: string;
  label?: string;
  project?: string;
  cycle?: string;
  query?: string;
  includeArchived?: boolean;
};

type IssueSqlClause = { where: string[]; params: unknown[] };

function buildIssueSqlFilter(domain: LinearDomain, filter: IssueListFilter): IssueSqlClause | null {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!filter.includeArchived) {
    where.push("archived_at IS NULL");
  }

  if (filter.team) {
    const team = domain.getTeam(filter.team);
    if (!team) return null;
    where.push("team_id = ?");
    params.push(team.id);
  }

  if (filter.assignee) {
    // Callers must resolve "me" to a concrete user before filtering. A literal
    // "me" (or any unknown ref) matches nobody rather than silently returning all.
    const user = domain.getUser(filter.assignee);
    if (!user) return null;
    where.push("assignee_id = ?");
    params.push(user.id);
  }

  if (filter.creator) {
    const user = domain.getUser(filter.creator);
    if (!user) return null;
    where.push("creator_id = ?");
    params.push(user.id);
  }

  if (filter.state) {
    const state = domain.getWorkflowState(filter.state, filter.team);
    if (!state) return null;
    where.push("state_id = ?");
    params.push(state.id);
  }

  if (filter.label) {
    const label = domain.getLabel(filter.label, filter.team);
    if (!label) return null;
    where.push("id IN (SELECT issue_id FROM issue_label_links WHERE label_id = ?)");
    params.push(label.id);
  }

  if (filter.project) {
    const project = domain.getProject(filter.project);
    if (!project) return null;
    where.push("project_id = ?");
    params.push(project.id);
  }

  if (filter.cycle) {
    const cycle = domain.getCycle(filter.cycle, filter.team);
    if (!cycle) return null;
    where.push("cycle_id = ?");
    params.push(cycle.id);
  }

  if (filter.query) {
    const q = `%${filter.query.toLowerCase()}%`;
    where.push("(LOWER(title) LIKE ? OR LOWER(COALESCE(description, '')) LIKE ?)");
    params.push(q, q);
  }

  return { where, params };
}

export function listIssues(domain: LinearDomain, filter: IssueListFilter = {}): LinearIssue[] {
  const clause = buildIssueSqlFilter(domain, filter);
  if (!clause) return [];
  const sql =
    clause.where.length === 0
      ? "SELECT * FROM issues ORDER BY created_at, id"
      : `SELECT * FROM issues WHERE ${clause.where.join(" AND ")} ORDER BY created_at, id`;
  return (domain.db.prepare(sql).all(...clause.params) as IssueRow[]).map((row) => mapIssue(domain.db, row));
}

export function countIssues(domain: LinearDomain, filter: IssueListFilter = {}): number {
  const clause = buildIssueSqlFilter(domain, filter);
  if (!clause) return 0;
  const sql =
    clause.where.length === 0
      ? "SELECT COUNT(*) AS n FROM issues"
      : `SELECT COUNT(*) AS n FROM issues WHERE ${clause.where.join(" AND ")}`;
  const row = domain.db.prepare(sql).get(...clause.params) as { n: number };
  return row.n;
}

export function getIssue(domain: LinearDomain, ref: string): LinearIssue | null {
  const row = domain.db
    .prepare(`SELECT * FROM issues WHERE id = ? OR identifier = ? LIMIT 1`)
    .get(ref, ref) as IssueRow | undefined;
  return row ? mapIssue(domain.db, row) : null;
}

export async function createIssue(
  domain: LinearDomain,
  input: IssueCreateInput,
  actor: ActorContext = {}
): Promise<LinearIssue> {
  domain.requireScopes(actor, ["issues:create"]);
  assertTitle(input.title);
  if (input.description != null) assertBody(input.description);
  const team = domain.requireTeam(input.teamId);
  const state =
    (input.stateId ? domain.getWorkflowState(input.stateId, team.id) : null) ??
    domain.getWorkflowState("Todo", team.id) ??
    domain.listWorkflowStates(team.id)[0];
  if (!state) badUserInput("No workflow state exists for the selected team");
  const viewer = domain.resolveViewer(actor);
  const now = domain.tick();
  const number = nextIssueNumber(domain, team.id);
  const id = domain.nextId("issue");
  const identifier = `${team.key}-${number}`;
  const labelIds = (input.labelIds ?? []).map((ref) => domain.requireLabel(ref, team.id).id);
  const assigneeId = input.assigneeId ? domain.requireUser(input.assigneeId).id : null;
  const delegateId = input.delegateId ? domain.requireUser(input.delegateId).id : null;
  const projectId = input.projectId ? domain.requireProject(input.projectId, team.id).id : null;
  const cycleId = input.cycleId ? domain.requireCycle(input.cycleId, team.id).id : null;
  const parentId = input.parentId ? domain.requireIssue(input.parentId).id : null;
  if (parentId === id) badUserInput("Issue cannot be its own parent");
  const estimate = normalizeEstimate(input.estimate);
  const baseUrl = domain.config("base_url") ?? "http://127.0.0.1:3337";

  domain.db
    .prepare(
      `INSERT INTO issues(
          id, identifier, number, team_id, title, description, priority, estimate, state_id,
          assignee_id, creator_id, delegate_id, project_id, cycle_id, parent_id, url,
          archived_at, canceled_at, completed_at, started_at, due_date,
          create_as_user, display_icon_url, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      identifier,
      number,
      team.id,
      input.title,
      input.description ?? null,
      normalizePriority(input.priority),
      estimate,
      state.id,
      assigneeId,
      viewer.id,
      delegateId,
      projectId,
      cycleId,
      parentId,
      `${baseUrl}/issue/${identifier}`,
      null,
      state.type === "canceled" ? now : null,
      state.type === "completed" ? now : null,
      state.type === "started" ? now : null,
      input.dueDate ?? null,
      input.createAsUser ?? null,
      input.displayIconUrl ?? null,
      now,
      now
    );
  setIssueLabels(domain, id, labelIds);
  appendIssueRelations(domain, id, input);
  const issue = domain.requireIssue(id);
  await emitWebhook(domain, {
    type: "Issue",
    action: "create",
    data: issueWebhookPayload(issue),
    actor: viewer,
    teamId: issue.teamId,
    url: issue.url,
  });
  if (issue.delegateId) {
    await domain.createAgentSessionOnIssue({ issueId: issue.id, agentUserId: issue.delegateId }, actor);
  }
  return issue;
}

export async function updateIssue(
  domain: LinearDomain,
  id: string,
  input: IssueUpdateInput,
  actor: ActorContext = {}
): Promise<LinearIssue> {
  domain.requireScopes(actor, ["write"]);
  const issue = domain.requireIssue(id);
  const before = issueWebhookPayload(issue);
  const patch: Partial<IssueRow> = {};
  let changed = false;
  if ("title" in input && input.title !== undefined) {
    assertTitle(input.title);
    patch.title = input.title;
    if (input.title !== issue.title) changed = true;
  }
  if ("description" in input) {
    if (input.description != null) assertBody(input.description);
    patch.description = input.description ?? null;
    if ((input.description ?? null) !== issue.description) changed = true;
  }
  if ("priority" in input) {
    patch.priority = normalizePriority(input.priority);
    if (patch.priority !== issue.priority) changed = true;
  }
  if ("estimate" in input) {
    patch.estimate = normalizeEstimate(input.estimate);
    if (patch.estimate !== issue.estimate) changed = true;
  }
  if ("parentId" in input) {
    patch.parent_id = input.parentId ? domain.requireIssue(input.parentId).id : null;
    if (patch.parent_id === issue.id) badUserInput("Issue cannot be its own parent");
    if (patch.parent_id) {
      // Reject ancestry cycles (A→B→A) by walking the proposed parent's chain.
      let cursor: string | null = patch.parent_id;
      const seen = new Set<string>([issue.id]);
      while (cursor) {
        if (seen.has(cursor)) badUserInput("Issue parent would create a cycle");
        seen.add(cursor);
        const row = domain.db
          .prepare("SELECT parent_id AS parentId FROM issues WHERE id = ?")
          .get(cursor) as { parentId: string | null } | undefined;
        cursor = row?.parentId ?? null;
      }
    }
    if (patch.parent_id !== issue.parentId) changed = true;
  }
  if ("stateId" in input && input.stateId != null) {
    const state = domain.requireState(input.stateId, issue.teamId);
    const now = domain.now();
    patch.state_id = state.id;
    patch.started_at =
      state.type === "started" ? (issue.startedAt ?? now) : state.type === "completed" ? issue.startedAt : null;
    patch.completed_at = state.type === "completed" ? (issue.completedAt ?? now) : null;
    patch.canceled_at = state.type === "canceled" ? (issue.canceledAt ?? now) : null;
    if (state.id !== issue.stateId) changed = true;
  }
  if ("assigneeId" in input) {
    patch.assignee_id = input.assigneeId ? domain.requireUser(input.assigneeId).id : null;
    if (patch.assignee_id !== issue.assigneeId) changed = true;
  }
  if ("delegateId" in input) {
    patch.delegate_id = input.delegateId ? domain.requireUser(input.delegateId).id : null;
    if (patch.delegate_id !== issue.delegateId) changed = true;
  }
  if ("projectId" in input) {
    patch.project_id = input.projectId ? domain.requireProject(input.projectId, issue.teamId).id : null;
    if (patch.project_id !== issue.projectId) changed = true;
  }
  if ("cycleId" in input) {
    patch.cycle_id = input.cycleId ? domain.requireCycle(input.cycleId, issue.teamId).id : null;
    if (patch.cycle_id !== issue.cycleId) changed = true;
  }
  if ("archivedAt" in input) {
    patch.archived_at = input.archivedAt ?? null;
    if ((input.archivedAt ?? null) !== issue.archivedAt) changed = true;
  }
  if ("dueDate" in input) {
    patch.due_date = input.dueDate ?? null;
    if ((input.dueDate ?? null) !== issue.dueDate) changed = true;
  }

  let nextLabelIds: string[] | undefined;
  if ("labelIds" in input && input.labelIds !== undefined && input.labelIds !== null) {
    nextLabelIds = input.labelIds.map((ref) => domain.requireLabel(ref, issue.teamId).id);
    const beforeLabels = [...issue.labelIds].sort().join("\0");
    const afterLabels = [...nextLabelIds].sort().join("\0");
    if (beforeLabels !== afterLabels) changed = true;
  }

  const relationsChanged = appendIssueRelations(domain, issue.id, input);
  if (relationsChanged) changed = true;

  if (!changed) return issue;

  const now = domain.tick();
  domain.db
    .prepare(
      `UPDATE issues SET
          title = COALESCE(?, title),
          description = CASE WHEN ? THEN ? ELSE description END,
          priority = COALESCE(?, priority),
          estimate = CASE WHEN ? THEN ? ELSE estimate END,
          state_id = COALESCE(?, state_id),
          assignee_id = CASE WHEN ? THEN ? ELSE assignee_id END,
          delegate_id = CASE WHEN ? THEN ? ELSE delegate_id END,
          project_id = CASE WHEN ? THEN ? ELSE project_id END,
          cycle_id = CASE WHEN ? THEN ? ELSE cycle_id END,
          parent_id = CASE WHEN ? THEN ? ELSE parent_id END,
          archived_at = CASE WHEN ? THEN ? ELSE archived_at END,
          canceled_at = CASE WHEN ? THEN ? ELSE canceled_at END,
          completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
          started_at = CASE WHEN ? THEN ? ELSE started_at END,
          due_date = CASE WHEN ? THEN ? ELSE due_date END,
          updated_at = ?
        WHERE id = ?`
    )
    .run(
      patch.title ?? null,
      "description" in input ? 1 : 0,
      patch.description ?? null,
      patch.priority ?? null,
      "estimate" in input ? 1 : 0,
      patch.estimate ?? null,
      patch.state_id ?? null,
      "assigneeId" in input ? 1 : 0,
      patch.assignee_id ?? null,
      "delegateId" in input ? 1 : 0,
      patch.delegate_id ?? null,
      "projectId" in input ? 1 : 0,
      patch.project_id ?? null,
      "cycleId" in input ? 1 : 0,
      patch.cycle_id ?? null,
      "parentId" in input ? 1 : 0,
      patch.parent_id ?? null,
      "archivedAt" in input ? 1 : 0,
      patch.archived_at ?? null,
      // Must CASE-clear timestamps on reopen — COALESCE(null, completed_at) would keep Done stamps.
      "stateId" in input ? 1 : 0,
      patch.canceled_at ?? null,
      "stateId" in input ? 1 : 0,
      patch.completed_at ?? null,
      "stateId" in input ? 1 : 0,
      patch.started_at ?? null,
      "dueDate" in input ? 1 : 0,
      patch.due_date ?? null,
      now,
      issue.id
    );

  if (nextLabelIds) {
    setIssueLabels(domain, issue.id, nextLabelIds);
  }

  const updated = domain.requireIssue(issue.id);
  const viewer = domain.resolveViewer(actor);
  await emitWebhook(domain, {
    type: "Issue",
    action: "update",
    data: issueWebhookPayload(updated),
    actor: viewer,
    teamId: updated.teamId,
    url: updated.url,
    updatedFrom: before,
  });
  if (updated.delegateId && updated.delegateId !== issue.delegateId) {
    await domain.createAgentSessionOnIssue({ issueId: updated.id, agentUserId: updated.delegateId }, actor);
  }
  return updated;
}

export async function deleteIssue(
  domain: LinearDomain,
  id: string,
  actor: ActorContext = {}
): Promise<LinearIssue> {
  domain.requireScopes(actor, ["write"]);
  const issue = domain.requireIssue(id);
  const viewer = domain.resolveViewer(actor);
  domain.db
    .prepare(
      "DELETE FROM agent_activities WHERE session_id IN (SELECT id FROM agent_sessions WHERE issue_id = ?)"
    )
    .run(issue.id);
  domain.db.prepare("DELETE FROM agent_sessions WHERE issue_id = ?").run(issue.id);
  domain.db.prepare("DELETE FROM comments WHERE issue_id = ?").run(issue.id);
  domain.db
    .prepare("DELETE FROM issue_relations WHERE issue_id = ? OR related_issue_id = ?")
    .run(issue.id, issue.id);
  domain.db.prepare("DELETE FROM issue_label_links WHERE issue_id = ?").run(issue.id);
  domain.db.prepare("DELETE FROM issues WHERE id = ?").run(issue.id);
  await emitWebhook(domain, {
    type: "Issue",
    action: "remove",
    data: issueWebhookPayload(issue),
    actor: viewer,
    teamId: issue.teamId,
    url: issue.url,
  });
  return issue;
}

export async function archiveIssue(
  domain: LinearDomain,
  id: string,
  actor: ActorContext = {}
): Promise<LinearIssue> {
  domain.requireScopes(actor, ["write"]);
  const issue = domain.requireIssue(id);
  const now = domain.tick();
  domain.db.prepare("UPDATE issues SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, issue.id);
  const updated = domain.requireIssue(issue.id);
  await emitWebhook(domain, {
    type: "Issue",
    action: "archive",
    data: issueWebhookPayload(updated),
    actor: domain.resolveViewer(actor),
    teamId: updated.teamId,
    url: updated.url,
  });
  return updated;
}

export async function unarchiveIssue(
  domain: LinearDomain,
  id: string,
  actor: ActorContext = {}
): Promise<LinearIssue> {
  domain.requireScopes(actor, ["write"]);
  const issue = domain.requireIssue(id);
  const now = domain.tick();
  domain.db.prepare("UPDATE issues SET archived_at = NULL, updated_at = ? WHERE id = ?").run(now, issue.id);
  const updated = domain.requireIssue(issue.id);
  await emitWebhook(domain, {
    type: "Issue",
    action: "unarchive",
    data: issueWebhookPayload(updated),
    actor: domain.resolveViewer(actor),
    teamId: updated.teamId,
    url: updated.url,
  });
  return updated;
}

export function nextIssueNumber(domain: LinearDomain, teamId: string): number {
  const team = domain.requireTeam(teamId);
  const next = team.issueSequence + 1;
  domain.db
    .prepare("UPDATE teams SET issue_sequence = ?, updated_at = ? WHERE id = ?")
    .run(next, domain.now(), team.id);
  return next;
}

export function setIssueLabels(domain: LinearDomain, issueId: string, labelIds: string[]): void {
  domain.db.prepare("DELETE FROM issue_label_links WHERE issue_id = ?").run(issueId);
  const insert = domain.db.prepare("INSERT INTO issue_label_links(issue_id, label_id) VALUES (?, ?)");
  for (const labelId of labelIds) insert.run(issueId, labelId);
}

function normalizeEstimate(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) badUserInput("estimate must be a non-negative number");
  return Math.floor(value);
}
