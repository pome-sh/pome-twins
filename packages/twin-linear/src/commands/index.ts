// file-size: LinearCommands is the single SQLite mutation surface for GraphQL+MCP+OAuth — split would duplicate transactions and webhook hooks.
// SPDX-License-Identifier: Apache-2.0
import { resetDatabase } from "../db.js";
import { badUserInput, notFound } from "../errors.js";
import { byteLength, linearId, linearIdFromCounter, slugify, token } from "../ids.js";
import { defaultSeedState, parseSeed, type ParsedLinearStateSeed } from "../seed.js";
import { exportLinearState, type LinearStateExport } from "../state.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  BODY_MAX_BYTES,
  DEFAULT_LINEAR_CLOCK,
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_LINEAR_SID,
  DEFAULT_SCOPES,
  TITLE_MAX_BYTES,
  type LinearAgentActivity,
  type LinearAgentActivityType,
  type LinearAgentSession,
  type LinearAgentSessionState,
  type LinearComment,
  type LinearCycle,
  type LinearIssue,
  type LinearIssueLabel,
  type LinearIssuePriority,
  type LinearOAuthApp,
  type LinearOrganization,
  type LinearProject,
  type LinearProjectState,
  type LinearStateSeed,
  type LinearTeam,
  type LinearToken,
  type LinearTokenActorType,
  type LinearTokenType,
  type LinearTwinDatabase,
  type LinearUser,
  type LinearWebhook,
  type LinearWebhookDelivery,
  type LinearWorkflowState,
  type LinearWorkflowStateType,
} from "../types.js";
import { dispatchLinearWebhook } from "../webhooks/dispatch.js";

export type ActorContext = {
  userId?: string | null;
  email?: string | null;
  scopes?: string[];
};

type IssueCreateInput = {
  teamId: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  stateId?: string | null;
  assigneeId?: string | null;
  delegateId?: string | null;
  labelIds?: string[] | null;
  projectId?: string | null;
  cycleId?: string | null;
  createAsUser?: string | null;
  displayIconUrl?: string | null;
  dueDate?: string | null;
};

type IssueUpdateInput = {
  title?: string;
  description?: string | null;
  priority?: number | null;
  stateId?: string | null;
  assigneeId?: string | null;
  delegateId?: string | null;
  labelIds?: string[] | null;
  projectId?: string | null;
  cycleId?: string | null;
  archivedAt?: string | null;
  dueDate?: string | null;
};

/** Alias used by public package exports. */
export type LinearDomain = LinearCommands;

export class LinearCommands {
  constructor(readonly db: LinearTwinDatabase) {}

  seed(input: LinearStateSeed | ParsedLinearStateSeed): void {
    const seed = parseSeed(input);
    this.db.transaction(() => {
      resetDatabase(this.db);
      this.applySeed(seed);
    }).immediate();
  }

  resetToDefault(): void {
    this.seed(defaultSeedState());
  }

  exportState(): LinearStateExport {
    return exportLinearState(this.db);
  }

  now(): string {
    const clock = this.config("clock") ?? DEFAULT_LINEAR_CLOCK;
    const counter = Number(this.config("logical_counter") ?? "0");
    const base = Date.parse(clock);
    return new Date(base + counter).toISOString();
  }

  tick(): string {
    const next = Number(this.config("logical_counter") ?? "0") + 1;
    this.setConfig("logical_counter", String(next));
    return this.now();
  }

  nextId(namespace = "entity"): string {
    const next = Number(this.config("id_counter") ?? "0") + 1;
    this.setConfig("id_counter", String(next));
    return linearIdFromCounter(namespace, next);
  }

  requireScopes(actor: ActorContext, required: string[]): void {
    if (!this.strictScopes() || required.length === 0) return;
    const provided = new Set(actor.scopes ?? []);
    if (provided.has("admin")) return;
    const missing = required.filter((scope) => {
      if (provided.has(scope)) return false;
      if ((scope === "issues:create" || scope === "comments:create") && provided.has("write")) return false;
      return true;
    });
    if (missing.length) badUserInput(`Missing required Linear scope: ${missing.join(", ")}`);
  }

  resolveViewer(actor: ActorContext = {}): LinearUser {
    if (actor.userId) {
      const byId = this.getUser(actor.userId);
      if (byId) return byId;
    }
    if (actor.email) {
      const byEmail = this.getUser(actor.email);
      if (byEmail) return byEmail;
    }
    return (
      this.listUsers().find((u) => u.admin && !u.app) ??
      this.listUsers().find((u) => !u.app) ??
      this.listUsers()[0] ??
      notFound("User")
    );
  }

  getOrganization(): LinearOrganization | null {
    const row = this.db.prepare("SELECT * FROM organizations LIMIT 1").get() as OrgRow | undefined;
    return row ? mapOrg(row) : null;
  }

  listUsers(): LinearUser[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY created_at, id").all() as UserRow[]).map(mapUser);
  }

  getUser(ref: string): LinearUser | null {
    const row = this.db
      .prepare(
        `SELECT * FROM users WHERE id = ? OR email = ? COLLATE NOCASE OR name = ? OR display_name = ? LIMIT 1`
      )
      .get(ref, ref, ref, ref) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  listTeams(): LinearTeam[] {
    return (this.db.prepare("SELECT * FROM teams ORDER BY key").all() as TeamRow[]).map(mapTeam);
  }

  getTeam(ref: string): LinearTeam | null {
    const row = this.db
      .prepare(`SELECT * FROM teams WHERE id = ? OR key = ? OR name = ? LIMIT 1`)
      .get(ref, ref, ref) as TeamRow | undefined;
    return row ? mapTeam(row) : null;
  }

  listWorkflowStates(teamRef?: string): LinearWorkflowState[] {
    if (!teamRef) {
      return (
        this.db.prepare("SELECT * FROM workflow_states ORDER BY position, name").all() as StateRow[]
      ).map(mapState);
    }
    const team = this.getTeam(teamRef);
    if (!team) return [];
    return (
      this.db
        .prepare("SELECT * FROM workflow_states WHERE team_id = ? ORDER BY position, name")
        .all(team.id) as StateRow[]
    ).map(mapState);
  }

  getWorkflowState(ref: string, teamRef?: string): LinearWorkflowState | null {
    const states = this.listWorkflowStates(teamRef);
    return (
      states.find((s) => s.id === ref || s.name === ref || s.type === ref) ??
      this.listWorkflowStates().find((s) => s.id === ref || s.name === ref) ??
      null
    );
  }

  listIssues(filter: {
    team?: string;
    assignee?: string;
    state?: string;
    query?: string;
    includeArchived?: boolean;
  } = {}): LinearIssue[] {
    let issues = (this.db.prepare("SELECT * FROM issues ORDER BY created_at, id").all() as IssueRow[]).map(
      (row) => this.mapIssue(row)
    );
    if (!filter.includeArchived) issues = issues.filter((i) => !i.archivedAt);
    if (filter.team) {
      const team = this.getTeam(filter.team);
      if (team) issues = issues.filter((i) => i.teamId === team.id);
      else issues = [];
    }
    if (filter.assignee) {
      if (filter.assignee === "me") {
        // caller should pass resolved user; treat as no-op filter if unresolved
      } else {
        const user = this.getUser(filter.assignee);
        issues = user ? issues.filter((i) => i.assigneeId === user.id) : [];
      }
    }
    if (filter.state) {
      const state = this.getWorkflowState(filter.state, filter.team);
      issues = state ? issues.filter((i) => i.stateId === state.id) : [];
    }
    if (filter.query) {
      const q = filter.query.toLowerCase();
      issues = issues.filter(
        (i) => i.title.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q)
      );
    }
    return issues;
  }

  getIssue(ref: string): LinearIssue | null {
    const row = this.db
      .prepare(`SELECT * FROM issues WHERE id = ? OR identifier = ? LIMIT 1`)
      .get(ref, ref) as IssueRow | undefined;
    return row ? this.mapIssue(row) : null;
  }

  async createIssue(input: IssueCreateInput, actor: ActorContext = {}): Promise<LinearIssue> {
    assertTitle(input.title);
    if (input.description != null) assertBody(input.description);
    const team = this.requireTeam(input.teamId);
    const state =
      (input.stateId ? this.getWorkflowState(input.stateId, team.id) : null) ??
      this.getWorkflowState("Todo", team.id) ??
      this.listWorkflowStates(team.id)[0];
    if (!state) badUserInput("No workflow state exists for the selected team");
    const viewer = this.resolveViewer(actor);
    const now = this.tick();
    const number = this.nextIssueNumber(team.id);
    const id = this.nextId("issue");
    const identifier = `${team.key}-${number}`;
    const labelIds = (input.labelIds ?? [])
      .map((ref) => this.requireLabel(ref, team.id).id)
      .filter(Boolean);
    const assigneeId = input.assigneeId ? this.requireUser(input.assigneeId).id : null;
    const delegateId = input.delegateId ? this.requireUser(input.delegateId).id : null;
    const projectId = input.projectId ? this.requireProject(input.projectId, team.id).id : null;
    const cycleId = input.cycleId ? this.requireCycle(input.cycleId, team.id).id : null;
    const baseUrl = this.config("base_url") ?? "http://127.0.0.1:3337";

    this.db
      .prepare(
        `INSERT INTO issues(
          id, identifier, number, team_id, title, description, priority, state_id,
          assignee_id, creator_id, delegate_id, project_id, cycle_id, url,
          archived_at, canceled_at, completed_at, started_at, due_date,
          create_as_user, display_icon_url, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        identifier,
        number,
        team.id,
        input.title,
        input.description ?? null,
        normalizePriority(input.priority),
        state.id,
        assigneeId,
        viewer.id,
        delegateId,
        projectId,
        cycleId,
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
    this.setIssueLabels(id, labelIds);
    const issue = this.getIssue(id)!;
    await dispatchLinearWebhook(this, {
      type: "Issue",
      action: "create",
      data: this.issueWebhookPayload(issue),
      actor: viewer,
      teamId: issue.teamId,
      url: issue.url,
    });
    if (issue.delegateId) {
      await this.createAgentSessionOnIssue({ issueId: issue.id, agentUserId: issue.delegateId }, actor);
    }
    return issue;
  }

  async updateIssue(id: string, input: IssueUpdateInput, actor: ActorContext = {}): Promise<LinearIssue> {
    const issue = this.requireIssue(id);
    const before = this.issueWebhookPayload(issue);
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
    if ("stateId" in input && input.stateId != null) {
      const state = this.requireState(input.stateId, issue.teamId);
      const now = this.now();
      patch.state_id = state.id;
      patch.started_at =
        state.type === "started" ? (issue.startedAt ?? now) : state.type === "completed" ? issue.startedAt : null;
      patch.completed_at = state.type === "completed" ? (issue.completedAt ?? now) : null;
      patch.canceled_at = state.type === "canceled" ? (issue.canceledAt ?? now) : null;
      if (state.id !== issue.stateId) changed = true;
    }
    if ("assigneeId" in input) {
      patch.assignee_id = input.assigneeId ? this.requireUser(input.assigneeId).id : null;
      if (patch.assignee_id !== issue.assigneeId) changed = true;
    }
    if ("delegateId" in input) {
      patch.delegate_id = input.delegateId ? this.requireUser(input.delegateId).id : null;
      if (patch.delegate_id !== issue.delegateId) changed = true;
    }
    if ("projectId" in input) {
      patch.project_id = input.projectId ? this.requireProject(input.projectId, issue.teamId).id : null;
      if (patch.project_id !== issue.projectId) changed = true;
    }
    if ("cycleId" in input) {
      patch.cycle_id = input.cycleId ? this.requireCycle(input.cycleId, issue.teamId).id : null;
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
    if ("labelIds" in input && input.labelIds) {
      nextLabelIds = input.labelIds.map((ref) => this.requireLabel(ref, issue.teamId).id);
      const beforeLabels = [...issue.labelIds].sort().join("\0");
      const afterLabels = [...nextLabelIds].sort().join("\0");
      if (beforeLabels !== afterLabels) changed = true;
    }

    if (!changed) return issue;

    const now = this.tick();
    this.db
      .prepare(
        `UPDATE issues SET
          title = COALESCE(?, title),
          description = CASE WHEN ? THEN ? ELSE description END,
          priority = COALESCE(?, priority),
          state_id = COALESCE(?, state_id),
          assignee_id = CASE WHEN ? THEN ? ELSE assignee_id END,
          delegate_id = CASE WHEN ? THEN ? ELSE delegate_id END,
          project_id = CASE WHEN ? THEN ? ELSE project_id END,
          cycle_id = CASE WHEN ? THEN ? ELSE cycle_id END,
          archived_at = CASE WHEN ? THEN ? ELSE archived_at END,
          canceled_at = COALESCE(?, canceled_at),
          completed_at = COALESCE(?, completed_at),
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
        patch.state_id ?? null,
        "assigneeId" in input ? 1 : 0,
        patch.assignee_id ?? null,
        "delegateId" in input ? 1 : 0,
        patch.delegate_id ?? null,
        "projectId" in input ? 1 : 0,
        patch.project_id ?? null,
        "cycleId" in input ? 1 : 0,
        patch.cycle_id ?? null,
        "archivedAt" in input ? 1 : 0,
        patch.archived_at ?? null,
        patch.canceled_at ?? null,
        patch.completed_at ?? null,
        "stateId" in input ? 1 : 0,
        patch.started_at ?? null,
        "dueDate" in input ? 1 : 0,
        patch.due_date ?? null,
        now,
        issue.id
      );

    if (nextLabelIds) {
      this.setIssueLabels(issue.id, nextLabelIds);
    }

    const updated = this.getIssue(issue.id)!;
    const viewer = this.resolveViewer(actor);
    await dispatchLinearWebhook(this, {
      type: "Issue",
      action: "update",
      data: this.issueWebhookPayload(updated),
      actor: viewer,
      teamId: updated.teamId,
      url: updated.url,
      updatedFrom: before,
    });
    if (updated.delegateId && updated.delegateId !== issue.delegateId) {
      await this.createAgentSessionOnIssue({ issueId: updated.id, agentUserId: updated.delegateId }, actor);
    }
    return updated;
  }

  async deleteIssue(id: string, actor: ActorContext = {}): Promise<LinearIssue> {
    const issue = this.requireIssue(id);
    const viewer = this.resolveViewer(actor);
    this.db.prepare("DELETE FROM agent_activities WHERE session_id IN (SELECT id FROM agent_sessions WHERE issue_id = ?)").run(issue.id);
    this.db.prepare("DELETE FROM agent_sessions WHERE issue_id = ?").run(issue.id);
    this.db.prepare("DELETE FROM comments WHERE issue_id = ?").run(issue.id);
    this.db.prepare("DELETE FROM issue_label_links WHERE issue_id = ?").run(issue.id);
    this.db.prepare("DELETE FROM issues WHERE id = ?").run(issue.id);
    await dispatchLinearWebhook(this, {
      type: "Issue",
      action: "remove",
      data: this.issueWebhookPayload(issue),
      actor: viewer,
      teamId: issue.teamId,
      url: issue.url,
    });
    return issue;
  }

  async archiveIssue(id: string, actor: ActorContext = {}): Promise<LinearIssue> {
    const issue = this.requireIssue(id);
    const now = this.tick();
    this.db.prepare("UPDATE issues SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, issue.id);
    const updated = this.getIssue(issue.id)!;
    await dispatchLinearWebhook(this, {
      type: "Issue",
      action: "archive",
      data: this.issueWebhookPayload(updated),
      actor: this.resolveViewer(actor),
      teamId: updated.teamId,
      url: updated.url,
    });
    return updated;
  }

  async unarchiveIssue(id: string, actor: ActorContext = {}): Promise<LinearIssue> {
    const issue = this.requireIssue(id);
    const now = this.tick();
    this.db.prepare("UPDATE issues SET archived_at = NULL, updated_at = ? WHERE id = ?").run(now, issue.id);
    const updated = this.getIssue(issue.id)!;
    await dispatchLinearWebhook(this, {
      type: "Issue",
      action: "unarchive",
      data: this.issueWebhookPayload(updated),
      actor: this.resolveViewer(actor),
      teamId: updated.teamId,
      url: updated.url,
    });
    return updated;
  }

  listComments(issueRef?: string): LinearComment[] {
    if (!issueRef) {
      return (this.db.prepare("SELECT * FROM comments ORDER BY created_at, id").all() as CommentRow[]).map(
        mapComment
      );
    }
    const issue = this.requireIssue(issueRef);
    return (
      this.db
        .prepare("SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at, id")
        .all(issue.id) as CommentRow[]
    ).map(mapComment);
  }

  getComment(ref: string): LinearComment | null {
    const row = this.db.prepare("SELECT * FROM comments WHERE id = ?").get(ref) as CommentRow | undefined;
    return row ? mapComment(row) : null;
  }

  async createComment(
    input: { issueId: string; body: string; createAsUser?: string | null; displayIconUrl?: string | null },
    actor: ActorContext = {}
  ): Promise<LinearComment> {
    assertBody(input.body);
    const issue = this.requireIssue(input.issueId);
    const viewer = this.resolveViewer(actor);
    const now = this.tick();
    const id = this.nextId("comment");
    this.db
      .prepare(
        `INSERT INTO comments(id, issue_id, user_id, body, create_as_user, display_icon_url, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(id, issue.id, viewer.id, input.body, input.createAsUser ?? null, input.displayIconUrl ?? null, now, now);
    const comment = this.getComment(id)!;
    await dispatchLinearWebhook(this, {
      type: "Comment",
      action: "create",
      data: this.commentWebhookPayload(comment),
      actor: viewer,
      teamId: issue.teamId,
      url: issue.url,
    });
    if (this.mentionsAppUser(comment.body)) {
      const appUser = this.listUsers().find((u) => u.app && comment.body.includes(u.displayName));
      if (appUser) {
        await this.createAgentSessionOnComment({ commentId: comment.id, agentUserId: appUser.id }, actor);
      }
    }
    return comment;
  }

  async updateComment(id: string, body: string, actor: ActorContext = {}): Promise<LinearComment> {
    assertBody(body);
    const comment = this.requireComment(id);
    const before = this.commentWebhookPayload(comment);
    const now = this.tick();
    this.db.prepare("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?").run(body, now, comment.id);
    const updated = this.getComment(comment.id)!;
    const issue = this.requireIssue(updated.issueId);
    await dispatchLinearWebhook(this, {
      type: "Comment",
      action: "update",
      data: this.commentWebhookPayload(updated),
      actor: this.resolveViewer(actor),
      teamId: issue.teamId,
      url: issue.url,
      updatedFrom: before,
    });
    return updated;
  }

  async deleteComment(id: string, actor: ActorContext = {}): Promise<string> {
    const comment = this.requireComment(id);
    const issue = this.requireIssue(comment.issueId);
    this.db.prepare("DELETE FROM agent_activities WHERE session_id IN (SELECT id FROM agent_sessions WHERE comment_id = ?)").run(comment.id);
    this.db.prepare("DELETE FROM agent_sessions WHERE comment_id = ?").run(comment.id);
    this.db.prepare("DELETE FROM comments WHERE id = ?").run(comment.id);
    await dispatchLinearWebhook(this, {
      type: "Comment",
      action: "remove",
      data: this.commentWebhookPayload(comment),
      actor: this.resolveViewer(actor),
      teamId: issue.teamId,
      url: issue.url,
    });
    return comment.id;
  }

  listLabels(teamRef?: string): LinearIssueLabel[] {
    const rows = this.db.prepare("SELECT * FROM issue_labels ORDER BY name").all() as LabelRow[];
    const labels = rows.map(mapLabel);
    if (!teamRef) return labels;
    const team = this.getTeam(teamRef);
    if (!team) return [];
    return labels.filter((l) => l.teamId === team.id || l.teamId === null);
  }

  getLabel(ref: string, teamRef?: string): LinearIssueLabel | null {
    return this.listLabels(teamRef).find((l) => l.id === ref || l.name === ref) ?? null;
  }

  async createLabel(
    input: { name: string; color?: string; description?: string | null; teamId?: string | null },
    actor: ActorContext = {}
  ): Promise<LinearIssueLabel> {
    const team = input.teamId ? this.requireTeam(input.teamId) : null;
    const now = this.tick();
    const id = this.nextId("label");
    this.db
      .prepare(
        `INSERT INTO issue_labels(id, team_id, name, color, description, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(id, team?.id ?? null, input.name, input.color ?? "#64748b", input.description ?? null, now, now);
    const label = this.getLabel(id)!;
    await dispatchLinearWebhook(this, {
      type: "IssueLabel",
      action: "create",
      data: { id: label.id, name: label.name, color: label.color },
      actor: this.resolveViewer(actor),
      teamId: label.teamId,
    });
    return label;
  }

  async updateLabel(
    id: string,
    input: { name?: string; color?: string; description?: string | null },
    actor: ActorContext = {}
  ): Promise<LinearIssueLabel> {
    const label = this.requireLabel(id);
    const now = this.tick();
    this.db
      .prepare(
        `UPDATE issue_labels SET
          name = COALESCE(?, name),
          color = COALESCE(?, color),
          description = CASE WHEN ? THEN ? ELSE description END,
          updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name ?? null,
        input.color ?? null,
        "description" in input ? 1 : 0,
        input.description ?? null,
        now,
        label.id
      );
    const updated = this.getLabel(label.id)!;
    await dispatchLinearWebhook(this, {
      type: "IssueLabel",
      action: "update",
      data: { id: updated.id, name: updated.name, color: updated.color },
      actor: this.resolveViewer(actor),
      teamId: updated.teamId,
    });
    return updated;
  }

  async deleteLabel(id: string, actor: ActorContext = {}): Promise<string> {
    const label = this.requireLabel(id);
    this.db.prepare("DELETE FROM issue_label_links WHERE label_id = ?").run(label.id);
    this.db.prepare("DELETE FROM issue_labels WHERE id = ?").run(label.id);
    await dispatchLinearWebhook(this, {
      type: "IssueLabel",
      action: "remove",
      data: { id: label.id, name: label.name, color: label.color },
      actor: this.resolveViewer(actor),
      teamId: label.teamId,
    });
    return label.id;
  }

  async addIssueLabel(issueId: string, labelId: string, actor: ActorContext = {}): Promise<LinearIssue> {
    const issue = this.requireIssue(issueId);
    const label = this.requireLabel(labelId, issue.teamId);
    if (issue.labelIds.includes(label.id)) return issue;
    const before = this.issueWebhookPayload(issue);
    this.db
      .prepare("INSERT OR IGNORE INTO issue_label_links(issue_id, label_id) VALUES (?, ?)")
      .run(issue.id, label.id);
    const now = this.tick();
    this.db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, issue.id);
    const updated = this.getIssue(issue.id)!;
    await dispatchLinearWebhook(this, {
      type: "Issue",
      action: "update",
      data: this.issueWebhookPayload(updated),
      actor: this.resolveViewer(actor),
      teamId: updated.teamId,
      url: updated.url,
      updatedFrom: before,
    });
    return updated;
  }

  async removeIssueLabel(issueId: string, labelId: string, actor: ActorContext = {}): Promise<LinearIssue> {
    const issue = this.requireIssue(issueId);
    const label = this.requireLabel(labelId, issue.teamId);
    if (!issue.labelIds.includes(label.id)) return issue;
    const before = this.issueWebhookPayload(issue);
    this.db.prepare("DELETE FROM issue_label_links WHERE issue_id = ? AND label_id = ?").run(issue.id, label.id);
    const now = this.tick();
    this.db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, issue.id);
    const updated = this.getIssue(issue.id)!;
    await dispatchLinearWebhook(this, {
      type: "Issue",
      action: "update",
      data: this.issueWebhookPayload(updated),
      actor: this.resolveViewer(actor),
      teamId: updated.teamId,
      url: updated.url,
      updatedFrom: before,
    });
    return updated;
  }

  listProjects(teamRef?: string): LinearProject[] {
    const rows = (this.db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as ProjectRow[]).map(
      mapProject
    );
    if (!teamRef) return rows;
    const team = this.getTeam(teamRef);
    if (!team) return [];
    return rows.filter((p) => p.teamId === team.id || p.teamId === null);
  }

  getProject(ref: string): LinearProject | null {
    return this.listProjects().find((p) => p.id === ref || p.name === ref) ?? null;
  }

  createProject(input: {
    name: string;
    teamId?: string | null;
    description?: string | null;
    state?: LinearProjectState;
  }): LinearProject {
    const team = input.teamId ? this.requireTeam(input.teamId) : null;
    const now = this.tick();
    const id = this.nextId("project");
    this.db
      .prepare(
        `INSERT INTO projects(id, team_id, name, description, state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(id, team?.id ?? null, input.name, input.description ?? null, input.state ?? "planned", now, now);
    return this.getProject(id)!;
  }

  updateProject(
    id: string,
    input: { name?: string; description?: string | null; state?: LinearProjectState }
  ): LinearProject {
    const project = this.requireProject(id);
    const now = this.tick();
    this.db
      .prepare(
        `UPDATE projects SET
          name = COALESCE(?, name),
          description = CASE WHEN ? THEN ? ELSE description END,
          state = COALESCE(?, state),
          updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name ?? null,
        "description" in input ? 1 : 0,
        input.description ?? null,
        input.state ?? null,
        now,
        project.id
      );
    return this.getProject(project.id)!;
  }

  listCycles(teamRef: string): LinearCycle[] {
    const team = this.requireTeam(teamRef);
    return (
      this.db
        .prepare("SELECT * FROM cycles WHERE team_id = ? ORDER BY number, created_at")
        .all(team.id) as CycleRow[]
    ).map(mapCycle);
  }

  getCycle(ref: string, teamRef?: string): LinearCycle | null {
    const cycles = teamRef
      ? this.listCycles(teamRef)
      : (this.db.prepare("SELECT * FROM cycles").all() as CycleRow[]).map(mapCycle);
    return cycles.find((c) => c.id === ref || c.name === ref || String(c.number) === ref) ?? null;
  }

  listWebhooks(): LinearWebhook[] {
    return (this.db.prepare("SELECT * FROM webhooks ORDER BY created_at, id").all() as WebhookRow[]).map(
      mapWebhook
    );
  }

  getWebhook(ref: string): LinearWebhook | null {
    const row = this.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(ref) as WebhookRow | undefined;
    return row ? mapWebhook(row) : null;
  }

  createWebhook(
    input: {
      url: string;
      label?: string;
      resourceTypes?: string[];
      teamId?: string | null;
      allPublicTeams?: boolean;
      secret?: string | null;
      enabled?: boolean;
    },
    actor: ActorContext = {}
  ): LinearWebhook {
    const team = input.teamId ? this.requireTeam(input.teamId) : null;
    const viewer = this.resolveViewer(actor);
    const now = this.tick();
    const id = this.nextId("webhook");
    this.db
      .prepare(
        `INSERT INTO webhooks(
          id, label, url, enabled, resource_types_json, team_id, all_public_teams, secret, creator_id, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        input.label ?? "Local webhook",
        input.url,
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.resourceTypes ?? ["Issue", "Comment"]),
        team?.id ?? null,
        (input.allPublicTeams ?? !team) ? 1 : 0,
        input.secret ?? null,
        viewer.id,
        now,
        now
      );
    return this.getWebhook(id)!;
  }

  deleteWebhook(id: string): string {
    const webhook = this.requireWebhook(id);
    this.db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").run(webhook.id);
    this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(webhook.id);
    return webhook.id;
  }

  recordWebhookDelivery(input: {
    id: string;
    webhookId: string;
    event: string;
    action: string;
    url: string;
    status: number | null;
    error: string | null;
    payload: unknown;
    headers: Record<string, string>;
  }): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries(
          id, webhook_id, event, action, url, status, error, payload_json, headers_json, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.id,
        input.webhookId,
        input.event,
        input.action,
        input.url,
        input.status,
        input.error,
        JSON.stringify(input.payload),
        JSON.stringify(input.headers),
        now,
        now
      );
  }

  listAgentSessions(): LinearAgentSession[] {
    return (
      this.db.prepare("SELECT * FROM agent_sessions ORDER BY created_at, id").all() as AgentSessionRow[]
    ).map(mapAgentSession);
  }

  getAgentSession(ref: string): LinearAgentSession | null {
    const row = this.db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(ref) as
      | AgentSessionRow
      | undefined;
    return row ? mapAgentSession(row) : null;
  }

  async createAgentSessionOnIssue(
    input: { issueId: string; agentUserId?: string; plan?: string | null; externalUrl?: string | null },
    actor: ActorContext = {}
  ): Promise<LinearAgentSession> {
    const issue = this.requireIssue(input.issueId);
    const viewer = this.resolveViewer(actor);
    const agent =
      (input.agentUserId ? this.requireUser(input.agentUserId) : null) ??
      this.listUsers().find((u) => u.app) ??
      viewer;
    const now = this.tick();
    const id = this.nextId("agent_session");
    this.db
      .prepare(
        `INSERT INTO agent_sessions(id, issue_id, comment_id, agent_user_id, state, plan, external_url, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(id, issue.id, null, agent.id, "pending", input.plan ?? null, input.externalUrl ?? null, now, now);
    const session = this.getAgentSession(id)!;
    await dispatchLinearWebhook(this, {
      type: "AgentSessionEvent",
      action: "created",
      data: { id: session.id, issueId: issue.id, state: session.state },
      actor: viewer,
      teamId: issue.teamId,
    });
    return session;
  }

  async createAgentSessionOnComment(
    input: { commentId: string; agentUserId?: string; plan?: string | null; externalUrl?: string | null },
    actor: ActorContext = {}
  ): Promise<LinearAgentSession> {
    const comment = this.requireComment(input.commentId);
    const issue = this.requireIssue(comment.issueId);
    const viewer = this.resolveViewer(actor);
    const agent =
      (input.agentUserId ? this.requireUser(input.agentUserId) : null) ??
      this.listUsers().find((u) => u.app) ??
      viewer;
    const now = this.tick();
    const id = this.nextId("agent_session");
    this.db
      .prepare(
        `INSERT INTO agent_sessions(id, issue_id, comment_id, agent_user_id, state, plan, external_url, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      .run(id, issue.id, comment.id, agent.id, "pending", input.plan ?? null, input.externalUrl ?? null, now, now);
    return this.getAgentSession(id)!;
  }

  updateAgentSession(
    id: string,
    input: { state?: string; plan?: string | null; externalUrl?: string | null }
  ): LinearAgentSession {
    const session = this.requireAgentSession(id);
    const now = this.tick();
    this.db
      .prepare(
        `UPDATE agent_sessions SET
          state = COALESCE(?, state),
          plan = CASE WHEN ? THEN ? ELSE plan END,
          external_url = CASE WHEN ? THEN ? ELSE external_url END,
          updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.state ? normalizeSessionState(input.state) : null,
        "plan" in input ? 1 : 0,
        input.plan ?? null,
        "externalUrl" in input ? 1 : 0,
        input.externalUrl ?? null,
        now,
        session.id
      );
    return this.getAgentSession(session.id)!;
  }

  async createAgentActivity(
    input: { sessionId: string; type: string; body: string; ephemeral?: boolean },
    actor: ActorContext = {}
  ): Promise<LinearAgentActivity> {
    assertBody(input.body);
    const session = this.requireAgentSession(input.sessionId);
    const viewer = this.resolveViewer(actor);
    const type = normalizeActivityType(input.type);
    const now = this.tick();
    const id = this.nextId("agent_activity");
    const ephemeral =
      typeof input.ephemeral === "boolean" ? input.ephemeral : type === "thought" || type === "action";
    this.db
      .prepare(
        `INSERT INTO agent_activities(id, session_id, user_id, type, body, ephemeral, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(id, session.id, viewer.id, type, input.body, ephemeral ? 1 : 0, now, now);
    if (type === "prompt") {
      await dispatchLinearWebhook(this, {
        type: "AgentSessionEvent",
        action: "prompted",
        data: { id: session.id, state: session.state },
        actor: viewer,
        teamId: session.issueId ? this.requireIssue(session.issueId).teamId : null,
      });
    }
    return this.getAgentActivity(id)!;
  }

  getAgentActivity(ref: string): LinearAgentActivity | null {
    const row = this.db.prepare("SELECT * FROM agent_activities WHERE id = ?").get(ref) as
      | AgentActivityRow
      | undefined;
    return row ? mapAgentActivity(row) : null;
  }

  listOAuthApps(): LinearOAuthApp[] {
    return (this.db.prepare("SELECT * FROM oauth_apps ORDER BY created_at").all() as OAuthAppRow[]).map(
      mapOAuthApp
    );
  }

  getOAuthApp(clientId: string): LinearOAuthApp | null {
    const row = this.db
      .prepare("SELECT * FROM oauth_apps WHERE client_id = ? OR id = ?")
      .get(clientId, clientId) as OAuthAppRow | undefined;
    return row ? mapOAuthApp(row) : null;
  }

  insertToken(input: {
    token: string;
    type: LinearTokenType;
    actorType: LinearTokenActorType;
    userId: string | null;
    appId: string | null;
    scopes: string[];
    expiresAt: string | null;
    refreshToken?: string | null;
    sid?: string;
  }): LinearToken {
    const now = this.now();
    const sid = input.sid ?? this.config("default_sid") ?? DEFAULT_LINEAR_SID;
    this.db
      .prepare(
        `INSERT INTO tokens(
          token, type, actor_type, user_id, app_id, scopes_json, expires_at, revoked, refresh_token, sid, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)`
      )
      .run(
        input.token,
        input.type,
        input.actorType,
        input.userId,
        input.appId,
        JSON.stringify(input.scopes),
        input.expiresAt,
        input.refreshToken ?? null,
        sid,
        now,
        now
      );
    return this.getToken(input.token)!;
  }

  getToken(tokenValue: string): LinearToken | null {
    const row = this.db.prepare("SELECT * FROM tokens WHERE token = ?").get(tokenValue) as TokenRow | undefined;
    return row ? mapToken(row) : null;
  }

  revokeToken(tokenValue: string): void {
    const now = this.now();
    this.db.prepare("UPDATE tokens SET revoked = 1, updated_at = ? WHERE token = ?").run(now, tokenValue);
  }

  storePendingCode(code: string, pending: PendingCode): void {
    this.db
      .prepare(
        `INSERT INTO oauth_pending_codes(
          code, app_id, client_id, redirect_uri, scopes_json, user_id, actor, code_challenge, code_challenge_method, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        code,
        pending.appId,
        pending.clientId,
        pending.redirectUri,
        JSON.stringify(pending.scopes),
        pending.userId,
        pending.actor,
        pending.codeChallenge,
        pending.codeChallengeMethod,
        pending.createdAt
      );
  }

  takePendingCode(code: string): PendingCode | null {
    const row = this.db.prepare("SELECT * FROM oauth_pending_codes WHERE code = ?").get(code) as
      | PendingCodeRow
      | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM oauth_pending_codes WHERE code = ?").run(code);
    return {
      appId: row.app_id,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      scopes: JSON.parse(row.scopes_json) as string[],
      userId: row.user_id,
      actor: row.actor as LinearTokenActorType,
      codeChallenge: row.code_challenge,
      codeChallengeMethod: row.code_challenge_method,
      createdAt: row.created_at,
    };
  }

  issueOAuthTokens(input: {
    userId: string | null;
    appId: string | null;
    actor: LinearTokenActorType;
    scopes: string[];
    includeRefresh?: boolean;
  }): {
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    scope: string;
    refresh_token?: string;
  } {
    const accessToken = token("lin");
    const includeRefresh = input.includeRefresh !== false;
    const refreshToken = includeRefresh ? token("lin_refresh") : null;
    const expiresAt = new Date(Date.parse(this.now()) + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
    this.insertToken({
      token: accessToken,
      type: input.actor === "app" && !includeRefresh ? "client_credentials" : "oauth_access",
      actorType: input.actor,
      userId: input.userId,
      appId: input.appId,
      scopes: input.scopes,
      expiresAt,
      refreshToken,
    });
    if (refreshToken) {
      this.insertToken({
        token: refreshToken,
        type: "oauth_refresh",
        actorType: input.actor,
        userId: input.userId,
        appId: input.appId,
        scopes: input.scopes,
        expiresAt: null,
      });
    }
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: input.scopes.join(" "),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    };
  }

  issueWebhookPayloadIssue(issue: LinearIssue): Record<string, unknown> {
    return this.issueWebhookPayload(issue);
  }

  // --- internals ---

  private applySeed(seed: ParsedLinearStateSeed): void {
    this.setConfig("clock", seed.clock);
    this.setConfig("logical_counter", "0");
    this.setConfig("id_counter", "0");
    this.setConfig("default_sid", seed.defaultSid);
    this.setConfig("base_url", seed.baseUrl);
    this.setConfig("strict_scopes", seed.strictScopes ? "1" : "0");

    const orgName = seed.organization?.name ?? "Pome Twin";
    const urlKey = seed.organization?.urlKey ?? slugify(orgName);
    const now = seed.clock;
    const orgId = seed.organization?.id ?? this.nextId("org");
    this.db
      .prepare(
        `INSERT INTO organizations(id, name, url_key, url, created_at, updated_at) VALUES (?,?,?,?,?,?)`
      )
      .run(orgId, orgName, urlKey, `https://linear.app/${urlKey}`, now, now);

    for (const user of seed.users) {
      const id = user.id ?? this.nextId("user");
      const name = user.name ?? user.displayName ?? user.email.split("@")[0]!;
      this.db
        .prepare(
          `INSERT INTO users(id, email, name, display_name, avatar_url, active, admin, app, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          user.email,
          name,
          user.displayName ?? name,
          user.avatarUrl ?? null,
          user.active ? 1 : 0,
          user.admin ? 1 : 0,
          user.app ? 1 : 0,
          now,
          now
        );
    }

    for (const teamCfg of seed.teams) {
      const id = teamCfg.id ?? this.nextId("team");
      this.db
        .prepare(
          `INSERT INTO teams(id, key, name, description, private, url, issue_sequence, created_at, updated_at)
           VALUES (?,?,?,?,?,?,0,?,?)`
        )
        .run(
          id,
          teamCfg.key,
          teamCfg.name,
          teamCfg.description ?? null,
          teamCfg.private ? 1 : 0,
          `https://linear.app/${urlKey}/team/${teamCfg.key}`,
          now,
          now
        );
      const states =
        teamCfg.states && teamCfg.states.length > 0
          ? teamCfg.states
          : [
              { name: "Backlog", type: "backlog" as const, position: 0 },
              { name: "Todo", type: "unstarted" as const, position: 1 },
              { name: "In Progress", type: "started" as const, position: 2 },
              { name: "Done", type: "completed" as const, position: 3 },
              { name: "Canceled", type: "canceled" as const, position: 4 },
            ];
      for (const [index, state] of states.entries()) {
        this.db
          .prepare(
            `INSERT INTO workflow_states(id, team_id, name, type, position, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?)`
          )
          .run(
            state.id ?? this.nextId("state"),
            id,
            state.name,
            state.type ?? inferStateType(state.name),
            state.position ?? index,
            now,
            now
          );
      }
    }

    for (const label of seed.labels) {
      const team = label.team ? this.requireTeam(label.team) : null;
      this.db
        .prepare(
          `INSERT INTO issue_labels(id, team_id, name, color, description, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run(
          label.id ?? this.nextId("label"),
          team?.id ?? null,
          label.name,
          label.color ?? "#64748b",
          label.description ?? null,
          now,
          now
        );
    }

    for (const project of seed.projects) {
      const team = project.team ? this.requireTeam(project.team) : null;
      this.db
        .prepare(
          `INSERT INTO projects(id, team_id, name, description, state, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run(
          project.id ?? this.nextId("project"),
          team?.id ?? null,
          project.name,
          project.description ?? null,
          project.state,
          now,
          now
        );
    }

    for (const cycle of seed.cycles) {
      const team = this.requireTeam(cycle.team);
      this.db
        .prepare(
          `INSERT INTO cycles(id, team_id, name, number, starts_at, ends_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          cycle.id ?? this.nextId("cycle"),
          team.id,
          cycle.name,
          cycle.number ?? 1,
          cycle.startsAt ?? null,
          cycle.endsAt ?? null,
          now,
          now
        );
    }

    const issueIdByTitle = new Map<string, string>();
    for (const issueCfg of seed.issues) {
      const team = this.requireTeam(issueCfg.team);
      const state =
        (issueCfg.state ? this.getWorkflowState(issueCfg.state, team.id) : null) ??
        this.getWorkflowState("Todo", team.id) ??
        this.listWorkflowStates(team.id)[0];
      if (!state) badUserInput(`No workflow state for team ${team.key}`);
      const number = this.nextIssueNumber(team.id);
      const id = issueCfg.id ?? this.nextId("issue");
      const identifier = `${team.key}-${number}`;
      const createdAt = issueCfg.createdAt ?? now;
      const updatedAt = issueCfg.updatedAt ?? createdAt;
      const creator = issueCfg.creator ? this.requireUser(issueCfg.creator) : this.resolveViewer({});
      const assignee = issueCfg.assignee ? this.requireUser(issueCfg.assignee) : null;
      const delegate = issueCfg.delegate ? this.requireUser(issueCfg.delegate) : null;
      const project = issueCfg.project ? this.requireProject(issueCfg.project, team.id) : null;
      const cycle = issueCfg.cycle ? this.requireCycle(issueCfg.cycle, team.id) : null;
      const baseUrl = seed.baseUrl;
      this.db
        .prepare(
          `INSERT INTO issues(
            id, identifier, number, team_id, title, description, priority, state_id,
            assignee_id, creator_id, delegate_id, project_id, cycle_id, url,
            archived_at, canceled_at, completed_at, started_at, due_date,
            create_as_user, display_icon_url, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          identifier,
          number,
          team.id,
          issueCfg.title,
          issueCfg.description ?? null,
          issueCfg.priority,
          state.id,
          assignee?.id ?? null,
          creator.id,
          delegate?.id ?? null,
          project?.id ?? null,
          cycle?.id ?? null,
          `${baseUrl}/issue/${identifier}`,
          null,
          state.type === "canceled" ? updatedAt : null,
          state.type === "completed" ? updatedAt : null,
          state.type === "started" ? updatedAt : null,
          issueCfg.dueDate ?? null,
          null,
          null,
          createdAt,
          updatedAt
        );
      const labelIds = issueCfg.labels.map((ref) => this.requireLabel(ref, team.id).id);
      this.setIssueLabels(id, labelIds);
      issueIdByTitle.set(issueCfg.title, id);
      if (issueCfg.id) issueIdByTitle.set(issueCfg.id, id);
      issueIdByTitle.set(identifier, id);
    }

    for (const comment of seed.comments) {
      const issueId =
        issueIdByTitle.get(comment.issue) ?? this.getIssue(comment.issue)?.id ?? notFound(`Issue ${comment.issue}`);
      const user = comment.user ? this.requireUser(comment.user) : this.resolveViewer({});
      const createdAt = comment.createdAt ?? now;
      this.db
        .prepare(
          `INSERT INTO comments(id, issue_id, user_id, body, create_as_user, display_icon_url, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          comment.id ?? this.nextId("comment"),
          issueId,
          user.id,
          comment.body,
          null,
          null,
          createdAt,
          createdAt
        );
    }

    for (const app of seed.oauthApps) {
      this.db
        .prepare(
          `INSERT INTO oauth_apps(
            id, client_id, client_secret, name, redirect_uris_json, scopes_json, actor,
            assignable, mentionable, app_user_id, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          app.id ?? this.nextId("oauth_app"),
          app.clientId,
          app.clientSecret,
          app.name,
          JSON.stringify(app.redirectUris),
          JSON.stringify(normalizeScopes(app.scopes, [...DEFAULT_SCOPES])),
          app.actor,
          app.assignable ? 1 : 0,
          app.mentionable ? 1 : 0,
          app.appUserId ?? null,
          now,
          now
        );
    }

    for (const tok of seed.tokens) {
      const user = tok.user ? this.requireUser(tok.user) : this.resolveViewer({});
      const app = tok.app ? this.getOAuthApp(tok.app) : null;
      this.insertToken({
        token: tok.token,
        type: tok.type,
        actorType: tok.actor ?? (app ? "app" : "user"),
        userId: user.id,
        appId: app?.id ?? null,
        scopes: normalizeScopes(tok.scopes, [...DEFAULT_SCOPES]),
        expiresAt: tok.expiresAt ?? null,
        sid: tok.sid ?? seed.defaultSid,
      });
    }

    for (const webhook of seed.webhooks) {
      const team = webhook.team ? this.requireTeam(webhook.team) : null;
      const creator = this.resolveViewer({ email: DEFAULT_LINEAR_EMAIL });
      this.db
        .prepare(
          `INSERT INTO webhooks(
            id, label, url, enabled, resource_types_json, team_id, all_public_teams, secret, creator_id, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          webhook.id ?? this.nextId("webhook"),
          webhook.label ?? "Local webhook",
          webhook.url,
          webhook.enabled ? 1 : 0,
          JSON.stringify(normalizeScopes(webhook.resourceTypes, ["Issue", "Comment"])),
          team?.id ?? null,
          (webhook.allPublicTeams ?? !team) ? 1 : 0,
          webhook.secret ?? null,
          creator.id,
          now,
          now
        );
    }
  }

  private nextIssueNumber(teamId: string): number {
    const team = this.requireTeam(teamId);
    const next = team.issueSequence + 1;
    this.db.prepare("UPDATE teams SET issue_sequence = ?, updated_at = ? WHERE id = ?").run(next, this.now(), team.id);
    return next;
  }

  private setIssueLabels(issueId: string, labelIds: string[]): void {
    this.db.prepare("DELETE FROM issue_label_links WHERE issue_id = ?").run(issueId);
    const insert = this.db.prepare("INSERT INTO issue_label_links(issue_id, label_id) VALUES (?, ?)");
    for (const labelId of labelIds) insert.run(issueId, labelId);
  }

  private mapIssue(row: IssueRow): LinearIssue {
    const labelIds = (
      this.db.prepare("SELECT label_id FROM issue_label_links WHERE issue_id = ?").all(row.id) as Array<{
        label_id: string;
      }>
    ).map((r) => r.label_id);
    return {
      id: row.id,
      identifier: row.identifier,
      number: row.number,
      teamId: row.team_id,
      title: row.title,
      description: row.description,
      priority: row.priority as LinearIssuePriority,
      stateId: row.state_id,
      assigneeId: row.assignee_id,
      creatorId: row.creator_id,
      delegateId: row.delegate_id,
      projectId: row.project_id,
      cycleId: row.cycle_id,
      labelIds,
      url: row.url,
      archivedAt: row.archived_at,
      canceledAt: row.canceled_at,
      completedAt: row.completed_at,
      startedAt: row.started_at,
      dueDate: row.due_date,
      createAsUser: row.create_as_user,
      displayIconUrl: row.display_icon_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private issueWebhookPayload(issue: LinearIssue): Record<string, unknown> {
    return {
      id: issue.id,
      identifier: issue.identifier,
      number: issue.number,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      url: issue.url,
      teamId: issue.teamId,
      stateId: issue.stateId,
      assigneeId: issue.assigneeId,
      labelIds: issue.labelIds,
      archivedAt: issue.archivedAt,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
  }

  private commentWebhookPayload(comment: LinearComment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      issueId: comment.issueId,
      userId: comment.userId,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
  }

  private mentionsAppUser(body: string): boolean {
    return body.includes("@");
  }

  private strictScopes(): boolean {
    return this.config("strict_scopes") === "1";
  }

  private config(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM linear_config WHERE key = ?").get(key) as { value: string } | undefined)
      ?.value;
  }

  private setConfig(key: string, value: string): void {
    this.db.prepare("INSERT INTO linear_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private requireTeam(ref: string): LinearTeam {
    return this.getTeam(ref) ?? notFound(`Team not found: ${ref}`);
  }

  private requireUser(ref: string): LinearUser {
    return this.getUser(ref) ?? notFound(`User not found: ${ref}`);
  }

  private requireIssue(ref: string): LinearIssue {
    return this.getIssue(ref) ?? notFound(`Issue not found: ${ref}`);
  }

  private requireComment(ref: string): LinearComment {
    return this.getComment(ref) ?? notFound(`Comment not found: ${ref}`);
  }

  private requireLabel(ref: string, teamId?: string): LinearIssueLabel {
    return this.getLabel(ref, teamId) ?? notFound(`Label not found: ${ref}`);
  }

  private requireProject(ref: string, _teamId?: string): LinearProject {
    return this.getProject(ref) ?? notFound(`Project not found: ${ref}`);
  }

  private requireCycle(ref: string, teamId?: string): LinearCycle {
    return this.getCycle(ref, teamId) ?? notFound(`Cycle not found: ${ref}`);
  }

  private requireState(ref: string, teamId?: string): LinearWorkflowState {
    return this.getWorkflowState(ref, teamId) ?? notFound(`Workflow state not found: ${ref}`);
  }

  private requireWebhook(ref: string): LinearWebhook {
    return this.getWebhook(ref) ?? notFound(`Webhook not found: ${ref}`);
  }

  private requireAgentSession(ref: string): LinearAgentSession {
    return this.getAgentSession(ref) ?? notFound(`Agent session not found: ${ref}`);
  }
}

export type PendingCode = {
  appId: string | null;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  userId: string | null;
  actor: LinearTokenActorType;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  createdAt: string;
};

function assertTitle(title: string): void {
  if (byteLength(title) > TITLE_MAX_BYTES) badUserInput(`Issue title exceeds ${TITLE_MAX_BYTES} bytes`);
}

function assertBody(body: string): void {
  if (byteLength(body) > BODY_MAX_BYTES) badUserInput(`Body exceeds ${BODY_MAX_BYTES} bytes`);
}

function normalizePriority(value: number | null | undefined): LinearIssuePriority {
  const n = typeof value === "number" ? Math.trunc(value) : 0;
  if (n < 0 || n > 4) badUserInput("priority must be 0..4");
  return n as LinearIssuePriority;
}

function normalizeScopes(value: string[] | string | undefined, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.map((s) => s.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [...fallback];
}

function inferStateType(name: string): LinearWorkflowStateType {
  const lower = name.toLowerCase();
  if (lower.includes("backlog")) return "backlog";
  if (lower.includes("progress") || lower.includes("started")) return "started";
  if (lower.includes("done") || lower.includes("complete")) return "completed";
  if (lower.includes("cancel")) return "canceled";
  return "unstarted";
}

function normalizeSessionState(value: string): LinearAgentSessionState {
  const allowed: LinearAgentSessionState[] = ["pending", "active", "completed", "failed", "canceled"];
  if (!allowed.includes(value as LinearAgentSessionState)) badUserInput(`Invalid agent session state: ${value}`);
  return value as LinearAgentSessionState;
}

function normalizeActivityType(value: string): LinearAgentActivityType {
  const allowed: LinearAgentActivityType[] = [
    "thought",
    "elicitation",
    "action",
    "response",
    "error",
    "prompt",
  ];
  if (!allowed.includes(value as LinearAgentActivityType)) badUserInput(`Invalid agent activity type: ${value}`);
  return value as LinearAgentActivityType;
}

// Row types + mappers

type OrgRow = { id: string; name: string; url_key: string; url: string; created_at: string; updated_at: string };
type UserRow = {
  id: string;
  email: string;
  name: string;
  display_name: string;
  avatar_url: string | null;
  active: number;
  admin: number;
  app: number;
  created_at: string;
  updated_at: string;
};
type TeamRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  private: number;
  url: string;
  issue_sequence: number;
  created_at: string;
  updated_at: string;
};
type StateRow = {
  id: string;
  team_id: string;
  name: string;
  type: string;
  position: number;
  created_at: string;
  updated_at: string;
};
type LabelRow = {
  id: string;
  team_id: string | null;
  name: string;
  color: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};
type ProjectRow = {
  id: string;
  team_id: string | null;
  name: string;
  description: string | null;
  state: string;
  created_at: string;
  updated_at: string;
};
type CycleRow = {
  id: string;
  team_id: string;
  name: string;
  number: number;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
};
type IssueRow = {
  id: string;
  identifier: string;
  number: number;
  team_id: string;
  title: string;
  description: string | null;
  priority: number;
  state_id: string;
  assignee_id: string | null;
  creator_id: string | null;
  delegate_id: string | null;
  project_id: string | null;
  cycle_id: string | null;
  url: string;
  archived_at: string | null;
  canceled_at: string | null;
  completed_at: string | null;
  started_at: string | null;
  due_date: string | null;
  create_as_user: string | null;
  display_icon_url: string | null;
  created_at: string;
  updated_at: string;
};
type CommentRow = {
  id: string;
  issue_id: string;
  user_id: string | null;
  body: string;
  create_as_user: string | null;
  display_icon_url: string | null;
  created_at: string;
  updated_at: string;
};
type OAuthAppRow = {
  id: string;
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris_json: string;
  scopes_json: string;
  actor: string;
  assignable: number;
  mentionable: number;
  app_user_id: string | null;
  created_at: string;
  updated_at: string;
};
type TokenRow = {
  token: string;
  type: string;
  actor_type: string;
  user_id: string | null;
  app_id: string | null;
  scopes_json: string;
  expires_at: string | null;
  revoked: number;
  refresh_token: string | null;
  sid: string;
  created_at: string;
  updated_at: string;
};
type WebhookRow = {
  id: string;
  label: string;
  url: string;
  enabled: number;
  resource_types_json: string;
  team_id: string | null;
  all_public_teams: number;
  secret: string | null;
  creator_id: string | null;
  created_at: string;
  updated_at: string;
};
type AgentSessionRow = {
  id: string;
  issue_id: string | null;
  comment_id: string | null;
  agent_user_id: string;
  state: string;
  plan: string | null;
  external_url: string | null;
  created_at: string;
  updated_at: string;
};
type AgentActivityRow = {
  id: string;
  session_id: string;
  user_id: string | null;
  type: string;
  body: string;
  ephemeral: number;
  created_at: string;
  updated_at: string;
};
type PendingCodeRow = {
  code: string;
  app_id: string | null;
  client_id: string;
  redirect_uri: string;
  scopes_json: string;
  user_id: string | null;
  actor: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  created_at: string;
};

function mapOrg(row: OrgRow): LinearOrganization {
  return {
    id: row.id,
    name: row.name,
    urlKey: row.url_key,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapUser(row: UserRow): LinearUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    active: !!row.active,
    admin: !!row.admin,
    app: !!row.app,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapTeam(row: TeamRow): LinearTeam {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    private: !!row.private,
    url: row.url,
    issueSequence: row.issue_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapState(row: StateRow): LinearWorkflowState {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    type: row.type as LinearWorkflowStateType,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapLabel(row: LabelRow): LinearIssueLabel {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    color: row.color,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapProject(row: ProjectRow): LinearProject {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    description: row.description,
    state: row.state as LinearProjectState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapCycle(row: CycleRow): LinearCycle {
  return {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    number: row.number,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapComment(row: CommentRow): LinearComment {
  return {
    id: row.id,
    issueId: row.issue_id,
    userId: row.user_id,
    body: row.body,
    createAsUser: row.create_as_user,
    displayIconUrl: row.display_icon_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapOAuthApp(row: OAuthAppRow): LinearOAuthApp {
  return {
    id: row.id,
    clientId: row.client_id,
    clientSecret: row.client_secret,
    name: row.name,
    redirectUris: JSON.parse(row.redirect_uris_json) as string[],
    scopes: JSON.parse(row.scopes_json) as string[],
    actor: row.actor as LinearTokenActorType,
    assignable: !!row.assignable,
    mentionable: !!row.mentionable,
    appUserId: row.app_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapToken(row: TokenRow): LinearToken {
  return {
    token: row.token,
    type: row.type as LinearTokenType,
    actorType: row.actor_type as LinearTokenActorType,
    userId: row.user_id,
    appId: row.app_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    revoked: !!row.revoked,
    refreshToken: row.refresh_token,
    sid: row.sid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapWebhook(row: WebhookRow): LinearWebhook {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    enabled: !!row.enabled,
    resourceTypes: JSON.parse(row.resource_types_json) as string[],
    teamId: row.team_id,
    allPublicTeams: !!row.all_public_teams,
    secret: row.secret,
    creatorId: row.creator_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapAgentSession(row: AgentSessionRow): LinearAgentSession {
  return {
    id: row.id,
    issueId: row.issue_id,
    commentId: row.comment_id,
    agentUserId: row.agent_user_id,
    state: row.state as LinearAgentSessionState,
    plan: row.plan,
    externalUrl: row.external_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapAgentActivity(row: AgentActivityRow): LinearAgentActivity {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    type: row.type as LinearAgentActivityType,
    body: row.body,
    ephemeral: !!row.ephemeral,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// silence unused import when tree-shaken in some builds
void linearId;
