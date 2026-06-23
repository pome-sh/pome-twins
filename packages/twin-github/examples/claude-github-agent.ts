import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type ToolCall = {
  tool: string;
  arguments: Record<string, unknown>;
};

const env = await loadEnv(resolve("../discord/.env"));
const apiKey = process.env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const mcpUrl = process.env.GITHUB_MCP_URL ?? process.env.GITHUB_CLONE_MCP_URL ?? process.env.POME_GITHUB_MCP_URL ?? "http://127.0.0.1:3333/s/demo/mcp";
const mcpToken = process.env.GITHUB_MCP_TOKEN ?? await localSessionToken(mcpUrl);

if (!apiKey) {
  throw new Error("ANTHROPIC_API_KEY is missing. Put it in discord/.env or export it before running this agent.");
}

async function main() {
  const task = process.argv.slice(2).join(" ") || "Create a branch, push a README change, open a PR, approve it, and merge it.";
  const client = new GitHubTwinClient(mcpUrl, mcpToken);
  const tools = await client.listTools();
  const plan = await askClaudeForPlan(task, tools);
  const results: Array<{ call: ToolCall; ok: boolean; status: number; body: unknown }> = [];
  let lastPullNumber: number | undefined;

  for (const call of plan) {
    if ((call.tool === "create_pull_request_review" || call.tool === "merge_pull_request") && lastPullNumber) {
      call.arguments.pull_number = lastPullNumber;
      call.arguments.pullNumber = lastPullNumber;
    }
    const response = await client.attempt(call.tool, call.arguments);
    results.push({ call, ok: response.ok, status: response.status, body: response.body });
    if (call.tool === "create_pull_request" && response.ok && typeof (response.body as { number?: unknown }).number === "number") {
      lastPullNumber = (response.body as { number: number }).number;
    }
    if (!response.ok) break;
  }

  await client.close().catch(() => undefined);
  console.log(JSON.stringify({ task, model, mcpUrl: redactSession(mcpUrl), calls: results }, null, 2));
}

async function askClaudeForPlan(task: string, availableTools: Array<{ name: string; description: string; input_schema: unknown }>) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey!,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            "You are a tiny GitHub automation agent for a local test twin.",
            "Return only JSON: an array of {\"tool\":\"name\",\"arguments\":{}} calls.",
            "Use the owner/repo named in the task. If none is named, default to owner acme, repo api, base branch main.",
            "Use branch claude-agent-review and file claude-agent.txt for the happy path.",
            `Task: ${task}`,
            `Tools: ${JSON.stringify(availableTools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })))}`
          ].join("\n")
        }
      ]
    })
  });
  if (!response.ok) {
    throw new Error(`Claude request failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((block) => block.type === "text")?.text ?? "[]";
  return JSON.parse(stripJsonFence(text)) as ToolCall[];
}

async function loadEnv(path: string) {
  const output: Record<string, string> = {};
  const text = await readFile(path, "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    output[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return output;
}

class GitHubTwinClient {
  private sessionId: string | null = null;
  private requestId = 1;

  constructor(
    private readonly url: string,
    private readonly token?: string
  ) {}

  async listTools() {
    if (this.isJsonRpcMcp()) {
      await this.initialize();
      const result = await this.rpc("tools/list", {});
      return (result as { tools: Array<{ name: string; description: string; inputSchema?: unknown; input_schema?: unknown }> }).tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema ?? tool.input_schema
      }));
    }

    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(`${this.url.replace(/\/$/, "")}/tools`, { headers });
    if (!response.ok) throw new Error(`Tool list failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { tools: Array<{ name: string; description: string; input_schema: unknown }> };
    return body.tools;
  }

  async attempt(tool: string, args: Record<string, unknown>) {
    try {
      const body = await this.call(tool, args);
      if (isGitHubErrorEnvelope(body)) return { ok: false, status: 500, body };
      return { ok: true, status: 200, body };
    } catch (error) {
      return { ok: false, status: (error as { status?: number }).status ?? 500, body: error instanceof Error ? error.message : String(error) };
    }
  }

  private async call(tool: string, args: Record<string, unknown>) {
    if (this.isJsonRpcMcp()) {
      await this.initialize();
      return unwrapToolResult(await this.rpc("tools/call", { name: tool, arguments: args }));
    }

    const response = await fetch(`${this.url.replace(/\/$/, "")}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify({ tool, arguments: args })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`Tool call failed: ${response.status}`), { status: response.status, body });
    return body;
  }

  private isJsonRpcMcp() {
    return !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(this.url) && (this.url.endsWith("/mcp") || this.url.includes("/github/mcp"));
  }

  private async initialize() {
    if (this.sessionId) return;
    const response = await this.postRpc({
      jsonrpc: "2.0",
      id: this.requestId++,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-github-agent", version: "0.1.0" } }
    });
    this.sessionId = response.headers.get("mcp-session-id");
    if (!this.sessionId) throw new Error("MCP initialize response did not include mcp-session-id");
    await this.postRpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  private async rpc(method: string, params: Record<string, unknown>) {
    const response = await this.postRpc({ jsonrpc: "2.0", id: this.requestId++, method, params });
    const parsed = parseMcpEnvelope(await response.text());
    if (parsed.error) throw new Error(parsed.error.message ?? `MCP ${method} failed`);
    return parsed.result;
  }

  private async postRpc(body: unknown) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {})
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw Object.assign(new Error(await response.text()), { status: response.status });
    return response;
  }

  async close() {
    if (!this.sessionId || !this.isJsonRpcMcp()) return;
    await fetch(this.url, {
      method: "DELETE",
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        "mcp-session-id": this.sessionId
      }
    });
    this.sessionId = null;
  }
}

function parseMcpEnvelope(text: string) {
  if (text.trimStart().startsWith("event:")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

function unwrapToolResult(result: any) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find?.((entry: { type?: string }) => entry.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

function stripJsonFence(text: string) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function redactSession(url: string) {
  return url.replace(/runtime\/[^/]+/g, "runtime/SESSION");
}

async function localSessionToken(url: string) {
  const match = url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/s\/([^/]+)\//);
  if (!match) return undefined;
  const { sign } = await import("hono/jwt");
  const secret = process.env.TWIN_AUTH_SECRET ?? "dev-only-insecure-secret";
  return sign({ sid: match[1], team_id: "tm_example", exp: Math.floor(Date.now() / 1000) + 3600 }, secret);
}

function isGitHubErrorEnvelope(body: unknown): body is { message: string; documentation_url?: string } {
  return Boolean(
    body &&
      typeof body === "object" &&
      "message" in body &&
      typeof (body as { message?: unknown }).message === "string" &&
      "documentation_url" in body
  );
}

await main();
