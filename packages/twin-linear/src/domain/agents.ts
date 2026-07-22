// SPDX-License-Identifier: Apache-2.0
import { notFound } from "../errors.js";
import type { LinearAgentActivity, LinearAgentSession } from "../types.js";
import { assertBody, normalizeActivityType, normalizeSessionState } from "./normalize.js";
import type { ActorContext, LinearDomain } from "./linear-domain.js";
import { mapAgentActivity, mapAgentSession, type AgentActivityRow, type AgentSessionRow } from "./rows.js";
import { emitWebhook } from "./webhooks.js";

export function listAgentSessions(domain: LinearDomain): LinearAgentSession[] {
  return (
    domain.db.prepare("SELECT * FROM agent_sessions ORDER BY created_at, id").all() as AgentSessionRow[]
  ).map(mapAgentSession);
}

export function getAgentSession(domain: LinearDomain, ref: string): LinearAgentSession | null {
  const row = domain.db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(ref) as
    | AgentSessionRow
    | undefined;
  return row ? mapAgentSession(row) : null;
}

export async function createAgentSessionOnIssue(
  domain: LinearDomain,
  input: { issueId: string; agentUserId?: string; plan?: string | null; externalUrl?: string | null },
  actor: ActorContext = {}
): Promise<LinearAgentSession> {
  domain.requireScopes(actor, ["write"]);
  const issue = domain.requireIssue(input.issueId);
  const viewer = domain.resolveViewer(actor);
  const agent =
    (input.agentUserId ? domain.requireUser(input.agentUserId) : null) ??
    domain.listUsers().find((u) => u.app) ??
    viewer;
  const now = domain.tick();
  const id = domain.nextId("agent_session");
  domain.db
    .prepare(
      `INSERT INTO agent_sessions(id, issue_id, comment_id, agent_user_id, state, plan, external_url, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(id, issue.id, null, agent.id, "pending", input.plan ?? null, input.externalUrl ?? null, now, now);
  const session = domain.requireAgentSession(id);
  await emitWebhook(domain, {
    type: "AgentSessionEvent",
    action: "created",
    data: { id: session.id, issueId: issue.id, state: session.state },
    actor: viewer,
    teamId: issue.teamId,
  });
  return session;
}

export async function createAgentSessionOnComment(
  domain: LinearDomain,
  input: { commentId: string; agentUserId?: string; plan?: string | null; externalUrl?: string | null },
  actor: ActorContext = {}
): Promise<LinearAgentSession> {
  // comments:create covers mention-triggered sessions from createComment; write covers GraphQL.
  domain.requireScopes(actor, ["comments:create"]);
  const comment = domain.requireComment(input.commentId);
  const issue = domain.requireIssue(comment.issueId);
  const viewer = domain.resolveViewer(actor);
  const agent =
    (input.agentUserId ? domain.requireUser(input.agentUserId) : null) ??
    domain.listUsers().find((u) => u.app) ??
    viewer;
  const now = domain.tick();
  const id = domain.nextId("agent_session");
  domain.db
    .prepare(
      `INSERT INTO agent_sessions(id, issue_id, comment_id, agent_user_id, state, plan, external_url, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(id, issue.id, comment.id, agent.id, "pending", input.plan ?? null, input.externalUrl ?? null, now, now);
  return domain.requireAgentSession(id);
}

export function updateAgentSession(
  domain: LinearDomain,
  id: string,
  input: { state?: string; plan?: string | null; externalUrl?: string | null },
  actor: ActorContext = {}
): LinearAgentSession {
  domain.requireScopes(actor, ["write"]);
  const session = domain.requireAgentSession(id);
  const now = domain.tick();
  domain.db
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
  return domain.requireAgentSession(session.id);
}

export async function createAgentActivity(
  domain: LinearDomain,
  input: { sessionId: string; type: string; body: string; ephemeral?: boolean },
  actor: ActorContext = {}
): Promise<LinearAgentActivity> {
  domain.requireScopes(actor, ["write"]);
  assertBody(input.body);
  const session = domain.requireAgentSession(input.sessionId);
  const viewer = domain.resolveViewer(actor);
  const type = normalizeActivityType(input.type);
  const now = domain.tick();
  const id = domain.nextId("agent_activity");
  const ephemeral =
    typeof input.ephemeral === "boolean" ? input.ephemeral : type === "thought" || type === "action";
  domain.db
    .prepare(
      `INSERT INTO agent_activities(id, session_id, user_id, type, body, ephemeral, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(id, session.id, viewer.id, type, input.body, ephemeral ? 1 : 0, now, now);
  if (type === "prompt") {
    await emitWebhook(domain, {
      type: "AgentSessionEvent",
      action: "prompted",
      data: { id: session.id, state: session.state },
      actor: viewer,
      teamId: session.issueId ? domain.requireIssue(session.issueId).teamId : null,
    });
  }
  const activity = domain.getAgentActivity(id);
  if (!activity) notFound(`Agent activity not found: ${id}`);
  return activity;
}

export function getAgentActivity(domain: LinearDomain, ref: string): LinearAgentActivity | null {
  const row = domain.db.prepare("SELECT * FROM agent_activities WHERE id = ?").get(ref) as
    | AgentActivityRow
    | undefined;
  return row ? mapAgentActivity(row) : null;
}

export function listAgentActivities(domain: LinearDomain, sessionId: string): LinearAgentActivity[] {
  return (
    domain.db
      .prepare("SELECT * FROM agent_activities WHERE session_id = ? ORDER BY created_at, id")
      .all(sessionId) as AgentActivityRow[]
  ).map(mapAgentActivity);
}
