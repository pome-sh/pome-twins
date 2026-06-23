// SPDX-License-Identifier: Apache-2.0
import { sign } from "hono/jwt";
import { mintApiKey } from "../src/api-keys.js";
import type { TwinStripeDatabase } from "../src/types.js";

export const TEST_AUTH_SECRET = "test-secret-32-chars-minimum-length";
export const TEST_SID = "test-session";
export const TEST_ACCOUNT_ID = "acct_test-session";

export async function signTestToken(
  overrides: { sid?: string; account_id?: string; expSeconds?: number } = {}
) {
  const sid = overrides.sid ?? TEST_SID;
  const account_id = overrides.account_id ?? `acct_${sid}`;
  const expSeconds = overrides.expSeconds ?? 3600;
  return sign(
    {
      sid,
      account_id,
      exp: Math.floor(Date.now() / 1000) + expSeconds
    },
    TEST_AUTH_SECRET
  );
}

export function withAuth(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * Mint a test api key that resolves to the given sid via the api_keys
 * table. Caller passes the live db handle.
 */
export function mintTestApiKey(
  db: TwinStripeDatabase,
  overrides: { sid?: string; key?: string; account_id?: string } = {}
) {
  const sid = overrides.sid ?? TEST_SID;
  return mintApiKey(db, {
    sid,
    account_id: overrides.account_id ?? `acct_${sid}`,
    key: overrides.key ?? `sk_test_pome_${sid}_${Math.random().toString(36).slice(2, 10)}`
  });
}
