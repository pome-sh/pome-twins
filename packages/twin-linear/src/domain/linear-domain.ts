// file-size: LinearDomain coordinator keeps lifecycle/identity helpers and thin delegations; area modules own issues/comments/catalog/etc.
// SPDX-License-Identifier: Apache-2.0
// file-size: Thin facade over domain modules; method surface mirrors LinearDomain API.
import { resetDatabase } from "../db.js";
import { badUserInput, notFound } from "../errors.js";
import { linearIdFromCounter } from "../ids.js";
import { defaultSeedState, parseSeed, type ParsedLinearStateSeed } from "../seed.js";
import { applySeed } from "../seed/apply.js";
import { exportLinearState, type LinearStateExport } from "../state.js";
import {
  DEFAULT_LINEAR_CLOCK,
  type LinearAgentActivity,
  type LinearAgentSession,
  type LinearComment,
  type LinearCycle,
  type LinearDocument,
  type LinearIssue,
  type LinearIssueLabel,
  type LinearIssueRelations,
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
  type LinearWorkflowState,
} from "../types.js";
import * as agents from "./agents.js";
import * as catalog from "./catalog.js";
import * as comments from "./comments.js";
import * as documents from "./documents.js";
import * as issueRelations from "./issue-relations.js";
import * as issues from "./issues.js";
import type { IssueCreateInput, IssueUpdateInput } from "./issues.js";
import * as labels from "./labels.js";
import * as oauthStore from "./oauth-store.js";
import * as projectsCycles from "./projects-cycles.js";

export type ActorContext = {
  userId?: string | null;
  email?: string | null;
  scopes?: string[];
};

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

export class LinearDomain {
  constructor(readonly db: LinearTwinDatabase) {}

  seed(input: LinearStateSeed | ParsedLinearStateSeed): void {
    const seed = parseSeed(input);
    this.db.transaction(() => {
      resetDatabase(this.db);
      applySeed(this, seed);
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
    return catalog.getOrganization(this);
  }

  listUsers(): LinearUser[] {
    return catalog.listUsers(this);
  }

  getUser(ref: string): LinearUser | null {
    return catalog.getUser(this, ref);
  }

  listTeams(): LinearTeam[] {
    return catalog.listTeams(this);
  }

  getTeam(ref: string): LinearTeam | null {
    return catalog.getTeam(this, ref);
  }

  listWorkflowStates(teamRef?: string): LinearWorkflowState[] {
    return catalog.listWorkflowStates(this, teamRef);
  }

  getWorkflowState(ref: string, teamRef?: string): LinearWorkflowState | null {
    return catalog.getWorkflowState(this, ref, teamRef);
  }

  listIssues(filter: issues.IssueListFilter = {}): LinearIssue[] {
    return issues.listIssues(this, filter);
  }

  countIssues(filter: issues.IssueListFilter = {}): number {
    return issues.countIssues(this, filter);
  }

  getIssue(ref: string): LinearIssue | null {
    return issues.getIssue(this, ref);
  }

  createIssue(input: IssueCreateInput, actor: ActorContext = {}): Promise<LinearIssue> {
    return issues.createIssue(this, input, actor);
  }

  updateIssue(id: string, input: IssueUpdateInput, actor: ActorContext = {}): Promise<LinearIssue> {
    return issues.updateIssue(this, id, input, actor);
  }

  deleteIssue(id: string, actor: ActorContext = {}): Promise<LinearIssue> {
    return issues.deleteIssue(this, id, actor);
  }

  archiveIssue(id: string, actor: ActorContext = {}): Promise<LinearIssue> {
    return issues.archiveIssue(this, id, actor);
  }

  unarchiveIssue(id: string, actor: ActorContext = {}): Promise<LinearIssue> {
    return issues.unarchiveIssue(this, id, actor);
  }

  listComments(issueRef?: string): LinearComment[] {
    return comments.listComments(this, issueRef);
  }

  getComment(ref: string): LinearComment | null {
    return comments.getComment(this, ref);
  }

  createComment(
    input: {
      issueId?: string;
      parentId?: string | null;
      body: string;
      createAsUser?: string | null;
      displayIconUrl?: string | null;
    },
    actor: ActorContext = {}
  ): Promise<LinearComment> {
    return comments.createComment(this, input, actor);
  }

  updateComment(id: string, body: string, actor: ActorContext = {}): Promise<LinearComment> {
    return comments.updateComment(this, id, body, actor);
  }

  deleteComment(id: string, actor: ActorContext = {}): Promise<string> {
    return comments.deleteComment(this, id, actor);
  }

  listIssueRelations(issueId: string): LinearIssueRelations {
    return issueRelations.listIssueRelations(this, issueId);
  }

  listDocuments(filter: documents.DocumentListFilter = {}): LinearDocument[] {
    return documents.listDocuments(this, filter);
  }

  getDocument(ref: string): LinearDocument | null {
    return documents.getDocument(this, ref);
  }

  createDocument(input: documents.DocumentCreateInput, actor: ActorContext = {}): LinearDocument {
    return documents.createDocument(this, input, actor);
  }

  updateDocument(id: string, input: documents.DocumentUpdateInput, actor: ActorContext = {}): LinearDocument {
    return documents.updateDocument(this, id, input, actor);
  }

  requireDocument(ref: string): LinearDocument {
    return this.getDocument(ref) ?? notFound(`Document not found: ${ref}`);
  }

  listLabels(teamRef?: string): LinearIssueLabel[] {
    return labels.listLabels(this, teamRef);
  }

  getLabel(ref: string, teamRef?: string): LinearIssueLabel | null {
    return labels.getLabel(this, ref, teamRef);
  }

  createLabel(
    input: { name: string; color?: string; description?: string | null; teamId?: string | null },
    actor: ActorContext = {}
  ): Promise<LinearIssueLabel> {
    return labels.createLabel(this, input, actor);
  }

  updateLabel(
    id: string,
    input: { name?: string; color?: string; description?: string | null },
    actor: ActorContext = {}
  ): Promise<LinearIssueLabel> {
    return labels.updateLabel(this, id, input, actor);
  }

  deleteLabel(id: string, actor: ActorContext = {}): Promise<string> {
    return labels.deleteLabel(this, id, actor);
  }

  addIssueLabel(issueId: string, labelId: string, actor: ActorContext = {}): Promise<LinearIssue> {
    return labels.addIssueLabel(this, issueId, labelId, actor);
  }

  removeIssueLabel(issueId: string, labelId: string, actor: ActorContext = {}): Promise<LinearIssue> {
    return labels.removeIssueLabel(this, issueId, labelId, actor);
  }

  listProjects(teamRef?: string): LinearProject[] {
    return projectsCycles.listProjects(this, teamRef);
  }

  getProject(ref: string): LinearProject | null {
    return projectsCycles.getProject(this, ref);
  }

  createProject(
    input: {
      name: string;
      teamId?: string | null;
      description?: string | null;
      state?: LinearProjectState;
    },
    actor: ActorContext = {}
  ): LinearProject {
    return projectsCycles.createProject(this, input, actor);
  }

  updateProject(
    id: string,
    input: { name?: string; description?: string | null; state?: LinearProjectState },
    actor: ActorContext = {}
  ): LinearProject {
    return projectsCycles.updateProject(this, id, input, actor);
  }

  listCycles(teamRef: string): LinearCycle[] {
    return projectsCycles.listCycles(this, teamRef);
  }

  getCycle(ref: string, teamRef?: string): LinearCycle | null {
    return projectsCycles.getCycle(this, ref, teamRef);
  }

  listWebhooks(): LinearWebhook[] {
    return oauthStore.listWebhooks(this);
  }

  getWebhook(ref: string): LinearWebhook | null {
    return oauthStore.getWebhook(this, ref);
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
    return oauthStore.createWebhook(this, input, actor);
  }

  deleteWebhook(id: string, actor: ActorContext = {}): string {
    return oauthStore.deleteWebhook(this, id, actor);
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
    oauthStore.recordWebhookDelivery(this, input);
  }

  listAgentSessions(): LinearAgentSession[] {
    return agents.listAgentSessions(this);
  }

  getAgentSession(ref: string): LinearAgentSession | null {
    return agents.getAgentSession(this, ref);
  }

  createAgentSessionOnIssue(
    input: { issueId: string; agentUserId?: string; plan?: string | null; externalUrl?: string | null },
    actor: ActorContext = {}
  ): Promise<LinearAgentSession> {
    return agents.createAgentSessionOnIssue(this, input, actor);
  }

  createAgentSessionOnComment(
    input: { commentId: string; agentUserId?: string; plan?: string | null; externalUrl?: string | null },
    actor: ActorContext = {}
  ): Promise<LinearAgentSession> {
    return agents.createAgentSessionOnComment(this, input, actor);
  }

  updateAgentSession(
    id: string,
    input: { state?: string; plan?: string | null; externalUrl?: string | null },
    actor: ActorContext = {}
  ): LinearAgentSession {
    return agents.updateAgentSession(this, id, input, actor);
  }

  createAgentActivity(
    input: { sessionId: string; type: string; body: string; ephemeral?: boolean },
    actor: ActorContext = {}
  ): Promise<LinearAgentActivity> {
    return agents.createAgentActivity(this, input, actor);
  }

  getAgentActivity(ref: string): LinearAgentActivity | null {
    return agents.getAgentActivity(this, ref);
  }

  listAgentActivities(sessionId: string): LinearAgentActivity[] {
    return agents.listAgentActivities(this, sessionId);
  }

  listOAuthApps(): LinearOAuthApp[] {
    return oauthStore.listOAuthApps(this);
  }

  getOAuthApp(clientId: string): LinearOAuthApp | null {
    return oauthStore.getOAuthApp(this, clientId);
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
    return oauthStore.insertToken(this, input);
  }

  getToken(tokenValue: string): LinearToken | null {
    return oauthStore.getToken(this, tokenValue);
  }

  revokeToken(tokenValue: string): void {
    oauthStore.revokeToken(this, tokenValue);
  }

  storePendingCode(code: string, pending: PendingCode): void {
    oauthStore.storePendingCode(this, code, pending);
  }

  takePendingCode(code: string): PendingCode | null {
    return oauthStore.takePendingCode(this, code);
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
    return oauthStore.issueOAuthTokens(this, input);
  }

  config(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM linear_config WHERE key = ?").get(key) as { value: string } | undefined)
      ?.value;
  }

  setConfig(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO linear_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, value);
  }

  requireTeam(ref: string): LinearTeam {
    return this.getTeam(ref) ?? notFound(`Team not found: ${ref}`);
  }

  requireUser(ref: string): LinearUser {
    return this.getUser(ref) ?? notFound(`User not found: ${ref}`);
  }

  requireIssue(ref: string): LinearIssue {
    return this.getIssue(ref) ?? notFound(`Issue not found: ${ref}`);
  }

  requireComment(ref: string): LinearComment {
    return this.getComment(ref) ?? notFound(`Comment not found: ${ref}`);
  }

  requireLabel(ref: string, teamId?: string): LinearIssueLabel {
    return this.getLabel(ref, teamId) ?? notFound(`Label not found: ${ref}`);
  }

  requireProject(ref: string, teamId?: string): LinearProject {
    const project = this.getProject(ref) ?? notFound(`Project not found: ${ref}`);
    // A team-scoped issue may only link to org-level projects or projects on its
    // own team — never another team's project.
    if (teamId && project.teamId && project.teamId !== teamId) {
      notFound(`Project not found in team: ${ref}`);
    }
    return project;
  }

  requireCycle(ref: string, teamId?: string): LinearCycle {
    return this.getCycle(ref, teamId) ?? notFound(`Cycle not found: ${ref}`);
  }

  requireState(ref: string, teamId?: string): LinearWorkflowState {
    return this.getWorkflowState(ref, teamId) ?? notFound(`Workflow state not found: ${ref}`);
  }

  requireWebhook(ref: string): LinearWebhook {
    return this.getWebhook(ref) ?? notFound(`Webhook not found: ${ref}`);
  }

  requireAgentSession(ref: string): LinearAgentSession {
    return this.getAgentSession(ref) ?? notFound(`Agent session not found: ${ref}`);
  }

  private strictScopes(): boolean {
    return this.config("strict_scopes") === "1";
  }
}
