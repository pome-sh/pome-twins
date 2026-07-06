// SPDX-License-Identifier: Apache-2.0
//
// `pome register agent <name>` — equivalent of `vercel link`. Creates the
// agent in the cloud control-plane and writes the returned `agentId` into
// `pome.config.json` so subsequent `pome run` is auto-scoped to it.
//
// Wire shape (see pome-cloud `docs/05-api-spec.md` and ADR-013):
//   POST /v1/agents  { name }
//     200 { id: "agt_…", slug, display_name, judge_model }
//     401 invalid_auth | 409 conflict (slug exists) | 422 validation_failed
//
// The CLI does not invent a slug — server is canonical. We persist whatever
// slug the server returns next to the id.

import { basename, dirname } from "node:path";

import {
  HostedAuthError,
  HostedOrchError,
} from "../hosted/errors.js";
import { resolveCredentials } from "./credentials.js";
import { friendlyHostedError } from "./session.js";
import {
  CONFIG_FILE,
  normalizeConfigAgentId,
  readProjectConfig,
  readRequiredProjectConfig,
  writeProjectConfig,
  type ProjectConfigRead,
} from "./project-config.js";

interface RegisterAgentOptions {
  apiBaseUrl: string;
  name: string;
  force: boolean;
}

interface AgentResponse {
  id: string;
  slug: string;
  display_name: string;
  judge_model: string;
}

function parseAgentResponse(raw: unknown): AgentResponse {
  if (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as { id?: unknown }).id === "string" &&
    typeof (raw as { slug?: unknown }).slug === "string" &&
    typeof (raw as { display_name?: unknown }).display_name === "string" &&
    typeof (raw as { judge_model?: unknown }).judge_model === "string"
  ) {
    return raw as AgentResponse;
  }
  throw new HostedOrchError("POST /v1/agents returned unexpected shape");
}

/** POST /v1/agents and persist the returned identity into the config read.
 *  Shared by `pome register agent` and `pome install` (FDRS-669). */
async function createAndPersistAgent(input: {
  apiBaseUrl: string;
  name: string;
  configRead: ProjectConfigRead;
  credentialsPath?: string;
}): Promise<AgentResponse> {
  const creds = await resolveCredentials({
    apiBaseUrl: input.apiBaseUrl,
    credentialsPath: input.credentialsPath,
  });
  const res = await fetch(`${creds.apiBaseUrl}/v1/agents`, {
    method: "POST",
    headers: {
      "x-api-key": creds.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: input.name }),
  }).catch((err: unknown) => {
    throw new HostedOrchError(
      err instanceof Error ? err.message : "network error",
    );
  });

  const text = await res.text();
  let json: unknown = {};
  try {
    json = text.length ? JSON.parse(text) : {};
  } catch {
    throw new HostedOrchError(`non-JSON response (status ${res.status})`);
  }
  if (!res.ok) {
    const errObj = (json as { error?: { message?: string; type?: string } })
      .error;
    if (res.status === 401 || res.status === 403) {
      throw new HostedAuthError(errObj?.message ?? `HTTP ${res.status}`);
    }
    if (res.status === 404) {
      throw new HostedOrchError(
        errObj?.message ??
          "POST /v1/agents is not available at this API URL. Upgrade pome-cloud or check that --api-url/POME_API_URL points at a version that supports agent registration.",
      );
    }
    throw new HostedOrchError(
      errObj?.message ?? `POST /v1/agents → HTTP ${res.status}`,
    );
  }

  const agent = parseAgentResponse(json);
  input.configRead.config.agentId = agent.id;
  input.configRead.config.agentSlug = agent.slug;
  await writeProjectConfig(input.configRead.path, input.configRead.config);
  return agent;
}

export async function runRegisterAgent(
  opts: RegisterAgentOptions,
): Promise<void> {
  const configRead = await readRequiredProjectConfig();
  const existing = normalizeConfigAgentId(configRead.config) ?? null;
  if (existing && !opts.force) {
    console.error(
      `Already registered agent ${existing}. Re-run with --force to overwrite.`,
    );
    return;
  }

  const agent = await createAndPersistAgent({
    apiBaseUrl: opts.apiBaseUrl,
    name: opts.name,
    configRead,
  });

  const displayName = stripControlCharacters(agent.display_name);
  console.error(
    `Registered agent "${displayName}" (${agent.id}, slug=${agent.slug}).`,
  );
  console.error(`Wrote agentId to ${CONFIG_FILE}.`);
  console.error(`Judge model: ${agent.judge_model}.`);
}

// ── FDRS-669 — `pome install` registration ─────────────────────────────────

export interface EnsureAgentRegisteredOptions {
  apiBaseUrl: string;
  /** Where to look for pome.config.json. Defaults to process.cwd(). */
  cwd?: string;
  /** Test seam — forwarded to resolveCredentials. */
  credentialsPath?: string;
}

export type EnsureAgentRegisteredResult =
  | { status: "registered"; agentId: string; agentSlug: string }
  | { status: "already-registered"; agentId: string; agentSlug?: string }
  | { status: "no-config" };

/** Idempotent registration for `pome install`: a repo with an agentId keeps
 *  it (no duplicate agents, no error, same slug); a fresh repo registers
 *  under the config directory's basename (vercel-link shape — the server
 *  canonicalizes the slug; we persist whatever it returns). */
export async function ensureAgentRegistered(
  opts: EnsureAgentRegisteredOptions,
): Promise<EnsureAgentRegisteredResult> {
  const configRead = await readProjectConfig(opts.cwd ?? process.cwd());
  if (!configRead) return { status: "no-config" };

  const existing = normalizeConfigAgentId(configRead.config);
  if (existing) {
    const slug = configRead.config.agentSlug;
    return {
      status: "already-registered",
      agentId: existing,
      agentSlug: typeof slug === "string" && slug.trim() ? slug.trim() : undefined,
    };
  }

  const agent = await createAndPersistAgent({
    apiBaseUrl: opts.apiBaseUrl,
    name: basename(dirname(configRead.path)),
    configRead,
    credentialsPath: opts.credentialsPath,
  });
  return { status: "registered", agentId: agent.id, agentSlug: agent.slug };
}

function stripControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "");
}

export { friendlyHostedError };
