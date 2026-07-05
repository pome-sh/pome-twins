// SPDX-License-Identifier: Apache-2.0
// FDRS-635 — deny-by-default egress floor for the capture-server.
//
// "Prod-safety is a network control, not a rule" (north-star board block 06):
// under `pome run` the CONNECT proxy refuses tunnels to any host outside the
// allowlist — twin hosts + LLM provider hosts + loopback — so an agent that
// strays to e.g. api.github.com gets connection-refused, not a silent
// passthrough to production.
//
// The default provider set mirrors `DEFAULT_AGENT_ENV_ALLOWLIST` in
// agentRunner.ts: a provider whose API key the runner forwards by default is
// a provider the floor lets the agent dial by default. Everything else goes
// through the paired valves — POME_AGENT_ENV_ALLOWLIST for the key,
// POME_EGRESS_ALLOW for the host.
//
// Known boundary (by design, see FDRS-635): the floor only binds processes
// that honor proxy env vars. Agents that bypass HTTPS_PROXY are caught by
// `pome doctor`'s routing probe — the two layers are complementary.

import { readFile } from "node:fs/promises";

// Providers whose keys the runner forwards by default (agentRunner.ts).
// `*.anthropic.com` (not just api.) keeps the Claude Agent SDK's own
// telemetry (statsig.anthropic.com) from showing up as refused-egress noise
// on every default-stack run. Deliberately NOT `*.googleapis.com` — that
// would open storage.googleapis.com and friends.
export const DEFAULT_LLM_PROVIDER_HOSTS: readonly string[] = [
  "*.anthropic.com", // ANTHROPIC_API_KEY
  "anthropic.com",
  "api.openai.com", // OPENAI_API_KEY
  "generativelanguage.googleapis.com", // GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
  "openrouter.ai", // OPENROUTER_API_KEY
  "ai-gateway.vercel.sh", // AI_GATEWAY_API_KEY
];

// Custom LLM endpoints: when the runner's environment points a provider SDK
// at a non-default base URL, that host joins the allowlist.
const BASE_URL_ENV_VARS = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"] as const;

export interface BlockedEgress {
  host: string;
  port: number;
  count: number;
}

// Sidecar row written by the capture-server for every refused CONNECT. Lives
// in egress.jsonl, deliberately NOT events.jsonl — the events row shape is
// locked by shared-types and consumed by the correlator, and the refusal is
// runner-facing diagnostics, not trace data.
export interface EgressRefusedRow {
  ts: string;
  kind: "EgressRefusedEvent";
  host: string;
  port: number;
}

function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  return value;
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // 127.0.0.0/8 — the whole loopback block, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// `patterns` entries: exact hostname, `*.suffix` (any-depth subdomain, not
// the apex), or bare `*` (allow everything — floor off). Ports never take
// part in matching: the floor is a host-level control.
export function isHostAllowed(host: string, patterns: readonly string[]): boolean {
  const candidate = normalizeHost(host);
  if (candidate.length === 0) return false;
  if (isLoopback(candidate)) return true;

  for (const raw of patterns) {
    const pattern = normalizeHost(raw);
    if (pattern.length === 0) continue;
    if (pattern === "*") return true;
    if (pattern.startsWith("*.")) {
      if (candidate.endsWith(pattern.slice(1))) return true;
      continue;
    }
    if (candidate === pattern) return true;
  }
  return false;
}

export function parseAllowCsv(csv: string | undefined): string[] {
  return (csv ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// Compute the allowlist for one run: default LLM providers + custom LLM
// base-URL hosts + the POME_EGRESS_ALLOW valve + the twin URLs the runner is
// about to inject (loopback in self-host; hosted twin domains future-proof).
//
// FDRS-643 — `extraHosts` is the demo-mode valve: `pome demo` adds the
// POME_API_BASE host so the bundled agent's anonymous-gateway calls
// (POST /v1/demo/sessions/:id/llm) survive the deny-by-default floor. Same
// pattern rules as everything else (exact host or `*.suffix`).
export function buildEgressAllowlist(
  env: Record<string, string | undefined>,
  opts: { twinUrls?: readonly string[]; extraHosts?: readonly string[] } = {},
): string[] {
  const patterns = [...DEFAULT_LLM_PROVIDER_HOSTS, ...(opts.extraHosts ?? [])];

  for (const key of BASE_URL_ENV_VARS) {
    const value = env[key]?.trim();
    if (!value) continue;
    try {
      patterns.push(new URL(value).hostname);
    } catch {
      // Malformed base URL — the provider SDK will fail on it anyway; the
      // floor doesn't need to.
    }
  }

  patterns.push(...parseAllowCsv(env.POME_EGRESS_ALLOW));

  for (const url of opts.twinUrls ?? []) {
    try {
      patterns.push(new URL(url).hostname);
    } catch {
      // ignore malformed twin URLs
    }
  }

  return [...new Set(patterns.map(normalizeHost).filter((p) => p.length > 0))];
}

// Read the egress sidecar and aggregate refusals per host:port, most-hit
// first. Tolerates a missing file (no refusals — the common case) and junk
// lines (partial writes on a crashed run).
export async function readBlockedEgress(path: string): Promise<BlockedEgress[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }

  const counts = new Map<string, BlockedEgress>();
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null) continue;
    const { kind, host, port } = row as Partial<EgressRefusedRow>;
    if (kind !== "EgressRefusedEvent" || typeof host !== "string" || typeof port !== "number") {
      continue;
    }
    const key = `${host}:${port}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { host, port, count: 1 });
  }

  return [...counts.values()].sort((a, b) => b.count - a.count);
}
