// SPDX-License-Identifier: Apache-2.0
//
// `pome register agent <name>` / `pome install` — the vercel-link seam. POSTs
// the manifest identity to `POST /v1/agents` (the F-820 slug resolver: live
// slug → alias → near-miss 409 → auto-create under the caller's team), then
// persists the server-canonical identity into `pome.json` and caches the
// resolved `agt_` id in gitignored `.pome/link.json`.
//
// Wire shape (pome-cloud `docs/05-api-spec.md`, ADR-013, F-820):
//   POST /v1/agents  { name, slug?, description?, version?, framework?, twins?, confirm? }
//     200 AgentResponse { id, slug, display_name, judge_model, framework?, … }
//     401/403 auth | 404 route skew | 409 conflict (near-miss w/ details.suggestion)
//
// The registered `agt_` id is NEVER written to the committed manifest (that is
// the fork-404 bug class): the manifest carries only the portable `agent.slug`.

import { basename, dirname } from "node:path";

import { MOUNTED_TWINS, type AgentResponse } from "@pome-sh/shared-types";
import {
  postAgentResolver,
  resolveSeams,
  type AgentPostBody,
  type InteractiveSeams,
} from "./agent-resolver.js";
import { resolveCredentials, type ResolvedCredentials } from "./credentials.js";
import { suggestFramework } from "./frameworks.js";
import {
  ensurePomeGitignored,
  readLinkCache,
  resolveCachedAgentId,
  writeLinkCache,
} from "./link-cache.js";
import {
  readManifest,
  readRequiredManifest,
  writeManifest,
  type ManifestRead,
} from "./project-config.js";
import { friendlyHostedError } from "./session.js";

const SCHEMA_URL = "https://pome.sh/schemas/v1/pome.json";

interface RegisterAgentOptions extends InteractiveSeams {
  apiBaseUrl: string;
  name: string;
  force: boolean;
  twins?: string[];
  /** Test seam — forwarded to resolveCredentials. */
  credentialsPath?: string;
}

/** Normalize a `--twins github,slack` comma list to a validated twin array. */
export function normalizeRegisterTwins(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const twins = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (twins.length === 0) return undefined;
  const allowed = new Set<string>(MOUNTED_TWINS);
  const unknown = twins.filter((t) => !allowed.has(t));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown twin(s) ${unknown.map((t) => `"${t}"`).join(", ")}. Supported: ${MOUNTED_TWINS.join(", ")}.`,
    );
  }
  return [...new Set(twins)];
}

// ── Persist: manifest + link cache + gitignore ──────────────────────────────

/** Read the manifest's existing agent block (for round-trip preservation and
 *  did-you-mean input) without forcing schema defaults. */
function rawAgentBlock(manifestRead: ManifestRead): Record<string, unknown> {
  const agent = manifestRead.raw.agent;
  return typeof agent === "object" && agent !== null && !Array.isArray(agent)
    ? (agent as Record<string, unknown>)
    : {};
}

/** Warn (never block) when the manifest declares an unrecognized framework. */
function warnUnknownFramework(existingAgent: Record<string, unknown>): void {
  const framework = existingAgent.framework;
  if (typeof framework !== "string" || framework.trim().length === 0) return;
  const result = suggestFramework(framework);
  if (result.known) return;
  const hint = result.suggestion ? ` Did you mean "${result.suggestion}"?` : "";
  console.error(`Unknown agent.framework "${framework}".${hint} (Recorded as-is.)`);
}

/** POST the resolver, then write the server-canonical identity into the
 *  manifest (preserving format + unrelated keys), cache the id in
 *  `.pome/link.json` (team-gated), and ensure `.pome/` is gitignored. */
async function createAndPersistAgent(input: {
  creds: ResolvedCredentials;
  name: string;
  manifestRead: ManifestRead;
  projectDir: string;
  twins?: string[];
  seams: Required<InteractiveSeams>;
}): Promise<AgentResponse> {
  const existingAgent = rawAgentBlock(input.manifestRead);
  warnUnknownFramework(existingAgent);

  const body: AgentPostBody = { name: input.name, twins: input.twins };
  if (typeof existingAgent.description === "string") body.description = existingAgent.description;
  if (typeof existingAgent.version === "string") body.version = existingAgent.version;
  if (typeof existingAgent.framework === "string") body.framework = existingAgent.framework;

  const agent = await postAgentResolver(input.creds, body, input.seams);

  // Write the manifest from the response — slug + display name are canonical;
  // description/version/framework fall back to the manifest when the cloud
  // returns nothing (older control plane).
  const nextAgent: Record<string, unknown> = { ...existingAgent, slug: agent.slug };
  nextAgent.name = agent.display_name;
  const description = agent.description ?? existingAgent.description;
  if (typeof description === "string") nextAgent.description = description;
  const version = agent.version ?? existingAgent.version;
  if (typeof version === "string") nextAgent.version = version;
  const framework = agent.framework ?? existingAgent.framework;
  if (typeof framework === "string") nextAgent.framework = framework;

  const nextRaw: Record<string, unknown> = {
    ...input.manifestRead.raw,
    agent: nextAgent,
  };
  if (typeof nextRaw.$schema !== "string") nextRaw.$schema = SCHEMA_URL;
  await writeManifest(input.manifestRead.path, input.manifestRead.format, nextRaw);

  // Cache the resolved id only when we know the caller's team (env-key auth
  // has no local team; the cache stays absent and every run re-resolves).
  if (input.creds.teamId) {
    await writeLinkCache(input.projectDir, { agent_id: agent.id, team_id: input.creds.teamId });
  }
  await ensurePomeGitignored(input.projectDir);
  return agent;
}

export async function runRegisterAgent(opts: RegisterAgentOptions): Promise<void> {
  const manifestRead = await readRequiredManifest();
  const projectDir = dirname(manifestRead.path);
  const creds = await resolveCredentials({
    apiBaseUrl: opts.apiBaseUrl,
    credentialsPath: opts.credentialsPath,
  });

  if (!opts.force) {
    const cachedId = resolveCachedAgentId(await readLinkCache(projectDir), creds.teamId);
    if (cachedId) {
      console.error(
        `Already linked to ${cachedId} (slug=${manifestRead.manifest.agent.slug}). Re-run with --force to re-resolve.`,
      );
      return;
    }
  }

  const agent = await createAndPersistAgent({
    creds,
    name: opts.name,
    manifestRead,
    projectDir,
    twins: opts.twins,
    seams: resolveSeams(opts),
  });

  const displayName = stripControlCharacters(agent.display_name);
  console.error(`Registered agent "${displayName}" (${agent.id}, slug=${agent.slug}).`);
  console.error(`Wrote agent.slug to ${basename(manifestRead.path)}.`);
  console.error(`Judge model: ${agent.judge_model}.`);
  if (agent.enabled_services !== undefined) {
    console.error(
      `Enabled services: ${agent.enabled_services.length > 0 ? agent.enabled_services.join(", ") : "(none)"}.`,
    );
  } else if (opts.twins && opts.twins.length > 0) {
    console.error(
      "Enabled services: not reported by this pome cloud (older control plane) — twin scoping may not have taken effect.",
    );
  }
}

// ── `pome install` registration seam ────────────────────────────────────────

export interface EnsureAgentRegisteredOptions extends InteractiveSeams {
  apiBaseUrl: string;
  /** Where to look for the manifest. Defaults to process.cwd(). */
  cwd?: string;
  /** Test seam — forwarded to resolveCredentials. */
  credentialsPath?: string;
}

export type EnsureAgentRegisteredResult =
  | { status: "registered"; agentId: string; agentSlug: string }
  | { status: "already-registered"; agentId: string; agentSlug?: string }
  | { status: "no-config" };

/** Idempotent registration for `pome install`: a repo already linked under the
 *  caller's team keeps its id (no network, no duplicate); a fresh repo registers
 *  under the manifest name (or the config directory's basename). */
export async function ensureAgentRegistered(
  opts: EnsureAgentRegisteredOptions,
): Promise<EnsureAgentRegisteredResult> {
  const manifestRead = await readManifest(opts.cwd ?? process.cwd());
  if (!manifestRead) return { status: "no-config" };

  const projectDir = dirname(manifestRead.path);
  const creds = await resolveCredentials({
    apiBaseUrl: opts.apiBaseUrl,
    credentialsPath: opts.credentialsPath,
  });

  const cachedId = resolveCachedAgentId(await readLinkCache(projectDir), creds.teamId);
  if (cachedId) {
    return {
      status: "already-registered",
      agentId: cachedId,
      agentSlug: manifestRead.manifest.agent.slug,
    };
  }

  const name = manifestRead.manifest.agent.name ?? basename(projectDir);
  const agent = await createAndPersistAgent({
    creds,
    name,
    manifestRead,
    projectDir,
    seams: resolveSeams(opts),
  });
  return { status: "registered", agentId: agent.id, agentSlug: agent.slug };
}

function stripControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "");
}

export { friendlyHostedError };
