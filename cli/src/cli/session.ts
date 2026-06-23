// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";

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
function ensureMcpSuffix(url: string): string {
  return /\/mcp\/?$/.test(url) ? url : `${url.replace(/\/$/, "")}/mcp`;
}

const ALLOWED_TWINS = new Set(["github", "stripe"]);

function redactSession(res: CreateSessionResponse): Record<string, unknown> {
  const pcIn = res.provider_credentials;
  const pcOut: Record<string, unknown> = {};
  if (pcIn.github) {
    pcOut.github = { ...pcIn.github, token: "***redacted***" };
  }
  if (pcIn.stripe) {
    pcOut.stripe = { ...pcIn.stripe, api_key: "***redacted***" };
  }
  return {
    session_id: res.session_id,
    session_token: res.session_token ?? res.session_id,
    twin_url: res.twin_url,
    expires_at: res.expires_at,
    openapi_url: res.openapi_url,
    per_twin: res.per_twin,
    provider_credentials: pcOut,
    agent_token: "***redacted***",
  };
}

function formatEnvExport(res: CreateSessionResponse, twin: string): string {
  const lines: string[] = [
    `# Pome hosted session — treat as secret. Twin: ${twin}`,
    `export POME_AUTH_TOKEN=${JSON.stringify(res.agent_token)}`,
    `export POME_SESSION_ID=${JSON.stringify(res.session_id)}`,
    `export POME_TWIN_URL=${JSON.stringify(res.twin_url)}`,
  ];
  if (res.per_twin?.[twin]?.api_url) {
    lines.push(
      `export POME_${twin.toUpperCase()}_API_URL=${JSON.stringify(res.per_twin[twin].api_url)}`,
    );
  }
  const gh = res.provider_credentials.github;
  if (gh) {
    lines.push(`export POME_GITHUB_TOKEN=${JSON.stringify(gh.token)}`);
  }
  const st = res.provider_credentials.stripe;
  if (st) {
    lines.push(`export POME_STRIPE_API_KEY=${JSON.stringify(st.api_key)}`);
    if (res.per_twin?.[twin]?.api_url) {
      lines.push(
        `export POME_STRIPE_API_BASE=${JSON.stringify(res.per_twin[twin].api_url)}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runSessionCreate(opts: {
  apiBaseUrl: string;
  twin: string;
  showSecrets: boolean;
  format: "text" | "json" | "env";
}): Promise<void> {
  const twin = opts.twin.trim().toLowerCase();
  if (!ALLOWED_TWINS.has(twin)) {
    throw new Error(
      `Unknown twin "${opts.twin}". V1 supports: ${[...ALLOWED_TWINS].join(", ")}.`,
    );
  }

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
    twins: [twin],
    scenarioSource: "# ..\n",
    idempotencyKey: randomUUID(),
    agentId,
  });

  if (opts.format === "json") {
    const payload = opts.showSecrets ? session : redactSession(session);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (opts.format === "env") {
    if (!opts.showSecrets) {
      console.error(
        "Refusing to print environment exports without --show-secrets (unsafe).",
      );
      process.exitCode = 2;
      return;
    }
    console.error(
      "# Warning: secrets below — only paste into a trusted shell session.",
    );
    console.log(formatEnvExport(session, twin));
    return;
  }

  console.error(`Session: ${session.session_id}`);
  console.error(`Expires: ${session.expires_at}`);
  if (session.per_twin?.[twin]) {
    console.error(`API: ${session.per_twin[twin].api_url}`);
    console.error(`MCP: ${ensureMcpSuffix(session.per_twin[twin].mcp_url)}`);
  } else {
    // Fallback for older cloud responses that only ship twin_url. Drop the
    // "(legacy)" label that confused users into thinking the URL was
    // deprecated (F21) — it's just the un-disambiguated single endpoint.
    console.error(`Twin URL: ${session.twin_url}`);
  }
  if (opts.showSecrets) {
    console.error(`Agent token: ${session.agent_token}`);
    if (session.provider_credentials.github) {
      console.error(
        `GitHub token: ${session.provider_credentials.github.token}`,
      );
    }
    if (session.provider_credentials.stripe) {
      console.error(
        `Stripe key: ${session.provider_credentials.stripe.api_key}`,
      );
    }
  } else {
    console.error(
      "Secrets redacted. Use --show-secrets or --format json --show-secrets.",
    );
  }
  // Print the concrete dashboard deep-link rather than the vague "open the
  // Twins page" hint (F22). Users who care can copy it straight into the
  // browser.
  console.error(`Dashboard: ${DEFAULT_DASHBOARD_URL}/twins/${session.session_id}`);
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
    const reason = r.expired_reason ? ` (${r.expired_reason})` : "";
    console.error(
      `${r.id}\t${displayState(r.state)}${reason}\t${r.twins.join(",")}\texpires ${r.expires_at}`,
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
