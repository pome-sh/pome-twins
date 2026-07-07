// SPDX-License-Identifier: Apache-2.0
// End-to-end smoke test: boots the twin in-process, calls auth.test +
// conversations.list + chat.postMessage + conversations.history + MCP list +
// MCP call, asserts envelope shapes, exits non-zero on any failure.
import { sign } from "hono/jwt";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { defaultSeedState } from "../src/seed.js";

process.env.TWIN_AUTH_SECRET = process.env.TWIN_AUTH_SECRET ?? "smoke-secret-32-chars-minimum-length";
process.env.SLACK_DETERMINISTIC_TS = "1";

const SID = "smoke-session";
const TEAM = "tm_smoke";
const LOGIN = "pome-agent";

const db = openSlackTwinDatabase(":memory:");
const domain = new SlackDomain(db);
domain.seed(defaultSeedState());
const recorder = createRecorderStore();
const app = createSlackTwinApp({ db, domain, recorder, runId: "smoke" });

const exp = Math.floor(Date.now() / 1000) + 3600;
const token = await sign({ sid: SID, team_id: TEAM, login: LOGIN, exp }, process.env.TWIN_AUTH_SECRET);

async function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await app.request(`/s/${SID}${path}`, { ...init, headers });
  const body = await res.json();
  return { status: res.status, body };
}

function assert(condition: unknown, message: string) {
  if (!condition) {
    console.error("FAIL:", message);
    process.exitCode = 1;
  } else {
    console.log("OK:", message);
  }
}

// 1. Root healthz (no auth).
{
  const res = await app.request("/healthz");
  const body = (await res.json()) as Record<string, unknown>;
  assert(res.status === 200, "GET /healthz returns 200");
  assert(body.twin === "slack", "healthz reports twin=slack");
  assert(body.tools === 8, "healthz reports 8 tools");
}

// 2. auth.test
{
  const { status, body } = await call("/auth.test");
  assert(status === 200, "auth.test 200");
  assert((body as { ok: boolean }).ok === true, "auth.test ok=true");
  assert((body as { team_id: string }).team_id === "T_POME", "auth.test team_id=T_POME");
  assert((body as { user_id: string }).user_id === "U_PRIMARY", "auth.test user_id=U_PRIMARY");
}

// 3. conversations.list
{
  const { status, body } = await call("/conversations.list");
  assert(status === 200, "conversations.list 200");
  const channels = (body as { channels: Array<{ id: string; name: string }> }).channels;
  assert(channels.length === 2, `conversations.list returns 2 channels (got ${channels.length})`);
  assert(channels.some((c) => c.id === "C_GENERAL"), "list contains C_GENERAL");
}

// 4. chat.postMessage (form-encoded)
let postedTs = "";
{
  const { status, body } = await call("/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ channel: "C_GENERAL", text: "hello from smoke" }).toString(),
  });
  assert(status === 200, "chat.postMessage 200");
  const ok = (body as { ok: boolean; ts: string }).ok === true;
  assert(ok, "chat.postMessage ok=true");
  postedTs = (body as { ts: string }).ts;
  assert(/^\d+\.\d{6}$/.test(postedTs), `chat.postMessage ts shape ok (${postedTs})`);
}

// 5. conversations.history shows the posted message
{
  const { body } = await call(`/conversations.history?channel=C_GENERAL&limit=10`);
  const messages = (body as { messages: Array<{ ts: string; text: string }> }).messages;
  assert(messages.length >= 3, `history has ≥3 messages (got ${messages.length})`);
  assert(messages.some((m) => m.ts === postedTs && m.text === "hello from smoke"), "history contains the posted message");
}

// 6. reactions.add
{
  const { status, body } = await call("/reactions.add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "C_GENERAL", timestamp: postedTs, name: "thumbsup" }),
  });
  assert(status === 200, "reactions.add 200");
  assert((body as { ok: boolean }).ok === true, "reactions.add ok=true");
}

// 7. conversations.replies on a non-existent ts → thread_not_found
{
  const { status, body } = await call("/conversations.replies?channel=C_GENERAL&ts=9999999999.999999");
  assert(status === 404, "conversations.replies non-existent returns 404");
  assert((body as { error: string }).error === "thread_not_found", "error=thread_not_found");
}

// 8. Thread reply flow
let threadParentTs = "";
{
  const post = await call("/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "C_GENERAL", text: "thread parent" }),
  });
  threadParentTs = (post.body as { ts: string }).ts;
  await call("/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "C_GENERAL", text: "reply 1", thread_ts: threadParentTs }),
  });
  await call("/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "C_GENERAL", text: "reply 2", thread_ts: threadParentTs }),
  });
  const { status, body } = await call(`/conversations.replies?channel=C_GENERAL&ts=${threadParentTs}`);
  assert(status === 200, "conversations.replies 200");
  const msgs = (body as { messages: Array<{ ts: string }> }).messages;
  assert(msgs.length === 3, `replies returns 3 (parent + 2 replies) (got ${msgs.length})`);
}

// 9. MCP list-tools (legacy)
{
  const { status, body } = await call("/mcp/tools");
  assert(status === 200, "GET /mcp/tools 200");
  const tools = (body as { tools: Array<{ name: string }> }).tools;
  assert(tools.length === 8, `8 tools listed (got ${tools.length})`);
  assert(tools.every((t) => t.name.startsWith("slack_")), "all tools prefixed slack_");
}

// 10. MCP JSON-RPC tools/list
{
  const res = await app.request(`/s/${SID}/mcp`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await res.json()) as { result: { tools: Array<{ name: string; inputSchema: { additionalProperties: false } }> } };
  assert(res.status === 200, "MCP tools/list 200");
  assert(body.result.tools.length === 8, "MCP lists 8 tools");
  assert(body.result.tools.every((t) => t.inputSchema?.additionalProperties === false), "all tools have additionalProperties:false");
}

// 11. MCP tools/call
{
  const res = await app.request(`/s/${SID}/mcp`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "slack_list_channels", arguments: { limit: 10 } },
    }),
  });
  const body = (await res.json()) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
  assert(res.status === 200, "MCP tools/call 200");
  assert(!body.result.isError, "MCP tools/call success (isError absent)");
  const parsed = JSON.parse(body.result.content[0]!.text);
  assert(parsed.ok === true, "MCP tool result has ok:true");
  assert(Array.isArray(parsed.channels), "MCP tool result has channels array");
}

// 12. users.profile.get
{
  const { status, body } = await call("/users.profile.get?user=U_ALICE");
  assert(status === 200, "users.profile.get 200");
  assert((body as { profile: { display_name: string } }).profile.display_name === "Alice", "profile display_name=Alice");
}

// 13. State export
{
  const { status, body } = await call("/_pome/state");
  assert(status === 200, "_pome/state 200");
  const state = body as { workspace: { id: string }; channels: unknown[] };
  assert(state.workspace.id === "T_POME", "state workspace id=T_POME");
  assert(state.channels.length === 2, "state has 2 channels");
}

// 14. Events recorded
{
  const { body } = await call("/_pome/events");
  const events = body as Array<{ method: string; status: number; state_mutation: boolean; state_delta: unknown }>;
  assert(events.length > 0, "events recorded");
  const post = events.find((e) => e.method === "POST" && e.status === 200 && e.state_mutation);
  assert(Boolean(post), "at least one mutation event captured");
  assert(post?.state_delta !== null, "mutation event has non-null state_delta");
}

// 15. Form-encoded → conversations.list (POST)
{
  const res = await app.request(`/s/${SID}/conversations.list`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ limit: "5" }).toString(),
  });
  assert(res.status === 200, "POST form conversations.list 200");
  const body = (await res.json()) as { channels: unknown[] };
  assert(body.channels.length > 0, "POST form list returns channels");
}

// 16. Catch-all 501 for unsupported endpoint
{
  const { status, body } = await call("/admin.users.list");
  assert(status === 501, `catch-all returns 501 (got ${status})`);
  assert((body as { error: string }).error === "unsupported_endpoint", "catch-all error=unsupported_endpoint");
}

if (process.exitCode) {
  console.error("\nsmoke FAILED");
} else {
  console.log("\nsmoke PASSED");
}
