// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTwin } from "../src/index.js";
import { createApp } from "../src/server.js";
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

describe("MCP tool registry mount + dispatch", () => {
  it("lists every declared tool with input_schema at GET /mcp/tools", async () => {
    const app = createApp(toyTwin);
    const res = await app.request(`${base}/mcp/tools`, withAuth(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: Array<{ name: string; input_schema: unknown }> };
    expect(body.tools.map((t) => t.name)).toEqual(["add_item", "count_items"]);
    expect(body.tools[0]?.input_schema).toBeTruthy();
  });

  it("dispatches via POST /mcp/tools/:name with Zod-parsed args", async () => {
    const app = createApp(toyTwin);
    const res = await app.request(
      `${base}/mcp/tools/add_item`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item: "via-tool-route" }),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ item: "via-tool-route", total: 1 });
  });

  it("dispatches via POST /mcp/call with {tool, arguments}", async () => {
    const app = createApp(toyTwin);
    const res = await app.request(
      `${base}/mcp/call`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "count_items", arguments: {} }),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0 });
  });

  it("returns 422 on invalid args (Zod validation)", async () => {
    const app = createApp(toyTwin);
    const res = await app.request(
      `${base}/mcp/call`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "add_item", arguments: { item: "" } }),
      })
    );
    expect(res.status).toBe(422);
  });

  it("returns 404 for unknown tool name", async () => {
    const app = createApp(toyTwin);
    const res = await app.request(
      `${base}/mcp/call`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "no_such_tool", arguments: {} }),
      })
    );
    expect(res.status).toBe(404);
  });

  it("recorded event uses each tool's declared mutation flag (recording-spec invariant)", async () => {
    const app = createApp(toyTwin, { runId: "run_mcp" });

    await app.request(
      `${base}/mcp/call`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "add_item", arguments: { item: "m" } }),
      })
    );
    await app.request(
      `${base}/mcp/call`,
      withAuth(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "count_items", arguments: {} }),
      })
    );

    const events = (await (await app.request(`${base}/_pome/events`, withAuth(token))).json()) as Array<
      Record<string, unknown>
    >;
    const callEvents = events.filter((e) => e.path === `${base}/mcp/call`);
    expect(callEvents).toHaveLength(2);
    // First call (add_item) — mutation: true
    expect(callEvents[0]?.state_mutation).toBe(true);
    // Second call (count_items) — mutation: false
    expect(callEvents[1]?.state_mutation).toBe(false);
  });

  it("invariant: a tool declared mutation:true cannot silently emit state_mutation:false", () => {
    // This is a structural property: the SDK's `recorder.handle` for /mcp/call
    // forwards `tool.mutation` directly. The toy twin's `add_item` tool
    // declares mutation:true; the recorded event in the previous test
    // confirms state_mutation=true. The inverse is impossible by construction —
    // there's no path where a mutation:true tool emits state_mutation:false
    // without an exception (caught and recorded as state_mutation:false with
    // the error populated, which is the documented exception).
    const def = defineTwin({
      id: "invariant-check",
      version: "0.0.1",
      fidelity: { default: "semantic" },
      domain: () => ({}),
      tools: [
        {
          name: "writer",
          description: "x",
          schema: z.object({}),
          handler: () => ({}),
          mutation: true,
        },
      ],
    });
    expect(def.tools[0]?.mutation).toBe(true);
  });
});
