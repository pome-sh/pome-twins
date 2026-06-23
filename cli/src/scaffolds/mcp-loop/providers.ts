// SPDX-License-Identifier: Apache-2.0
//
// Model-string → Vercel AI SDK model resolver, plus a key-preflight helper the
// matrix (and the entrypoint) can call before any network I/O.
//
// One env var per provider (spec §2). A provider-prefixed model string like
// `openai/gpt-5`, `anthropic/claude-opus-4-8`, `openrouter/qwen-3-235b`, or
// `google/gemini-2.5-pro` picks the provider; bare ids (`claude-*`, `gpt-*`,
// `gemini-*`, `o1`/`o3`) are mapped by prefix to stay back-compatible with the
// claude-agent-sdk-style native ids. The piece after the first `/` (or the bare
// id) is the provider-native model id handed to the SDK.
//
// Resolution is dependency-light at module load: the provider factory packages
// are imported, but a model is only constructed when `resolveModel()` is called,
// so a missing key fails at preflight (clear) rather than at the first token.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { gateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";

// When a Vercel AI Gateway key is present, every provider/model slug routes
// through the gateway with that ONE key — no per-provider key needed, and it
// reaches providers the per-provider path doesn't model (deepseek/, meta/,
// xai/, qwen, ...). This is the preferred path for the model matrix: one key,
// the whole fleet.
export function gatewayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.AI_GATEWAY_API_KEY;
  return v !== undefined && v.trim() !== "";
}

// The four providers the v1 fleet can sweep. Each entry knows the single env var
// its SDK reads (so preflight is honest) and how to build a model from a native
// model id.
export type ProviderId = "anthropic" | "openai" | "openrouter" | "google";

export type ResolvedProvider = {
  provider: ProviderId;
  /** The single env var that must be set for this provider. */
  envKey: string;
  /** The provider-native model id (the part after `provider/`, or the bare id). */
  modelId: string;
};

// Map a (possibly provider-prefixed) model string to its provider + native id +
// required env var. Mirrors the matrix preflight table in
// cli/src/matrix/preflight.ts — keep the two in sync. Returns null for an
// unknown prefix so callers can fail clearly.
export function resolveProvider(model: string): ResolvedProvider | null {
  const m = model.trim();
  const slash = m.indexOf("/");
  const prefix = slash >= 0 ? m.slice(0, slash) : "";
  const rest = slash >= 0 ? m.slice(slash + 1) : m;

  if (prefix === "anthropic" || m.startsWith("claude")) {
    return { provider: "anthropic", envKey: "ANTHROPIC_API_KEY", modelId: rest };
  }
  if (prefix === "openrouter") {
    // OpenRouter model ids are themselves slashed (`qwen/qwen-3-235b`), so keep
    // everything after the FIRST segment intact.
    return { provider: "openrouter", envKey: "OPENROUTER_API_KEY", modelId: rest };
  }
  if (
    prefix === "openai" ||
    m.startsWith("gpt-") ||
    m.startsWith("o1") ||
    m.startsWith("o3")
  ) {
    return { provider: "openai", envKey: "OPENAI_API_KEY", modelId: rest };
  }
  if (prefix === "google" || m.startsWith("gemini")) {
    return { provider: "google", envKey: "GOOGLE_API_KEY", modelId: rest };
  }
  return null;
}

// Resolve the synthetic host the scaffold stamps on its emitted LlmCallEvent
// rows (the scaffold talks to the AI SDK, never the HTTP/byte layer). When the
// gateway key is present every slug routes through "ai-gateway"; otherwise map
// the resolved provider to its public API host. An unknown provider defaults to
// "ai-gateway" (the only reachable path without a per-provider mapping). Kept
// here alongside gatewayEnabled/resolveProvider so host derivation lives where
// the provider knowledge already is.
const PROVIDER_HOSTS: Record<ProviderId, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  google: "generativelanguage.googleapis.com",
  openrouter: "openrouter.ai",
};

export function resolveLlmHost(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (gatewayEnabled(env)) return "ai-gateway";
  const resolved = resolveProvider(model);
  if (!resolved) return "ai-gateway";
  return PROVIDER_HOSTS[resolved.provider];
}

// Preflight: does the env hold the key this model needs? Pure over `env` so it's
// unit-testable and reusable from the matrix orchestrator.
export type ModelPreflight =
  | { ok: true; provider: ProviderId | "gateway"; envKey: string }
  | { ok: false; reason: "unknown-provider"; model: string }
  | { ok: false; reason: "missing-key"; provider: ProviderId; envKey: string };

export function preflightModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelPreflight {
  // Gateway key present → any slug is reachable with that one key.
  if (gatewayEnabled(env)) {
    const known = resolveProvider(model);
    return {
      ok: true,
      provider: known?.provider ?? "gateway",
      envKey: "AI_GATEWAY_API_KEY",
    };
  }
  const resolved = resolveProvider(model);
  if (!resolved) return { ok: false, reason: "unknown-provider", model };
  const value = env[resolved.envKey];
  if (value === undefined || value.trim() === "") {
    return {
      ok: false,
      reason: "missing-key",
      provider: resolved.provider,
      envKey: resolved.envKey,
    };
  }
  return { ok: true, provider: resolved.provider, envKey: resolved.envKey };
}

// Human-readable one-liner for a failed model preflight.
export function preflightModelMessage(pf: ModelPreflight): string {
  if (pf.ok) return `model preflight ok (${pf.provider})`;
  if (pf.reason === "unknown-provider") {
    return `mcp-loop: unknown provider for model "${pf.model}" (expected one of anthropic/ openai/ openrouter/ google/, or a bare claude*/gpt-*/o1/o3/gemini* id)`;
  }
  return `mcp-loop: missing ${pf.envKey} (${pf.provider}) — set it and re-run`;
}

// Construct the AI SDK LanguageModel for a model string. Throws (clearly) on an
// unknown provider or a missing key — call preflightModel() first if you want to
// fail before any model construction. The provider factory reads the key from
// the env var explicitly (not the SDK default) so the key the matrix preflighted
// is exactly the one used — notably Google's SDK default reads
// GOOGLE_GENERATIVE_AI_API_KEY, but we standardize on GOOGLE_API_KEY.
export function resolveModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): LanguageModel {
  // Gateway key present → hand the full provider/model slug to the gateway,
  // which routes it with the single AI_GATEWAY_API_KEY.
  if (gatewayEnabled(env)) {
    return gateway(model.trim());
  }
  const resolved = resolveProvider(model);
  if (!resolved) {
    throw new Error(
      `mcp-loop: cannot resolve provider for model "${model}"`,
    );
  }
  const apiKey = env[resolved.envKey];
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(`mcp-loop: ${resolved.envKey} is not set`);
  }

  switch (resolved.provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(resolved.modelId);
    case "openai":
      return createOpenAI({ apiKey })(resolved.modelId);
    case "openrouter":
      return createOpenRouter({ apiKey }).chat(resolved.modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(resolved.modelId);
  }
}
