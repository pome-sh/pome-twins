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
//   * the loud-501 unsupported-route envelope,
//   * auth over the socket,
//   * chunked (streamed) request bodies and raw mixed-case header bytes
//     through node:http's header normalization.
//
// One server per file; closed in afterAll so vitest exits cleanly.

import { connect } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { toolDefinitions } from "../src/tools.js";
import { unsupportedEnvelope } from "../src/unsupported-envelope.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;

let server: ReturnType<typeof serve> | undefined;
let port: number;
let baseUrl: string;
let mcpUrl: string;
let token: string;

function seedWithPullRequest() {
  return {
    users: [
      { login: "acme", type: "Organization" as const, name: "Acme" },
      { login: "alice", type: "User" as const, name: "Alice" },
      { login: "pome-agent", type: "User" as const, name: "Pome Agent" }
    ],
    repositories: [
      {
        owner: "acme",
        name: "api",
        description: "Seeded for the socket-boundary suite.",
        default_branch: "main",
        collaborators: ["alice", "pome-agent"],
        labels: [{ name: "bug", color: "d73a4a", description: "Something is not working" }],
        files: [
          { path: "README.md", content: "# Acme\n" },
          { path: "src/index.ts", content: "export function handler() {\n  return 'ok';\n}\n" },
          { path: "src/index.ts", content: "export function handler() {\n  return 'new';\n}\n", branch: "feature/x" }
        ],
        issues: [],
        pull_requests: [
          {
            number: 1,
            title: "MCP wire-fixture PR",
            body: "Known-seeded read fixture for the socket-boundary suite.",
            head: "feature/x",
            base: "main",
            state: "open" as const,
            author: "alice"
          }
        ]
      }
    ]
  };
}

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
  const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
  await new Promise<void>((resolve, reject) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      port = info.port;
      resolve();
    });
    server.on("error", reject);
  });
  baseUrl = `http://127.0.0.1:${port}`;
  mcpUrl = `${baseUrl}/s/${TEST_SID}/mcp`;
});

afterAll(async () => {
  // vitest runs afterAll even when beforeAll rejects before serve() assigns
  // `server`; guard so the real failure isn't buried under a TypeError.
  const s = server;
  if (s) {
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
      // Undici keeps client sockets alive; drop them so close() can complete.
      (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

describe("socket boundary — real MCP SDK client over @hono/node-server", () => {
  it("completes the initialize handshake and lists all 65 tools through JSON-RPC framing", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: authHeaders() }
    });
    const client = new Client({ name: "socket-boundary", version: "0.0.1" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const serverInfo = client.getServerVersion();
      expect(serverInfo?.name).toBe("twin-github");

      const listResult = await client.listTools();
      expect(listResult.tools).toHaveLength(toolDefinitions.length);
      expect(toolDefinitions.length).toBe(65);
      expect(listResult.tools.map((t) => t.name)).toEqual(toolDefinitions.map((t) => t.name));
      for (const tool of listResult.tools) {
        expect(tool.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
      }
    } finally {
      await client.close();
    }
  });

  it("tools/call returns the seeded PR wrapped in content[] through the wire", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: authHeaders() }
    });
    const client = new Client({ name: "socket-boundary", version: "0.0.1" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const callResult = await client.callTool({
        name: "get_pull_request",
        arguments: { owner: "acme", repo: "api", pull_number: 1 }
      });
      expect(callResult.isError).toBeFalsy();
      const content = callResult.content as Array<{ type: string; text?: string }>;
      expect(content).toHaveLength(1);
      expect(content[0]!.type).toBe("text");
      const parsed = JSON.parse(content[0]!.text ?? "") as { number: number; title: string; state: string };
      expect(parsed.number).toBe(1);
      expect(parsed.title).toBe("MCP wire-fixture PR");
      expect(parsed.state).toBe("open");
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
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(response.status).toBe(401);
  });
});

describe("socket boundary — error envelopes over a real socket", () => {
  it("unknown session route returns the loud 501 unsupported envelope", async () => {
    const response = await fetch(`${baseUrl}/s/${TEST_SID}/definitely/not/a/route`, {
      headers: authHeaders()
    });
    // Pin the literal status independently of unsupportedEnvelope.status —
    // both sides would otherwise derive from the same constant and a
    // regression of the "loud 501" contract could self-verify.
    expect(response.status).toBe(501);
    expect(unsupportedEnvelope.status).toBe(501);
    const body = (await response.json()) as typeof unsupportedEnvelope.body;
    expect(body.message).toBe(unsupportedEnvelope.body.message);
    expect(body._twin.fidelity).toBe("unsupported");
    expect(body._twin.supported_surfaces).toContain("POST /s/:sid/mcp");
  });
});

describe("socket boundary — body streaming and header normalization", () => {
  it("streams a chunked request body (no Content-Length) through the bridge", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: "chunked", method: "ping" }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Two chunks to force more than one data event through the bridge.
        controller.enqueue(payload.slice(0, 10));
        controller.enqueue(payload.slice(10));
        controller.close();
      }
    });
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: stream,
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; result: unknown };
    expect(body).toEqual({ jsonrpc: "2.0", id: "chunked", result: {} });
  });

  it("normalizes mixed-case header bytes written directly to the TCP socket", async () => {
    const json = JSON.stringify({ jsonrpc: "2.0", id: "raw-socket", method: "ping" });
    const request =
      `POST /s/${TEST_SID}/mcp HTTP/1.1\r\n` +
      `HOST: 127.0.0.1:${port}\r\n` +
      `AUTHORIZATION: Bearer ${token}\r\n` +
      `CONTENT-TYPE: application/json\r\n` +
      `CONTENT-LENGTH: ${Buffer.byteLength(json)}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      json;
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(request));
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(raw.startsWith("HTTP/1.1 200")).toBe(true);
    const bodyText = raw.slice(raw.indexOf("\r\n\r\n") + 4);
    // Body may be chunked-encoded; assert on the JSON substring instead of parsing.
    expect(bodyText).toContain('"id":"raw-socket"');
    expect(bodyText).toContain('"result":{}');
  });
});
