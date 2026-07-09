// SPDX-License-Identifier: Apache-2.0
//
// Engine auth (F-681). Spec of record: the F-712 [DECISION] — the engine
// owns the auth *mechanism* (bearer resolution, provider-shaped token
// verify + minting, JWT verification with expired-vs-invalid
// classification, the session-id match); each twin declares only its
// *shape* through `BearerAuthOptions` (token prefixes, error envelopes,
// extra token locations, raw-bearer and sid-mismatch pins, credential
// lookup, mount mode). Per-twin wire behavior stays frozen by the
// contract suite; changing a pin is a deliberate contract change.
import type { Context, MiddlewareHandler } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { verify } from "hono/jwt";
import { createAdminGate } from "./admin-gate.js";

/** `team_id` stamped on sessions authenticated by a provider-shaped token. */
export const PROVIDER_SHAPED_TEAM_ID = "provider-shaped";

export interface SessionClaims {
  sid: string;
  team_id: string;
  exp: number;
  [claim: string]: unknown;
}

/** Minimum session value; twins extend it via hooks (login, account_id, …). */
export type SessionValue = { sid: string } & Record<string, unknown>;

export function resolveAuthSecret(): string {
  const secret = process.env.TWIN_AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("TWIN_AUTH_SECRET required in production");
  }
  return secret ?? "dev-only-insecure-secret";
}

// ─── Provider-shaped tokens (F-712 rows 1 + 10) ─────────────────────────────
//
// Wire shape (frozen, minted by twins + cloud since before F-681):
//   <prefix><base64url(sid)>_<sig22>          (legacy, no expiry)
//   <prefix><base64url(sid)>_<exp>_<sig22>    (expiring)
// where sig = hmac-sha256(secret, "<provider>:<sid>[:<exp>]") base64url,
// truncated to 22 chars.

export interface ProviderTokenSpec {
  /** HMAC domain separator ("github" | "slack" | "stripe" | …). */
  provider: string;
  /** Declared token prefixes, e.g. ["xoxb-pome-", "xoxp-pome-"]. */
  prefixes: readonly string[];
}

const SIG_LENGTH = 22;

export interface MintProviderTokenOptions {
  sid: string;
  /** Unix-seconds expiry. Omit for the legacy non-expiring shape. */
  exp?: number;
  /** Defaults to the spec's first declared prefix. */
  prefix?: string;
  secret?: string;
}

/**
 * Mint a provider-shaped token (F-712 row 10: minting lives in the engine;
 * CLI + cloud mint through it, parameterized by the twin's declared shape).
 */
export function mintProviderToken(
  spec: ProviderTokenSpec,
  options: MintProviderTokenOptions
): string {
  const prefix = options.prefix ?? spec.prefixes[0];
  if (!prefix || !spec.prefixes.includes(prefix)) {
    throw new Error(
      `mintProviderToken: prefix "${options.prefix ?? "<none>"}" is not declared by provider "${spec.provider}"`
    );
  }
  const secret = options.secret ?? resolveAuthSecret();
  const encoded = Buffer.from(options.sid, "utf8").toString("base64url");
  if (options.exp !== undefined) {
    // Mint/verify symmetry: a non-integer exp used to silently mint the
    // NEVER-expiring legacy shape, and a millisecond-scale exp minted a
    // token verifyProviderToken can never accept. Both are caller bugs —
    // fail at mint time.
    if (!Number.isSafeInteger(options.exp) || options.exp <= 0) {
      throw new Error(
        `mintProviderToken: exp must be a positive integer unix timestamp in seconds (got ${String(options.exp)})`
      );
    }
    if (options.exp >= 1e12) {
      throw new Error(
        `mintProviderToken: exp ${options.exp} looks like milliseconds — pass a unix timestamp in SECONDS`
      );
    }
    return `${prefix}${encoded}_${options.exp}_${signProviderExp(spec.provider, options.sid, options.exp, secret)}`;
  }
  return `${prefix}${encoded}_${signProvider(spec.provider, options.sid, secret)}`;
}

/**
 * Verify a provider-shaped token; returns the sid on success.
 *
 * The parse is right-anchored — the signature is always the trailing 22
 * base64url chars, the optional exp is a trailing all-digit segment of the
 * remainder — and the HMAC disambiguates the exp-vs-sid split. This fixes
 * the F-712 appendix bug once: the old per-twin `([^_]+)` regexes broke for
 * any sid whose base64url encoding contains `_` (the alphabet includes it).
 */
export function verifyProviderToken(
  spec: ProviderTokenSpec,
  token: string,
  secret = resolveAuthSecret()
): string | undefined {
  const prefix = spec.prefixes.find((p) => token.startsWith(p));
  if (!prefix) return undefined;
  const rest = token.slice(prefix.length);
  // Shortest valid form: 1-char encoded sid + "_" + 22-char sig.
  if (rest.length < SIG_LENGTH + 2) return undefined;
  if (rest[rest.length - SIG_LENGTH - 1] !== "_") return undefined;
  const sig = rest.slice(-SIG_LENGTH);
  const head = rest.slice(0, -(SIG_LENGTH + 1));

  // Candidate 1: expiring shape — head = <encodedSid>_<exp>.
  const expMatch = head.match(/^(.+)_(\d{1,12})$/);
  if (expMatch) {
    const sid = decodeBase64Url(expMatch[1]!);
    const exp = Number(expMatch[2]!);
    if (sid !== undefined && Number.isSafeInteger(exp)) {
      if (safeEqual(sig, signProviderExp(spec.provider, sid, exp, secret))) {
        return exp >= Math.floor(Date.now() / 1000) ? sid : undefined;
      }
    }
  }

  // Candidate 2: legacy shape — head = <encodedSid>.
  const sid = decodeBase64Url(head);
  if (sid === undefined) return undefined;
  if (safeEqual(sig, signProvider(spec.provider, sid, secret))) return sid;
  return undefined;
}

function signProvider(provider: string, sid: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`${provider}:${sid}`)
    .digest("base64url")
    .slice(0, SIG_LENGTH);
}

function signProviderExp(provider: string, sid: string, exp: number, secret: string) {
  return createHmac("sha256", secret)
    .update(`${provider}:${sid}:${exp}`)
    .digest("base64url")
    .slice(0, SIG_LENGTH);
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

// ─── Bearer middleware (F-712 rows 2–9) ─────────────────────────────────────

/** Why a request failed auth; rendered by the twin's `unauthorized` hook. */
export type UnauthorizedKind = "no_token" | "invalid" | "expired";

export interface AuthEnvelope {
  status: number;
  body: unknown;
}

/** Extra token location (F-712 row 3). Returns the token or undefined. */
export type TokenResolver = (
  c: Context
) => string | undefined | Promise<string | undefined>;

/** Accept `?<param>=<token>` in the query string (real Slack behavior). */
export function queryTokenResolver(param = "token"): TokenResolver {
  return (c) => {
    const token = c.req.query(param);
    return token && token.length > 0 ? token : undefined;
  };
}

/**
 * Accept `<param>=<token>` in a form-encoded POST body (real Slack
 * behavior). Only parses when the content type is form-encoded, so JSON
 * streaming reads downstream are never consumed here; `parseBody()` caches
 * on the Hono context, so downstream handlers see the same object.
 */
export function formTokenResolver(param = "token"): TokenResolver {
  return async (c) => {
    if (c.req.method !== "POST") return undefined;
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    if (
      !contentType.includes("application/x-www-form-urlencoded") &&
      !contentType.includes("multipart/form-data")
    ) {
      return undefined;
    }
    try {
      const body = (await c.req.parseBody()) as Record<string, unknown>;
      const token = body[param];
      return typeof token === "string" && token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  };
}

export interface BearerAuthOptions {
  /** Row 1: the twin's provider-shaped token declaration. */
  providerToken?: ProviderTokenSpec;
  /** Row 7: extra session fields for provider-shaped sessions. */
  providerSession?: (sid: string) => Record<string, unknown>;
  /** Row 3: extra token locations tried after the Authorization header. */
  tokenResolvers?: readonly TokenResolver[];
  /**
   * Row 4 pin: accept a prefix-less bearer and case-insensitive "bearer".
   * Default false (github/slack); stripe pins true. Flipping a twin is a
   * contract change (CONTRACT.md + suite, then a cloud consumer PR).
   */
  allowRawBearer?: boolean;
  /**
   * Row 9: when false, a request with no `:sid` path segment trusts the
   * bearer alone (stripe's root `/v1/*` SDK-compat mount). Default true.
   */
  requirePathSid?: boolean;
  /** Row 8: DB-backed credential lookup, consulted before provider/JWT. */
  resolveCredential?: (
    token: string,
    c: Context
  ) => SessionValue | undefined | Promise<SessionValue | undefined>;
  /**
   * Rows 2 + 6: the twin's 401 envelope, keyed by failure classification.
   * `info.token` carries the presented credential so a twin can render
   * shape-dependent messages (stripe: api-key-shaped tokens answer
   * "Invalid API Key provided.", JWTs answer "Bad credentials").
   */
  unauthorized?: (kind: UnauthorizedKind, info?: { token?: string }) => AuthEnvelope;
  /** Row 5 pin: the twin's sid-mismatch envelope (github/slack 401, stripe 403). */
  sidMismatch?: () => AuthEnvelope;
  /** Row 7: extra session fields derived from verified JWT claims. */
  sessionExtras?: (claims: SessionClaims) => Record<string, unknown>;
}

const defaultUnauthorized = (): AuthEnvelope => ({
  status: 401,
  body: { message: "Bad credentials", documentation_url: "" },
});

const defaultSidMismatch = (): AuthEnvelope => ({
  status: 401,
  body: { message: "Forbidden", documentation_url: "" },
});

function respond(envelope: AuthEnvelope): Response {
  return Response.json(envelope.body, { status: envelope.status });
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

function bearerHeaderToken(c: Context, allowRaw: boolean): string | undefined {
  const header = c.req.header("Authorization") ?? c.req.header("authorization");
  if (!header) return undefined;
  const trimmed = header.trim();
  if (allowRaw) {
    if (trimmed.toLowerCase().startsWith("bearer ")) {
      const token = trimmed.slice("bearer ".length).trim();
      return token.length > 0 ? token : undefined;
    }
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!trimmed.startsWith("Bearer ")) return undefined;
  const token = trimmed.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

function classifyJwtError(err: unknown): UnauthorizedKind {
  const name = (err as { name?: string }).name ?? "";
  const message = err instanceof Error ? err.message : "";
  return name === "JwtTokenExpired" || /expired/i.test(message) ? "expired" : "invalid";
}

export function bearerAuth(options: BearerAuthOptions = {}): MiddlewareHandler {
  const unauthorized = options.unauthorized ?? defaultUnauthorized;
  const sidMismatch = options.sidMismatch ?? defaultSidMismatch;
  const requirePathSid = options.requirePathSid ?? true;
  const allowRawBearer = options.allowRawBearer === true;

  return async (c, next) => {
    let token = bearerHeaderToken(c, allowRawBearer);
    if (!token && options.tokenResolvers) {
      for (const resolveToken of options.tokenResolvers) {
        token = (await resolveToken(c)) || undefined;
        if (token) break;
      }
    }
    if (!token) return respond(unauthorized("no_token"));

    const pathSid = c.req.param("sid") ?? extractSidFromUrl(c.req.url);
    const checkSid = (sid: string): Response | undefined => {
      if (pathSid) return sid === pathSid ? undefined : respond(sidMismatch());
      return requirePathSid ? respond(sidMismatch()) : undefined;
    };

    // Row 8: DB-backed credential lookup (stripe api_keys).
    if (options.resolveCredential) {
      const resolved = await options.resolveCredential(token, c);
      if (resolved) {
        const mismatch = checkSid(resolved.sid);
        if (mismatch) return mismatch;
        c.set("session", resolved);
        await next();
        return;
      }
    }

    // Row 1: provider-shaped tokens.
    if (options.providerToken) {
      const providerSid = verifyProviderToken(options.providerToken, token);
      if (providerSid) {
        const mismatch = checkSid(providerSid);
        if (mismatch) return mismatch;
        c.set("session", {
          sid: providerSid,
          team_id: PROVIDER_SHAPED_TEAM_ID,
          ...(options.providerSession?.(providerSid) ?? {}),
        });
        await next();
        return;
      }
    }

    // Session JWT, with engine-side expired-vs-invalid classification
    // (row 6). The envelope hook decides how each kind renders on the wire.
    let claims: SessionClaims;
    try {
      claims = (await verify(token, resolveAuthSecret(), "HS256")) as unknown as SessionClaims;
    } catch (err) {
      return respond(unauthorized(classifyJwtError(err), { token }));
    }
    if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) {
      return respond(unauthorized("expired", { token }));
    }
    if (!claims.sid) return respond(unauthorized("invalid", { token }));
    const mismatch = checkSid(claims.sid);
    if (mismatch) return mismatch;

    c.set("session", {
      sid: claims.sid,
      team_id: claims.team_id,
      ...(options.sessionExtras?.(claims) ?? {}),
    });
    await next();
  };
}

/**
 * Admin endpoint protection. Thin wrapper over the shared admin-gate module
 * (FDRS-587 / FDRS-616) using the default error envelope.
 */
export function requireAdminAuth(): MiddlewareHandler {
  return createAdminGate();
}
