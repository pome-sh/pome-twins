import { sign } from "hono/jwt";

export const TEST_AUTH_SECRET = "test-secret-32-chars-minimum-length";
export const TEST_SID = "test-session";
export const TEST_TEAM = "tm_test";
export const TEST_LOGIN = "pome-agent";

export async function signTestToken(
  overrides: { sid?: string; team_id?: string; login?: string | null; expSeconds?: number } = {}
) {
  const sid = overrides.sid ?? TEST_SID;
  const team_id = overrides.team_id ?? TEST_TEAM;
  const expSeconds = overrides.expSeconds ?? 3600;
  const exp = Math.floor(Date.now() / 1000) + expSeconds;
  const login = overrides.login === null ? undefined : overrides.login ?? TEST_LOGIN;
  const claims: Record<string, unknown> = { sid, team_id, exp };
  if (login !== undefined) claims.login = login;
  return sign(claims, TEST_AUTH_SECRET);
}

export function withAuth(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}
