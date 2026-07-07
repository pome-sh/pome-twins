// SPDX-License-Identifier: Apache-2.0
//
// The Slack twin as a thin `@pome-sh/sdk` plugin (F-683). This manifest is
// pure declaration: domain factory, seed schema, tools, routes, and the
// wire-frozen Slack shapes (FDRS-711 / F-712) — error envelopes, auth pins,
// healthz extras, the 501 unsupported envelope, the admin-gate 403 body.
// All mechanism (HTTP mount, auth, recorder + redaction, MCP dispatch,
// /_pome/*, admin gate, db driver) lives in the engine.

import { z, ZodError } from "zod";
import { defineTwin, type ToolCallContext, type TwinDefinition } from "@pome-sh/sdk";
import {
  UnknownToolError,
  createApp,
  formTokenResolver,
  queryTokenResolver,
  type RecorderStore,
  type SessionValue,
} from "@pome-sh/sdk/server";
import type { Hono } from "hono";
import { openSlackTwinDatabase } from "./db.js";
import { SlackDomain, type Actor } from "./domain.js";
import { TwinError, twinErrorFromSqliteConstraint } from "./errors.js";
import { registerSlackRoutes } from "./routes.js";
import { defaultSeedState } from "./seed.js";
import { executeTool, isMutatingTool, listTools, toolDefinitions } from "./tools.js";
import { slackError } from "./serializers.js";
import type { SlackStateSeed, SlackTwinDatabase } from "./types.js";
import { unsupportedEnvelope } from "./unsupported-envelope.js";

type SlackSeed = Record<string, unknown>;

// Slack accepts arbitrary seed bodies (frozen: garbage → 200 {ok:true}).
// Non-object bodies collapse to `{}` — the same "tolerant parse" the old
// form-or-JSON admin handler applied; SlackDomain.applySeed defaults every
// missing field.
const tolerantSeedSchema = z.preprocess(
  (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {}),
  z.record(z.string(), z.unknown())
);

function actorFromSession(session: SessionValue | undefined): Actor {
  return { login: typeof session?.login === "string" ? session.login : undefined };
}

function wrapSlackOk(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if ("ok" in obj) return obj;
    return { ok: true, ...obj };
  }
  return { ok: true, result: value };
}

// The engine's `/mcp/call` parses with its own zod instance, so a bare
// `instanceof ZodError` can miss; fall back to the duck check on `name`.
function zodIssues(err: unknown): Array<{ path: ReadonlyArray<PropertyKey>; message: string }> | undefined {
  if (err instanceof ZodError) return err.issues;
  if (err instanceof Error && err.name === "ZodError" && Array.isArray((err as { issues?: unknown }).issues)) {
    return (err as unknown as ZodError).issues;
  }
  return undefined;
}

/**
 * Wire-frozen Slack error projection: application-level errors return HTTP
 * 200 with `{ok:false, error}` — matches real Slack; official SDKs
 * (@slack/web-api, @slack/bolt) treat non-200 as a transport failure.
 * Genuine server bugs stay 5xx so platform retries / alerting kick in.
 */
function slackErrorEnvelope(err: unknown): { status: number; body: unknown } {
  if (err instanceof UnknownToolError) return { status: 404, body: slackError("unknown_tool") };
  if (err instanceof TwinError) {
    return { status: 200, body: { ok: false, error: err.code, ...(err.extra ?? {}) } };
  }
  const issues = zodIssues(err);
  if (issues) {
    return {
      status: 200,
      body: {
        ok: false,
        error: "invalid_arguments",
        response_metadata: {
          messages: issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
        },
      },
    };
  }
  // Map SQLite UNIQUE violations from concurrent requests to Slack-shaped
  // domain errors (name_taken / already_reacted / already_pinned).
  const mapped = twinErrorFromSqliteConstraint("", err);
  if (mapped) return { status: 200, body: { ok: false, error: mapped.code, ...(mapped.extra ?? {}) } };
  return {
    status: 500,
    body: { ok: false, error: "internal_error", warning: err instanceof Error ? err.message : "internal_error" },
  };
}

// listTools() carries the frozen tool-list wire shape: forced draft-7
// `additionalProperties:false` input_schema + readOnlyHint annotations.
const toolListing = new Map(listTools().map((tool) => [tool.name, tool]));

export const slackTwinDefinition: TwinDefinition<SlackTwinDatabase, SlackSeed, SlackDomain> = defineTwin({
  id: "slack",
  version: process.env.POME_TWIN_VERSION ?? "0.1.0",
  implementation: "slack_clone",
  packageName: "@pome-sh/twin-slack",
  fidelity: { default: "semantic" },
  seed: tolerantSeedSchema as unknown as z.ZodType<SlackSeed>,
  domain: ({ db, seed }) => {
    const domain = new SlackDomain(db ?? openSlackTwinDatabase(":memory:"));
    if (seed !== undefined) domain.seed(seed as SlackStateSeed);
    return domain;
  },
  routes: registerSlackRoutes,
  state: ({ domain }) => domain.exportState(),
  admin: {
    reset: ({ domain }) => {
      domain.resetToDefault(defaultSeedState);
      return { ok: true };
    },
    seed: ({ domain, seed }) => {
      domain.applySeed(seed.seed ?? seed);
      return { ok: true };
    },
    // Frozen slack admin-gate 403 body.
    forbidden: () => ({ status: 403, body: slackError("restricted_action") }),
  },
  tools: toolDefinitions.map((def) => {
    const listed = toolListing.get(def.name);
    return {
      name: def.name,
      description: def.description,
      schema: def.schema as unknown as z.ZodType<unknown>,
      mutation: isMutatingTool(def.name),
      inputSchema: listed?.input_schema as unknown as Record<string, unknown>,
      ...("annotations" in (listed ?? {}) ? { annotations: (listed as { annotations: Record<string, unknown> }).annotations } : {}),
      handler: (domain: SlackDomain, args: unknown, ctx: ToolCallContext) =>
        wrapSlackOk(
          executeTool(
            domain,
            def.name,
            args as Record<string, unknown>,
            ctx.reportDelta,
            actorFromSession(ctx.session)
          )
        ),
    };
  }),
  // Frozen healthz shape: {ok, twin, implementation, tools, runtime} — no
  // version/fidelity extras (slack never carried them).
  healthz: () => ({}),
  unsupported: () => unsupportedEnvelope,
  errorEnvelope: slackErrorEnvelope,
  auth: {
    // F-712 pins: Bearer header + ?token= + form-body token; raw bearer
    // rejected (allowRawBearer default false); sid mismatch → 401
    // invalid_auth; expired vs invalid classified by the engine and
    // rendered through the envelope hook.
    providerToken: { provider: "slack", prefixes: ["xoxb-pome-", "xoxp-pome-"] },
    providerSession: () => ({ login: "pome-agent" }),
    tokenResolvers: [queryTokenResolver("token"), formTokenResolver("token")],
    unauthorized: (kind) => ({
      status: 401,
      body: slackError(kind === "no_token" ? "not_authed" : kind === "expired" ? "token_expired" : "invalid_auth"),
    }),
    sidMismatch: () => ({ status: 401, body: slackError("invalid_auth") }),
    sessionExtras: (claims) =>
      typeof claims.login === "string" && claims.login.length > 0 ? { login: claims.login } : {},
  },
});

export type CreateSlackTwinAppOptions = {
  db?: SlackTwinDatabase;
  /**
   * Accepted for API compatibility with the pre-F-683 factory; the engine
   * rebuilds the (stateless) SlackDomain from `db`, so callers that seeded
   * through their own instance see identical state.
   */
  domain?: SlackDomain;
  recorder?: RecorderStore;
  runId?: string;
  seed?: SlackStateSeed;
};

/** Assemble the Slack twin app on the engine (in-process; no port bind). */
export function createSlackTwinApp(opts: CreateSlackTwinAppOptions = {}): Hono {
  return createApp(slackTwinDefinition, {
    db: opts.db ?? openSlackTwinDatabase(":memory:"),
    recorder: opts.recorder,
    runId: opts.runId ?? "spawn",
    seed: opts.seed as SlackSeed | undefined,
  });
}
