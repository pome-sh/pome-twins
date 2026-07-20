/**
 * Pome bundled example: minimal-viktor-langgraph.
 *
 * The same viktor.com-style "AI employee" merge bot as `examples/minimal-viktor`
 * — review the open PRs in a repo, merge the safe ones, block the unsafe ones,
 * flag the malicious ones, and report every outcome to Slack — but built on
 * LangGraph instead of the Vercel AI SDK, and observed via OpenInference OTel
 * instrumentation instead of the AI SDK's `experimental_telemetry`.
 *
 * Two twins in one run (native multi-twin):
 *   GitHub twin  — provisioned by `pome run` (POME_GITHUB_REST_URL / POME_AUTH_TOKEN)
 *   Slack twin   — provisioned by `pome run` (POME_SLACK_REST_URL / POME_SLACK_TOKEN),
 *                  with VIKTOR_SLACK_* honored as a manual fallback
 *
 * Behavior contract (identical to minimal-viktor; the six scenarios assert it):
 *   merge     → Slack message starting "successfully merged" + repo/PR/title
 *   block     → REQUEST_CHANGES review + Slack "merge blocked: <reason>" + PR link
 *   malicious → never merge; REQUEST_CHANGES + Slack alert naming the author and
 *               asking the team to BLOCK them
 *
 * Default model claude-sonnet-5 via @langchain/anthropic (ANTHROPIC_API_KEY);
 * set LANGGRAPH_MODEL to any anthropic/* or openai/* slug. POME_PREFLIGHT=1
 * prints "preflight ok" plus the POME_ / VIKTOR_ / OTEL_ env var NAMES received
 * (names only, never values) and exits 0.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { buildGraph } from "./graph.js";
import { initTelemetry } from "./telemetry.js";

if (process.env.POME_PREFLIGHT === "1") {
  const names = Object.keys(process.env)
    .filter((k) => k.startsWith("POME_") || k.startsWith("VIKTOR_") || k.startsWith("OTEL_"))
    .sort();
  console.log("preflight ok");
  console.log(`preflight env: ${names.join(",")}`);
  process.exit(0);
}

const task = requiredEnv("POME_TASK");
const ghUrl = requiredEnv("POME_GITHUB_REST_URL").replace(/\/$/, "");
const ghToken = process.env.POME_AUTH_TOKEN;
const slackUrl = (process.env.POME_SLACK_REST_URL ?? process.env.VIKTOR_SLACK_REST_URL)?.replace(/\/$/, "");
const slackToken =
  process.env.POME_SLACK_TOKEN ?? process.env.VIKTOR_SLACK_TOKEN ?? process.env.POME_AUTH_TOKEN;
if (!slackUrl) {
  throw new Error(
    "Slack twin URL is required: set POME_SLACK_REST_URL (native multi-twin) or VIKTOR_SLACK_REST_URL (manual fallback).",
  );
}

const modelSlug = (process.env.LANGGRAPH_MODEL ?? process.env.VIKTOR_MODEL ?? "claude-sonnet-5").trim();
const slackChannel = (process.env.VIKTOR_SLACK_CHANNEL ?? "eng-alerts").trim();

await main();

async function main() {
  // Instrument LangChain BEFORE the graph runs so every node/LLM/tool call is
  // captured, then export to pome if a run endpoint was injected.
  const telemetry = initTelemetry();
  try {
    const model = await resolveModel(modelSlug);
    const graph = buildGraph(model, { ghUrl, ghToken, slackUrl: slackUrl!, slackToken }, slackChannel);
    const final = await graph.invoke({ task });
    console.log(
      JSON.stringify({
        task,
        model: modelSlug,
        repo: `${final.owner}/${final.repo}`,
        decisions: (final.decisions ?? []).map((d) => ({
          pr: d.number,
          outcome: d.outcome,
          reason: d.reason,
        })),
        reports: final.reports ?? [],
      }),
    );
  } catch (err) {
    // A model/graph failure is a failed trial, not a silent crash.
    console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  } finally {
    await telemetry.shutdown();
  }
}

// Anthropic first (the default, and the key this example is tested with). Any
// `openai/*` or `gpt*` slug routes to @langchain/openai. Everything else fails
// loudly rather than silently picking a wrong provider.
async function resolveModel(slug: string): Promise<BaseChatModel> {
  const slash = slug.indexOf("/");
  const prefix = slash >= 0 ? slug.slice(0, slash) : "";
  const id = slash >= 0 ? slug.slice(slash + 1) : slug;

  if (prefix === "anthropic" || slug.startsWith("claude")) {
    const { ChatAnthropic } = await import("@langchain/anthropic");
    return new ChatAnthropic({ model: id, apiKey: requiredEnv("ANTHROPIC_API_KEY"), temperature: 0 });
  }
  // OpenAI: an explicit `openai/` prefix, or a bare GPT / o-series id
  // (`gpt-…`, `o1`, `o3`…). `/^o\d/` so an `ollama/…` slug isn't swept in.
  if (prefix === "openai" || /^gpt/.test(slug) || /^o\d/.test(slug)) {
    const { ChatOpenAI } = await import("@langchain/openai");
    return new ChatOpenAI({ model: id, apiKey: requiredEnv("OPENAI_API_KEY"), temperature: 0 });
  }
  throw new Error(
    `LANGGRAPH_MODEL=${slug} is not recognized. Use an anthropic/* (default) or openai/* slug.`,
  );
}

function requiredEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}
