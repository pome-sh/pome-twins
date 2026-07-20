// SPDX-License-Identifier: Apache-2.0
//
// Additive MCP contract (Gmail twin prerequisite): optional title/outputSchema
// on ToolSpec, structuredContent on tools/call when outputSchema is set, and
// wire-identity for tools that omit the new fields.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTwin, type ToolCallContext } from "../src/index.js";
import { createApp } from "../src/server.js";
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

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { id: { type: "string" }, ok: { type: "boolean" } },
  required: ["id", "ok"],
  additionalProperties: false,
} as const;

function schemaTwin() {
  return defineTwin({
    id: "schema-mcp",
    version: "0.0.1",
    fidelity: { default: "semantic" },
    domain: () => ({}),
    tools: [
      {
        name: "plain_tool",
        description: "No title/outputSchema — must stay wire-identical.",
        schema: z.object({}),
        handler: () => ({ plain: true }),
        mutation: false,
      },
      {
        name: "structured_tool",
        description: "Declares title + outputSchema.",
        title: "Structured Tool",
        schema: z.object({ id: z.string() }),
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        outputSchema: { ...OUTPUT_SCHEMA },
        annotations: { readOnlyHint: true },
        handler: (_domain, args) => ({ id: (args as { id: string }).id, ok: true }),
        mutation: false,
      },
      {
        name: "write_tool",
        description: "Mutation stays independent of annotations.",
        schema: z.object({}),
        annotations: { readOnlyHint: true },
        handler: (_domain, _args, ctx: ToolCallContext) => {
          ctx.reportDelta({ before: null, after: { n: 1 } });
          return { wrote: true };
        },
        mutation: true,
      },
    ],
  });
}

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

describe("optional title/outputSchema on tools/list", () => {
  it("omits title/outputSchema keys when unset (wire-identical baseline)", async () => {
    const app = createApp(schemaTwin());
    const body = (await (await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    const plain = body.result.tools.find((t) => t.name === "plain_tool")!;
    expect(Object.keys(plain).sort()).toEqual(["description", "inputSchema", "name"]);
    expect("title" in plain).toBe(false);
    expect("outputSchema" in plain).toBe(false);
    expect("annotations" in plain).toBe(false);
  });

  it("emits title, outputSchema, and annotations when set", async () => {
    const app = createApp(schemaTwin());
    const body = (await (await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as {
      result: {
        tools: Array<{
          name: string;
          title?: string;
          outputSchema?: unknown;
          annotations?: { readOnlyHint?: boolean };
        }>;
      };
    };
    const structured = body.result.tools.find((t) => t.name === "structured_tool")!;
    expect(structured.title).toBe("Structured Tool");
    expect(structured.outputSchema).toEqual(OUTPUT_SCHEMA);
    expect(structured.annotations).toEqual({ readOnlyHint: true });
  });

  it("mirrors optional fields on legacy GET /mcp/tools", async () => {
    const app = createApp(schemaTwin());
    const body = (await (await app.request(`${base}/mcp/tools`, withAuth(token))).json()) as {
      tools: Array<Record<string, unknown>>;
    };
    const plain = body.tools.find((t) => t.name === "plain_tool")!;
    expect("title" in plain).toBe(false);
    expect("outputSchema" in plain).toBe(false);
    const structured = body.tools.find((t) => t.name === "structured_tool")!;
    expect(structured.title).toBe("Structured Tool");
    expect(structured.outputSchema).toEqual(OUTPUT_SCHEMA);
  });
});

describe("structuredContent on tools/call", () => {
  it("includes structuredContent only when outputSchema is declared", async () => {
    const app = createApp(schemaTwin());
    const structured = (await (
      await rpc(app, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "structured_tool", arguments: { id: "m1" } },
      })
    ).json()) as { result: Record<string, unknown> };
    expect(structured.result.structuredContent).toEqual({ id: "m1", ok: true });
    expect(JSON.parse((structured.result.content as Array<{ text: string }>)[0]!.text)).toEqual({
      id: "m1",
      ok: true,
    });

    const plain = (await (
      await rpc(app, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "plain_tool", arguments: {} },
      })
    ).json()) as { result: Record<string, unknown> };
    expect(Object.keys(plain.result).sort()).toEqual(["content"]);
    expect("structuredContent" in plain.result).toBe(false);
  });

  it("does not attach structuredContent on isError results", async () => {
    const app = createApp(schemaTwin());
    const body = (await (
      await rpc(app, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "structured_tool", arguments: { id: 1 } },
      })
    ).json()) as { result: Record<string, unknown> };
    expect(body.result.isError).toBe(true);
    expect("structuredContent" in body.result).toBe(false);
  });
});

describe("annotations stay independent of mutation", () => {
  it("records state_mutation from ToolSpec.mutation even when readOnlyHint is true", async () => {
    const app = createApp(schemaTwin());
    await rpc(app, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "write_tool", arguments: {} },
    });
    const events = (await (await app.request(`${base}/_pome/events`, withAuth(token))).json()) as Array<{
      state_mutation: boolean;
      state_delta: unknown;
    }>;
    expect(events[0]?.state_mutation).toBe(true);
    expect(events[0]?.state_delta).toEqual({ before: null, after: { n: 1 } });
  });
});
