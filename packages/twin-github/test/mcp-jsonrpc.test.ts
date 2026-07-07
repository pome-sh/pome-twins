// SPDX-License-Identifier: Apache-2.0
//
// Wire-protocol tests for the real MCP JSON-RPC endpoint at /s/:sid/mcp.
// Uses Hono's `app.request()` directly (web-fetch); no Node server needed
// because the handler is hand-rolled on web primitives.
//
// Real `@modelcontextprotocol/sdk` Client interop is exercised by the
// `scripts/validate-mcp.ts` validation script (booted via @hono/node-server).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/twin.js";
import { createRecorderStore } from "@pome-sh/sdk/server";
import { toolDefinitions } from "../src/tools.js";
import type { RecorderEvent } from "@pome-sh/shared-types";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken();
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;
const mcp = `${base}/mcp`;

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
        description: "Seeded for MCP JSON-RPC tests.",
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
            body: "Used as a known-seeded read fixture for the MCP JSON-RPC tests.",
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

async function rpc(app: ReturnType<typeof createGitHubCloneApp>, message: unknown, authToken = token) {
  return app.request(mcp, withAuth(authToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message)
  }));
}

describe("MCP JSON-RPC — /s/:sid/mcp", () => {
  it("rejects requests without a bearer token (auth middleware applies)", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await app.request(mcp, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(response.status).toBe(401);
  });

  it("handles initialize and echoes a supported protocolVersion", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" }
      }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(body.result.serverInfo.name).toBe("twin-github");
  });

  it("returns HTTP 202 with empty body for notifications", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await rpc(app, {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("handles ping with result: {}", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await rpc(app, { jsonrpc: "2.0", id: "p1", method: "ping" });
    const body = (await response.json()) as any;
    expect(body).toEqual({ jsonrpc: "2.0", id: "p1", result: {} });
  });

  it("tools/list returns all 62 tools with camelCase inputSchema", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = (await response.json()) as any;
    expect(body.result.tools).toHaveLength(toolDefinitions.length);
    expect(toolDefinitions.length).toBe(62);
    expect(body.result.tools.map((t: any) => t.name)).toEqual(toolDefinitions.map((t) => t.name));
    for (const tool of body.result.tools) {
      expect(tool).toHaveProperty("inputSchema");
      expect(tool).not.toHaveProperty("input_schema");
      expect(tool.inputSchema).toEqual(expect.objectContaining({ type: "object" }));
    }
  });

  it("tools/call wraps domain result in content[]", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_pull_request",
        arguments: { owner: "acme", repo: "api", pull_number: 1 }
      }
    });
    const body = (await response.json()) as any;
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content).toHaveLength(1);
    expect(body.result.content[0].type).toBe("text");
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.title).toBe("MCP wire-fixture PR");
    expect(parsed.number).toBe(1);
    expect(parsed.state).toBe("open");
  });

  it("tools/call passes the authenticated actor to get_me", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const aliceToken = await signTestToken({ login: "alice" });
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: "me",
      method: "tools/call",
      params: {
        name: "get_me",
        arguments: {}
      }
    }, aliceToken);
    const body = (await response.json()) as any;
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.login).toBe("alice");
  });

  it("tools/call returns isError for an unknown tool", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {} }
    });
    const body = (await response.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).message).toMatch(/Unknown tool/);
  });

  it("tools/call returns isError when the domain throws (PR not found)", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "get_pull_request",
        arguments: { owner: "acme", repo: "api", pull_number: 9999 }
      }
    });
    const body = (await response.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).message).toMatch(/not found/i);
  });

  it("tools/call returns isError on Zod validation failure", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await rpc(app, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "get_pull_request",
        arguments: { owner: "acme" } // missing repo, pull_number
      }
    });
    const body = (await response.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text).message).toBe("Validation Failed");
  });

  it("unknown JSON-RPC method returns -32601", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await rpc(app, { jsonrpc: "2.0", id: 7, method: "resources/list" });
    const body = (await response.json()) as any;
    expect(body.error.code).toBe(-32601);
  });

  it("malformed JSON returns -32700", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await app.request(mcp, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json"
    }));
    const body = (await response.json()) as any;
    expect(body.error.code).toBe(-32700);
  });

  it("batch: notifications are swallowed, requests respond in order", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await rpc(app, [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 10, method: "ping" },
      { jsonrpc: "2.0", id: 11, method: "tools/list" }
    ]);
    const body = (await response.json()) as any[];
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe(10);
    expect(body[1].id).toBe(11);
    expect(body[1].result.tools).toHaveLength(toolDefinitions.length);
  });

  it("batch of only notifications returns HTTP 202", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const response = await rpc(app, [
      { jsonrpc: "2.0", method: "notifications/initialized" }
    ]);
    expect(response.status).toBe(202);
  });

  it("GET and DELETE on /mcp return 405 (stateless mode)", async () => {
    const app = createGitHubCloneApp({ seed: seedWithPullRequest() });
    const getResp = await app.request(mcp, withAuth(token, { method: "GET" }));
    expect(getResp.status).toBe(405);
    const delResp = await app.request(mcp, withAuth(token, { method: "DELETE" }));
    expect(delResp.status).toBe(405);
  });
});

describe("MCP JSON-RPC — recorder parity with /mcp/call", () => {
  function setup() {
    const recorder = createRecorderStore();
    const app = createGitHubCloneApp({
      recorder,
      runId: "run_mcp_jsonrpc_test",
      seed: seedWithPullRequest()
    });
    return { app, recorder };
  }

  async function callViaMcp(app: ReturnType<typeof createGitHubCloneApp>, name: string, args: unknown) {
    return app.request(mcp, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    }));
  }

  async function callViaLegacy(app: ReturnType<typeof createGitHubCloneApp>, name: string, args: unknown) {
    return app.request(`${base}/mcp/call`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: name, arguments: args })
    }));
  }

  it("tools/call records the same field set as /mcp/call (read path)", async () => {
    const { app, recorder } = setup();
    const args = { owner: "acme", repo: "api", pull_number: 1 };

    const legacyResp = await callViaLegacy(app, "get_pull_request", args);
    expect(legacyResp.status).toBe(200);
    const mcpResp = await callViaMcp(app, "get_pull_request", args);
    expect(mcpResp.status).toBe(200);

    const events = recorder.events();
    expect(events).toHaveLength(2);
    const [legacyEvent, mcpEvent] = events as [RecorderEvent, RecorderEvent];

    // Identical field set.
    expect(new Set(Object.keys(mcpEvent))).toEqual(new Set(Object.keys(legacyEvent)));

    // Identical canonical fields.
    expect(mcpEvent.method).toBe(legacyEvent.method);
    expect(mcpEvent.status).toBe(legacyEvent.status);
    expect(mcpEvent.state_mutation).toBe(legacyEvent.state_mutation);
    expect(mcpEvent.state_delta).toEqual(legacyEvent.state_delta);
    expect(mcpEvent.fidelity).toBe(legacyEvent.fidelity);
    expect(mcpEvent.error).toBe(legacyEvent.error);
    expect(mcpEvent.request_body).toEqual(legacyEvent.request_body);
    expect(mcpEvent.response_body).toEqual(legacyEvent.response_body);

    // Paths differ by surface — that's the only intentional divergence.
    expect(legacyEvent.path).toBe(`${base}/mcp/call`);
    expect(mcpEvent.path).toBe(`${base}/mcp`);
  });

  it("tools/call records mutating tools with state_mutation=true + state_delta", async () => {
    const { app, recorder } = setup();
    const response = await callViaMcp(app, "create_issue", {
      owner: "acme",
      repo: "api",
      title: "via MCP"
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.result.isError).toBeUndefined();

    const event = recorder.events().at(-1)!;
    expect(event.state_mutation).toBe(true);
    expect(event.state_delta).not.toBeNull();
    expect((event.state_delta as any).after).toMatchObject({ title: "via MCP" });
    expect(event.request_body).toEqual({
      tool: "create_issue",
      arguments: { owner: "acme", repo: "api", title: "via MCP" }
    });
  });

  it("tools/call records error responses with status and error message", async () => {
    const { app, recorder } = setup();
    await callViaMcp(app, "get_pull_request", { owner: "acme", repo: "api", pull_number: 9999 });
    const event = recorder.events().at(-1)!;
    expect(event.status).toBe(404);
    expect(event.error).toMatch(/not found/i);
    expect(event.state_mutation).toBe(false);
    expect(event.state_delta).toBeNull();
  });
});
