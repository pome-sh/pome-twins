// SPDX-License-Identifier: Apache-2.0
import type { LinearIssue, LinearIssueLabel } from "../types.js";
import type { ActorContext, LinearDomain } from "./linear-domain.js";
import { mapLabel, type LabelRow } from "./rows.js";
import { emitWebhook, issueWebhookPayload } from "./webhooks.js";

export function listLabels(domain: LinearDomain, teamRef?: string): LinearIssueLabel[] {
  const rows = domain.db.prepare("SELECT * FROM issue_labels ORDER BY name").all() as LabelRow[];
  const labels = rows.map(mapLabel);
  if (!teamRef) return labels;
  const team = domain.getTeam(teamRef);
  if (!team) return [];
  return labels.filter((l) => l.teamId === team.id || l.teamId === null);
}

export function getLabel(domain: LinearDomain, ref: string, teamRef?: string): LinearIssueLabel | null {
  return domain.listLabels(teamRef).find((l) => l.id === ref || l.name === ref) ?? null;
}

export async function createLabel(
  domain: LinearDomain,
  input: { name: string; color?: string; description?: string | null; teamId?: string | null },
  actor: ActorContext = {}
): Promise<LinearIssueLabel> {
  domain.requireScopes(actor, ["write"]);
  const team = input.teamId ? domain.requireTeam(input.teamId) : null;
  const now = domain.tick();
  const id = domain.nextId("label");
  domain.db
    .prepare(
      `INSERT INTO issue_labels(id, team_id, name, color, description, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`
    )
    .run(id, team?.id ?? null, input.name, input.color ?? "#64748b", input.description ?? null, now, now);
  const label = domain.getLabel(id)!;
  await emitWebhook(domain, {
    type: "IssueLabel",
    action: "create",
    data: { id: label.id, name: label.name, color: label.color },
    actor: domain.resolveViewer(actor),
    teamId: label.teamId,
  });
  return label;
}

export async function updateLabel(
  domain: LinearDomain,
  id: string,
  input: { name?: string; color?: string; description?: string | null },
  actor: ActorContext = {}
): Promise<LinearIssueLabel> {
  domain.requireScopes(actor, ["write"]);
  const label = domain.requireLabel(id);
  const now = domain.tick();
  domain.db
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
  const updated = domain.getLabel(label.id)!;
  await emitWebhook(domain, {
    type: "IssueLabel",
    action: "update",
    data: { id: updated.id, name: updated.name, color: updated.color },
    actor: domain.resolveViewer(actor),
    teamId: updated.teamId,
  });
  return updated;
}

export async function deleteLabel(
  domain: LinearDomain,
  id: string,
  actor: ActorContext = {}
): Promise<string> {
  domain.requireScopes(actor, ["write"]);
  const label = domain.requireLabel(id);
  domain.db.prepare("DELETE FROM issue_label_links WHERE label_id = ?").run(label.id);
  domain.db.prepare("DELETE FROM issue_labels WHERE id = ?").run(label.id);
  await emitWebhook(domain, {
    type: "IssueLabel",
    action: "remove",
    data: { id: label.id, name: label.name, color: label.color },
    actor: domain.resolveViewer(actor),
    teamId: label.teamId,
  });
  return label.id;
}

export async function addIssueLabel(
  domain: LinearDomain,
  issueId: string,
  labelId: string,
  actor: ActorContext = {}
): Promise<LinearIssue> {
  domain.requireScopes(actor, ["write"]);
  const issue = domain.requireIssue(issueId);
  const label = domain.requireLabel(labelId, issue.teamId);
  if (issue.labelIds.includes(label.id)) return issue;
  const before = issueWebhookPayload(issue);
  domain.db
    .prepare("INSERT OR IGNORE INTO issue_label_links(issue_id, label_id) VALUES (?, ?)")
    .run(issue.id, label.id);
  const now = domain.tick();
  domain.db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, issue.id);
  const updated = domain.getIssue(issue.id)!;
  await emitWebhook(domain, {
    type: "Issue",
    action: "update",
    data: issueWebhookPayload(updated),
    actor: domain.resolveViewer(actor),
    teamId: updated.teamId,
    url: updated.url,
    updatedFrom: before,
  });
  return updated;
}

export async function removeIssueLabel(
  domain: LinearDomain,
  issueId: string,
  labelId: string,
  actor: ActorContext = {}
): Promise<LinearIssue> {
  domain.requireScopes(actor, ["write"]);
  const issue = domain.requireIssue(issueId);
  const label = domain.requireLabel(labelId, issue.teamId);
  if (!issue.labelIds.includes(label.id)) return issue;
  const before = issueWebhookPayload(issue);
  domain.db.prepare("DELETE FROM issue_label_links WHERE issue_id = ? AND label_id = ?").run(issue.id, label.id);
  const now = domain.tick();
  domain.db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, issue.id);
  const updated = domain.getIssue(issue.id)!;
  await emitWebhook(domain, {
    type: "Issue",
    action: "update",
    data: issueWebhookPayload(updated),
    actor: domain.resolveViewer(actor),
    teamId: updated.teamId,
    url: updated.url,
    updatedFrom: before,
  });
  return updated;
}
