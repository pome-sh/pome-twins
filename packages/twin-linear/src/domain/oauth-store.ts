// SPDX-License-Identifier: Apache-2.0
import { token } from "../ids.js";
import { assertWebhookUrl } from "../webhook-url.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_LINEAR_SID,
  type LinearOAuthApp,
  type LinearToken,
  type LinearTokenActorType,
  type LinearTokenType,
  type LinearWebhook,
} from "../types.js";
import type { ActorContext, LinearDomain, PendingCode } from "./linear-domain.js";
import {
  mapOAuthApp,
  mapToken,
  mapWebhook,
  type OAuthAppRow,
  type PendingCodeRow,
  type TokenRow,
  type WebhookRow,
} from "./rows.js";

export function listOAuthApps(domain: LinearDomain): LinearOAuthApp[] {
  return (domain.db.prepare("SELECT * FROM oauth_apps ORDER BY created_at").all() as OAuthAppRow[]).map(
    mapOAuthApp
  );
}

export function getOAuthApp(domain: LinearDomain, clientId: string): LinearOAuthApp | null {
  const row = domain.db
    .prepare("SELECT * FROM oauth_apps WHERE client_id = ? OR id = ?")
    .get(clientId, clientId) as OAuthAppRow | undefined;
  return row ? mapOAuthApp(row) : null;
}

export function insertToken(
  domain: LinearDomain,
  input: {
    token: string;
    type: LinearTokenType;
    actorType: LinearTokenActorType;
    userId: string | null;
    appId: string | null;
    scopes: string[];
    expiresAt: string | null;
    refreshToken?: string | null;
    sid?: string;
  }
): LinearToken {
  const now = domain.now();
  const sid = input.sid ?? domain.config("default_sid") ?? DEFAULT_LINEAR_SID;
  domain.db
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
  return domain.getToken(input.token)!;
}

export function getToken(domain: LinearDomain, tokenValue: string): LinearToken | null {
  const row = domain.db.prepare("SELECT * FROM tokens WHERE token = ?").get(tokenValue) as TokenRow | undefined;
  return row ? mapToken(row) : null;
}

export function revokeToken(domain: LinearDomain, tokenValue: string): void {
  const now = domain.now();
  domain.db.prepare("UPDATE tokens SET revoked = 1, updated_at = ? WHERE token = ?").run(now, tokenValue);
}

export function storePendingCode(domain: LinearDomain, code: string, pending: PendingCode): void {
  domain.db
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

export function takePendingCode(domain: LinearDomain, code: string): PendingCode | null {
  const row = domain.db.prepare("SELECT * FROM oauth_pending_codes WHERE code = ?").get(code) as
    | PendingCodeRow
    | undefined;
  if (!row) return null;
  domain.db.prepare("DELETE FROM oauth_pending_codes WHERE code = ?").run(code);
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

export function issueOAuthTokens(
  domain: LinearDomain,
  input: {
    userId: string | null;
    appId: string | null;
    actor: LinearTokenActorType;
    scopes: string[];
    includeRefresh?: boolean;
  }
): {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
} {
  const accessToken = token("lin");
  const includeRefresh = input.includeRefresh !== false;
  const refreshToken = includeRefresh ? token("lin_refresh") : null;
  const expiresAt = new Date(Date.parse(domain.now()) + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
  domain.insertToken({
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
    domain.insertToken({
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

export function listWebhooks(domain: LinearDomain): LinearWebhook[] {
  return (domain.db.prepare("SELECT * FROM webhooks ORDER BY created_at, id").all() as WebhookRow[]).map(
    mapWebhook
  );
}

export function getWebhook(domain: LinearDomain, ref: string): LinearWebhook | null {
  const row = domain.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(ref) as WebhookRow | undefined;
  return row ? mapWebhook(row) : null;
}

export function createWebhook(
  domain: LinearDomain,
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
  domain.requireScopes(actor, ["write"]);
  const url = assertWebhookUrl(input.url);
  const team = input.teamId ? domain.requireTeam(input.teamId) : null;
  const viewer = domain.resolveViewer(actor);
  const now = domain.tick();
  const id = domain.nextId("webhook");
  domain.db
    .prepare(
      `INSERT INTO webhooks(
          id, label, url, enabled, resource_types_json, team_id, all_public_teams, secret, creator_id, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      input.label ?? "Local webhook",
      url,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.resourceTypes ?? ["Issue", "Comment"]),
      team?.id ?? null,
      (input.allPublicTeams ?? !team) ? 1 : 0,
      input.secret ?? null,
      viewer.id,
      now,
      now
    );
  return domain.getWebhook(id)!;
}

export function deleteWebhook(domain: LinearDomain, id: string, actor: ActorContext = {}): string {
  domain.requireScopes(actor, ["write"]);
  const webhook = domain.requireWebhook(id);
  domain.db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").run(webhook.id);
  domain.db.prepare("DELETE FROM webhooks WHERE id = ?").run(webhook.id);
  return webhook.id;
}

export function recordWebhookDelivery(
  domain: LinearDomain,
  input: {
    id: string;
    webhookId: string;
    event: string;
    action: string;
    url: string;
    status: number | null;
    error: string | null;
    payload: unknown;
    headers: Record<string, string>;
  }
): void {
  const now = domain.now();
  domain.db
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
