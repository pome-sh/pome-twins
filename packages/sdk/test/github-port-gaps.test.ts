// SPDX-License-Identifier: Apache-2.0
//
// Engine gaps surfaced by the F-682 port (twin-github → thin plugin).
// Written test-first per the pilot rule: gaps are fixed in the engine, never
// by re-adding per-twin harness code.
//
//   1. 204 responses — recorder.handle must answer a `{status: 204, body:
//      null}` result with an empty-body 204 (Response forbids a body on
//      null-body statuses; c.json(null, 204) used to surface as a 500).
//      github's frozen surface has several 204 routes (branch/milestone/
//      comment deletes, the collaborator-membership check).
//   2. tool_call_id stamping (FDRS-402 adapter-rich path) — github's frozen
//      tape persists the incoming x-pome-correlation-id as `tool_call_id` on
//      every recorded event. Declarative per twin: slack's frozen tape
//      stamps null (engine default).
//   3. pomeHealth extras — a twin with a frozen `/s/:sid/_pome/health` shape
//      (github: implementation/fidelity/runtime, no version) replaces the
//      engine default `{version, fidelity}` extras.
//   4. pomeRoutes — extra per-twin GET routes under the reserved `/_pome/*`
//      session namespace (github's frozen GET /s/:sid/_pome/access-control).
//      Core names (health/state/events) stay engine-owned.
//   5. mcpUnknownTool — the JSON-RPC tools/call unknown-tool result body is
//      frozen per twin: github pins the pre-port `{message: "Unknown tool:
//      <name>"}` text while its legacy /mcp/call surface keeps the 422
//      validation envelope from `errorEnvelope`.
//   6. admin reportDelta — /admin/reset and /admin/seed handlers can report
//      a state delta recorded on the event (github's frozen tape recorded
//      the seed delta on admin mutations).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTwin } from "../src/index.js";
import { createApp, createRecorderStore } from "../src/server.js";
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

function jsonPost(body: unknown, headers: Record<string, string> = {}) {
  return withAuth(token, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("recorder.handle answers 204 results with an empty body", () => {
  function twin204() {
    return defineTwin({
      id: "nocontent",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      routes: (app, { recorder }) => {
        app.delete(
          "/thing",
          recorder.handle({ mutation: false }, () => ({
            status: 204,
            body: null,
            mutation: true,
            delta: { before: { n: 1 }, after: null },
          }))
        );
      },
      tools: [],
    });
  }

  it("returns HTTP 204 with an empty body instead of a 500", async () => {
    const store = createRecorderStore();
    const app = createApp(twin204(), { recorder: store });
    const res = await app.request(`${base}/thing`, withAuth(token, { method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const [event] = store.events();
    expect(event?.status).toBe(204);
    expect(event?.state_mutation).toBe(true);
    expect(event?.state_delta).toEqual({ before: { n: 1 }, after: null });
  });
});

describe("tool_call_id stamping is a per-twin pin (FDRS-402)", () => {
  function stampedTwin(stampToolCallId: boolean) {
    return defineTwin({
      id: "stampy",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      ...(stampToolCallId ? { stampToolCallId } : {}),
      routes: (app, { recorder }) => {
        app.post(
          "/echo",
          recorder.handle({ mutation: false }, () => ({ status: 200, body: { ok: true } }))
        );
      },
      tools: [
        {
          name: "noop",
          description: "No-op tool.",
          schema: z.object({}),
          handler: () => ({ ok: true }),
          mutation: false,
        },
      ],
    });
  }

  it("stamps x-pome-correlation-id as tool_call_id on REST events when pinned", async () => {
    const store = createRecorderStore();
    const app = createApp(stampedTwin(true), { recorder: store });
    await app.request(`${base}/echo`, jsonPost({}, { "x-pome-correlation-id": "cor_1" }));
    const [event] = store.events();
    expect(event?.tool_call_id).toBe("cor_1");
    expect(event?.correlation_id).toBe("cor_1");
  });

  it("falls back to null tool_call_id when the header is absent", async () => {
    const store = createRecorderStore();
    const app = createApp(stampedTwin(true), { recorder: store });
    await app.request(`${base}/echo`, jsonPost({}));
    const [event] = store.events();
    expect(event?.tool_call_id).toBeNull();
    expect(event?.correlation_id).toBe(event?.request_id);
  });

  it("stamps tool_call_id on JSON-RPC tools/call events when pinned", async () => {
    const store = createRecorderStore();
    const app = createApp(stampedTwin(true), { recorder: store });
    await app.request(
      `${base}/mcp`,
      jsonPost(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "noop", arguments: {} } },
        { "x-pome-correlation-id": "cor_mcp" }
      )
    );
    const event = store.events().find((e) => e.path === `${base}/mcp`);
    expect(event?.tool_call_id).toBe("cor_mcp");
    expect(event?.correlation_id).toBe("cor_mcp");
  });

  it("keeps the frozen null tool_call_id for twins without the pin (slack tape)", async () => {
    const store = createRecorderStore();
    const app = createApp(stampedTwin(false), { recorder: store });
    await app.request(`${base}/echo`, jsonPost({}, { "x-pome-correlation-id": "cor_2" }));
    const [event] = store.events();
    expect(event?.tool_call_id).toBeNull();
    expect(event?.correlation_id).toBe("cor_2");
  });
});

describe("pomeHealth: frozen per-session health extras", () => {
  it("replaces the default {version, fidelity} extras with the twin's shape", async () => {
    const twin = defineTwin({
      id: "healthy",
      version: "9.9.9",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      pomeHealth: () => ({ implementation: "healthy_clone", fidelity: "semantic", runtime: { package: "x" } }),
      tools: [],
    });
    const app = createApp(twin);
    const res = await app.request(`${base}/_pome/health`, withAuth(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      twin: "healthy",
      implementation: "healthy_clone",
      fidelity: "semantic",
      runtime: { package: "x" },
    });
  });

  it("keeps the default extras when the hook is absent", async () => {
    const twin = defineTwin({
      id: "defaulthealth",
      version: "1.2.3",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [],
    });
    const app = createApp(twin);
    const res = await app.request(`${base}/_pome/health`, withAuth(token));
    expect(await res.json()).toEqual({
      ok: true,
      twin: "defaulthealth",
      version: "1.2.3",
      fidelity: "semantic",
    });
  });
});

describe("pomeRoutes: extra per-twin routes under /_pome/*", () => {
  it("serves a declared GET /_pome/<name> route under bearer auth", async () => {
    const twin = defineTwin({
      id: "cataloged",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({ catalog: { version: 2 } }),
      pomeRoutes: {
        "access-control": ({ domain }) => (domain as { catalog: unknown }).catalog,
      },
      tools: [],
    });
    const app = createApp(twin);
    const denied = await app.request(`${base}/_pome/access-control`);
    expect(denied.status).toBe(401);
    const res = await app.request(`${base}/_pome/access-control`, withAuth(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 2 });
  });

  it("refuses to boot when a pome route shadows a core name", () => {
    const twin = defineTwin({
      id: "shadowy",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      pomeRoutes: { state: () => ({}) },
      tools: [],
    });
    expect(() => createApp(twin)).toThrowError(/reserved/i);
  });
});

describe("mcpUnknownTool: frozen JSON-RPC unknown-tool result body", () => {
  function githubishTwin(withPin: boolean) {
    return defineTwin({
      id: "githubish",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      errorEnvelope: () => ({ status: 422, body: { message: "Validation Failed" } }),
      ...(withPin ? { mcpUnknownTool: (name: string) => ({ message: `Unknown tool: ${name}` }) } : {}),
      tools: [],
    });
  }

  it("pins the JSON-RPC result body while /mcp/call keeps the envelope", async () => {
    const app = createApp(githubishTwin(true));
    const rpc = await app.request(
      `${base}/mcp`,
      jsonPost({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } })
    );
    const body = (await rpc.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ message: "Unknown tool: nope" });

    const legacy = await app.request(`${base}/mcp/call`, jsonPost({ tool: "nope", arguments: {} }));
    expect(legacy.status).toBe(422);
    expect(await legacy.json()).toEqual({ message: "Validation Failed" });
  });

  it("defaults to the errorEnvelope projection when the pin is absent", async () => {
    const app = createApp(githubishTwin(false));
    const rpc = await app.request(
      `${base}/mcp`,
      jsonPost({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } })
    );
    const body = (await rpc.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ message: "Validation Failed" });
  });
});

describe("admin handlers can report a state delta", () => {
  it("records the reported delta on /admin/reset and /admin/seed events", async () => {
    const store = createRecorderStore();
    const twin = defineTwin({
      id: "deltable",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      seed: z.record(z.string(), z.unknown()),
      domain: () => ({}),
      admin: {
        reset: ({ reportDelta }) => {
          reportDelta?.({ before: { repos: 3 }, after: { repos: 1 } });
          return { ok: true };
        },
        seed: ({ reportDelta }) => {
          reportDelta?.({ before: { repos: 1 }, after: { repos: 2 } });
          return { ok: true };
        },
      },
      tools: [],
    });
    const app = createApp(twin, { recorder: store });

    const reset = await app.request("/admin/reset", { method: "POST" });
    expect(reset.status).toBe(200);
    const resetEvent = store.events().at(-1);
    expect(resetEvent?.state_delta).toEqual({ before: { repos: 3 }, after: { repos: 1 } });
    expect(resetEvent?.state_mutation).toBe(true);

    const seed = await app.request("/admin/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anything: true }),
    });
    expect(seed.status).toBe(200);
    const seedEvent = store.events().at(-1);
    expect(seedEvent?.state_delta).toEqual({ before: { repos: 1 }, after: { repos: 2 } });
  });
});
