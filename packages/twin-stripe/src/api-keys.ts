// SPDX-License-Identifier: Apache-2.0
// Stripe SDKs send `Authorization: Bearer sk_test_...`. We accept both that and the
// `Authorization: Bearer sk_test_...`. We accept both that and the
// twin-github JWT shape. This module owns the api_keys table.
import type { ApiKeyRow, TwinStripeDatabase } from "./types.js";
import { newApiKey } from "./ids.js";
import { nowIso } from "./util.js";

export type MintApiKeyInput = {
  sid: string;
  account_id?: string;
  /** Override key for tests / seed. Must already begin with sk_test_pome_. */
  key?: string;
};

/**
 * Mint a new Stripe-shaped api key bound to a session id. The Stripe SDK
 * sends `Authorization: Bearer <key>` and the twin resolves the row to a
 * sid. Pattern from D-ENG-1.
 */
export function mintApiKey(
  db: TwinStripeDatabase,
  input: MintApiKeyInput
): ApiKeyRow {
  const key = input.key ?? newApiKey();
  const account_id = input.account_id ?? `acct_${input.sid}`;
  const created_at = nowIso();
  db.prepare(
    `INSERT INTO api_keys (key, sid, account_id, created_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(key) DO UPDATE SET
       sid = excluded.sid,
       account_id = excluded.account_id,
       revoked_at = NULL`
  ).run(key, input.sid, account_id, created_at);
  return { key, sid: input.sid, account_id, created_at, revoked_at: null };
}

/** Revoke a key without deleting (audit). */
export function revokeApiKey(db: TwinStripeDatabase, key: string): void {
  db.prepare(`UPDATE api_keys SET revoked_at = ? WHERE key = ?`).run(
    nowIso(),
    key
  );
}

/**
 * Resolve a bearer token (the value after `Bearer `) to a session if it is
 * an active api key. Returns undefined if the key is missing, malformed,
 * or revoked. Caller is responsible for distinguishing api keys from JWTs
 * via the `sk_test_pome_` / `rk_test_pome_` prefix.
 */
export function resolveSidFromKey(
  db: TwinStripeDatabase,
  token: string
): { sid: string; account_id: string } | undefined {
  const row = db
    .prepare(
      `SELECT key, sid, account_id, created_at, revoked_at
         FROM api_keys
        WHERE key = ? AND revoked_at IS NULL`
    )
    .get(token) as ApiKeyRow | undefined;
  if (!row) return undefined;
  return { sid: row.sid, account_id: row.account_id };
}

/** Heuristic prefix check — does this token look like one of our api keys? */
export function looksLikeApiKey(token: string): boolean {
  return (
    token.startsWith("sk_test_pome_") ||
    token.startsWith("rk_test_pome_") ||
    // Tolerate raw Stripe-style sk_test_* / rk_test_* in case a downstream
    // user mints their own non-pome-prefixed test keys via the admin API.
    token.startsWith("sk_test_") ||
    token.startsWith("rk_test_")
  );
}
