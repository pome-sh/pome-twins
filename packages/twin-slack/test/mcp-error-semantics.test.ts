import { beforeEach, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/twin.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { defaultSeedState } from "../src/seed.js";
import { signTestToken, TEST_SID, withAuth } from "./_authHelper.js";

const base = `/s/${TEST_SID}`;

function freshApp() {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  const recorder = createRecorderStore();
  const app = createSlackTwinApp({ db, domain, recorder, runId: "mcp-err" });
  return { app, recorder };
}

describe("error semantics and recorder", () => {
  let token: string;
  beforeEach(async () => {
    token = await signTestToken();
  });

  it("unsupported endpoint returns 501 with fidelity metadata", async () => {
    const { app } = freshApp();
    const res = await app.request(`${base}/admin.users.list`, withAuth(token, {}));
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; _twin: { fidelity: string } };
    expect(body.error).toBe("unsupported_endpoint");
    expect(body._twin.fidelity).toBe("unsupported");
  });

  it("MCP tools/call unknown tool returns error result without 500", async () => {
    const { app } = freshApp();
    const res = await app.request(
      `${base}/mcp`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "not_a_real_tool", arguments: {} },
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
  });

  it("MCP tools/call ZodError → isError:true with response_metadata.messages", async () => {
    const { app } = freshApp();
    const res = await app.request(
      `${base}/mcp`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          // missing required channel_id and text
          params: { name: "slack_post_message", arguments: {} },
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    const text = JSON.parse(body.result.content[0]!.text) as {
      ok: boolean;
      error: string;
      response_metadata?: { messages: string[] };
    };
    expect(text.ok).toBe(false);
    expect(text.error).toBe("invalid_arguments");
    expect(text.response_metadata?.messages.length).toBeGreaterThan(0);
  });

  it("MCP tools/call TwinError → isError:true with Slack envelope shape", async () => {
    const { app } = freshApp();
    const res = await app.request(
      `${base}/mcp`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "slack_post_message", arguments: { channel_id: "C_NONEXIST", text: "x" } },
        }),
      })
    );
    const body = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    const text = JSON.parse(body.result.content[0]!.text) as { ok: boolean; error: string };
    expect(text.ok).toBe(false);
    expect(text.error).toBe("channel_not_found");
  });

  it("MCP method-not-found returns JSON-RPC -32601", async () => {
    const { app } = freshApp();
    const res = await app.request(
      `${base}/mcp`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "nonexistent/method" }),
      })
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });
});
