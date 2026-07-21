// SPDX-License-Identifier: Apache-2.0
//
// Run-path agent identity (F-819). Resolves the `agt_` id + version to stamp on
// a hosted session from the committed manifest + gitignored `.pome/link.json`.
//
// The cached id is trusted only when its `team_id` matches the caller's team: a
// re-clone under the same team short-circuits with no network (Champion TTHW);
// a fork or team switch silently re-resolves the slug via `POST /v1/agents` so
// a run never sends a foreign `agt_` id and self-onboards with zero extra
// commands. A resolver hiccup degrades to "unattributed" rather than blocking a
// local twin run.

import { dirname } from "node:path";

import {
  postAgentResolver,
  resolveSeams,
} from "./agent-resolver.js";
import { resolveCredentials } from "./credentials.js";
import {
  ensurePomeGitignored,
  readLinkCache,
  resolveCachedAgentId,
  writeLinkCache,
} from "./link-cache.js";
import { readManifest } from "./project-config.js";

export interface RunAgentIdentity {
  /** The resolved agent id to send at session create; absent = unattributed. */
  agentId?: string;
  /** `--agent-version` override, else the manifest's `agent.version`. */
  agentVersion?: string;
  /** The manifest's `agent.framework` — the run's "SDK badge" on the dashboard. */
  framework?: string;
  /** The manifest's `agent.slug`, when a manifest is present. */
  agentSlug?: string;
}

export interface ResolveRunAgentIdentityInput {
  /** Directory to discover the manifest + link cache from (walks up). */
  startDir: string;
  apiBaseUrl: string;
  /** `--agent-version` flag value; wins over the manifest's version. */
  agentVersionOverride?: string;
  /** Test seam — forwarded to resolveCredentials. */
  credentialsPath?: string;
}

export async function resolveRunAgentIdentity(
  input: ResolveRunAgentIdentityInput,
): Promise<RunAgentIdentity> {
  const manifestRead = await readManifest(input.startDir);
  if (!manifestRead) {
    return input.agentVersionOverride
      ? { agentVersion: input.agentVersionOverride }
      : {};
  }

  const { agent } = manifestRead.manifest;
  const agentVersion = input.agentVersionOverride ?? agent.version;
  const base: RunAgentIdentity = {
    agentVersion,
    framework: agent.framework,
    agentSlug: agent.slug,
  };
  const projectDir = dirname(manifestRead.path);

  try {
    const creds = await resolveCredentials({
      apiBaseUrl: input.apiBaseUrl,
      credentialsPath: input.credentialsPath,
    });
    const cachedId = resolveCachedAgentId(await readLinkCache(projectDir), creds.teamId);
    if (cachedId) {
      return { ...base, agentId: cachedId };
    }
    // Silent re-resolution — a run never prompts for a near-miss.
    const resolved = await postAgentResolver(
      creds,
      {
        name: agent.name ?? agent.slug,
        slug: agent.slug,
        description: agent.description,
        version: agent.version,
        framework: agent.framework,
      },
      resolveSeams({ stdinIsTTY: false }),
    );
    if (creds.teamId) {
      await writeLinkCache(projectDir, { agent_id: resolved.id, team_id: creds.teamId });
      await ensurePomeGitignored(projectDir);
    }
    return { ...base, agentId: resolved.id };
  } catch (err) {
    console.error(
      `pome: could not resolve agent identity (${
        err instanceof Error ? err.message : String(err)
      }); running unattributed.`,
    );
    return base;
  }
}
