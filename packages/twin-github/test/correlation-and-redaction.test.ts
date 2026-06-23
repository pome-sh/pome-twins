// SPDX-License-Identifier: Apache-2.0
//
// FDRS-402 — recorder middleware must:
//   1. Read `x-pome-correlation-id` from incoming requests and persist it on
//      the recorded event as `tool_call_id` AND (for legacy correlator
//      compatibility) as `correlation_id`.
//   2. Apply a centralized secret redactor to request_body / response_body
//      before persisting, so events.jsonl never contains `Authorization`,
//      `token`, `api_key`, etc. payloads.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitHubCloneApp } from "../src/app.js";
import { createRecorder } from "../src/recorder.js";
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

function setupApp() {
  const recorder = createRecorder();
  const app = createGitHubCloneApp({ recorder, runId: "run_fdrs402" });
  return { app, recorder };
}

function lastEvent(events: RecorderEvent[]): RecorderEvent {
  expect(events.length).toBeGreaterThan(0);
  return events[events.length - 1]!;
}

describe("FDRS-402 — x-pome-correlation-id persistence (REST)", () => {
  it("persists header as tool_call_id AND correlation_id on a mutating REST call", async () => {
    const { app, recorder } = setupApp();
    const response = await app.request(`${base}/repos/acme/api/issues`, withAuth(token, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pome-correlation-id": "cor_test123"
      },
      body: JSON.stringify({ title: "Hello", body: "World" })
    }));
    expect(response.status).toBe(201);

    const event = lastEvent(recorder.events());
    expect(event.tool_call_id).toBe("cor_test123");
    expect(event.correlation_id).toBe("cor_test123");
  });

  it("persists header on a read REST call as well", async () => {
    const { app, recorder } = setupApp();
    const response = await app.request(`${base}/repos/acme/api`, withAuth(token, {
      headers: { "x-pome-correlation-id": "cor_readpath" }
    }));
    expect(response.status).toBe(200);

    const event = lastEvent(recorder.events());
    expect(event.tool_call_id).toBe("cor_readpath");
    expect(event.correlation_id).toBe("cor_readpath");
  });

  it("falls back to null tool_call_id when the header is absent", async () => {
    const { app, recorder } = setupApp();
    const response = await app.request(`${base}/repos/acme/api`, withAuth(token));
    expect(response.status).toBe(200);

    const event = lastEvent(recorder.events());
    expect(event.tool_call_id).toBeNull();
    // correlation_id falls back to a generated request id — non-empty, not the
    // header value. Adapter-less heuristic path stays unchanged.
    expect(event.correlation_id).toBeTruthy();
    expect(event.correlation_id).not.toBe("cor_test123");
  });
});

describe("FDRS-402 — x-pome-correlation-id persistence (MCP JSON-RPC)", () => {
  it("persists header as tool_call_id AND correlation_id when invoking a tool via MCP", async () => {
    const { app, recorder } = setupApp();
    const response = await app.request(mcp, withAuth(token, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pome-correlation-id": "cor_mcp_call"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_issue",
          arguments: { owner: "acme", repo: "api", title: "MCP", body: "via mcp" }
        }
      })
    }));
    expect(response.status).toBe(200);

    const event = lastEvent(recorder.events());
    expect(event.tool_call_id).toBe("cor_mcp_call");
    expect(event.correlation_id).toBe("cor_mcp_call");
  });
});

describe("FDRS-402 — centralized redactor on request_body / response_body", () => {
  it("redacts secret-shaped keys in the recorded request_body", async () => {
    const { app, recorder } = setupApp();
    const response = await app.request(`${base}/repos/acme/api/issues`, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Hello",
        body: "World",
        token: "tk_super_secret",
        api_key: "ak_super_secret",
        nested: { authorization: "Bearer leaked" }
      })
    }));
    expect(response.status).toBe(201);

    const event = lastEvent(recorder.events());
    const recordedRequest = event.request_body as Record<string, unknown>;
    expect(recordedRequest).toBeTruthy();
    expect(recordedRequest.token).toBe("[REDACTED]");
    expect(recordedRequest.api_key).toBe("[REDACTED]");
    expect((recordedRequest.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    // Non-secret fields are preserved verbatim.
    expect(recordedRequest.title).toBe("Hello");
    expect(recordedRequest.body).toBe("World");
  });

  it("redacts secrets in the request_body of an MCP tool call too", async () => {
    const { app, recorder } = setupApp();
    const response = await app.request(mcp, withAuth(token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "create_issue",
          arguments: {
            owner: "acme",
            repo: "api",
            title: "MCP",
            body: "via mcp",
            // Forbidden — but the recorder must not leak even if it slips through.
            access_token: "leaked_token"
          }
        }
      })
    }));
    expect(response.status).toBe(200);

    const event = lastEvent(recorder.events());
    const recordedRequest = event.request_body as { tool?: string; arguments?: Record<string, unknown> };
    expect(recordedRequest.tool).toBe("create_issue");
    const args = recordedRequest.arguments;
    expect(args).toBeTruthy();
    expect(args!.access_token).toBe("[REDACTED]");
    expect(args!.owner).toBe("acme");
  });
});
