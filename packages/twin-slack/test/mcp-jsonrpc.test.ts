import { beforeAll, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/app.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { defaultSeedState } from "../src/seed.js";
import { signTestToken, TEST_AUTH_SECRET, TEST_SID } from "./_authHelper.js";

beforeAll(() => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  process.env.SLACK_DETERMINISTIC_TS = "1";
});

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  return createSlackTwinApp({ db, domain, runId: "mcp-test" });
}

async function jsonRpc(token: string, body: unknown) {
  const app = freshApp();
  const res = await app.request(`/s/${TEST_SID}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("MCP JSON-RPC dispatch", () => {
  let token: string;
  beforeAll(async () => {
    token = await signTestToken();
  });

  it("initialize echoes supported protocolVersion", async () => {
    const { status, body } = await jsonRpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });
    expect(status).toBe(200);
    expect((body as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    expect((body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("twin-slack");
  });

  it("initialize with unknown protocolVersion falls back to default", async () => {
    const { body } = await jsonRpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "9999-99-99" },
    });
    expect((body as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
  });

  it("ping returns empty result", async () => {
    const { body } = await jsonRpc(token, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect((body as { result: unknown }).result).toEqual({});
  });

  it("tools/list returns 8 tools with inputSchema", async () => {
    const { body } = await jsonRpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (body as { result: { tools: Array<{ name: string; inputSchema: unknown }> } }).result.tools;
    expect(tools.length).toBe(8);
    expect(tools.every((t) => Boolean(t.inputSchema))).toBe(true);
  });

  it("tools/call slack_list_channels returns ok:true content", async () => {
    const { body } = await jsonRpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slack_list_channels", arguments: { limit: 5 } },
    });
    const result = (body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.channels)).toBe(true);
  });

  it("tools/call unknown tool returns isError:true", async () => {
    const { body } = await jsonRpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slack_bogus", arguments: {} },
    });
    const result = (body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("unknown_tool");
  });

  it("tools/call with bad arguments returns Zod 422-shaped error", async () => {
    const { body } = await jsonRpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slack_post_message", arguments: { channel_id: "C_GENERAL" /* missing text */ } },
    });
    const result = (body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("invalid_arguments");
  });

  it("tools/call with domain TwinError returns Slack error envelope", async () => {
    const { body } = await jsonRpc(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "slack_get_user_profile", arguments: { user_id: "U_NOPE" } },
    });
    const result = (body as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("user_not_found");
  });

  it("notifications produce no response (HTTP 202)", async () => {
    const app = freshApp();
    const res = await app.request(`/s/${TEST_SID}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
  });

  it("unknown method returns -32601", async () => {
    const { body } = await jsonRpc(token, { jsonrpc: "2.0", id: 1, method: "tools/bogus" });
    expect((body as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("batch request returns array of responses", async () => {
    const app = freshApp();
    const res = await app.request(`/s/${TEST_SID}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]),
    });
    const body = (await res.json()) as Array<{ id: number; result: unknown }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    expect(body.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it("GET /mcp returns 405", async () => {
    const app = freshApp();
    const res = await app.request(`/s/${TEST_SID}/mcp`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(405);
  });

  it("DELETE /mcp returns 405", async () => {
    const app = freshApp();
    const res = await app.request(`/s/${TEST_SID}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(405);
  });

  it("tools/call slack_post_message succeeds", async () => {
    const { body } = await jsonRpc(token, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "slack_post_message", arguments: { channel_id: "C_GENERAL", text: "rpc post" } },
    });
    const result = (body as { result: { content: Array<{ text: string }> } }).result;
    const parsed = JSON.parse(result.content[0]!.text) as { ok: boolean; ts: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.ts).toMatch(/^\d+\.\d{6}$/);
  });

  it("notification-only batch returns 202 with empty body", async () => {
    const app = freshApp();
    const res = await app.request(`/s/${TEST_SID}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", method: "notifications/initialized" }]),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("parse error → JSON-RPC -32700", async () => {
    const app = freshApp();
    const res = await app.request(`/s/${TEST_SID}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "not-json",
    });
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});
