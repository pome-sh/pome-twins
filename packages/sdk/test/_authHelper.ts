// SPDX-License-Identifier: Apache-2.0
import { sign } from "hono/jwt";

export const TEST_AUTH_SECRET = "test-secret-32-chars-minimum-length";
export const TEST_SID = "test-session";
export const TEST_TEAM = "tm_test";

export async function signTestToken(
  overrides: { sid?: string; team_id?: string; expSeconds?: number } = {}
) {
  const sid = overrides.sid ?? TEST_SID;
  const team_id = overrides.team_id ?? TEST_TEAM;
  const expSeconds = overrides.expSeconds ?? 3600;
  return sign(
    { sid, team_id, exp: Math.floor(Date.now() / 1000) + expSeconds },
    TEST_AUTH_SECRET
  );
}

export function withAuth(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}
