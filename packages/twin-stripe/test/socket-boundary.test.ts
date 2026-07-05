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
//   * the JSON-RPC POST /s/:sid/mcp endpoint (FDRS-528, routes/index.ts) via
//     both the real @modelcontextprotocol/sdk Client and raw JSON-RPC framing,
//   * the 202/405 status contract for MCP notifications and GET/DELETE,
//   * JSON-RPC error framing (-32700) for malformed bytes,
//   * Stripe bracket-form-encoded request bodies over the socket,
//   * the loud-501 endpoint_not_supported envelope,
//   * auth over the socket.
//
// One server per file; closed in afterAll so vitest exits cleanly.

import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTools } from "../src/tools.js";
import { createStripeApp, TEST_SID } from "./_appHelper.js";

let server: ReturnType<typeof serve>;
let baseUrl: string;
let mcpUrl: string;
let token: string;

beforeAll(async () => {
  const twin = await createStripeApp();
  token = twin.token;
  const port = await new Promise<number>((resolve, reject) => {
    server = serve({ fetch: twin.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
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

async function rpc(message: unknown) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(message)
  });
  return response;
}

describe("socket boundary — raw JSON-RPC framing over @hono/node-server", () => {
  it("initialize echoes a supported protocolVersion and identifies twin-stripe", async () => {
    const response = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "socket-boundary", version: "0.0.1" }
      }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(body.result.serverInfo.name).toBe("twin-stripe");
  });

  it("ping round-trips with result: {}", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: "p1", method: "ping" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: "p1", result: {} });
  });

  it("tools/call retrieve_balance returns the balance wrapped in content[]", async () => {
    const response = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "retrieve_balance", arguments: {} }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { isError?: boolean; content: Array<{ type: string; text: string }> };
    };
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content).toHaveLength(1);
    expect(body.result.content[0]!.type).toBe("text");
    const parsed = JSON.parse(body.result.content[0]!.text) as { object: string };
    expect(parsed.object).toBe("balance");
  });
});

describe("socket boundary — real MCP SDK client over @hono/node-server", () => {
  it("completes the initialize handshake and lists the full tool catalog through JSON-RPC framing", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: authHeaders() }
    });
    const client = new Client({ name: "socket-boundary", version: "0.0.1" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const serverInfo = client.getServerVersion();
      expect(serverInfo?.name).toBe("twin-stripe");

      const listResult = await client.listTools();
      const catalog = listTools();
      expect(listResult.tools).toHaveLength(catalog.length);
      expect(listResult.tools.map((t) => t.name)).toEqual(catalog.map((t) => t.name));
      for (const tool of listResult.tools) {
        // MCP tools/list must expose camelCase inputSchema (mapped from the
        // legacy input_schema of listTools()).
        expect(tool.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
      }
    } finally {
      await client.close();
    }
  });
});

describe("socket boundary — status-code contract over a real socket", () => {
  it("MCP notification returns HTTP 202 with an empty body", async () => {
    const response = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
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
    const response = await fetch(`${baseUrl}/s/${TEST_SID}/v1/balance`);
    expect(response.status).toBe(401);
  });
});

describe("socket boundary — form-encoded bodies over a real socket", () => {
  it("POST /v1/payment_intents accepts Stripe bracket-form encoding", async () => {
    const form = new URLSearchParams();
    form.set("amount", "1000");
    form.set("currency", "usd");
    form.set("payment_method_types[0]", "crypto");
    // The twin requires the x402 crypto-deposit mode + a supported network;
    // the nested bracket keys also exercise formToObject's deep-path decoding
    // over the socket.
    form.set("payment_method_options[crypto][mode]", "deposit");
    form.set("payment_method_options[crypto][deposit_options][networks][0]", "base");
    const response = await fetch(`${baseUrl}/s/${TEST_SID}/v1/payment_intents`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/x-www-form-urlencoded" }),
      body: form.toString()
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      amount: number;
      currency: string;
      payment_method_types: string[];
    };
    expect(body.object).toBe("payment_intent");
    expect(body.amount).toBe(1000);
    expect(body.currency).toBe("usd");
    expect(body.payment_method_types).toEqual(["crypto"]);
  });
});

describe("socket boundary — error envelopes over a real socket", () => {
  it("unknown /v1 route returns the loud 501 endpoint_not_supported envelope", async () => {
    const response = await fetch(`${baseUrl}/s/${TEST_SID}/v1/definitely_not_a_route`, {
      headers: authHeaders()
    });
    expect(response.status).toBe(501);
    const body = (await response.json()) as {
      error: { type: string; code: string; fidelity: string; supported_surfaces: string[] };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("endpoint_not_supported");
    expect(body.error.fidelity).toBe("unsupported");
    expect(body.error.supported_surfaces).toContain("Stripe-shaped REST under /v1/*");
  });
});
