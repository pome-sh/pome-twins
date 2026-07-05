// SPDX-License-Identifier: Apache-2.0
//
// Socket-boundary characterization suite (FDRS-603).
//
// Every other HTTP test in this package drives Hono via `app.request()` — a
// synthetic web Request that never touches @hono/node-server's
// IncomingMessage→Request translation, header normalization, body streaming,
// or socket teardown. This suite boots the twin through the ACTUAL
// `serve()` bridge on an ephemeral port (port: 0 — vitest workers run in
// parallel; never a fixed port) and characterizes the wire contract:
//
//   * real @modelcontextprotocol/sdk Client over StreamableHTTPClientTransport
//     (promoted from scripts/validate-mcp.ts, which stays as a manual script),
//   * the 202/405 status contract for MCP notifications and GET/DELETE,
//   * JSON-RPC error framing (-32700) for malformed bytes,
//   * form-urlencoded request bodies over the socket (Slack's native encoding),
//   * Slack's HTTP-200 {ok:false} application-error envelope,
//   * the loud-501 unsupported-endpoint envelope,
//   * auth over the socket.
//
// One server per file; closed in afterAll so vitest exits cleanly.

import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSlackTwinApp } from "../src/app.js";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain.js";
import { defaultSeedState } from "../src/seed.js";
import { toolDefinitions } from "../src/tools.js";
import { unsupportedEnvelope } from "../src/unsupported-envelope.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken } from "./_authHelper.js";

let server: ReturnType<typeof serve>;
let baseUrl: string;
let mcpUrl: string;
let token: string;

beforeAll(async () => {
  // test/setup.ts already pins TWIN_AUTH_SECRET + SLACK_DETERMINISTIC_TS;
  // re-assert the secret so this file also works standalone.
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();

  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed(defaultSeedState());
  const app = createSlackTwinApp({ db, domain });

  const port = await new Promise<number>((resolve, reject) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
    server.on("error", reject);
  });
  baseUrl = `http://127.0.0.1:${port}`;
  mcpUrl = `${baseUrl}/s/${TEST_SID}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    // Undici keeps client sockets alive; drop them so close() can complete.
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  });
});

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

describe("socket boundary — real MCP SDK client over @hono/node-server", () => {
  it("completes the initialize handshake and lists the 8 agent tools through JSON-RPC framing", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: authHeaders() }
    });
    const client = new Client({ name: "socket-boundary", version: "0.0.1" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const serverInfo = client.getServerVersion();
      expect(serverInfo?.name).toBe("twin-slack");

      const listResult = await client.listTools();
      expect(listResult.tools).toHaveLength(toolDefinitions.length);
      expect(listResult.tools.map((t) => t.name)).toEqual(toolDefinitions.map((t) => t.name));
    } finally {
      await client.close();
    }
  });

  it("tools/call round-trips read and write tools through the wire", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: authHeaders() }
    });
    const client = new Client({ name: "socket-boundary", version: "0.0.1" }, { capabilities: {} });
    try {
      await client.connect(transport);

      const listRes = await client.callTool({ name: "slack_list_channels", arguments: { limit: 10 } });
      expect(listRes.isError).toBeFalsy();
      const listContent = listRes.content as Array<{ type: string; text?: string }>;
      expect(listContent[0]!.type).toBe("text");
      const channels = JSON.parse(listContent[0]!.text ?? "") as {
        ok: boolean;
        channels: Array<{ id: string }>;
      };
      expect(channels.ok).toBe(true);
      expect(channels.channels.map((ch) => ch.id)).toContain("C_GENERAL");

      const postRes = await client.callTool({
        name: "slack_post_message",
        arguments: { channel_id: "C_GENERAL", text: "via socket-boundary suite" }
      });
      expect(postRes.isError).toBeFalsy();
      const postContent = postRes.content as Array<{ type: string; text?: string }>;
      const posted = JSON.parse(postContent[0]!.text ?? "") as {
        ok: boolean;
        message?: { text: string };
      };
      expect(posted.ok).toBe(true);
      expect(posted.message?.text).toBe("via socket-boundary suite");
    } finally {
      await client.close();
    }
  });
});

describe("socket boundary — status-code contract over a real socket", () => {
  it("MCP notification returns HTTP 202 with an empty body", async () => {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("GET and DELETE on /mcp return 405 with Allow: POST (stateless mode)", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const response = await fetch(mcpUrl, { method, headers: authHeaders() });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      const body = (await response.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32601);
    }
  });

  it("malformed JSON bytes return JSON-RPC -32700 with HTTP 200", async () => {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: "{ not json"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("requests without a bearer token are rejected with 401 over the socket", async () => {
    const response = await fetch(`${baseUrl}/s/${TEST_SID}/auth.test`, { method: "POST" });
    expect(response.status).toBe(401);
  });
});

describe("socket boundary — form-encoded bodies over a real socket", () => {
  it("chat.postMessage accepts an application/x-www-form-urlencoded body", async () => {
    const response = await fetch(`${baseUrl}/s/${TEST_SID}/chat.postMessage`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ channel: "C_GENERAL", text: "form body over a real socket" }).toString()
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; channel: string; message?: { text: string } };
    expect(body.ok).toBe(true);
    expect(body.channel).toBe("C_GENERAL");
    expect(body.message?.text).toBe("form body over a real socket");
  });

  it("application errors keep Slack semantics: HTTP 200 with {ok:false, error}", async () => {
    const response = await fetch(`${baseUrl}/s/${TEST_SID}/conversations.info`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ channel: "C_DOES_NOT_EXIST" }).toString()
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("channel_not_found");
  });
});

describe("socket boundary — error envelopes over a real socket", () => {
  it("unknown session route returns the loud 501 unsupported envelope", async () => {
    const response = await fetch(`${baseUrl}/s/${TEST_SID}/definitely.not.a.method`, {
      method: "POST",
      headers: authHeaders()
    });
    expect(response.status).toBe(unsupportedEnvelope.status);
    const body = (await response.json()) as typeof unsupportedEnvelope.body;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("unsupported_endpoint");
    expect(body._twin.fidelity).toBe("unsupported");
    expect(body._twin.supported_surfaces).toContain("chat.postMessage");
  });
});
