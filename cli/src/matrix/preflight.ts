// SPDX-License-Identifier: Apache-2.0
//
// Provider-key preflight (plan decision — fail early + clearly).
//
// Map each fleet model's provider prefix to the one env var that provider's
// SDK reads, collect the distinct required keys, and report any that are
// missing BEFORE spawning a single cell — so a 20-cell run doesn't burn time
// only to fail every cell on a missing key.
//
// scaffold:"command" agents declare no model and need no provider key (keyless
// scripted CI fleet), so eval/agents.scripted.yaml preflights clean.
import type { AgentEntry } from "./agentsConfig.js";

// model-string prefix → env var the provider SDK reads. Mirrors the table the
// eval/README documents. `claude*` (bare, no slash) is the Anthropic SDK's
// native model id form used by the claude-agent-sdk scaffold.
export type ProviderKey = {
  provider: string;
  env: string;
};

export function providerKeyForModel(model: string): ProviderKey | null {
  const m = model.trim();
  if (m.startsWith("anthropic/") || m.startsWith("claude")) {
    return { provider: "anthropic", env: "ANTHROPIC_API_KEY" };
  }
  if (m.startsWith("openrouter/")) {
    return { provider: "openrouter", env: "OPENROUTER_API_KEY" };
  }
  if (m.startsWith("openai/") || m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3")) {
    return { provider: "openai", env: "OPENAI_API_KEY" };
  }
  if (m.startsWith("google/") || m.startsWith("gemini")) {
    return { provider: "google", env: "GOOGLE_API_KEY" };
  }
  return null;
}

export type PreflightResult = {
  ok: boolean;
  requiredKeys: ProviderKey[];
  missing: ProviderKey[];
};

// Compute which provider keys the fleet needs and which are absent from `env`
// (defaults to process.env). Pure over `env` so it is unit-testable.
export function preflightFleet(
  agents: AgentEntry[],
  env: NodeJS.ProcessEnv = process.env,
): PreflightResult {
  const gatewayKey = env.AI_GATEWAY_API_KEY;
  const hasGateway = gatewayKey !== undefined && gatewayKey.trim() !== "";

  const required = new Map<string, ProviderKey>();
  for (const a of agents) {
    if (a.scaffold === "command") continue; // keyless
    if (a.scaffold === "claude-agent-sdk") {
      // The real Claude Agent SDK calls Anthropic directly (not the gateway),
      // so it always needs ANTHROPIC_API_KEY regardless of the gateway key.
      required.set("ANTHROPIC_API_KEY", {
        provider: "anthropic",
        env: "ANTHROPIC_API_KEY",
      });
      continue;
    }
    // mcp-loop (and any future model-string scaffold): one gateway key covers
    // every provider/model slug, so prefer it over per-provider keys.
    if (hasGateway) {
      required.set("AI_GATEWAY_API_KEY", {
        provider: "vercel-ai-gateway",
        env: "AI_GATEWAY_API_KEY",
      });
      continue;
    }
    if (!a.model) continue; // schema guarantees model for non-command, but be safe
    const key = providerKeyForModel(a.model);
    if (key) required.set(key.env, key);
  }
  const requiredKeys = [...required.values()].sort((x, y) =>
    x.env.localeCompare(y.env),
  );
  const missing = requiredKeys.filter((k) => {
    const v = env[k.env];
    return v === undefined || v.trim() === "";
  });
  return { ok: missing.length === 0, requiredKeys, missing };
}

// Human-readable lines for the missing-key failure path.
export function missingKeyMessage(result: PreflightResult): string[] {
  const lines: string[] = [];
  lines.push("pome matrix: missing provider API key(s) required by this fleet:");
  for (const k of result.missing) {
    lines.push(`  - ${k.env} (${k.provider})`);
  }
  lines.push("");
  lines.push(
    "Set the key(s) in your environment and re-run. For a keyless smoke test,",
  );
  lines.push("provide a scripted-only fleet via --agents <file> (no API keys needed) instead.");
  return lines;
}
