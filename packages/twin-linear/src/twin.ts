// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { defineTwin, type TwinDefinition } from "@pome-sh/sdk";
import { createApp, type RecorderStore, type SessionValue } from "@pome-sh/sdk/server";
import { Hono } from "hono";
import { resolveLinearCredential } from "./auth-credential.js";
import { LinearCommands } from "./commands/index.js";
import { openLinearTwinDatabase } from "./db.js";
import { linearErrorEnvelope, unauthorizedEnvelope, unsupportedEnvelope } from "./errors.js";
import { LINEAR_MCP_TOOL_COUNT, linearTools } from "./mcp.js";
import { registerOAuthRoutes } from "./oauth/routes.js";
import { projectLinearRecording } from "./recording.js";
import { registerLinearRoutes } from "./routes.js";
import { defaultSeedState, linearSeedSchema, type ParsedLinearStateSeed } from "./seed.js";
import { linearStateDelta } from "./state.js";
import {
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_SCOPES,
  LINEAR_PROVIDER_TOKEN_PREFIX,
  type LinearStateSeed,
  type LinearTwinDatabase,
} from "./types.js";

const seedSchema = z.preprocess(
  (value) => (value === null || value === undefined ? defaultSeedState() : value),
  linearSeedSchema
) as unknown as z.ZodType<ParsedLinearStateSeed>;

function buildLinearTwinDefinition(
  dbForCredential?: LinearTwinDatabase
): TwinDefinition<LinearTwinDatabase, ParsedLinearStateSeed, LinearCommands> {
  return defineTwin({
    id: "linear",
    version: process.env.POME_TWIN_VERSION ?? "0.1.0",
    implementation: "linear_twin",
    packageName: "@pome-sh/twin-linear",
    fidelity: { default: "semantic" },
    seed: seedSchema,
    domain: ({ db, seed }) => {
      const domain = new LinearCommands(db ?? dbForCredential ?? openLinearTwinDatabase(":memory:"));
      if (seed) domain.seed(seed);
      return domain;
    },
    routes: registerLinearRoutes,
    tools: linearTools,
    state: ({ domain }) => domain.exportState(),
    admin: {
      reset: ({ domain, reportDelta }) => {
        const before = domain.exportState();
        domain.resetToDefault();
        reportDelta(linearStateDelta(before, domain.exportState()));
        return { ok: true };
      },
      seed: ({ domain, seed, reportDelta }) => {
        const before = domain.exportState();
        domain.seed(seed);
        reportDelta(linearStateDelta(before, domain.exportState()));
        return { ok: true };
      },
    },
    recordingProjection: projectLinearRecording,
    errorEnvelope: linearErrorEnvelope,
    unsupported: ({ method, path }) => unsupportedEnvelope(method, path),
    healthz: () => ({
      fidelity: "semantic",
      tools: LINEAR_MCP_TOOL_COUNT,
    }),
    mountSessionAtRoot: true,
    auth: {
      providerToken: { provider: "linear", prefixes: [LINEAR_PROVIDER_TOKEN_PREFIX] },
      requirePathSid: false,
      allowRawBearer: true,
      resolveCredential: (token) => {
        if (!dbForCredential) return undefined;
        return resolveLinearCredential(dbForCredential, token);
      },
      unauthorized: () => unauthorizedEnvelope("Bad credentials"),
      sidMismatch: () => unauthorizedEnvelope("Session id mismatch"),
      sessionExtras: (claims) => ({
        linear_email:
          typeof claims.linear_email === "string" && claims.linear_email.length > 0
            ? claims.linear_email.toLowerCase()
            : DEFAULT_LINEAR_EMAIL,
        // JWT sessions are not OAuth-scoped; grant the twin default scope set.
        scopes: [...DEFAULT_SCOPES],
      }),
      providerSession: (sid) => ({
        linear_email: DEFAULT_LINEAR_EMAIL,
        via: "provider_token",
        sid,
        scopes: [...DEFAULT_SCOPES],
      }),
    },
  });
}

/** Static definition — prefer `createLinearTwinDefinition(db)` so resolveCredential closes over SQLite. */
export const linearTwinDefinition = buildLinearTwinDefinition();

export function createLinearTwinDefinition(
  db: LinearTwinDatabase
): TwinDefinition<LinearTwinDatabase, ParsedLinearStateSeed, LinearCommands> {
  return defineTwin({
    id: "linear",
    version: process.env.POME_TWIN_VERSION ?? "0.1.0",
    implementation: "linear_twin",
    packageName: "@pome-sh/twin-linear",
    fidelity: { default: "semantic" },
    seed: seedSchema,
    domain: ({ db: injected, seed }) => {
      if (injected && injected !== db) {
        throw new Error(
          "twin-linear: the db passed to createApp/serve must be the db the definition was created with"
        );
      }
      const domain = new LinearCommands(db);
      if (seed) domain.seed(seed);
      return domain;
    },
    routes: registerLinearRoutes,
    tools: linearTools,
    state: ({ domain }) => domain.exportState(),
    admin: {
      reset: ({ domain, reportDelta }) => {
        const before = domain.exportState();
        domain.resetToDefault();
        reportDelta(linearStateDelta(before, domain.exportState()));
        return { ok: true };
      },
      seed: ({ domain, seed, reportDelta }) => {
        const before = domain.exportState();
        domain.seed(seed);
        reportDelta(linearStateDelta(before, domain.exportState()));
        return { ok: true };
      },
    },
    recordingProjection: projectLinearRecording,
    errorEnvelope: linearErrorEnvelope,
    unsupported: ({ method, path }) => unsupportedEnvelope(method, path),
    healthz: () => ({
      fidelity: "semantic",
      tools: LINEAR_MCP_TOOL_COUNT,
    }),
    mountSessionAtRoot: true,
    auth: {
      providerToken: { provider: "linear", prefixes: [LINEAR_PROVIDER_TOKEN_PREFIX] },
      requirePathSid: false,
      allowRawBearer: true,
      resolveCredential: (token) => resolveLinearCredential(db, token),
      unauthorized: () => unauthorizedEnvelope("Bad credentials"),
      sidMismatch: () => unauthorizedEnvelope("Session id mismatch"),
      sessionExtras: (claims) => ({
        linear_email:
          typeof claims.linear_email === "string" && claims.linear_email.length > 0
            ? claims.linear_email.toLowerCase()
            : DEFAULT_LINEAR_EMAIL,
        scopes: [...DEFAULT_SCOPES],
      }),
      providerSession: (sid) => ({
        linear_email: DEFAULT_LINEAR_EMAIL,
        via: "provider_token",
        sid,
        scopes: [...DEFAULT_SCOPES],
      }),
    },
  });
}

export type CreateLinearTwinAppOptions = {
  db?: LinearTwinDatabase;
  recorder?: RecorderStore;
  runId?: string;
  seed?: LinearStateSeed;
  noSeed?: boolean;
};

/**
 * Mount OAuth outside bearerAuth. The engine's session router (including
 * mountSessionAtRoot) requires a bearer; Linear authorize/token/revoke are
 * public HTTP surfaces.
 */
export function withPublicOAuth(app: Hono, db: LinearTwinDatabase): Hono {
  const root = new Hono();
  registerOAuthRoutes(root, new LinearCommands(db));
  root.route("/", app);
  return root;
}

export function createLinearTwinApp(options: CreateLinearTwinAppOptions = {}): Hono {
  const db = options.db ?? openLinearTwinDatabase(":memory:");
  const definition = createLinearTwinDefinition(db);
  const seed = options.noSeed
    ? undefined
    : ((options.seed ?? (options.db ? undefined : defaultSeedState())) as ParsedLinearStateSeed | undefined);
  const app = createApp(definition, {
    db,
    recorder: options.recorder,
    runId: options.runId ?? "spawn",
    seed,
  });
  return withPublicOAuth(app, db);
}

export function linearEmailFromSession(session?: SessionValue): string {
  return typeof session?.linear_email === "string" ? session.linear_email : DEFAULT_LINEAR_EMAIL;
}
