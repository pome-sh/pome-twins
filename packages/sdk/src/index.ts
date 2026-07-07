// SPDX-License-Identifier: Apache-2.0
//
// `@pome-sh/sdk` — public surface for community twin authors.
//
// `defineTwin()` returns a `TwinDefinition` value (data, not a class). Boot
// it with `serve()` from `@pome-sh/sdk/server`. The SDK enforces wedge
// invariants (recording-spec.md v1.0 emit shape, mutation-flag consistency,
// `/_pome/*` shadowing) per OQ-B6 — community twins cannot ship broken
// FIDELITY claims silently.

import { z } from "zod";
import type { Context, Hono } from "hono";
import {
  recorderEventSchema,
  recorderFidelitySchema,
  type RecorderEvent,
  type RecorderFidelity,
  type TwinId,
} from "@pome-sh/shared-types";

export { recorderEventSchema, recorderFidelitySchema };
export type { RecorderEvent, RecorderFidelity, TwinId };

export { openTwinDatabase } from "./db.js";
export type { OpenTwinDatabaseOptions, TwinDatabase, TwinRunResult, TwinStatement, TwinTransaction } from "./db.js";
export { redactEvent, redactSecrets } from "./redaction.js";

// FIDELITY.md uses three tiers (`semantic` | `shape` | `unsupported`); the
// recording-spec.md v1.0 per-event enum is closed at two (`semantic` |
// `unsupported`). They serve different purposes — the FIDELITY tier is a
// per-tool documentation classifier, the recorder field is per-request.
export const fidelityTierSchema = z.enum(["semantic", "shape", "unsupported"]);
export type FidelityTier = z.infer<typeof fidelityTierSchema>;

export interface ToolFidelityMetadata {
  tier?: FidelityTier;
  backingSurface?: string;
  tests?: string[];
  deviations?: string;
}

/**
 * Per-call context handed to tool handlers by every MCP dispatch surface
 * (JSON-RPC `tools/call`, legacy `/mcp/tools/:name` + `/mcp/call`). Carries
 * the authenticated session (actor identity) and a `reportDelta` sink so
 * MCP-dispatched mutations surface `state_delta` on the recorded event —
 * the two facilities the per-twin mcp.ts modules had before F-683.
 */
export interface ToolCallContext {
  /** The session set by the engine's bearerAuth for this request. */
  session?: import("./auth.js").SessionValue;
  /** Report the row-level before/after recorded as this event's `state_delta`. */
  reportDelta: (delta: RecorderEvent["state_delta"]) => void;
}

export interface ToolSpec<TDomain = unknown, TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  handler: (domain: TDomain, args: TInput, ctx: ToolCallContext) => TOutput | Promise<TOutput>;
  mutation: boolean;
  fidelity?: ToolFidelityMetadata;
  /**
   * MCP tool-list annotations (e.g. `{ readOnlyHint: true }`), emitted
   * verbatim on both tool-list surfaces when present.
   */
  annotations?: Record<string, unknown>;
  /**
   * Literal JSON-Schema override for the tool listings. Twins with a frozen
   * schema wire shape (e.g. slack's forced draft-7
   * `additionalProperties:false` form) supply it here; defaults to
   * `z.toJSONSchema(schema)`.
   */
  inputSchema?: Record<string, unknown>;
}

/** The JSON-Schema a tool advertises: the declared override, else zod-derived. */
export function toolInputSchema(tool: Pick<ToolSpec, "schema" | "inputSchema">): Record<string, unknown> {
  return tool.inputSchema ?? (z.toJSONSchema(tool.schema) as Record<string, unknown>);
}

export interface TwinFidelity {
  default: FidelityTier;
}

export interface RouteContext<TDomain = unknown> {
  domain: TDomain;
  recorder: RecorderHandle;
  runId: string;
  twin: TwinId;
}

export type RouteRegistrar<TDomain = unknown> = (
  app: Hono,
  ctx: RouteContext<TDomain>
) => void;

export interface RecorderHandlerResult {
  status: number;
  body: unknown;
  /**
   * Optional override for the per-event `state_mutation` field. When unset,
   * the recorder uses the `mutation` flag passed to `handle({mutation})`.
   * Used by the SDK's MCP dispatch routes to plumb the per-tool mutation
   * flag (different per call) into the recorder event.
   */
  mutation?: boolean;
  /**
   * Optional state delta recorded on the event (`state_delta`). Routes that
   * know exactly what they changed surface it here; defaults to null.
   */
  delta?: RecorderEvent["state_delta"];
}

export interface RecorderHandle {
  record(event: RecorderEvent): void;
  events(): RecorderEvent[];
  /**
   * Wrap a Hono handler with auto-recording. The wrapped function returns
   * `{ status, body }` (not a `Response`); the recorder fills in `ts`,
   * `request_id`, `latency_ms`, `state_mutation`, `error`, then writes the
   * `RecorderEvent` and returns `c.json(body, status)`.
   */
  handle(
    opts: {
      mutation: boolean;
      fidelity?: RecorderFidelity;
      /** Per-surface error projection override (admin routes have their own frozen envelope on some twins). */
      errorEnvelope?: (err: unknown) => { status: number; body: unknown };
    },
    fn: (c: Context) => Promise<RecorderHandlerResult> | RecorderHandlerResult
  ): (c: Context) => Promise<Response>;
}

export interface AdminHandlers<TDomain = unknown, TSeed = unknown> {
  /**
   * Implements POST /admin/reset. `reportDelta` records the row-level
   * before/after as the admin event's `state_delta` (github's frozen tape
   * records the seed delta on admin mutations, F-682).
   */
  reset?: (ctx: {
    domain: TDomain;
    reportDelta: (delta: RecorderEvent["state_delta"]) => void;
  }) => unknown | Promise<unknown>;
  /**
   * Implements POST /admin/seed. The seed body is Zod-parsed via
   * `definition.seed` first; `reportDelta` stamps the event's `state_delta`.
   */
  seed?: (ctx: {
    domain: TDomain;
    seed: TSeed;
    reportDelta: (delta: RecorderEvent["state_delta"]) => void;
  }) => unknown | Promise<unknown>;
  /**
   * Per-surface error projection for /admin/reset|seed. Pre-port slack's
   * admin handlers answered EVERY thrown error with 500
   * {ok:false, error:"internal_error", warning} — bypassing the session
   * envelope. Defaults to the twin's `errorEnvelope`.
   */
  errorEnvelope?: (err: unknown) => { status: number; body: unknown };
  /**
   * The twin's admin-gate 403 envelope (slack pins
   * `{ok:false, error:"restricted_action"}`). Gate mechanism —
   * TWIN_ADMIN_TOKEN mode, loopback socket check — stays in the engine
   * (`packages/sdk/src/admin-gate.ts`); this is pure shape. Defaults to the
   * generic `{message: "Forbidden"}` envelope.
   */
  forbidden?: () => { status: number; body: unknown };
}

export interface TwinDefinition<
  TDb = unknown,
  TSeed = unknown,
  TDomain = unknown,
> {
  id: string;
  version: string;
  fidelity: TwinFidelity;
  seed?: z.ZodType<TSeed>;
  domain: (ctx: { db: TDb; seed: TSeed | undefined }) => TDomain;
  routes?: RouteRegistrar<TDomain>;
  tools: ToolSpec<TDomain>[];
  /**
   * Optional state introspection for `GET /s/:sid/_pome/state`. If absent,
   * the route returns a 501 envelope so consumers fail loudly instead of
   * silently reading an empty state.
   */
  state?: (ctx: { domain: TDomain }) => unknown | Promise<unknown>;
  /**
   * Optional admin handlers for `/admin/reset` and `/admin/seed`. If absent,
   * the routes still mount (with the localhost guard) and return a 501
   * envelope explaining that the twin did not configure them.
   */
  admin?: AdminHandlers<TDomain, TSeed>;
  /**
   * Optional error-envelope projector. Called from the recorder middleware
   * catch path to convert a thrown error into the `{ status, body }` shape
   * the route returns. API-mirroring twins use this to preserve the
   * upstream API's error shape (e.g. Stripe's nested `{ error: { type,
   * code, message, doc_url } }`, GitHub's `{ message, documentation_url,
   * status, errors[] }`). Defaults to a generic `{ message, errors? }`
   * envelope.
   */
  errorEnvelope?: (err: unknown) => { status: number; body: unknown };
  /**
   * `/healthz` `implementation` field (runtime contract). Defaults to
   * `"<id>_clone"`.
   */
  implementation?: string;
  /**
   * npm package name reported in the `/healthz` `runtime` block. Defaults
   * to `"@pome-sh/twin-<id>"`.
   */
  packageName?: string;
  /**
   * Extra `/healthz` fields merged over the contract core
   * `{ok, twin, implementation, tools, runtime}`. When absent the engine
   * adds `{version, fidelity}`; a twin with a frozen healthz shape supplies
   * its own extras (possibly `{}` to omit both).
   */
  healthz?: () => Record<string, unknown>;
  /**
   * The twin's 501 loud-unsupported envelope for unknown session routes.
   * Defaults to the generic `{message, fidelity, method, path}` body.
   */
  unsupported?: (ctx: { method: string; path: string }) => {
    status: number;
    body: unknown;
  };
  /**
   * Per-twin request-body reader for the engine-owned JSON surfaces
   * (`/admin/seed`, legacy `/mcp/call`, `/mcp/tools/:name`). Defaults to
   * strict JSON — malformed bodies throw `SyntaxError` into the twin's
   * `errorEnvelope`. Twins with frozen tolerant/form parsing pass their
   * pre-port reader (slack `parseFormOrJson`, stripe form-or-JSON).
   */
  bodyReader?: (c: import("hono").Context) => Promise<unknown>;
  /**
   * Session-wide middleware slot mounted immediately after bearer auth and
   * BEFORE the engine's MCP / `/_pome/*` routes — the pre-port
   * `session.use("*")` position (stripe registers failure-injection and
   * idempotency here so they cover MCP dispatch too). Register `use()`
   * middleware only; routes belong in `routes`.
   */
  middleware?: RouteRegistrar<TDomain>;
  /**
   * Legacy `POST /mcp/call` dispatch pins (F-683 review): slack's frozen
   * surface accepts `{name}`/`{params}` as aliases of `{tool}`/`{arguments}`
   * and answers a body naming no tool with its own envelope instead of the
   * strict-parse error.
   */
  legacyMcp?: {
    aliases?: boolean;
    missingTool?: () => { status: number; body: unknown };
  };
  /**
   * Extra `/s/:sid/_pome/health` fields merged over the contract core
   * `{ok, twin}`. When absent the engine adds `{version, fidelity}`; a twin
   * with a frozen per-session health shape (slack: bare {ok, twin};
   * github: implementation, fidelity, runtime — no version) supplies its
   * own extras. The hook receives the app's recorder so counters can be
   * surfaced (stripe).
   */
  pomeHealth?: (ctx: { recorder: RecorderHandle }) => Record<string, unknown>;
  /**
   * Extra per-twin GET routes under the reserved `/s/:sid/_pome/*` session
   * namespace, keyed by subpath (github's frozen
   * `GET /s/:sid/_pome/access-control`). Handlers return the JSON body;
   * the engine mounts them behind bearer auth, after its own core routes.
   * The core names (`health`, `state`, `events`) stay engine-owned — a twin
   * declaring one refuses to boot.
   */
  pomeRoutes?: Record<string, (ctx: { domain: TDomain }) => unknown | Promise<unknown>>;
  /**
   * FDRS-402 adapter-rich stamping pin: when true, every recorded event
   * persists the incoming `x-pome-correlation-id` header as `tool_call_id`
   * (github's frozen tape shape). Defaults to false — slack's frozen tape
   * stamps null. Flipping a twin is a deliberate tape-shape change.
   */
  stampToolCallId?: boolean;
  /**
   * JSON-RPC `tools/call` unknown-tool result body (frozen per-twin wire
   * shape). Defaults to the twin's `errorEnvelope` projection of
   * `UnknownToolError` (slack/stripe). github pins the pre-port
   * `{message: "Unknown tool: <name>"}` text — its legacy `/mcp/call`
   * surface keeps the 422 validation envelope from `errorEnvelope`.
   */
  mcpUnknownTool?: (name: string) => unknown;
  /**
   * Per-twin auth declarations (F-712): token shape, error envelopes, extra
   * token locations, raw-bearer / sid-mismatch pins, credential lookup.
   * Mechanism lives in the engine's `bearerAuth`; this is pure shape.
   */
  auth?: import("./auth.js").BearerAuthOptions;
}

// ─── Meta-validation ────────────────────────────────────────────────────────

export class TwinManifestError extends Error {
  constructor(message: string, readonly issues: ReadonlyArray<z.core.$ZodIssue> = []) {
    super(message);
    this.name = "TwinManifestError";
  }
}

// Duck-typed on purpose: a twin's schemas may come from its own zod copy
// (unhoisted workspace installs, community twins bundling zod) — a bare
// `instanceof z.ZodType` would reject schemas from any zod instance other
// than the SDK's own.
const isZodType = (value: unknown): value is z.ZodType =>
  value instanceof z.ZodType ||
  (typeof value === "object" &&
    value !== null &&
    typeof (value as z.ZodType).parse === "function" &&
    typeof (value as z.ZodType).safeParse === "function");
const isFunction = (value: unknown): value is Function =>
  typeof value === "function";

const slugLike = /^[a-z][a-z0-9_-]*$/;

const toolFidelityMeta = z.object({
  tier: fidelityTierSchema.optional(),
  backingSurface: z.string().optional(),
  tests: z.array(z.string()).optional(),
  deviations: z.string().optional(),
});

const toolMeta = z.object({
  name: z.string().min(1).regex(slugLike, "tool name must be a lowercase slug"),
  description: z.string().min(1),
  schema: z.custom<z.ZodType>(isZodType, "tool.schema must be a Zod schema"),
  handler: z.custom<Function>(isFunction, "tool.handler must be a function"),
  mutation: z.boolean(),
  fidelity: toolFidelityMeta.optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});

const adminMeta = z.object({
  reset: z.custom<Function>(isFunction).optional(),
  seed: z.custom<Function>(isFunction).optional(),
  errorEnvelope: z.custom<Function>(isFunction).optional(),
  forbidden: z.custom<Function>(isFunction).optional(),
});

const twinMeta = z.object({
  id: z.string().min(1).regex(slugLike, "twin id must be a lowercase slug"),
  version: z.string().min(1),
  fidelity: z.object({ default: fidelityTierSchema }),
  seed: z.custom<z.ZodType>(isZodType, "seed must be a Zod schema").optional(),
  domain: z.custom<Function>(isFunction, "domain must be a function"),
  routes: z.custom<Function>(isFunction, "routes must be a function").optional(),
  tools: z.array(toolMeta),
  state: z.custom<Function>(isFunction).optional(),
  admin: adminMeta.optional(),
  errorEnvelope: z.custom<Function>(isFunction).optional(),
  implementation: z.string().min(1).optional(),
  packageName: z.string().min(1).optional(),
  healthz: z.custom<Function>(isFunction).optional(),
  bodyReader: z.custom<Function>(isFunction).optional(),
  middleware: z.custom<Function>(isFunction).optional(),
  legacyMcp: z
    .object({
      aliases: z.boolean().optional(),
      missingTool: z.custom<Function>(isFunction).optional(),
    })
    .optional(),
  pomeHealth: z.custom<Function>(isFunction).optional(),
  unsupported: z.custom<Function>(isFunction).optional(),
  pomeRoutes: z.record(z.string(), z.custom<Function>(isFunction)).optional(),
  stampToolCallId: z.boolean().optional(),
  mcpUnknownTool: z.custom<Function>(isFunction).optional(),
  auth: z
    .custom<object>((value) => typeof value === "object" && value !== null, "auth must be an options object")
    .optional(),
});

/**
 * Define a twin manifest. Runs Zod meta-validation at the call site
 * (typically module-load time) and throws `TwinManifestError` on shape
 * violations or duplicate tool names.
 */
export function defineTwin<TDb = unknown, TSeed = unknown, TDomain = unknown>(
  spec: TwinDefinition<TDb, TSeed, TDomain>
): TwinDefinition<TDb, TSeed, TDomain> {
  const parsed = twinMeta.safeParse(spec);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new TwinManifestError(`Invalid twin manifest: ${detail}`, parsed.error.issues);
  }
  const seen = new Set<string>();
  for (const tool of spec.tools) {
    if (seen.has(tool.name)) {
      throw new TwinManifestError(`Duplicate tool name: ${tool.name}`);
    }
    seen.add(tool.name);
  }
  return spec;
}

// ─── Reserved paths (used by server.ts; exported for tests) ─────────────────

/**
 * Path prefixes the SDK reserves under `/s/:sid`. User routes that match or
 * start with these are rejected at boot per OQ-B6 (`/_pome/*` shadow
 * detection). `/mcp/*` is reserved for the same reason — community twins
 * cannot silently override the MCP dispatch surface.
 */
export const RESERVED_SESSION_PREFIXES = ["/_pome", "/mcp"] as const;
