// SPDX-License-Identifier: Apache-2.0
//
// Engine surfaces required by the frozen runtime contract (F-681 / F-711):
// healthz implementation+runtime block, per-twin healthz extras, the
// definition-level auth options, JSON-RPC /s/:sid/mcp, the per-twin 501
// unsupported envelope, state_delta plumbing, and the serve() boot guard.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineTwin } from "../src/index.js";
import { UnknownToolError } from "../src/errors.js";
import { createApp, createRecorderStore, serve } from "../src/server.js";
import { TEST_AUTH_SECRET, TEST_SID, signTestToken, withAuth } from "./_authHelper.js";
import { toyTwin } from "./_toyTwin.js";

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

describe("healthz contract shape", () => {
  it("carries implementation and the runtime build-info block by default", async () => {
    const app = createApp(toyTwin);
    const body = (await (await app.request("/healthz")).json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.twin).toBe("toy");
    expect(body.implementation).toBe("toy_clone");
    expect(body.tools).toBe(2);
    const runtime = body.runtime as Record<string, unknown>;
    for (const key of ["package", "version", "git_sha", "build_time"]) {
      expect(typeof runtime[key]).toBe("string");
    }
    expect(runtime.package).toBe("@pome-sh/twin-toy");
    // Default extras keep the pre-F-681 fields.
    expect(body.version).toBe("0.1.0");
    expect(body.fidelity).toBe("semantic");
  });

  it("lets a twin replace the healthz extras (e.g. slack omits fidelity/version)", async () => {
    const slackish = defineTwin({
      ...toyTwin,
      id: "slackish",
      implementation: "slack_clone",
      packageName: "@pome-sh/twin-slack",
      healthz: () => ({}),
    });
    const app = createApp(slackish);
    const body = (await (await app.request("/healthz")).json()) as Record<string, unknown>;
    expect(body.implementation).toBe("slack_clone");
    expect((body.runtime as Record<string, unknown>).package).toBe("@pome-sh/twin-slack");
    expect("fidelity" in body).toBe(false);
    expect("version" in body).toBe(false);
  });
});

describe("definition-level auth options", () => {
  it("wires definition.auth into the session bearer middleware", async () => {
    const twin = defineTwin({
      ...toyTwin,
      id: "authy",
      auth: {
        unauthorized: (kind) => ({
          status: 401,
          body: { ok: false, error: kind === "no_token" ? "not_authed" : "invalid_auth" },
        }),
      },
    });
    const app = createApp(twin);
    const res = await app.request(`${base}/_pome/health`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "not_authed" });
  });
});

describe("JSON-RPC /s/:sid/mcp", () => {
  function rpc(app: ReturnType<typeof createApp>, body: unknown) {
    return app.request(
      `${base}/mcp`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  it("answers initialize with protocolVersion + serverInfo", async () => {
    const app = createApp(toyTwin);
    const res = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(typeof body.result.serverInfo.name).toBe("string");
  });

  it("answers ping and tools/list (list length matches healthz.tools)", async () => {
    const app = createApp(toyTwin);
    const ping = (await (await rpc(app, { jsonrpc: "2.0", id: 2, method: "ping" })).json()) as any;
    expect(ping.result).toEqual({});
    const list = (await (await rpc(app, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json()) as any;
    expect(list.result.tools).toHaveLength(2);
  });

  it("executes tools/call and records the event with the tool's mutation flag", async () => {
    const store = createRecorderStore();
    const app = createApp(toyTwin, { recorder: store });
    const res = await rpc(app, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "add_item", arguments: { item: "x" } },
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ item: "x", total: 1 });
    const event = store.events().find((e) => e.path.endsWith("/mcp"));
    expect(event?.state_mutation).toBe(true);
  });

  it("returns an isError tool result for an unknown tool", async () => {
    const app = createApp(toyTwin);
    const res = await rpc(app, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
  });

  it("answers 405 for GET and DELETE (stateless mode)", async () => {
    const app = createApp(toyTwin);
    expect((await app.request(`${base}/mcp`, withAuth(token))).status).toBe(405);
    expect((await app.request(`${base}/mcp`, withAuth(token, { method: "DELETE" }))).status).toBe(405);
  });

  it("answers 202 for notifications and -32601 for unknown methods", async () => {
    const app = createApp(toyTwin);
    const notification = await rpc(app, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification.status).toBe(202);
    const unknown = (await (await rpc(app, { jsonrpc: "2.0", id: 6, method: "nope/nope" })).json()) as any;
    expect(unknown.error.code).toBe(-32601);
  });

  it("answers -32700 (HTTP 200) for a JSON parse error", async () => {
    const app = createApp(toyTwin);
    const res = await app.request(
      `${base}/mcp`,
      withAuth(token, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" })
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).error.code).toBe(-32700);
  });
});

describe("unknown-tool envelope via legacy /mcp/call", () => {
  it("throws UnknownToolError so the twin's errorEnvelope can shape the wire", async () => {
    const slackish = defineTwin({
      ...toyTwin,
      id: "slackish2",
      errorEnvelope: (err) =>
        err instanceof UnknownToolError
          ? { status: 404, body: { ok: false, error: "unknown_tool" } }
          : { status: 500, body: { message: "boom" } },
    });
    const app = createApp(slackish);
    const res = await app.request(
      `${base}/mcp/call`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "definitely_not_a_tool", arguments: {} }),
      })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "unknown_tool" });
  });
});

describe("per-twin unsupported envelope", () => {
  it("uses the twin's 501 envelope for unknown session routes", async () => {
    const slackish = defineTwin({
      ...toyTwin,
      id: "slackish3",
      unsupported: () => ({
        status: 501,
        body: { ok: false, error: "unsupported_endpoint", _twin: { fidelity: "unsupported" } },
      }),
    });
    const app = createApp(slackish);
    const res = await app.request(`${base}/definitely/not/a/route`, withAuth(token));
    expect(res.status).toBe(501);
    const body = (await res.json()) as any;
    expect(body.error).toBe("unsupported_endpoint");
    expect(body._twin.fidelity).toBe("unsupported");
  });

  it("still records the unsupported hit as fidelity:unsupported", async () => {
    const store = createRecorderStore();
    const app = createApp(toyTwin, { recorder: store });
    await app.request(`${base}/definitely/not/a/route`, withAuth(token));
    const event = store.events().at(-1);
    expect(event?.fidelity).toBe("unsupported");
    expect(event?.status).toBe(501);
  });
});

describe("state_delta plumbing", () => {
  it("carries a route-supplied delta into the recorded event", async () => {
    const store = createRecorderStore();
    const twin = defineTwin({
      ...toyTwin,
      id: "delta",
      routes: (app, { recorder }) => {
        app.post(
          "/mutate",
          recorder.handle({ mutation: true }, () => ({
            status: 200,
            body: { ok: true },
            delta: { before: null, after: { items: 1 } },
          }))
        );
      },
    });
    const app = createApp(twin, { recorder: store });
    await app.request(`${base}/mutate`, withAuth(token, { method: "POST" }));
    const event = store.events().at(-1);
    expect(event?.state_delta).toEqual({ before: null, after: { items: 1 } });
  });
});

describe("serve() boot guard", () => {
  it("refuses a non-loopback bind without TWIN_AUTH_SECRET, naming the variable", async () => {
    const saved = process.env.TWIN_AUTH_SECRET;
    delete process.env.TWIN_AUTH_SECRET;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(serve(toyTwin, { port: 0, hostname: "0.0.0.0" })).rejects.toThrow(
        /TWIN_AUTH_SECRET/
      );
    } finally {
      process.env.TWIN_AUTH_SECRET = saved;
      warnSpy.mockRestore();
    }
  });

  it("boots on loopback without TWIN_AUTH_SECRET (dev flow)", async () => {
    const saved = process.env.TWIN_AUTH_SECRET;
    delete process.env.TWIN_AUTH_SECRET;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { close } = await serve(toyTwin, { port: 0, hostname: "127.0.0.1" });
      await close();
    } finally {
      process.env.TWIN_AUTH_SECRET = saved;
      warnSpy.mockRestore();
    }
  });
});
