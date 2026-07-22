// SPDX-License-Identifier: Apache-2.0
import { badUserInput } from "../errors.js";
import type { LinearComment } from "../types.js";
import { assertBody } from "./normalize.js";
import type { ActorContext, LinearDomain } from "./linear-domain.js";
import { mapComment, type CommentRow } from "./rows.js";
import { commentWebhookPayload, emitWebhook } from "./webhooks.js";

export function listComments(domain: LinearDomain, issueRef?: string): LinearComment[] {
  if (!issueRef) {
    return (domain.db.prepare("SELECT * FROM comments ORDER BY created_at, id").all() as CommentRow[]).map(
      mapComment
    );
  }
  const issue = domain.requireIssue(issueRef);
  return (
    domain.db
      .prepare("SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at, id")
      .all(issue.id) as CommentRow[]
  ).map(mapComment);
}

export function getComment(domain: LinearDomain, ref: string): LinearComment | null {
  const row = domain.db.prepare("SELECT * FROM comments WHERE id = ?").get(ref) as CommentRow | undefined;
  return row ? mapComment(row) : null;
}

export async function createComment(
  domain: LinearDomain,
  input: {
    issueId?: string;
    parentId?: string | null;
    body: string;
    createAsUser?: string | null;
    displayIconUrl?: string | null;
  },
  actor: ActorContext = {}
): Promise<LinearComment> {
  domain.requireScopes(actor, ["comments:create"]);
  assertBody(input.body);
  const parent = input.parentId ? domain.requireComment(input.parentId) : null;
  const issueRef = input.issueId ?? parent?.issueId;
  if (!issueRef) badUserInput("issueId is required when creating a comment (or provide parentId)");
  const issue = domain.requireIssue(issueRef);
  if (parent && parent.issueId !== issue.id) {
    badUserInput("parentId must belong to the same issue");
  }
  const viewer = domain.resolveViewer(actor);
  const now = domain.tick();
  const id = domain.nextId("comment");
  domain.db
    .prepare(
      `INSERT INTO comments(id, issue_id, parent_id, user_id, body, create_as_user, display_icon_url, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      issue.id,
      parent?.id ?? null,
      viewer.id,
      input.body,
      input.createAsUser ?? null,
      input.displayIconUrl ?? null,
      now,
      now
    );
  const comment = domain.getComment(id)!;
  await emitWebhook(domain, {
    type: "Comment",
    action: "create",
    data: commentWebhookPayload(comment),
    actor: viewer,
    teamId: issue.teamId,
    url: issue.url,
  });
  if (mentionsAppUser(comment.body)) {
    const appUser = domain.listUsers().find((u) => u.app && comment.body.includes(u.displayName));
    if (appUser) {
      await domain.createAgentSessionOnComment({ commentId: comment.id, agentUserId: appUser.id }, actor);
    }
  }
  return comment;
}

export async function updateComment(
  domain: LinearDomain,
  id: string,
  body: string,
  actor: ActorContext = {}
): Promise<LinearComment> {
  domain.requireScopes(actor, ["write"]);
  assertBody(body);
  const comment = domain.requireComment(id);
  const before = commentWebhookPayload(comment);
  const now = domain.tick();
  domain.db.prepare("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?").run(body, now, comment.id);
  const updated = domain.getComment(comment.id)!;
  const issue = domain.requireIssue(updated.issueId);
  await emitWebhook(domain, {
    type: "Comment",
    action: "update",
    data: commentWebhookPayload(updated),
    actor: domain.resolveViewer(actor),
    teamId: issue.teamId,
    url: issue.url,
    updatedFrom: before,
  });
  return updated;
}

export async function deleteComment(
  domain: LinearDomain,
  id: string,
  actor: ActorContext = {}
): Promise<string> {
  domain.requireScopes(actor, ["write"]);
  const comment = domain.requireComment(id);
  const issue = domain.requireIssue(comment.issueId);
  // Full reply tree (SQLite FK may be off). Nested threads are root → reply → reply.
  const treeIds = (
    domain.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM comments WHERE id = ?
           UNION ALL
           SELECT c.id FROM comments c INNER JOIN tree t ON c.parent_id = t.id
         )
         SELECT id FROM tree`
      )
      .all(comment.id) as Array<{ id: string }>
  ).map((row) => row.id);
  const placeholders = treeIds.map(() => "?").join(", ");
  domain.db
    .prepare(
      `DELETE FROM agent_activities WHERE session_id IN (
         SELECT id FROM agent_sessions WHERE comment_id IN (${placeholders})
       )`
    )
    .run(...treeIds);
  domain.db.prepare(`DELETE FROM agent_sessions WHERE comment_id IN (${placeholders})`).run(...treeIds);
  domain.db.prepare(`DELETE FROM comments WHERE id IN (${placeholders})`).run(...treeIds);
  await emitWebhook(domain, {
    type: "Comment",
    action: "remove",
    data: commentWebhookPayload(comment),
    actor: domain.resolveViewer(actor),
    teamId: issue.teamId,
    url: issue.url,
  });
  return comment.id;
}

function mentionsAppUser(body: string): boolean {
  return body.includes("@");
}
