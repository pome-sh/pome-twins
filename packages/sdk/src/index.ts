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
export type { OpenTwinDatabaseOptions, TwinDatabase, TwinStatement } from "./db.js";
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

export interface ToolSpec<TDomain = unknown, TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  handler: (domain: TDomain, args: TInput) => TOutput | Promise<TOutput>;
  mutation: boolean;
  fidelity?: ToolFidelityMetadata;
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
    opts: { mutation: boolean; fidelity?: RecorderFidelity },
    fn: (c: Context) => Promise<RecorderHandlerResult> | RecorderHandlerResult
  ): (c: Context) => Promise<Response>;
}

export interface AdminHandlers<TDomain = unknown, TSeed = unknown> {
  /** Implements POST /admin/reset. */
  reset?: (ctx: { domain: TDomain }) => unknown | Promise<unknown>;
  /** Implements POST /admin/seed. The seed body is Zod-parsed via `definition.seed` first. */
  seed?: (ctx: { domain: TDomain; seed: TSeed }) => unknown | Promise<unknown>;
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

const isZodType = (value: unknown): value is z.ZodType =>
  value instanceof z.ZodType;
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
});

const adminMeta = z.object({
  reset: z.custom<Function>(isFunction).optional(),
  seed: z.custom<Function>(isFunction).optional(),
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
  unsupported: z.custom<Function>(isFunction).optional(),
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
