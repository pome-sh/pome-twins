// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the mcp-loop scaffold. Exercises the tool-call loop with a
// MOCKED model (ai/test's MockLanguageModelV3) and a FAKE MCP client — no
// network, no API key. Also covers the dependency-free MCP-over-fetch client,
// env-contract resolution, and provider/key preflight.
import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import {
  runMcpLoop,
  createHttpMcpClient,
  resolveMcpUrl,
  resolveLoopEnv,
  DEFAULT_MAX_TURNS,
  type McpClient,
  type McpToolDef,
} from "../../src/scaffolds/mcp-loop/loop.js";
import {
  resolveProvider,
  resolveLlmHost,
  preflightModel,
  preflightModelMessage,
} from "../../src/scaffolds/mcp-loop/providers.js";

// A fake MCP client: one tool, records calls. No network.
function fakeMcp(): McpClient & { calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  const tools: McpToolDef[] = [
    {
      name: "get_issue",
      description: "Read an issue",
      inputSchema: {
        type: "object",
        properties: { number: { type: "number" } },
        required: ["number"],
      },
    },
  ];
  return {
    calls,
    async listTools() {
      return tools;
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { text: JSON.stringify({ number: 1, title: "boom" }), isError: false };
    },
  };
}

// A standard V3 usage block.
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

// Build a mock model that emits ONE tool call on the first generate and a final
// text block on the second — the canonical two-turn loop.
function twoTurnModel(): LanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "get_issue",
              input: JSON.stringify({ number: 1 }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "Issue #1 is a bug." }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage,
        warnings: [],
      };
    },
  });
}

describe("runMcpLoop (mocked model + fake MCP)", () => {
  it("drives a tool call then returns the model's final text", async () => {
    const mcp = fakeMcp();
    const result = await runMcpLoop({
      model: twoTurnModel(),
      mcp,
      task: "Triage issue #1",
    });

    expect(result.text).toBe("Issue #1 is a bug.");
    expect(result.toolCallCount).toBe(1);
    expect(result.finishReason).toBe("stop");
    expect(result.steps).toBeGreaterThanOrEqual(2);
    // The loop actually dispatched the tool back through the MCP client.
    expect(mcp.calls).toEqual([{ name: "get_issue", args: { number: 1 } }]);
  });

  it("emits isomorphic ToolUse/ToolResult signal rows when a path is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-loop-sig-"));
    const signalsPath = join(dir, "signals.jsonl");

    await runMcpLoop({
      model: twoTurnModel(),
      mcp: fakeMcp(),
      task: "Triage issue #1",
      signalsPath,
    });

    const rows = readFileSync(signalsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const use = rows.find((r) => r.kind === "ToolUseEvent");
    const res = rows.find((r) => r.kind === "ToolResultEvent");
    expect(use).toMatchObject({ kind: "ToolUseEvent", tool_name: "get_issue" });
    expect(use.tool_use_id).toEqual(expect.any(String));
    expect(typeof use.ts).toBe("string");
    // ToolUse / ToolResult correlate on the same tool_use_id.
    expect(res).toMatchObject({ kind: "ToolResultEvent", is_error: false });
    expect(res.tool_use_id).toBe(use.tool_use_id);
  });

  it("emits a per-step LlmCallEvent with tokens/latency/model/host when a path is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-loop-llm-"));
    const signalsPath = join(dir, "signals.jsonl");

    await runMcpLoop({
      model: twoTurnModel(),
      mcp: fakeMcp(),
      task: "Triage issue #1",
      signalsPath,
      modelId: "anthropic/claude-opus-4.5",
      host: "ai-gateway",
    });

    const rows = readFileSync(signalsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const llm = rows.filter((r) => r.kind === "LlmCallEvent");
    // Two-turn loop ⇒ at least one model step ⇒ at least one LlmCallEvent.
    expect(llm.length).toBeGreaterThanOrEqual(1);
    const row = llm[0];
    expect(row).toMatchObject({
      kind: "LlmCallEvent",
      // The mock's V3 usage flattens to inputTokens:10 / outputTokens:5.
      prompt_tokens: 10,
      completion_tokens: 5,
      model: "anthropic/claude-opus-4.5",
      host: "ai-gateway",
      port: 443,
      bytes_in: 0,
      bytes_out: 0,
      url: null,
      method: null,
      status: null,
      // The mock carries no gateway providerMetadata ⇒ cost is honestly null.
      cost_usd: null,
    });
    expect(typeof row.latency_ms).toBe("number");
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof row.ts).toBe("string");
    expect(row.event_id).toEqual(expect.any(String));
  });

  it("finishes immediately when the model emits no tool calls", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: "No action needed." }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage,
        warnings: [],
      }),
    });
    const mcp = fakeMcp();
    const result = await runMcpLoop({ model, mcp, task: "Do nothing" });
    expect(result.text).toBe("No action needed.");
    expect(result.toolCallCount).toBe(0);
    expect(mcp.calls).toEqual([]);
  });
});

describe("createHttpMcpClient (fake fetch — no network)", () => {
  // A fake fetch that answers the twin's stateless JSON-RPC the way
  // packages/twin-github/src/mcp.ts does.
  function rpcFetch(): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params?: { name?: string; arguments?: unknown };
      };
      const reply = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (body.method === "initialize") {
        return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
      }
      if (body.method === "tools/list") {
        return reply({
          tools: [
            { name: "get_issue", description: "Read", inputSchema: { type: "object" } },
          ],
        });
      }
      if (body.method === "tools/call") {
        return reply({
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        });
      }
      return reply({});
    }) as unknown as typeof fetch;
  }

  it("lists tools and calls a tool over JSON-RPC, sending the auth bearer", async () => {
    let sawAuth: string | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      sawAuth = new Headers(init?.headers).get("authorization");
      return rpcFetch()(url as never, init as never);
    }) as unknown as typeof fetch;

    const client = createHttpMcpClient({
      url: "http://twin/s/x/mcp",
      authToken: "jwt-abc",
      fetchImpl,
    });

    const tools = await client.listTools();
    expect(tools).toEqual([
      { name: "get_issue", description: "Read", inputSchema: { type: "object" } },
    ]);

    const out = await client.callTool("get_issue", { number: 1 });
    expect(out).toEqual({ text: JSON.stringify({ ok: true }), isError: false });
    expect(sawAuth).toBe("Bearer jwt-abc");
  });

  it("surfaces a JSON-RPC error as a thrown error", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = createHttpMcpClient({ url: "http://twin/mcp", fetchImpl });
    await expect(client.listTools()).rejects.toThrow(/Method not found/);
  });
});

describe("resolveMcpUrl / resolveLoopEnv", () => {
  it("picks the active twin's MCP URL via POME_TWIN_NAMES", () => {
    const env = {
      POME_TWIN_NAMES: "github",
      POME_GITHUB_MCP_URL: "http://twin/s/x/mcp",
    } as NodeJS.ProcessEnv;
    expect(resolveMcpUrl(env)).toBe("http://twin/s/x/mcp");
  });

  it("falls back to any POME_<X>_MCP_URL when no twin name is set", () => {
    const env = { POME_STRIPE_MCP_URL: "http://twin/stripe/mcp" } as NodeJS.ProcessEnv;
    expect(resolveMcpUrl(env)).toBe("http://twin/stripe/mcp");
  });

  it("returns null when no MCP URL is present", () => {
    expect(resolveMcpUrl({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("resolves the full contract from env", () => {
    const env = {
      POME_TASK: "Triage #1",
      POME_GITHUB_MCP_URL: "http://twin/s/x/mcp",
      POME_AUTH_TOKEN: "jwt",
      POME_MATRIX_MODEL: "openai/gpt-5",
      POME_ADAPTER_SIGNALS_PATH: "/tmp/sig.jsonl",
    } as NodeJS.ProcessEnv;
    const c = resolveLoopEnv(env);
    expect(c).toMatchObject({
      task: "Triage #1",
      mcpUrl: "http://twin/s/x/mcp",
      authToken: "jwt",
      model: "openai/gpt-5",
      signalsPath: "/tmp/sig.jsonl",
    });
  });

  it("throws clearly when POME_TASK is missing", () => {
    expect(() => resolveLoopEnv({} as NodeJS.ProcessEnv)).toThrow(/POME_TASK/);
  });

  it("throws clearly when no MCP URL is present", () => {
    expect(() =>
      resolveLoopEnv({ POME_TASK: "x", POME_MATRIX_MODEL: "openai/gpt-5" } as NodeJS.ProcessEnv),
    ).toThrow(/MCP_URL/);
  });

  it("exposes the default turn budget", () => {
    expect(DEFAULT_MAX_TURNS).toBe(12);
  });
});

describe("provider resolution + key preflight", () => {
  it("maps provider-prefixed and bare model strings to provider + native id", () => {
    expect(resolveProvider("openai/gpt-5")).toEqual({
      provider: "openai",
      envKey: "OPENAI_API_KEY",
      modelId: "gpt-5",
    });
    expect(resolveProvider("anthropic/claude-opus-4-8")).toMatchObject({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    });
    expect(resolveProvider("claude-opus-4-8")).toMatchObject({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    });
    // OpenRouter ids are themselves slashed — keep everything after the prefix.
    expect(resolveProvider("openrouter/qwen/qwen-3-235b")).toMatchObject({
      provider: "openrouter",
      modelId: "qwen/qwen-3-235b",
    });
    expect(resolveProvider("gemini-2.5-pro")).toMatchObject({ provider: "google" });
    expect(resolveProvider("mystery/model")).toBeNull();
  });

  it("preflightModel passes when the key is present and fails clearly otherwise", () => {
    expect(preflightModel("openai/gpt-5", { OPENAI_API_KEY: "sk-x" })).toEqual({
      ok: true,
      provider: "openai",
      envKey: "OPENAI_API_KEY",
    });

    const missing = preflightModel("openai/gpt-5", {});
    expect(missing.ok).toBe(false);
    expect(preflightModelMessage(missing)).toMatch(/OPENAI_API_KEY/);

    const unknown = preflightModel("mystery/x", {});
    expect(unknown.ok).toBe(false);
    expect(preflightModelMessage(unknown)).toMatch(/unknown provider/);
  });

  it("resolveLlmHost prefers the gateway host, else the provider's API host", () => {
    // Gateway key present ⇒ every slug routes through the gateway host.
    expect(resolveLlmHost("anthropic/claude-opus-4.5", { AI_GATEWAY_API_KEY: "g" })).toBe(
      "ai-gateway",
    );
    // No gateway key ⇒ map the resolved provider to its public API host.
    expect(resolveLlmHost("claude-opus-4-8", {})).toBe("api.anthropic.com");
    expect(resolveLlmHost("openai/gpt-5", {})).toBe("api.openai.com");
    expect(resolveLlmHost("gemini-2.5-pro", {})).toBe("generativelanguage.googleapis.com");
    expect(resolveLlmHost("openrouter/qwen/qwen-3-235b", {})).toBe("openrouter.ai");
    // Unknown provider with no gateway key still yields a reachable default.
    expect(resolveLlmHost("mystery/model", {})).toBe("ai-gateway");
  });
});
