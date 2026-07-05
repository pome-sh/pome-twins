// SPDX-License-Identifier: Apache-2.0
import type { MiddlewareHandler } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { verify } from "hono/jwt";
import { slackError } from "./serializers.js";
import { createAdminGate } from "./admin-gate.js";

export interface SessionClaims {
  sid: string;
  team_id: string;
  exp: number;
  login?: string;
}

export interface Session {
  sid: string;
  team_id: string;
  login?: string;
}

export function resolveAuthSecret(): string {
  const secret = process.env.TWIN_AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("TWIN_AUTH_SECRET required in production");
  }
  return secret ?? "dev-only-insecure-secret";
}

function unauthorized(code = "invalid_auth") {
  return Response.json(slackError(code), { status: 401 });
}

/**
 * Resolve the bearer token from any of the locations real Slack accepts:
 *   1. Authorization: Bearer <token>  (preferred — MCP / SDK default)
 *   2. ?token=<token> in the URL    (some legacy Slack SDK paths)
 *   3. token=<token> in the form body (Slack docs note this is supported
 *      for application/x-www-form-urlencoded requests).
 *
 * We read the form body via parseBody() — but only when the content-type
 * is form-encoded, to avoid breaking JSON streaming reads downstream.
 */
async function resolveToken(c: import("hono").Context): Promise<string | undefined> {
  const header = c.req.header("Authorization") ?? c.req.header("authorization");
  if (header && header.startsWith("Bearer ")) {
    const t = header.slice("Bearer ".length).trim();
    if (t) return t;
  }
  // ?token= fallback (query string).
  const qToken = c.req.query("token");
  if (qToken) return qToken;
  // form-body token= fallback. Only attempt for form-encoded POSTs.
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (
    c.req.method === "POST" &&
    (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data"))
  ) {
    try {
      // parseBody is buffered + caches the parsed body on Hono's context,
      // so downstream handlers calling parseFormOrJson get the same object.
      const body = (await c.req.parseBody()) as Record<string, unknown>;
      const formToken = body.token;
      if (typeof formToken === "string" && formToken.length > 0) return formToken;
    } catch {
      // ignore parse failures; auth fall-through returns not_authed
    }
  }
  return undefined;
}

function extractSidFromUrl(rawUrl: string): string | undefined {
  try {
    const path = new URL(rawUrl).pathname;
    const match = path.match(/^\/s\/([^/]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export function bearerAuth(): MiddlewareHandler {
  return async (c, next) => {
    const token = await resolveToken(c);
    if (!token) return unauthorized("not_authed");

    // Provider-shape Slack tokens: xoxb-pome-<sid>-<sig> | xoxp-pome-<sid>-<sig>
    const providerSid = verifyProviderToken(token);
    if (providerSid) {
      const pathSid = c.req.param("sid") ?? extractSidFromUrl(c.req.url);
      if (providerSid !== pathSid) {
        return Response.json(slackError("invalid_auth"), { status: 401 });
      }
      c.set("session", { sid: providerSid, team_id: "provider-shaped", login: "pome-agent" });
      await next();
      return;
    }

    let claims: SessionClaims;
    try {
      claims = (await verify(token, resolveAuthSecret(), "HS256")) as unknown as SessionClaims;
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      if (name === "JwtTokenExpired" || /expired/i.test((err as Error).message ?? "")) {
        return unauthorized("token_expired");
      }
      return unauthorized("invalid_auth");
    }

    if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) {
      return unauthorized("token_expired");
    }

    const pathSid = c.req.param("sid") ?? extractSidFromUrl(c.req.url);
    if (!claims.sid || claims.sid !== pathSid) {
      return Response.json(slackError("invalid_auth"), { status: 401 });
    }

    const session: Session = { sid: claims.sid, team_id: claims.team_id };
    if (typeof claims.login === "string" && claims.login.length > 0) session.login = claims.login;
    c.set("session", session);
    await next();
  };
}

function verifyProviderToken(token: string): string | undefined {
  // Preferred shape (with session expiry): xoxb-pome-<base64url(sid)>_<exp>_<sig>
  // Legacy shape (no expiry):              xoxb-pome-<base64url(sid)>_<sig>
  // The `\d+` middle segment unambiguously picks the new shape over the legacy.
  const matchExp = token.match(/^xox[bp]-pome-([^_]+)_(\d+)_(.+)$/);
  if (matchExp) {
    const expSeconds = Number(matchExp[2]);
    if (!Number.isFinite(expSeconds)) return undefined;
    if (expSeconds < Math.floor(Date.now() / 1000)) return undefined;
    const sid = decodeBase64Url(matchExp[1]!);
    if (!sid) return undefined;
    const expected = signProviderExp(sid, expSeconds, resolveAuthSecret());
    if (safeEqual(matchExp[3]!, expected)) return sid;
    return undefined;
  }
  const matchLegacy = token.match(/^xox[bp]-pome-([^_]+)_(.+)$/);
  if (!matchLegacy) return undefined;
  const sid = decodeBase64Url(matchLegacy[1]!);
  if (!sid) return undefined;
  const expected = signProvider(sid, resolveAuthSecret());
  if (safeEqual(matchLegacy[2]!, expected)) return sid;
  return undefined;
}

function signProvider(sid: string, secret: string) {
  return createHmac("sha256", secret).update(`slack:${sid}`).digest("base64url").slice(0, 22);
}

function signProviderExp(sid: string, exp: number, secret: string) {
  return createHmac("sha256", secret).update(`slack:${sid}:${exp}`).digest("base64url").slice(0, 22);
}

function decodeBase64Url(value: string): string | undefined {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Admin endpoint protection. Thin wrapper over the shared, mirrored
 * admin-gate module (FDRS-587 / FDRS-616) with the Slack error envelope.
 */
export function requireAdminAuth(): MiddlewareHandler {
  return createAdminGate({
    forbidden: () => Response.json(slackError("restricted_action"), { status: 403 }),
  });
}

/**
 * Build a provider-shape Slack token. When `exp` is passed, emits the
 * 4-segment shape `<prefix>-pome-<base64url(sid)>_<exp>_<sig>` where the
 * HMAC covers `slack:<sid>:<exp>` so a leaked token expires with its
 * session. When `exp` is omitted, emits the legacy 3-segment shape for
 * backward compatibility — verifyProviderToken accepts both.
 *
 * Cloud control-plane should always pass `exp` matching the issued JWT's
 * `exp` claim so xoxb / xoxp tokens cannot outlive their session.
 */
export function signSlackProviderToken(
  sid: string,
  secret: string = resolveAuthSecret(),
  prefix: "xoxb" | "xoxp" = "xoxb",
  exp?: number
): string {
  const sigEncoded = Buffer.from(sid, "utf8").toString("base64url");
  if (typeof exp === "number" && Number.isFinite(exp)) {
    const sig = signProviderExp(sid, exp, secret);
    return `${prefix}-pome-${sigEncoded}_${exp}_${sig}`;
  }
  const sig = signProvider(sid, secret);
  return `${prefix}-pome-${sigEncoded}_${sig}`;
}
