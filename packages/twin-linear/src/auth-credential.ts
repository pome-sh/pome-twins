// SPDX-License-Identifier: Apache-2.0
import type { SessionValue } from "@pome-sh/sdk/server";
import {
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_LINEAR_SID,
  LINEAR_PROVIDER_TOKEN_PREFIX,
  type LinearTwinDatabase,
} from "./types.js";

export function looksLikeLinearToken(token: string): boolean {
  if (!token || token.length < 8) return false;
  if (token.startsWith(LINEAR_PROVIDER_TOKEN_PREFIX)) return false;
  // Personal API keys / OAuth access tokens / client credentials stored in DB.
  return (
    token.startsWith("lin_") ||
    token.startsWith("lin_oauth_") ||
    /^[A-Za-z0-9_-]{20,}$/.test(token)
  );
}

type TokenRow = {
  token: string;
  type: string;
  actor_type: string;
  user_id: string | null;
  app_id: string | null;
  scopes_json: string;
  expires_at: string | null;
  revoked: number;
  sid: string;
  email: string | null;
};

/**
 * Resolve a DB-backed Linear token into a session.
 * Auth order in twin.ts: resolveCredential → lin_pome_ provider → JWT.
 */
export function resolveLinearCredential(
  db: LinearTwinDatabase,
  token: string,
  nowIso?: string
): SessionValue | undefined {
  if (!looksLikeLinearToken(token)) return undefined;

  const row = db
    .prepare(
      `SELECT t.token, t.type, t.actor_type, t.user_id, t.app_id, t.scopes_json,
              t.expires_at, t.revoked, t.sid, u.email
       FROM tokens t
       LEFT JOIN users u ON u.id = t.user_id
       WHERE t.token = ?`
    )
    .get(token) as TokenRow | undefined;

  if (!row) return undefined;
  if (row.revoked) return undefined;
  if (row.type === "oauth_refresh") return undefined;
  if (row.expires_at) {
    const now =
      nowIso ??
      (
        db.prepare("SELECT value FROM linear_config WHERE key = 'clock'").get() as
          | { value: string }
          | undefined
      )?.value ??
      new Date().toISOString();
    if (row.expires_at < now) return undefined;
  }

  let scopes: string[] = [];
  try {
    scopes = JSON.parse(row.scopes_json) as string[];
  } catch {
    scopes = [];
  }

  return {
    sid: row.sid || DEFAULT_LINEAR_SID,
    linear_user_id: row.user_id,
    linear_email: (row.email ?? DEFAULT_LINEAR_EMAIL).toLowerCase(),
    linear_app_id: row.app_id,
    linear_actor: row.actor_type,
    scopes,
    via: "linear_token",
  };
}
