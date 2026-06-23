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

import {
  HostedAuthError,
  HostedOrchError,
} from "../hosted/errors.js";
import { resolveCredentials } from "./credentials.js";
import { friendlyHostedError } from "./session.js";
import {
  CONFIG_FILE,
  normalizeConfigAgentId,
  readRequiredProjectConfig,
  writeProjectConfig,
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

export async function runRegisterAgent(
  opts: RegisterAgentOptions,
): Promise<void> {
  const { path, config } = await readRequiredProjectConfig();
  const existing = normalizeConfigAgentId(config) ?? null;
  if (existing && !opts.force) {
    console.error(
      `Already registered agent ${existing}. Re-run with --force to overwrite.`,
    );
    return;
  }

  const creds = await resolveCredentials({ apiBaseUrl: opts.apiBaseUrl });
  const res = await fetch(`${creds.apiBaseUrl}/v1/agents`, {
    method: "POST",
    headers: {
      "x-api-key": creds.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: opts.name }),
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
  config.agentId = agent.id;
  config.agentSlug = agent.slug;
  await writeProjectConfig(path, config);

  const displayName = stripControlCharacters(agent.display_name);
  console.error(
    `Registered agent "${displayName}" (${agent.id}, slug=${agent.slug}).`,
  );
  console.error(`Wrote agentId to ${CONFIG_FILE}.`);
  console.error(`Judge model: ${agent.judge_model}.`);
}

function stripControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "");
}

export { friendlyHostedError };
