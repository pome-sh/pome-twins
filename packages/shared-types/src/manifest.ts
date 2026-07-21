// SPDX-License-Identifier: Apache-2.0
//
// shared-types §6 — the pome.json / pome.yaml MANIFEST (F-818, format spec
// F-804). One canonical zod schema; JSON and YAML are interchangeable carriers
// of the same snake_case keys (both files present is a hard error at the CLI
// loader, not here). The `agent` block is the stable cross-carrier identity
// contract; top-level keys are CLI run-config and may evolve faster.
//
// SLUG_RE and deriveAgentSlug are THE slug authority for every consumer (CLI,
// control-plane /v1/agents, dashboard, MCP). SLUG_RE is byte-identical to the
// pome-cloud control-plane's regex; deriveAgentSlug is a behavior-identical
// port of packages/db/src/agent-slug.ts (equivalence pinned in
// test/manifest.test.ts). pome-cloud imports both from here as of F-820 —
// local and server validation must never drift again.

import { z } from "zod";

// Canonical agent-slug shape: kebab-case, lowercase alphanumerics, no edge or
// doubled dashes. Length is capped separately (the regex is anchored on shape).
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 64;

// Shared agent slug derivation for REST, dashboard, and CLI registration
// paths. Keep this pure: validation and reserved-slug checks live at each API
// edge. Returns "" when nothing sluggable remains — callers must check.
//
// The first replace collapses every non-alphanumeric run (dashes included) to
// a single dash, so afterwards each edge carries at most one dash — the
// anchored single-char strips are exhaustive and stay linear (the upstream
// `/^-+|-+$/g` form is a CodeQL js/polynomial-redos finding).
export function deriveAgentSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
}

export const agentSlugSchema = z
  .string()
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_RE, "Agent slug must be kebab-case: lowercase letters, digits, single dashes");

// The `agent` identity block. `slug` is the only required field in the whole
// manifest — portable and non-sensitive. The registered `agt_` id is
// deliberately NOT here: committed opaque ids are the fork-404 bug class; the
// platform resolver (POST /v1/agents) maps slug → id under the caller's team.
export const manifestAgentSchema = z.object({
  slug: agentSlugSchema,
  name: z.string().min(1).optional(),          // display name (server display_name)
  description: z.string().optional(),          // shown on dashboard
  version: z.string().optional(),              // user-declared label; never auto-bumped
  // Open enum by design: unknown frameworks get a did-you-mean warning at the
  // consuming edge, never a validation error.
  framework: z.string().min(1).optional(),     // langgraph | claude-agent-sdk | openai-agents | …
});
export type ManifestAgent = z.infer<typeof manifestAgentSchema>;

export const manifestSchema = z.object({
  // pome.json carries the editor pointer; pome.yaml uses a comment instead.
  $schema: z.string().optional(),
  agent: manifestAgentSchema,
  command: z.string().min(1).optional(),       // how the CLI launches the agent
  twins: z.array(z.string().min(1)).min(1).optional(), // default twin set for runs
  tasks: z.string().min(1).optional(),         // task files directory (legacy name: scenarios)
  artifacts_dir: z.string().min(1).default("runs"),
  pass_threshold: z.number().int().min(0).max(100).default(100),
});
export type Manifest = z.infer<typeof manifestSchema>;
// Writer-side shape: what an author may put in pome.json / pome.yaml before
// the run-config defaults are injected (z.input trick, F-778).
export type ManifestInput = z.input<typeof manifestSchema>;

// The JSON Schema served at pome.sh/schemas/v1/pome.json (F-821) and resolved
// by editors via the manifest's `$schema` pointer. `io: "input"` emits the
// AUTHOR-side shape — run-config keys with defaults stay optional instead of
// being promoted to required by the parsed (output) view. Shared by the
// build-time emitter (scripts/emit-manifest-schema.mjs) and the snapshot test
// so the two can never disagree.
export function buildManifestJsonSchema(): Record<string, unknown> {
  return {
    $id: "https://pome.sh/schemas/v1/pome.json",
    title: "Pome agent manifest (pome.json / pome.yaml)",
    ...z.toJSONSchema(manifestSchema, { io: "input" }),
  };
}
