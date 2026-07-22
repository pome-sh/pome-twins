// SPDX-License-Identifier: Apache-2.0
//
// The GitHub twin as a thin `@pome-sh/sdk` plugin (F-682). This manifest is
// pure declaration: domain factory, seed parser, tools, routes, and the
// wire-frozen GitHub shapes (FDRS-711 / F-712) — error envelopes, auth pins,
// healthz extras, the 501 unsupported envelope, the /_pome/access-control
// catalog route, the FDRS-402 tool_call_id tape pin. All mechanism (HTTP
// mount, auth, recorder + redaction, MCP dispatch, /_pome/*, admin gate,
// db driver) lives in the engine.

import { z, ZodError } from "zod";
import { defineTwin, type ToolCallContext, type TwinDefinition } from "@pome-sh/sdk";
import {
  UnknownToolError,
  createApp,
  twinBuildInfo,
  type RecorderStore,
  type SessionValue,
} from "@pome-sh/sdk/server";
import type { Hono } from "hono";
import { summarizeGitHubAccessControlCatalog } from "@pome-sh/shared-types";
import { githubAccessControlPayload } from "./access-control.js";
import { openGitHubCloneDatabase } from "./db.js";
import { GitHubDomain } from "./domain/index.js";
import { TwinError, githubError } from "./errors.js";
import { registerGitHubRoutes } from "./routes.js";
import { defaultSeedState, parseSeed, type ParsedGitHubStateSeed } from "./seed.js";
import { executeTool, isMutatingTool, listTools, toolDefinitions } from "./tools.js";
import type { GitHubCloneDatabase, GitHubStateSeed } from "./types.js";
import { unsupportedEnvelope } from "./unsupported-envelope.js";

// The manifest seed "schema" is parseSeed itself, duck-typed to zod's
// parse/safeParse surface. The frozen /admin/seed wire behavior is exactly
// parseSeed's error split — schema violation → ZodError → 422 "Validation
// Failed"; empty body (the engine's readJson maps it to null) → SyntaxError
// → 400 "Problems parsing JSON" — which a plain zod schema cannot reproduce.
const seedParser = {
  parse(input: unknown): ParsedGitHubStateSeed {
    if (input === null || input === undefined) throw new SyntaxError("Problems parsing JSON");
    return parseSeed(input);
  },
  safeParse(input: unknown) {
    try {
      return { success: true as const, data: seedParser.parse(input) };
    } catch (error) {
      return { success: false as const, error };
    }
  },
} as unknown as z.ZodType<ParsedGitHubStateSeed>;

function actorFromSession(session: SessionValue | undefined): string | undefined {
  return typeof session?.login === "string" ? session.login : undefined;
}

// The engine's `/mcp/call` parses with its own zod instance, so a bare
// `instanceof ZodError` can miss; fall back to the duck check on `name`.
function zodIssues(err: unknown): Array<{ path: ReadonlyArray<PropertyKey>; code?: string }> | undefined {
  if (err instanceof ZodError) return err.issues;
  if (err instanceof Error && err.name === "ZodError" && Array.isArray((err as { issues?: unknown }).issues)) {
    return (err as unknown as ZodError).issues;
  }
  return undefined;
}

/**
 * Wire-frozen GitHub error projection: `{message, documentation_url,
 * status, errors?}` (githubError). Statuses: TwinError carries its own;
 * validation (Zod or unknown tool) → 422 "Validation Failed"; JSON parse →
 * 400; anything else → 500 so platform retries / alerting kick in.
 */
function githubErrorEnvelope(err: unknown): { status: number; body: unknown } {
  if (err instanceof UnknownToolError) {
    // Frozen legacy-dispatch behavior: an unknown tool is a 422 validation
    // failure on the `tool` field (pre-port executeTool → validationFailed).
    return {
      status: 422,
      body: githubError("Validation Failed", 422, [
        { resource: "Request", field: "tool", code: "invalid", value: err.tool },
      ]),
    };
  }
  if (err instanceof TwinError) {
    return { status: err.status, body: githubError(err.message, err.status, err.errors) };
  }
  const issues = zodIssues(err);
  if (issues) {
    return {
      status: 422,
      body: githubError(
        "Validation Failed",
        422,
        issues.map((issue) => ({
          resource: "Request",
          field: issue.path.join("."),
          code: issue.code,
        }))
      ),
    };
  }
  if (err instanceof SyntaxError) {
    return { status: 400, body: githubError("Problems parsing JSON", 400) };
  }
  return {
    status: 500,
    body: githubError(err instanceof Error ? err.message : "Internal Server Error", 500),
  };
}

// listTools() carries the frozen tool-list wire shape: the twin-zod
// serialization emitted on both list surfaces since before the port.
const toolListing = new Map(listTools().map((tool) => [tool.name, tool]));

export const githubTwinDefinition: TwinDefinition<GitHubCloneDatabase, ParsedGitHubStateSeed, GitHubDomain> =
  defineTwin({
    id: "github",
    version: process.env.POME_TWIN_VERSION ?? "0.1.0",
    implementation: "github_clone",
    packageName: "@pome-sh/twin-github",
    fidelity: { default: "semantic" },
    seed: seedParser,
    domain: ({ db, seed }) => {
      const domain = new GitHubDomain(db ?? openGitHubCloneDatabase());
      if (seed !== undefined) domain.seed(seed);
      return domain;
    },
    routes: registerGitHubRoutes,
    state: ({ domain }) => domain.exportState(),
    admin: {
      reset: ({ domain, reportDelta }) => {
        domain.seed(defaultSeedState(), reportDelta);
        return { ok: true, message: "GitHub twin state reset to default seed." };
      },
      seed: ({ domain, seed, reportDelta }) => {
        domain.seed(seed, reportDelta);
        return { ok: true, repositories: seed.repositories.length };
      },
      // The admin-gate 403 body is the gate's default GitHub envelope
      // ({message: "Forbidden"}); no per-twin override needed.
    },
    tools: toolDefinitions.map((def) => ({
      name: def.name,
      description: def.description,
      schema: def.schema as unknown as z.ZodType<unknown>,
      mutation: isMutatingTool(def.name),
      inputSchema: toolListing.get(def.name)?.input_schema as Record<string, unknown>,
      handler: (domain: GitHubDomain, args: unknown, ctx: ToolCallContext) =>
        executeTool(domain, def.name, args, ctx.reportDelta, {
          actor: actorFromSession(ctx.session),
        }),
    })),
    // Frozen healthz shape: {ok, twin, implementation, fidelity, tools,
    // access_control, runtime} — no version field (github never carried it).
    healthz: () => ({
      fidelity: "semantic",
      access_control: summarizeGitHubAccessControlCatalog(),
    }),
    // Frozen per-session health shape: implementation + fidelity + runtime,
    // no version (pre-port /_pome/health).
    pomeHealth: () => ({
      implementation: "github_clone",
      fidelity: "semantic",
      runtime: twinBuildInfo("@pome-sh/twin-github"),
    }),
    // Frozen extra session route (CONTRACT.md per-twin table).
    pomeRoutes: {
      "access-control": () => githubAccessControlPayload(),
    },
    // FDRS-402 adapter-rich tape pin: x-pome-correlation-id persists as
    // tool_call_id on every recorded event (github's frozen tape shape).
    stampToolCallId: true,
    // Frozen JSON-RPC unknown-tool result text (the legacy /mcp/call surface
    // keeps the 422 validation envelope from errorEnvelope above).
    mcpUnknownTool: (name) => ({ message: `Unknown tool: ${name}` }),
    unsupported: () => unsupportedEnvelope,
    errorEnvelope: githubErrorEnvelope,
    auth: {
      // F-712 pins (wire-frozen): Bearer-header only (no extra token
      // resolvers), raw bearer rejected (allowRawBearer=false), sid mismatch
      // → 401 {message:"Forbidden"}, and every credential failure — expired
      // JWT included — renders 401 {message:"Bad credentials"}. The pre-port
      // explicit "Token expired" branch was dead code: hono/jwt's verify
      // throws JwtTokenExpired before the branch was ever reached, so the
      // wire always said "Bad credentials" (pre-ruled: deleting it is zero
      // wire diff).
      providerToken: { provider: "github", prefixes: ["ghp_pome_", "github_pat_pome_"] },
      allowRawBearer: false,
      unauthorized: () => ({
        status: 401,
        body: { message: "Bad credentials", documentation_url: "" },
      }),
      sidMismatch: () => ({
        status: 401,
        body: { message: "Forbidden", documentation_url: "" },
      }),
      sessionExtras: (claims) =>
        typeof claims.login === "string" && claims.login.length > 0 ? { login: claims.login } : {},
    },
  });

export type GitHubCloneAppOptions = {
  db?: GitHubCloneDatabase;
  seed?: GitHubStateSeed;
  recorder?: RecorderStore;
  runId?: string;
};

/** Assemble the GitHub twin app on the engine (in-process; no port bind). */
export function createGitHubCloneApp(options: GitHubCloneAppOptions = {}): Hono {
  return createApp(githubTwinDefinition, {
    db: options.db ?? openGitHubCloneDatabase(),
    recorder: options.recorder,
    runId: options.runId ?? "local",
    // Pre-port factory semantics: an explicit `db` carries its own state
    // (the boot path seeds before binding); otherwise seed the supplied or
    // default world.
    seed: options.db ? undefined : ((options.seed ?? defaultSeedState()) as ParsedGitHubStateSeed),
  });
}
