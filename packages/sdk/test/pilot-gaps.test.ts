// SPDX-License-Identifier: Apache-2.0
//
// Engine gaps surfaced by the F-683 pilot port (twin-slack → thin plugin).
// Written test-first per the pilot rule: gaps are fixed in the engine, never
// by re-adding per-twin harness code.
//
//   1. ToolCallContext — tool handlers receive the authenticated session and
//      a reportDelta sink so MCP-dispatched mutations carry actor identity
//      and state_delta on the tape (parity with the per-twin mcp.ts modules).
//   2. Tool-list serialization — per-tool `annotations` (MCP readOnlyHint)
//      and a literal `inputSchema` override, emitted on BOTH tool-list
//      surfaces (legacy GET /mcp/tools and JSON-RPC tools/list).
//   3. Admin-gate envelope — `admin.forbidden` lets a twin keep its frozen
//      403 body (slack: {ok:false, error:"restricted_action"}).
//   4. Correlation/step stamping — every recorded event carries
//      correlation_id (x-pome-correlation-id header, else request_id) and
//      task_step_id/scenario_step_id from x-pome-scenario-step-id, exactly
//      like the per-twin recorders the engine replaces.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTwin, type ToolCallContext } from "../src/index.js";
import { createApp, createRecorderStore, formTokenResolver } from "../src/server.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";

const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;
beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = TEST_AUTH_SECRET;
  token = await signTestToken({ extra: { login: "alice" } });
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

const base = `/s/${TEST_SID}`;

const FROZEN_SCHEMA = {
  type: "object",
  properties: { channel_id: { type: "string" } },
  required: ["channel_id"],
  additionalProperties: false,
} as const;

function pilotTwin() {
  return defineTwin({
    id: "pilot",
    version: "0.0.1",
    fidelity: { default: "semantic" },
    domain: () => ({}),
    auth: {
      sessionExtras: (claims) => (typeof claims.login === "string" ? { login: claims.login } : {}),
    },
    tools: [
      {
        name: "who_am_i",
        description: "Echo the session actor.",
        schema: z.object({}),
        handler: (_domain, _args, ctx: ToolCallContext) => ({
          login: typeof ctx.session?.login === "string" ? ctx.session.login : null,
        }),
        mutation: false,
        annotations: { readOnlyHint: true },
        inputSchema: { ...FROZEN_SCHEMA },
      },
      {
        name: "bump",
        description: "Mutate and report a delta.",
        schema: z.object({}),
        handler: (_domain, _args, ctx: ToolCallContext) => {
          ctx.reportDelta({ before: null, after: { n: 1 } });
          return { ok: true };
        },
        mutation: true,
      },
    ],
  });
}

function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return withAuth(token, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("ToolCallContext: session + reportDelta reach tool handlers", () => {
  it("passes the authenticated session to handlers via legacy /mcp/call", async () => {
    const app = createApp(pilotTwin());
    const res = await app.request(`${base}/mcp/call`, jsonPost("/mcp/call", { tool: "who_am_i", arguments: {} }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "alice" });
  });

  it("passes the session to handlers via JSON-RPC tools/call", async () => {
    const app = createApp(pilotTwin());
    const res = await app.request(
      `${base}/mcp`,
      jsonPost("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "who_am_i", arguments: {} } })
    );
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ login: "alice" });
  });

  it("records a handler-reported delta on the event for POST /mcp/tools/:name", async () => {
    const store = createRecorderStore();
    const app = createApp(pilotTwin(), { recorder: store });
    const res = await app.request(`${base}/mcp/tools/bump`, jsonPost("/mcp/tools/bump", {}));
    expect(res.status).toBe(200);
    const event = store.events().find((e) => e.path === `${base}/mcp/tools/bump`);
    expect(event?.state_mutation).toBe(true);
    expect(event?.state_delta).toEqual({ before: null, after: { n: 1 } });
  });

  it("records a handler-reported delta on the event for legacy /mcp/call", async () => {
    const store = createRecorderStore();
    const app = createApp(pilotTwin(), { recorder: store });
    await app.request(`${base}/mcp/call`, jsonPost("/mcp/call", { tool: "bump", arguments: {} }));
    const event = store.events().find((e) => e.path === `${base}/mcp/call`);
    expect(event?.state_delta).toEqual({ before: null, after: { n: 1 } });
  });

  it("records a handler-reported delta on the event for JSON-RPC tools/call", async () => {
    const store = createRecorderStore();
    const app = createApp(pilotTwin(), { recorder: store });
    await app.request(
      `${base}/mcp`,
      jsonPost("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bump", arguments: {} } })
    );
    const event = store.events().find((e) => e.path === `${base}/mcp`);
    expect(event?.state_mutation).toBe(true);
    expect(event?.state_delta).toEqual({ before: null, after: { n: 1 } });
  });
});

describe("tool-list serialization: annotations + inputSchema override", () => {
  it("emits annotations and the literal inputSchema override on GET /mcp/tools", async () => {
    const app = createApp(pilotTwin());
    const res = await app.request(`${base}/mcp/tools`, withAuth(token));
    const body = (await res.json()) as {
      tools: Array<{ name: string; input_schema: unknown; annotations?: { readOnlyHint?: boolean } }>;
    };
    const who = body.tools.find((t) => t.name === "who_am_i")!;
    expect(who.input_schema).toEqual(FROZEN_SCHEMA);
    expect(who.annotations).toEqual({ readOnlyHint: true });
    const bump = body.tools.find((t) => t.name === "bump")!;
    expect("annotations" in bump).toBe(false);
  });

  it("emits annotations and the literal inputSchema override on JSON-RPC tools/list", async () => {
    const app = createApp(pilotTwin());
    const res = await app.request(
      `${base}/mcp`,
      jsonPost("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/list" })
    );
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean } }> };
    };
    const who = body.result.tools.find((t) => t.name === "who_am_i")!;
    expect(who.inputSchema).toEqual(FROZEN_SCHEMA);
    expect(who.annotations).toEqual({ readOnlyHint: true });
    const bump = body.result.tools.find((t) => t.name === "bump")!;
    expect("annotations" in bump).toBe(false);
  });
});

describe("admin gate: per-twin forbidden envelope", () => {
  afterEach(() => {
    delete process.env.TWIN_ADMIN_TOKEN;
  });

  function gatedTwin() {
    return defineTwin({
      id: "gated",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      admin: {
        reset: () => ({ ok: true }),
        forbidden: () => ({ status: 403, body: { ok: false, error: "restricted_action" } }),
      },
      tools: [],
    });
  }

  it("renders the twin's admin.forbidden envelope when token auth fails", async () => {
    process.env.TWIN_ADMIN_TOKEN = "gate-token";
    const app = createApp(gatedTwin());
    const missing = await app.request("/admin/reset", { method: "POST" });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ ok: false, error: "restricted_action" });
    const right = await app.request("/admin/reset", {
      method: "POST",
      headers: { "X-Admin-Token": "gate-token" },
    });
    expect(right.status).toBe(200);
  });

  it("keeps the default Forbidden envelope when the hook is absent", async () => {
    process.env.TWIN_ADMIN_TOKEN = "gate-token";
    const app = createApp(
      defineTwin({
        id: "default-gate",
        version: "0.0.1",
        fidelity: { default: "semantic" },
        domain: () => ({}),
        admin: { reset: () => ({ ok: true }) },
        tools: [],
      })
    );
    const res = await app.request("/admin/reset", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: "Forbidden" });
  });
});

describe("recorder.handle after the form token resolver consumed the body", () => {
  it("does not 500 when the request body stream was already read (form-encoded auth)", async () => {
    const store = createRecorderStore();
    const twin = defineTwin({
      id: "formy",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      auth: { tokenResolvers: [formTokenResolver("token")] },
      routes: (app, { recorder }) => {
        app.post(
          "/echo",
          recorder.handle({ mutation: false }, () => ({ status: 200, body: { ok: true } }))
        );
      },
      tools: [],
    });
    const app = createApp(twin, { recorder: store });
    const form = new URLSearchParams({ token, note: "hi" });
    const res = await app.request(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [event] = store.events();
    // The stream is gone — the tape records a null body instead of crashing.
    expect(event?.request_body).toBeNull();
    expect(event?.status).toBe(200);
  });
});

describe("correlation + task-step stamping on every recorded event", () => {
  it("stamps correlation_id and task_step_id/scenario_step_id from headers in recorder.handle", async () => {
    const store = createRecorderStore();
    const twin = defineTwin({
      id: "stamped",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      routes: (app, { recorder }) => {
        app.post(
          "/echo",
          recorder.handle({ mutation: false }, () => ({ status: 200, body: { ok: true } }))
        );
      },
      tools: [],
    });
    const app = createApp(twin, { recorder: store });
    await app.request(
      `${base}/echo`,
      jsonPost("/echo", {}, { "x-pome-correlation-id": "corr-1", "x-pome-scenario-step-id": "step-2" })
    );
    const [event] = store.events();
    expect(event?.correlation_id).toBe("corr-1");
    expect(event?.task_step_id).toBe("step-2");
    expect(event?.scenario_step_id).toBe("step-2");

    await app.request(`${base}/echo`, jsonPost("/echo", {}));
    const bare = store.events()[1];
    expect(bare?.correlation_id).toBe(bare?.request_id);
    expect(bare?.task_step_id).toBeNull();
  });

  it("stamps the same fields on JSON-RPC tools/call events", async () => {
    const store = createRecorderStore();
    const app = createApp(pilotTwin(), { recorder: store });
    await app.request(
      `${base}/mcp`,
      jsonPost(
        "/mcp",
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bump", arguments: {} } },
        { "x-pome-scenario-step-id": "step-9" }
      )
    );
    const event = store.events().find((e) => e.path === `${base}/mcp`);
    expect(event?.task_step_id).toBe("step-9");
    expect(event?.scenario_step_id).toBe("step-9");
    expect(event?.correlation_id).toBe(event?.request_id);
  });
});
