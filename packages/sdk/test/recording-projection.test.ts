// SPDX-License-Identifier: Apache-2.0
//
// Optional TwinDefinition.recordingProjection: runs before redactEvent so
// twins can replace large/binary payloads with digests. Unset = no-op.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTwin, type RecorderEvent } from "../src/index.js";
import { createApp, createRecorderHandle, createRecorderStore } from "../src/server.js";
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

function digestBody(raw: string): { sha256: string; size: number } {
  return {
    sha256: createHash("sha256").update(raw).digest("hex"),
    size: Buffer.byteLength(raw),
  };
}

function projectMime(event: RecorderEvent): RecorderEvent {
  const projectValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(projectValue);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key === "raw" && typeof child === "string" ? digestBody(child) : projectValue(child);
    }
    return out;
  };
  return {
    ...event,
    request_body: projectValue(event.request_body),
    response_body: projectValue(event.response_body),
  };
}

describe("recordingProjection", () => {
  it("is a no-op when unset (existing twins unchanged)", async () => {
    const store = createRecorderStore();
    const twin = defineTwin({
      id: "no-proj",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [
        {
          name: "echo",
          description: "echo",
          schema: z.object({ raw: z.string() }),
          handler: (_d, args) => args,
          mutation: false,
        },
      ],
    });
    const app = createApp(twin, { recorder: store });
    await app.request(
      `${base}/mcp/call`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "echo", arguments: { raw: "hello-mime" } }),
      })
    );
    const event = store.events()[0]!;
    expect(event.request_body).toEqual({ tool: "echo", arguments: { raw: "hello-mime" } });
    expect(event.response_body).toEqual({ raw: "hello-mime" });
  });

  it("runs before secret redaction on handle() and record()", async () => {
    const store = createRecorderStore();
    const mime = "From: a@b.test\r\napi_key=should-never-land\r\n\r\nbody";
    const projected = digestBody(mime);

    const recorder = createRecorderHandle({
      runId: "r",
      twin: "toy",
      store,
      recordingProjection: projectMime,
    });

    const { Hono } = await import("hono");
    const app = new Hono();
    app.post(
      "/x",
      recorder.handle({ mutation: false }, () => ({
        status: 200,
        body: { raw: mime, password: "hunter2" },
      }))
    );
    await app.request("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: mime, password: "hunter2" }),
    });

    const [viaHandle] = store.events();
    expect(viaHandle!.request_body).toEqual({ raw: projected, password: "[REDACTED]" });
    expect(viaHandle!.response_body).toEqual({ raw: projected, password: "[REDACTED]" });
    expect(JSON.stringify(viaHandle)).not.toContain("should-never-land");
    expect(JSON.stringify(viaHandle)).not.toContain(mime);

    const store2 = createRecorderStore();
    const direct = createRecorderHandle({
      runId: "r",
      twin: "toy",
      store: store2,
      recordingProjection: projectMime,
    });
    direct.record({
      ts: new Date().toISOString(),
      run_id: "r",
      twin: "toy",
      request_id: "req_1",
      step_id: null,
      tool_call_id: null,
      method: "POST",
      path: "/x",
      request_body: { raw: mime, client_secret: "leak" },
      status: 200,
      response_body: null,
      latency_ms: 1,
      fidelity: "semantic",
      state_mutation: false,
      state_delta: null,
      error: null,
    });
    const [viaRecord] = store2.events();
    expect(viaRecord!.request_body).toEqual({ raw: projected, client_secret: "[REDACTED]" });
  });

  it("is wired from TwinDefinition through createApp", async () => {
    const store = createRecorderStore();
    const mime = "MIME-CANARY-payload-bytes";
    const twin = defineTwin({
      id: "with-proj",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      recordingProjection: projectMime,
      tools: [
        {
          name: "echo",
          description: "echo",
          schema: z.object({ raw: z.string() }),
          handler: (_d, args) => args,
          mutation: false,
        },
      ],
    });
    const app = createApp(twin, { recorder: store });
    await app.request(
      `${base}/mcp`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: { raw: mime } },
        }),
      })
    );
    const event = store.events().find((e) => e.path.endsWith("/mcp"))!;
    expect(event.response_body).toEqual({ raw: digestBody(mime) });
    expect(JSON.stringify(event)).not.toContain(mime);
  });
});
