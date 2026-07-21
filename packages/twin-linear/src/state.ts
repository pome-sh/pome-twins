// SPDX-License-Identifier: Apache-2.0
import { STATE_EXPORT_CAP, type LinearTwinDatabase } from "./types.js";

export type LinearStateExport = {
  schemaVersion: 1;
  clock: string | null;
  organization: unknown | null;
  users: unknown[];
  teams: unknown[];
  workflowStates: unknown[];
  labels: unknown[];
  projects: unknown[];
  cycles: unknown[];
  issues: unknown[];
  comments: unknown[];
  oauthApps: unknown[];
  tokens: unknown[];
  webhooks: unknown[];
  webhookDeliveries: unknown[];
  agentSessions: unknown[];
  agentActivities: unknown[];
  exportBounds: {
    truncatedCollections: string[];
  };
};

export type LinearStateDeltaView = {
  schemaVersion: 1;
  organization?: unknown | null;
  users?: unknown[];
  teams?: unknown[];
  workflowStates?: unknown[];
  labels?: unknown[];
  projects?: unknown[];
  cycles?: unknown[];
  issues?: unknown[];
  comments?: unknown[];
  oauthApps?: unknown[];
  tokens?: unknown[];
  webhooks?: unknown[];
  webhookDeliveries?: unknown[];
  agentSessions?: unknown[];
  agentActivities?: unknown[];
};

const ENTITY_COLLECTIONS = [
  "organization",
  "users",
  "teams",
  "workflowStates",
  "labels",
  "projects",
  "cycles",
  "issues",
  "comments",
  "oauthApps",
  "tokens",
  "webhooks",
  "webhookDeliveries",
  "agentSessions",
  "agentActivities",
] as const;

export function exportLinearState(db: LinearTwinDatabase): LinearStateExport {
  const truncatedCollections: string[] = [];
  const clock = (
    db.prepare("SELECT value FROM linear_config WHERE key = 'clock'").get() as { value: string } | undefined
  )?.value ?? null;

  const webhookDeliveries = capped(
    (
      db
        .prepare(
          `SELECT id, webhook_id AS webhookId, event, action, url, status, error,
                  payload_json AS payload, headers_json AS headers, created_at AS createdAt
           FROM webhook_deliveries ORDER BY created_at DESC, id DESC`
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({
      ...row,
      payload: parseJson(row.payload),
      headers: redactHeaders(parseJson(row.headers) as Record<string, unknown>),
    })),
    "webhookDeliveries",
    truncatedCollections,
    true
  );

  const agentActivities = capped(
    db
      .prepare(
        `SELECT id, session_id AS sessionId, user_id AS userId, type, body, ephemeral,
                created_at AS createdAt FROM agent_activities ORDER BY created_at DESC, id DESC`
      )
      .all() as unknown[],
    "agentActivities",
    truncatedCollections,
    true
  );

  return {
    schemaVersion: 1,
    clock,
    organization:
      (
        db
          .prepare(
            `SELECT id, name, url_key AS urlKey, url, created_at AS createdAt, updated_at AS updatedAt
             FROM organizations LIMIT 1`
          )
          .get() as unknown
      ) ?? null,
    users: db
      .prepare(
        `SELECT id, email, name, display_name AS displayName, avatar_url AS avatarUrl,
                active, admin, app, created_at AS createdAt, updated_at AS updatedAt
         FROM users ORDER BY email`
      )
      .all()
      .map((row) => boolify(row as Record<string, unknown>, ["active", "admin", "app"])),
    teams: db
      .prepare(
        `SELECT id, key, name, description, private, url, issue_sequence AS issueSequence,
                created_at AS createdAt, updated_at AS updatedAt FROM teams ORDER BY key`
      )
      .all()
      .map((row) => boolify(row as Record<string, unknown>, ["private"])),
    workflowStates: db
      .prepare(
        `SELECT id, team_id AS teamId, name, type, position, created_at AS createdAt, updated_at AS updatedAt
         FROM workflow_states ORDER BY team_id, position`
      )
      .all(),
    labels: db
      .prepare(
        `SELECT id, team_id AS teamId, name, color, description, created_at AS createdAt, updated_at AS updatedAt
         FROM issue_labels ORDER BY name`
      )
      .all(),
    projects: db
      .prepare(
        `SELECT id, team_id AS teamId, name, description, state, created_at AS createdAt, updated_at AS updatedAt
         FROM projects ORDER BY name`
      )
      .all(),
    cycles: db
      .prepare(
        `SELECT id, team_id AS teamId, name, number, starts_at AS startsAt, ends_at AS endsAt,
                created_at AS createdAt, updated_at AS updatedAt FROM cycles ORDER BY number`
      )
      .all(),
    issues: (
      db
        .prepare(
          `SELECT id, identifier, number, team_id AS teamId, title, description, priority,
                  state_id AS stateId, assignee_id AS assigneeId, creator_id AS creatorId,
                  delegate_id AS delegateId, project_id AS projectId, cycle_id AS cycleId, url,
                  archived_at AS archivedAt, created_at AS createdAt, updated_at AS updatedAt
           FROM issues ORDER BY identifier`
        )
        .all() as Array<Record<string, unknown>>
    ).map((issue) => ({
      ...issue,
      labelIds: (
        db.prepare("SELECT label_id AS id FROM issue_label_links WHERE issue_id = ?").all(issue.id) as Array<{
          id: string;
        }>
      ).map((r) => r.id),
    })),
    comments: db
      .prepare(
        `SELECT id, issue_id AS issueId, user_id AS userId, body, created_at AS createdAt, updated_at AS updatedAt
         FROM comments ORDER BY created_at`
      )
      .all(),
    oauthApps: (
      db
        .prepare(
          `SELECT id, client_id AS clientId, client_secret AS clientSecret, name,
                  redirect_uris_json AS redirectUris, scopes_json AS scopes, actor,
                  assignable, mentionable, app_user_id AS appUserId,
                  created_at AS createdAt, updated_at AS updatedAt
           FROM oauth_apps ORDER BY name`
        )
        .all() as Array<Record<string, unknown>>
    ).map((app) => ({
      ...boolify(app, ["assignable", "mentionable"]),
      clientSecret: "[redacted]",
      redirectUris: parseJson(app.redirectUris),
      scopes: parseJson(app.scopes),
    })),
    tokens: (
      db
        .prepare(
          `SELECT token, type, actor_type AS actorType, user_id AS userId, app_id AS appId,
                  scopes_json AS scopes, expires_at AS expiresAt, revoked, sid,
                  created_at AS createdAt FROM tokens ORDER BY created_at`
        )
        .all() as Array<Record<string, unknown>>
    ).map((tok) => ({
      ...boolify(tok, ["revoked"]),
      token: redactSecret(String(tok.token)),
      scopes: parseJson(tok.scopes),
    })),
    webhooks: (
      db
        .prepare(
          `SELECT id, label, url, enabled, resource_types_json AS resourceTypes, team_id AS teamId,
                  all_public_teams AS allPublicTeams, secret, creator_id AS creatorId,
                  created_at AS createdAt FROM webhooks ORDER BY created_at`
        )
        .all() as Array<Record<string, unknown>>
    ).map((wh) => ({
      ...boolify(wh, ["enabled", "allPublicTeams"]),
      secret: wh.secret ? "[redacted]" : null,
      resourceTypes: parseJson(wh.resourceTypes),
    })),
    webhookDeliveries,
    agentSessions: db
      .prepare(
        `SELECT id, issue_id AS issueId, comment_id AS commentId, agent_user_id AS agentUserId,
                state, plan, external_url AS externalUrl, created_at AS createdAt
         FROM agent_sessions ORDER BY created_at`
      )
      .all(),
    agentActivities,
    exportBounds: { truncatedCollections },
  };
}

/** Returns null when before/after are deep-equal (no-op mutations). */
export function linearStateDelta(
  before: LinearStateExport,
  after: LinearStateExport
): { before: LinearStateDeltaView | null; after: LinearStateDeltaView | null } | null {
  const beforeView: LinearStateDeltaView = { schemaVersion: 1 };
  const afterView: LinearStateDeltaView = { schemaVersion: 1 };
  let changed = false;
  for (const key of ENTITY_COLLECTIONS) {
    const left = before[key];
    const right = after[key];
    if (stableStringify(left) !== stableStringify(right)) {
      (beforeView as Record<string, unknown>)[key] = left;
      (afterView as Record<string, unknown>)[key] = right;
      changed = true;
    }
  }
  return changed ? { before: beforeView, after: afterView } : null;
}

function capped<T>(
  rows: T[],
  name: string,
  truncated: string[],
  preferNewest = false
): T[] {
  if (rows.length <= STATE_EXPORT_CAP) return preferNewest ? [...rows].reverse() : rows;
  truncated.push(name);
  const slice = preferNewest ? rows.slice(0, STATE_EXPORT_CAP) : rows.slice(-STATE_EXPORT_CAP);
  return preferNewest ? slice.reverse() : slice;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function boolify(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out = { ...row };
  for (const key of keys) {
    if (key in out) out[key] = !!out[key];
  }
  return out;
}

function redactSecret(value: string): string {
  if (value.length <= 8) return "[redacted]";
  return `${value.slice(0, 4)}…[redacted]`;
}

function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/authorization|secret|signature/i.test(key) && typeof value === "string") {
      out[key] = "[redacted]";
    } else {
      out[key] = value;
    }
  }
  return out;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
