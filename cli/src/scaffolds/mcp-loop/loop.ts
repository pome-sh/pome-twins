// SPDX-License-Identifier: Apache-2.0
//
// Model-agnostic MCP tool-call loop (spec §2 — the "mcp-loop" scaffold).
//
// Speaks the SAME agent contract as the existing example agents: it reads
// POME_TASK, the twin's POME_<TWIN>_MCP_URL, and POME_AUTH_TOKEN from the
// environment (the CLI runner sets these per cell). It connects to the twin's
// stateless MCP endpoint (JSON-RPC over Streamable HTTP), exposes the twin's
// tools to the model via the Vercel AI SDK, and runs a tool-call loop until the
// model finishes or hits the turn budget.
//
// NO new runtime dep: the MCP client is a ~40-line JSON-RPC-over-fetch client
// against the twin's stateless Streamable-HTTP server (see
// packages/twin-github/src/mcp.ts — single POST per request, `application/json`
// response, `tools/list` → { tools }, `tools/call` → { content:[{text}], isError }).
//
// Trace signals (best-effort, NOT analyzed in v1): when POME_ADAPTER_SIGNALS_PATH
// is set, the loop appends ToolUseEvent / ToolResultEvent rows whose on-disk
// shape is isomorphic with @pome-sh/adapter-claude-sdk's signals.ts, so traces
// stay comparable across scaffolds and v2's explanation layer inherits them.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  generateText,
  stepCountIs,
  dynamicTool,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
} from "ai";

// ---------------------------------------------------------------------------
// MCP client (dependency-free JSON-RPC over fetch, stateless Streamable HTTP).
// ---------------------------------------------------------------------------

export type McpToolDef = {
  name: string;
  description?: string;
  // camelCase JSON Schema, exactly as the twin's tools/list returns it.
  inputSchema: Record<string, unknown>;
};

export type McpCallResult = {
  // Concatenated text content from the tool-call result.
  text: string;
  isError: boolean;
};

export interface McpClient {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: unknown): Promise<McpCallResult>;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcOk = { jsonrpc: "2.0"; id: number; result: unknown };
type JsonRpcErr = {
  jsonrpc: "2.0";
  id: number | null;
  error: { code: number; message: string };
};

// A minimal Streamable-HTTP MCP client. Each request is one POST; the twin is
// stateless (no Mcp-Session-Id, no SSE for single requests). We still send an
// `initialize` once for protocol-correctness even though the twin doesn't
// require session state.
export function createHttpMcpClient(opts: {
  url: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
}): McpClient {
  const doFetch = opts.fetchImpl ?? fetch;
  let nextId = 1;
  let initialized = false;

  async function rpc(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // The twin replies with application/json for single requests, but a
      // spec-compliant client advertises it accepts SSE too.
      accept: "application/json, text/event-stream",
    };
    if (opts.authToken) headers.authorization = `Bearer ${opts.authToken}`;

    const res = await doFetch(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!res.ok) {
      throw new Error(`MCP ${method} failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as JsonRpcOk | JsonRpcErr;
    if ("error" in body) {
      throw new Error(`MCP ${method} error ${body.error.code}: ${body.error.message}`);
    }
    return body.result;
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    await rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "pome-mcp-loop", version: "1" },
    });
    initialized = true;
  }

  return {
    async listTools(): Promise<McpToolDef[]> {
      await ensureInitialized();
      const result = (await rpc("tools/list")) as { tools?: unknown };
      const tools = Array.isArray(result.tools) ? result.tools : [];
      return tools.flatMap((t): McpToolDef[] => {
        if (
          t &&
          typeof t === "object" &&
          typeof (t as { name?: unknown }).name === "string"
        ) {
          const obj = t as Record<string, unknown>;
          const schema =
            obj.inputSchema && typeof obj.inputSchema === "object"
              ? (obj.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} };
          return [
            {
              name: obj.name as string,
              description:
                typeof obj.description === "string" ? obj.description : undefined,
              inputSchema: schema,
            },
          ];
        }
        return [];
      });
    },

    async callTool(name: string, args: unknown): Promise<McpCallResult> {
      await ensureInitialized();
      const result = (await rpc("tools/call", { name, arguments: args ?? {} })) as {
        content?: unknown;
        isError?: unknown;
      };
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((part) =>
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
            ? ((part as { text: string }).text)
            : "",
        )
        .join("");
      return { text, isError: result.isError === true };
    },
  };
}

// ---------------------------------------------------------------------------
// Best-effort trace signals (isomorphic with @pome-sh/adapter-claude-sdk).
// ---------------------------------------------------------------------------

// Hand-built JSON-line rows matching the adapter's on-disk shapes (no
// shared-types runtime dep). The CLI runner merges this file into the canonical
// events.jsonl after the subprocess exits.
function emitToolUse(
  signalsPath: string | null,
  row: { tool_use_id: string; tool_name: string; input: unknown },
): void {
  if (!signalsPath) return;
  try {
    appendFileSync(
      signalsPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        event_id: randomUUID(),
        parent_id: null,
        kind: "ToolUseEvent",
        tool_use_id: row.tool_use_id,
        tool_name: row.tool_name,
        input: row.input,
      }) + "\n",
    );
  } catch {
    // best-effort: never let trace I/O fail the agent.
  }
}

function emitToolResult(
  signalsPath: string | null,
  row: { tool_use_id: string; output: unknown; is_error: boolean },
): void {
  if (!signalsPath) return;
  try {
    appendFileSync(
      signalsPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        event_id: randomUUID(),
        parent_id: null,
        kind: "ToolResultEvent",
        tool_use_id: row.tool_use_id,
        output: row.output,
        is_error: row.is_error,
      }) + "\n",
    );
  } catch {
    // best-effort.
  }
}

// Append ONE authoritative LlmCallEvent per generateText step (one model
// round-trip). The capture-server proxy can't read token/cost from the
// encrypted CONNECT tunnel; the scaffold holds the AI SDK response and is the
// only source that knows usage. The matrix runs mcp-loop cells with capture
// OFF (see cli/src/matrix/index.ts), so these rows are the SOLE LlmCallEvent
// rows and runResourceMetrics sums them without double-counting proxy latency.
//
// On-disk shape matches llmCallEventSchema (src/types/shared.ts): host/port/
// bytes_in/bytes_out are non-null (the scaffold never sees the HTTP/byte layer,
// so bytes are honestly 0 and host is synthetic); url/method/status are null;
// model/prompt_tokens/completion_tokens/cost_usd carry real values.
function emitLlmCall(
  signalsPath: string | null,
  row: {
    host: string;
    latency_ms: number;
    model: string;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    cost_usd: number | null;
  },
): void {
  if (!signalsPath) return;
  try {
    appendFileSync(
      signalsPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        event_id: randomUUID(),
        parent_id: null,
        kind: "LlmCallEvent",
        host: row.host,
        port: 443,
        latency_ms: row.latency_ms,
        bytes_in: 0,
        bytes_out: 0,
        url: null,
        method: null,
        status: null,
        model: row.model,
        prompt_tokens: row.prompt_tokens,
        completion_tokens: row.completion_tokens,
        cost_usd: row.cost_usd,
      }) + "\n",
    );
  } catch {
    // best-effort: never let trace I/O fail the agent.
  }
}

// Read the Vercel AI Gateway's per-call cost from a step's providerMetadata.
// ProviderMetadata = Record<string, Record<string, JSONValue>>; the gateway
// surfaces cost under providerMetadata.gateway.cost. Defensive: returns the
// number only when finite, else null (provider/route dependent — may be absent).
function readGatewayCost(pm: unknown): number | null {
  if (!pm || typeof pm !== "object") return null;
  const gateway = (pm as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") return null;
  const cost = (gateway as Record<string, unknown>).cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
}

// Coerce a possibly-undefined SDK token count to a schema-valid non-negative
// integer, or null when absent/non-finite.
function coerceTokenCount(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

// 12 turns: matches the example agents' 8-turn loop with headroom for
// multi-step (T5) scenarios. Wall-clock is the runner's scenario-timeout SIGTERM
// (spec §2 / plan) — the loop does not run a second timeout.
export const DEFAULT_MAX_TURNS = 12;

export type RunLoopOptions = {
  model: LanguageModel;
  mcp: McpClient;
  task: string;
  system?: string;
  maxTurns?: number;
  // Where to append best-effort ToolUse/ToolResult/LlmCall signals (or null to
  // skip).
  signalsPath?: string | null;
  // The verbatim POME_MATRIX_MODEL slug (e.g. "anthropic/claude-opus-4.5") used
  // as LlmCallEvent.model — distinct from the resolved `model: LanguageModel`,
  // which has no portable public model-id accessor. This is the human-readable
  // label and the exact key the matrix's Tier-2 pricing table looks up.
  // Defaults to "unknown" when omitted (hand-run callers without a slug).
  modelId?: string;
  // Synthetic host for the emitted LlmCallEvent (the scaffold never sees the
  // HTTP layer). The caller derives it from provider + gateway; defaults to
  // "ai-gateway".
  host?: string;
};

export type RunLoopResult = {
  text: string;
  toolCallCount: number;
  steps: number;
  finishReason: string;
};

// Build the AI SDK tool set from the twin's MCP tools. Each tool's `execute`
// dispatches back through the MCP client and emits best-effort trace signals.
function buildToolSet(
  tools: McpToolDef[],
  mcp: McpClient,
  signalsPath: string | null,
  onToolCall: () => void,
): Record<string, ReturnType<typeof dynamicTool>> {
  const set: Record<string, ReturnType<typeof dynamicTool>> = {};
  for (const t of tools) {
    set[t.name] = dynamicTool({
      description: t.description ?? `MCP tool ${t.name}`,
      inputSchema: jsonSchema(t.inputSchema as never),
      execute: async (input: unknown) => {
        onToolCall();
        const toolUseId = randomUUID();
        emitToolUse(signalsPath, {
          tool_use_id: toolUseId,
          tool_name: t.name,
          input,
        });
        const result = await mcp.callTool(t.name, input);
        emitToolResult(signalsPath, {
          tool_use_id: toolUseId,
          output: result.text,
          is_error: result.isError,
        });
        // Hand the raw tool text back to the model; the AI SDK serializes it.
        return result.text;
      },
    });
  }
  return set;
}

// Run the tool-call loop. The model + MCP client are injected so this is fully
// unit-testable with a mocked model and a fake MCP client (no network, no key).
export async function runMcpLoop(options: RunLoopOptions): Promise<RunLoopResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const signalsPath = options.signalsPath ?? null;

  const mcpTools = await options.mcp.listTools();
  let toolCallCount = 0;
  const toolSet = buildToolSet(mcpTools, options.mcp, signalsPath, () => {
    toolCallCount += 1;
  });

  const messages: ModelMessage[] = [{ role: "user", content: options.task }];

  const modelId = options.modelId ?? "unknown";
  const host = options.host ?? "ai-gateway";

  const t0 = Date.now();
  const result = await generateText({
    model: options.model,
    system: options.system,
    messages,
    tools: toolSet,
    // Keep stepping while the model emits tool calls, up to the turn budget.
    stopWhen: stepCountIs(maxTurns),
  });
  const elapsed = Date.now() - t0;

  // Emit one authoritative LlmCallEvent per step (each step = one model call).
  // The generateText wall-clock is split evenly across steps so the summed
  // latency_ms over rows equals the real wall-clock (the SDK exposes no
  // per-step timing). Tokens/cost are exact per step.
  const stepCount = result.steps.length;
  const perStepLatency = Math.max(0, Math.round(elapsed / Math.max(1, stepCount)));
  for (const step of result.steps) {
    emitLlmCall(signalsPath, {
      host,
      latency_ms: perStepLatency,
      model: modelId,
      prompt_tokens: coerceTokenCount(step.usage?.inputTokens),
      completion_tokens: coerceTokenCount(step.usage?.outputTokens),
      cost_usd: readGatewayCost(step.providerMetadata),
    });
  }

  return {
    text: result.text,
    toolCallCount,
    steps: result.steps.length,
    // The ai-level finishReason is a string union (the provider-level
    // {unified, raw} object is flattened by generateText).
    finishReason: result.finishReason,
  };
}

// ---------------------------------------------------------------------------
// Env-contract resolution (shared by the entrypoint; pure over an env map).
// ---------------------------------------------------------------------------

export type LoopEnvContract = {
  task: string;
  mcpUrl: string;
  authToken?: string;
  model: string;
  promptPath?: string;
  signalsPath: string | null;
};

// Discover the twin MCP URL from POME_<TWIN>_MCP_URL. The runner currently sets
// POME_GITHUB_MCP_URL; this is generic over twins (Stripe/Slack land the same
// shape). POME_TWIN_NAMES, when present, picks the active twin; otherwise the
// first POME_*_MCP_URL wins.
export function resolveMcpUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = (env.POME_TWIN_NAMES ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  for (const name of names) {
    const v = env[`POME_${name}_MCP_URL`];
    if (v && v.trim()) return v.trim();
  }
  // Fall back to any POME_<X>_MCP_URL in the environment.
  for (const [k, v] of Object.entries(env)) {
    if (/^POME_[A-Z0-9]+_MCP_URL$/.test(k) && v && v.trim()) return v.trim();
  }
  return null;
}

// Resolve the full env contract or throw a clear error naming the missing var.
export function resolveLoopEnv(
  env: NodeJS.ProcessEnv = process.env,
): LoopEnvContract {
  const task = env.POME_TASK?.trim();
  if (!task) throw new Error("mcp-loop: POME_TASK is required");

  const mcpUrl = resolveMcpUrl(env);
  if (!mcpUrl) {
    throw new Error(
      "mcp-loop: no POME_<TWIN>_MCP_URL found in the environment (e.g. POME_GITHUB_MCP_URL)",
    );
  }

  const model = env.POME_MATRIX_MODEL?.trim();
  if (!model) {
    throw new Error("mcp-loop: POME_MATRIX_MODEL is required (set by the matrix)");
  }

  const signalsRaw = env.POME_ADAPTER_SIGNALS_PATH;
  return {
    task,
    mcpUrl,
    authToken: env.POME_AUTH_TOKEN?.trim() || undefined,
    model,
    promptPath: env.POME_MATRIX_PROMPT_PATH?.trim() || undefined,
    signalsPath: signalsRaw && signalsRaw.length > 0 ? signalsRaw : null,
  };
}
