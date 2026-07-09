// SPDX-License-Identifier: Apache-2.0
//
// Minimal Slack-twin agent example.
//
// Asks Claude to plan a small Slack-flavored workflow (list channels, post a
// message, react, walk the thread, read history) and executes each tool
// call against the local twin's MCP JSON-RPC endpoint via
// @modelcontextprotocol/sdk's Client. Mirrors the shape of
// twin-github/examples/claude-github-agent.ts but uses the 8 visible Slack
// MCP tools.
//
// Run:
//   TWIN_AUTH_SECRET=dev-only-insecure-secret SLACK_DETERMINISTIC_TS=1 npm run dev   # in another terminal
//   ANTHROPIC_API_KEY=sk-... npm run agent:claude -- "post a hello to #general and react :rocket:"

import { sign } from "hono/jwt";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type ToolCall = { tool: string; arguments: Record<string, unknown> };

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const MCP_URL = process.env.SLACK_CLONE_MCP_URL ?? "http://127.0.0.1:3333/s/demo/mcp";
const AUTH_SECRET = process.env.TWIN_AUTH_SECRET ?? "dev-only-insecure-secret";

if (!ANTHROPIC_KEY) {
  throw new Error("Set ANTHROPIC_API_KEY before running this agent.");
}

const task = process.argv.slice(2).join(" ") || "Post a friendly hello message to #general, react :wave:, then read the channel history.";

const sidMatch = new URL(MCP_URL).pathname.match(/^\/s\/([^/]+)/);
if (!sidMatch?.[1]) throw new Error(`MCP URL must include /s/<sid>: got ${MCP_URL}`);
const sid = sidMatch[1];

const token = await sign(
  { sid, team_id: "tm_local", login: "pome-agent", exp: Math.floor(Date.now() / 1000) + 3600 },
  AUTH_SECRET
);

const client = new Client({ name: "claude-slack-agent", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));

console.log(`Connected — ${tools.length} tools available against ${MCP_URL}`);

const planResp = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": ANTHROPIC_KEY,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 1024,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          "You are a tiny Slack automation agent for a local test twin.",
          "Return ONLY JSON: an array of {\"tool\":\"name\",\"arguments\":{}} calls.",
          "Use channel_id 'C_GENERAL' unless the task names another channel.",
          "Use the slack_post_message tool for posting; slack_add_reaction for reactions;",
          "slack_get_channel_history / slack_list_channels for reads.",
          `Task: ${task}`,
          `Tools: ${JSON.stringify(tools)}`,
        ].join("\n"),
      },
    ],
  }),
});
if (!planResp.ok) throw new Error(`Claude planning request failed: ${planResp.status} ${await planResp.text()}`);
const planData = (await planResp.json()) as { content?: Array<{ type: string; text?: string }> };
const planText = planData.content?.find((b) => b.type === "text")?.text ?? "[]";
const plan = JSON.parse(planText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")) as ToolCall[];

console.log(`Plan: ${plan.length} call(s)`);

const results: Array<{ call: ToolCall; ok: boolean; body: unknown }> = [];
for (const call of plan) {
  const res = await client.callTool({ name: call.tool, arguments: call.arguments });
  const isError = (res as { isError?: boolean }).isError === true;
  const body = parseToolBody(res);
  results.push({ call, ok: !isError, body });
  console.log(`  → ${call.tool} ${isError ? "ERR" : "OK"}: ${JSON.stringify(body).slice(0, 120)}`);
  if (isError) break;
}

await client.close();

console.log(JSON.stringify({ task, model: MODEL, mcpUrl: redact(MCP_URL), calls: results }, null, 2));

function parseToolBody(result: unknown): unknown {
  const r = result as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = r.content?.find((b) => b.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

function redact(url: string): string {
  return url.replace(/\/s\/[^/]+\//, "/s/<sid>/");
}
