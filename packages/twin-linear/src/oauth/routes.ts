// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { LinearDomain } from "../domain/index.js";
import { token } from "../ids.js";
import { OAUTH_CODE_TTL_SECONDS, type LinearOAuthApp, type LinearTokenActorType } from "../types.js";

export function registerOAuthRoutes(
  app: { get: Function; post: Function },
  commands: LinearDomain
): void {
  app.get("/oauth/authorize", (c: Context) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const responseType = c.req.query("response_type") ?? "code";
    const state = c.req.query("state") ?? "";
    const scope = c.req.query("scope") ?? "read";
    const requestedActor = normalizeActor(c.req.query("actor"));
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const codeChallengeMethod = c.req.query("code_challenge_method") ?? "";

    if (responseType !== "code") {
      return c.html(errorPage("Unsupported response_type", "Only response_type=code is supported."), 400);
    }
    if (!redirectUri) {
      return c.html(errorPage("Missing redirect URI", "The redirect_uri parameter is required."), 400);
    }

    const oauthApp = requireRegisteredOAuthApp(commands, clientId);
    if (!oauthApp) {
      return c.html(
        errorPage(
          "Application not found",
          clientId
            ? `The client_id '${escapeHtml(clientId)}' is not registered.`
            : "No OAuth applications are registered in this twin."
        ),
        400
      );
    }
    if (!matchesRedirectUri(redirectUri, oauthApp.redirectUris)) {
      return c.html(errorPage("Redirect URI mismatch", "The redirect_uri is not registered for this app."), 400);
    }
    const pkceError = validatePkceParams(codeChallenge, codeChallengeMethod);
    if (pkceError) {
      return c.html(errorPage("Invalid PKCE parameters", pkceError), 400);
    }
    const actor = requestedActor ?? oauthApp.actor ?? "user";
    if (requestedActor && requestedActor !== oauthApp.actor) {
      return c.html(errorPage("Invalid actor", `This app is configured for actor=${oauthApp.actor}.`), 400);
    }
    const requestedScopes = normalizeScopes(scope, oauthApp.scopes ?? ["read"]);
    const invalidScopes = scopesOutsideApp(requestedScopes, oauthApp);
    if (invalidScopes.length > 0) {
      return c.html(
        errorPage("Invalid scope", `The app is not registered for scopes: ${invalidScopes.join(", ")}.`),
        400
      );
    }

    const title = actor === "app" ? "Install Linear App" : "Authorize Linear App";
    const appName = oauthApp.name;
    const buttons =
      actor === "app"
        ? userButton({
            letter: "L",
            login: appName,
            name: `Install ${appName}`,
            email: requestedScopes.join(", "),
            hidden: {
              user_ref: oauthApp.appUserId ?? "",
              actor,
              redirect_uri: redirectUri,
              scope: requestedScopes.join(" "),
              state,
              client_id: clientId,
              code_challenge: codeChallenge,
              code_challenge_method: codeChallengeMethod,
            },
          })
        : commands
            .listUsers()
            .filter((user) => !user.app && user.active)
            .map((user) =>
              userButton({
                letter: (user.displayName[0] ?? "U").toUpperCase(),
                login: user.email,
                name: user.displayName,
                email: user.email,
                hidden: {
                  user_ref: user.id,
                  actor,
                  redirect_uri: redirectUri,
                  scope: requestedScopes.join(" "),
                  state,
                  client_id: clientId,
                  code_challenge: codeChallenge,
                  code_challenge_method: codeChallengeMethod,
                },
              })
            )
            .join("\n");

    return c.html(
      cardPage(
        title,
        `Continue to <strong>${escapeHtml(appName)}</strong> with scopes <strong>${escapeHtml(requestedScopes.join(", "))}</strong>.`,
        buttons || '<p class="empty">No users in the Linear twin store.</p>'
      )
    );
  });

  app.post("/oauth/authorize/callback", async (c: Context) => {
    const body = await c.req.parseBody();
    const clientId = bodyStr(body.client_id);
    const redirectUri = bodyStr(body.redirect_uri);
    const state = bodyStr(body.state);
    const scopes = normalizeScopes(bodyStr(body.scope), ["read"]);
    const requestedActor = normalizeActor(bodyStr(body.actor));
    const userRef = bodyStr(body.user_ref);
    const codeChallenge = bodyStr(body.code_challenge);
    const codeChallengeMethod = bodyStr(body.code_challenge_method);

    const oauthApp = requireRegisteredOAuthApp(commands, clientId);
    if (!oauthApp) {
      return c.html(errorPage("Application not found", "The OAuth app is not registered."), 400);
    }
    if (!matchesRedirectUri(redirectUri, oauthApp.redirectUris)) {
      return c.html(errorPage("Redirect URI mismatch", "The redirect_uri is not registered for this app."), 400);
    }
    const pkceError = validatePkceParams(codeChallenge, codeChallengeMethod);
    if (pkceError) {
      return c.html(errorPage("Invalid PKCE parameters", pkceError), 400);
    }
    const actor = requestedActor ?? oauthApp.actor ?? "user";
    if (requestedActor && requestedActor !== oauthApp.actor) {
      return c.html(errorPage("Invalid actor", `This app is configured for actor=${oauthApp.actor}.`), 400);
    }
    const invalidScopes = scopesOutsideApp(scopes, oauthApp);
    if (invalidScopes.length > 0) {
      return c.html(
        errorPage("Invalid scope", `The app is not registered for scopes: ${invalidScopes.join(", ")}.`),
        400
      );
    }

    const user =
      userRef
        ? commands.getUser(userRef)
        : commands.listUsers().find((u) => !u.app);
    const appUser =
      actor === "app"
        ? (oauthApp.appUserId ? commands.getUser(oauthApp.appUserId) : user)
        : user;
    if (!appUser) {
      return c.html(errorPage("No Linear actor", "No matching user or app actor is available."), 400);
    }

    const code = token("lin_code");
    commands.storePendingCode(code, {
      appId: oauthApp.id,
      clientId,
      redirectUri,
      scopes,
      userId: appUser.id,
      actor,
      codeChallenge: codeChallenge || null,
      codeChallengeMethod: codeChallengeMethod || null,
      createdAt: commands.now(),
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  app.post("/oauth/token", async (c: Context) => {
    const body = await c.req.parseBody();
    const grantType = bodyStr(body.grant_type);
    const clientAuth = clientCredentials(c.req.header("Authorization"), body);
    const oauthApp = requireRegisteredOAuthApp(commands, clientAuth.clientId);
    if (!oauthApp) {
      return oauthError("invalid_client", "The OAuth app is not registered.");
    }
    if (!constantTimeSecretEqual(clientAuth.clientSecret, oauthApp.clientSecret)) {
      return oauthError("invalid_client", "Invalid client credentials.");
    }

    if (grantType === "authorization_code") {
      const code = bodyStr(body.code);
      const pending = commands.takePendingCode(code);
      if (!pending) return oauthError("invalid_grant", "Authorization code is invalid.");
      const ageMs = Date.parse(commands.now()) - Date.parse(pending.createdAt);
      if (ageMs > OAUTH_CODE_TTL_SECONDS * 1000) {
        return oauthError("invalid_grant", "Authorization code has expired.");
      }
      if (pending.redirectUri !== bodyStr(body.redirect_uri)) {
        return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
      }
      if (pending.clientId !== clientAuth.clientId) {
        return oauthError("invalid_grant", "client_id does not match the authorization request.");
      }
      if (!verifyPkce(pending.codeChallenge, pending.codeChallengeMethod, bodyStr(body.code_verifier))) {
        return oauthError("invalid_grant", "PKCE verification failed.");
      }
      return c.json(
        commands.issueOAuthTokens({
          userId: pending.userId,
          appId: pending.appId,
          actor: pending.actor,
          scopes: pending.scopes,
        })
      );
    }

    if (grantType === "refresh_token") {
      const refreshToken = bodyStr(body.refresh_token);
      const existing = commands.getToken(refreshToken);
      if (!existing || existing.type !== "oauth_refresh" || existing.revoked) {
        return oauthError("invalid_grant", "Refresh token is invalid.");
      }
      if (existing.appId !== oauthApp.id) {
        return oauthError("invalid_grant", "Refresh token was not issued to this OAuth app.");
      }
      commands.revokeToken(refreshToken);
      return c.json(
        commands.issueOAuthTokens({
          userId: existing.userId,
          appId: existing.appId,
          actor: existing.actorType,
          scopes: existing.scopes,
        })
      );
    }

    if (grantType === "client_credentials") {
      if (oauthApp.actor !== "app") {
        return oauthError("unauthorized_client", "The OAuth app is not configured for app actor tokens.");
      }
      const scopes = normalizeScopes(bodyStr(body.scope), oauthApp.scopes ?? ["read"]);
      const invalidScopes = scopesOutsideApp(scopes, oauthApp);
      if (invalidScopes.length > 0) {
        return oauthError("invalid_scope", `The app is not registered for scopes: ${invalidScopes.join(", ")}.`);
      }
      const appUserId =
        oauthApp.appUserId ?? commands.listUsers().find((user) => user.app)?.id ?? null;
      return c.json(
        commands.issueOAuthTokens({
          userId: appUserId,
          appId: oauthApp.id,
          actor: "app",
          scopes,
          includeRefresh: false,
        })
      );
    }

    return oauthError(
      "unsupported_grant_type",
      "Only authorization_code, refresh_token, and client_credentials are supported."
    );
  });

  app.post("/oauth/revoke", async (c: Context) => {
    const body = await c.req.parseBody();
    const value = bodyStr(body.token) || bodyStr(body.access_token) || bodyStr(body.refresh_token);
    if (value) commands.revokeToken(value);
    return c.body(null, 200);
  });
}

function oauthError(error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

function clientCredentials(
  authHeader: string | undefined,
  body: Record<string, unknown>
): { clientId: string; clientSecret: string } {
  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf-8");
      const separator = decoded.indexOf(":");
      if (separator < 0) return { clientId: "", clientSecret: "" };
      return {
        clientId: decodeURIComponent(decoded.slice(0, separator)),
        clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
      };
    } catch {
      return { clientId: "", clientSecret: "" };
    }
  }
  return { clientId: bodyStr(body.client_id), clientSecret: bodyStr(body.client_secret) };
}

function normalizeActor(value: string | undefined): LinearTokenActorType | undefined {
  if (value === "app" || value === "user") return value;
  return undefined;
}

function scopesOutsideApp(scopes: string[], oauthApp: LinearOAuthApp | null | undefined): string[] {
  if (!oauthApp) return [];
  const allowed = new Set(oauthApp.scopes);
  return scopes.filter((scope) => !allowed.has(scope));
}

function normalizeScopes(value: string, fallback: string[]): string[] {
  const parts = value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [...fallback];
}

function requireRegisteredOAuthApp(
  commands: LinearDomain,
  clientId: string
): LinearOAuthApp | null {
  if (!clientId) return null;
  return commands.getOAuthApp(clientId) ?? null;
}

function validatePkceParams(challenge: string, method: string): string | null {
  if (!challenge && !method) return null;
  if (challenge && !method) {
    return "code_challenge_method is required when code_challenge is set.";
  }
  if (!challenge && method) {
    return "code_challenge is required when code_challenge_method is set.";
  }
  if (method !== "S256" && method !== "plain") {
    return "Unsupported code_challenge_method. Only S256 and plain are accepted.";
  }
  return null;
}

function verifyPkce(
  challenge: string | null,
  method: string | null,
  verifier: string
): boolean {
  if (!challenge) return true;
  if (!verifier) return false;
  if (method === "S256") {
    const hashed = createHash("sha256").update(verifier).digest("base64url");
    return hashed === challenge;
  }
  if (method === "plain") {
    return verifier === challenge;
  }
  // Unknown / missing method with a stored challenge must fail closed.
  return false;
}

function matchesRedirectUri(redirectUri: string, allowed: string[]): boolean {
  return allowed.some((uri) => uri === redirectUri);
}

function constantTimeSecretEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bodyStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorPage(title: string, message: string): string {
  return cardPage(title, escapeHtml(message), "");
}

function cardPage(title: string, subtitleHtml: string, bodyHtml: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:2rem}
.card{max-width:480px;margin:0 auto;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:1.5rem}
h1{font-size:1.25rem;margin:0 0 .75rem}p{opacity:.85;line-height:1.5}
button,form button{display:block;width:100%;text-align:left;margin:.5rem 0;padding:.85rem 1rem;border-radius:8px;border:1px solid #30363d;background:#21262d;color:#e6edf3;cursor:pointer}
button:hover{border-color:#58a6ff}
.meta{font-size:.85rem;opacity:.7}
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${subtitleHtml}</p>${bodyHtml}</div></body></html>`;
}

function userButton(opts: {
  letter: string;
  login: string;
  name: string;
  email: string;
  hidden: Record<string, string>;
}): string {
  const fields = Object.entries(opts.hidden)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
    .join("");
  return `<form method="post" action="/oauth/authorize/callback">${fields}
<button type="submit"><strong>${escapeHtml(opts.name)}</strong><div class="meta">${escapeHtml(opts.email)}</div></button></form>`;
}
