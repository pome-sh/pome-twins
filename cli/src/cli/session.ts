// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { MOUNTED_TWINS } from "@pome-sh/shared-types";
import { createHostedClient } from "../hosted/client.js";
import type { CreateSessionResponse } from "../types/shared.js";
import {
  HostedAuthError,
  HostedOrchError,
  HostedQuotaError,
} from "../hosted/errors.js";
import { resolveCredentials } from "./credentials.js";
import { DEFAULT_DASHBOARD_URL } from "./defaults.js";
import { normalizeConfigAgentId, readProjectConfig } from "./project-config.js";

// Defensive append: the server's per_twin.mcp_url has been observed missing
// the `/mcp` suffix that agents need to mount the MCP transport (F19). The
// standalone `pome twin start` path already appends `/mcp` in `cli/main.ts`;
// mirror that here so agents reading the printed value get a working MCP URL
// regardless of which side ships the fix first.
export function ensureMcpSuffix(url: string): string {
  return /\/mcp\/?$/.test(url) ? url : `${url.replace(/\/$/, "")}/mcp`;
}

// Multi-twin (M3): the CLI's ad-hoc session allowlist is the shared mounted-twin
// set (github, stripe, slack). Slack is now reachable; repeated `--twin` flags
// stand up a multi-twin session in one call.
const ALLOWED_TWINS = new Set<string>(MOUNTED_TWINS);

function redactSession(res: CreateSessionResponse): Record<string, unknown> {
  const pcIn = res.provider_credentials;
  const pcOut: Record<string, unknown> = {};
  if (pcIn.github) {
    pcOut.github = { ...pcIn.github, token: "***redacted***" };
  }
  if (pcIn.stripe) {
    pcOut.stripe = { ...pcIn.stripe, api_key: "***redacted***" };
  }
  if (pcIn.slack) {
    pcOut.slack = { ...pcIn.slack, token: "***redacted***" };
  }
  return {
    session_id: res.session_id,
    session_token: res.session_token ? "***redacted***" : res.session_id,
    twin_url: res.twin_url,
    expires_at: res.expires_at,
    openapi_url: res.openapi_url,
    per_twin: res.per_twin,
    provider_credentials: pcOut,
    agent_token: "***redacted***",
  };
}

function formatEnvExport(res: CreateSessionResponse, twins: string[]): string {
  const lines: string[] = [
    `# Pome hosted session — treat as secret. Twins: ${twins.join(", ")}`,
    `export POME_AUTH_TOKEN=${JSON.stringify(res.agent_token)}`,
    `export POME_SESSION_ID=${JSON.stringify(res.session_id)}`,
    // Legacy single-endpoint URL (= the primary twin's api_url). Kept for
    // agents written against the pre-multi-twin contract.
    `export POME_TWIN_URL=${JSON.stringify(res.twin_url)}`,
    `export POME_TWIN_NAMES=${JSON.stringify(twins.join(","))}`,
  ];
  // Multi-twin (M3): one POME_<TWIN>_{REST,MCP}_URL pair per twin, plus the
  // provider-specific credential line. Loops per_twin so a github+slack session
  // emits distinct endpoints for each.
  for (const twin of twins) {
    const upper = twin.toUpperCase();
    const pt = res.per_twin?.[twin];
    if (pt?.api_url) {
      lines.push(`export POME_${upper}_REST_URL=${JSON.stringify(pt.api_url)}`);
      lines.push(
        `export POME_${upper}_MCP_URL=${JSON.stringify(ensureMcpSuffix(pt.mcp_url))}`,
      );
    }
    if (twin === "github") {
      const gh = res.provider_credentials.github;
      if (gh) {
        lines.push(`export POME_GITHUB_TOKEN=${JSON.stringify(gh.token)}`);
      }
    } else if (twin === "stripe") {
      const st = res.provider_credentials.stripe;
      if (st) {
        lines.push(`export POME_STRIPE_API_KEY=${JSON.stringify(st.api_key)}`);
      }
      if (pt?.api_url) {
        lines.push(`export POME_STRIPE_API_BASE=${JSON.stringify(pt.api_url)}`);
      }
    } else if (twin === "slack") {
      // The twin proxy verifies only the session JWT (agent_token) as bearer —
      // the provider-specific Slack credential is NOT accepted at the proxy
      // (same rationale as the Stripe api-key line in the hosted runner). So
      // the agent's Slack bearer is the JWT, not provider_credentials.slack.token.
      lines.push(`export POME_SLACK_TOKEN=${JSON.stringify(res.agent_token)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Normalize one-or-more `--twin` flags into a validated, de-duped twin list.
 *  Repeated flags stand up an ad-hoc multi-twin session; each is validated
 *  against MOUNTED_TWINS for a friendly error before the round-trip. */
export function normalizeSessionTwins(raw: string[]): string[] {
  const twins = raw.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  for (const twin of twins) {
    if (!ALLOWED_TWINS.has(twin)) {
      throw new Error(
        `Unknown twin "${twin}". Supported: ${[...ALLOWED_TWINS].join(", ")}.`,
      );
    }
  }
  const deduped = [...new Set(twins)];
  if (deduped.length === 0) {
    throw new Error(
      `No twin specified. Pass --twin <name> (repeat for multi-twin). Supported: ${[...ALLOWED_TWINS].join(", ")}.`,
    );
  }
  return deduped;
}

export async function runSessionCreate(opts: {
  apiBaseUrl: string;
  /** One-or-more twins. Repeated `--twin` flags stand up a multi-twin session. */
  twins: string[];
  showSecrets: boolean;
  format: "text" | "json" | "env";
  secretsFile?: string;
}): Promise<void> {
  const twins = normalizeSessionTwins(opts.twins);

  const creds = await resolveCredentials({ apiBaseUrl: opts.apiBaseUrl });
  const client = createHostedClient({
    baseUrl: creds.apiBaseUrl,
    apiKey: creds.apiKey,
  });
  const configRead = await readProjectConfig(process.cwd());
  const agentId = configRead
    ? normalizeConfigAgentId(configRead.config)
    : undefined;

  const session = await client.createSession({
    twins,
    scenarioSource: "# ..\n",
    idempotencyKey: randomUUID(),
    agentId,
  });

  if (opts.secretsFile) {
    await writeSecretsFile(opts.secretsFile, formatEnvExport(session, twins));
    console.error(`Wrote session secrets to ${opts.secretsFile} (mode 0600).`);
  }

  if (opts.format === "json") {
    const payload = redactSession(session);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (opts.format === "env") {
    if (opts.secretsFile) {
      return;
    }
    console.error(
      "Refusing to print environment exports. Use --secrets-file <path> to write them to a 0600 file.",
    );
    process.exitCode = 2;
    return;
  }

  console.error(`Session: ${session.session_id}`);
  console.error(`Expires: ${session.expires_at}`);
  // Multi-twin (M3): print one API/MCP line per twin so a github+slack session
  // shows both endpoints. Falls back to the legacy bare twin_url on an older
  // cloud that only ships it.
  let printedAny = false;
  for (const twin of twins) {
    const pt = session.per_twin?.[twin];
    if (pt) {
      const label = twins.length > 1 ? `${twin} ` : "";
      console.error(`${label}API: ${pt.api_url}`);
      console.error(`${label}MCP: ${ensureMcpSuffix(pt.mcp_url)}`);
      printedAny = true;
    }
  }
  if (!printedAny) {
    // Fallback for older cloud responses that only ship twin_url. Drop the
    // "(legacy)" label that confused users into thinking the URL was
    // deprecated (F21) — it's just the un-disambiguated single endpoint.
    console.error(`Twin URL: ${session.twin_url}`);
  }
  if (opts.showSecrets) {
    console.error("--show-secrets no longer prints secrets. Use --secrets-file <path>.");
  }
  console.error("Secrets redacted.");
  // Print the concrete dashboard deep-link rather than the vague "open the
  // Twins page" hint (F22). Users who care can copy it straight into the
  // browser.
  console.error(`Dashboard: ${DEFAULT_DASHBOARD_URL}/twins/${session.session_id}`);
}

async function writeSecretsFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

export type SessionListStateFilter =
  | "running"
  | "ready"
  | "done"
  | "expired"
  | "all";

// F25 — server returns mixed vocab ("ready" for boot-complete, "running"
// for active, plus "done" / "expired"). The dashboard says "Running" for
// both "ready" and "running". Normalize on the CLI so users grepping
// state across surfaces see one word. Free-form passthrough for unknown
// values so we don't hide a new server state behind an undefined map.
function displayState(serverState: string): string {
  if (serverState === "ready") return "running";
  return serverState;
}

// F24 — `--state running` is the default (sane first-run output). `all`
// disables filtering. The other values map 1:1 to server vocab; we accept
// "running" in input and translate it to "ready"/"running" matching.
function matchesStateFilter(
  serverState: string,
  filter: SessionListStateFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "running") return serverState === "ready" || serverState === "running";
  return serverState === filter;
}

export async function runSessionList(opts: {
  apiBaseUrl: string;
  limit: number;
  format: "text" | "json";
  state: SessionListStateFilter;
}): Promise<void> {
  const creds = await resolveCredentials({ apiBaseUrl: opts.apiBaseUrl });
  const client = createHostedClient({
    baseUrl: creds.apiBaseUrl,
    apiKey: creds.apiKey,
  });
  // Request more than `limit` from the server so client-side state
  // filtering still leaves us with a useful page. Cap to avoid runaway
  // payloads.
  const fetchLimit = opts.state === "all" ? opts.limit : Math.min(opts.limit * 4, 200);
  const all = await client.listSessions({ limit: fetchLimit });
  const filtered = all.filter((r) => matchesStateFilter(r.state, opts.state));
  const rows = filtered.slice(0, opts.limit);
  if (opts.format === "json") {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    const scope = opts.state === "all" ? "any" : `state=${opts.state}`;
    console.error(`No sessions returned (${scope}).`);
    return;
  }
  for (const r of rows) {
    console.error(
      `${r.id}\t${displayState(r.state)}\t${r.twins.join(",")}\texpires ${r.expires_at}`,
    );
  }
}

export async function runSessionStop(opts: {
  apiBaseUrl: string;
  sessionId: string;
}): Promise<void> {
  const creds = await resolveCredentials({ apiBaseUrl: opts.apiBaseUrl });
  const client = createHostedClient({
    baseUrl: creds.apiBaseUrl,
    apiKey: creds.apiKey,
  });
  await client.deleteSession(opts.sessionId, false);
  console.error(`Stopped session ${opts.sessionId}.`);
}

export function friendlyHostedError(err: unknown): string {
  if (err instanceof HostedAuthError) {
    return `${err.message} · Run \`pome login\` or set a valid POME_API_KEY.`;
  }
  if (err instanceof HostedQuotaError) {
    return `${err.message} · Quota or billing limit — check your team plan in the dashboard.`;
  }
  if (err instanceof HostedOrchError) {
    const m = err.message;
    if (/422|validation/i.test(m)) {
      return `${m} · Check twin name and request body.`;
    }
    if (/503|spawn/i.test(m)) {
      return `${m} · Control plane could not start the sandbox — retry later.`;
    }
    return m;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
