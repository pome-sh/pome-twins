import { sign } from "hono/jwt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../../src/twin/githubCloneAdapter.js";

const TEST_AUTH_SECRET = "test-secret-32-chars-minimum-length";
const TEST_SID = "adapter-session";
const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await sign(
    { sid: TEST_SID, team_id: "tm_test", exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_AUTH_SECRET
  );
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

describe("github_clone adapter", () => {
  it("loads the new GitHub clone and exposes REST plus MCP surfaces", async () => {
    const app = (await createGitHubCloneApp()) as { request: (url: string, init?: RequestInit) => Promise<Response> | Response };

    const health = await app.request("/healthz");
    expect(health.status).toBe(200);

    const toolsResponse = await app.request(`/s/${TEST_SID}/mcp/tools`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const tools = (await toolsResponse.json()) as { tools: Array<{ name: string }> };
    expect(tools.tools).toHaveLength(37);
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain("merge_pull_request");
    expect(toolNames).toContain("create_commit_status");
    expect(toolNames).toContain("create_check_run");
  });

  it("serves real MCP JSON-RPC at POST /s/:sid/mcp (initialize, tools/list, tools/call)", async () => {
    const app = (await createGitHubCloneApp()) as { request: (url: string, init?: RequestInit) => Promise<Response> | Response };
    const url = `/s/${TEST_SID}/mcp`;
    const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };

    // initialize
    const initRes = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    });
    expect(initRes.status).toBe(200);
    const initJson = (await initRes.json()) as { jsonrpc: string; id: number; result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(initJson.jsonrpc).toBe("2.0");
    expect(initJson.id).toBe(1);
    expect(initJson.result.protocolVersion).toBe("2025-06-18");
    expect(initJson.result.serverInfo.name).toBe("twin-github");

    // notifications/initialized → 202 empty body
    const notifRes = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });
    expect(notifRes.status).toBe(202);

    // tools/list → 37 tools with camelCase inputSchema
    const listRes = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    });
    const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    expect(listJson.result.tools).toHaveLength(37);
    expect(listJson.result.tools[0]).toHaveProperty("inputSchema");
    expect(listJson.result.tools[0]).not.toHaveProperty("input_schema");

    // tools/call → result.content with JSON text
    const callRes = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_repositories", arguments: { q: "" } }
      })
    });
    const callJson = (await callRes.json()) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
    expect(callJson.result.isError).toBeUndefined();
    expect(callJson.result.content[0].type).toBe("text");
    expect(() => JSON.parse(callJson.result.content[0].text)).not.toThrow();

    // unknown tool → isError true, not JSON-RPC error
    const unknownRes = await app.request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {} }
      })
    });
    const unknownJson = (await unknownRes.json()) as { result: { isError: boolean } };
    expect(unknownJson.result.isError).toBe(true);

    // GET → 405
    const getRes = await app.request(url, { method: "GET", headers });
    expect(getRes.status).toBe(405);
  });
});
