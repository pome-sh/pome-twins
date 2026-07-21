// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import { createRecorderStore } from "@pome-sh/sdk/server";
import canonicalListing from "../fixtures/mcp-tools-list.canonical.json" with { type: "json" };
import {
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_LINEAR_SID,
  createLinearTwinApp,
  linearTools,
  openLinearTwinDatabase,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

const secret = "linear-mcp-test-secret-32-characters!";
const sid = DEFAULT_LINEAR_SID;
const base = `/s/${sid}`;
const previousSecret = process.env.TWIN_AUTH_SECRET;
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = secret;
  token = await sign(
    {
      sid,
      team_id: "tm_linear",
      linear_email: DEFAULT_LINEAR_EMAIL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret
  );
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.TWIN_AUTH_SECRET;
  else process.env.TWIN_AUTH_SECRET = previousSecret;
});

function fixture(recorder?: ReturnType<typeof createRecorderStore>) {
  const db = openLinearTwinDatabase(":memory:");
  const app = createLinearTwinApp({
    db,
    seed: testSeed(),
    recorder,
    runId: "mcp-test",
  });
  return { app, db };
}

function withAuth(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

function rpc(app: ReturnType<typeof createLinearTwinApp>, body: unknown) {
  return app.request(
    `${base}/mcp`,
    withAuth({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function call(
  app: ReturnType<typeof createLinearTwinApp>,
  id: number,
  name: string,
  args: Record<string, unknown>
) {
  return (await (
    await rpc(app, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    })
  ).json()) as {
    jsonrpc: "2.0";
    id: number;
    result: {
      content: Array<{ type: string; text: string }>;
      structuredContent?: Record<string, unknown>;
      isError: boolean;
    };
  };
}

describe("Linear MCP frozen contract", () => {
  it("lists exactly 18 tools in launch order", async () => {
    const { app } = fixture();
    const listed = (await (
      await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" })
    ).json()) as { result: { tools: Array<{ name: string }> } };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toHaveLength(18);
    expect(names).toEqual(canonicalListing.meta.launchToolOrder);
    expect(linearTools.map((tool) => tool.name)).toEqual(canonicalListing.meta.launchToolOrder);
  });

  it("creates and updates issues through save_issue", async () => {
    const { app } = fixture();
    const created = await call(app, 1, "save_issue", {
      title: "MCP created",
      team: "ENG",
      description: "via MCP",
    });
    expect(created.result.isError).toBe(false);
    const issue = created.result.structuredContent as {
      id: string;
      identifier: string;
      title: string;
    };
    expect(issue.title).toBe("MCP created");
    expect(issue.identifier).toMatch(/^ENG-\d+$/);

    const updated = await call(app, 2, "save_issue", {
      id: issue.id,
      title: "MCP updated",
    });
    expect(updated.result.isError).toBe(false);
    expect(updated.result.structuredContent).toMatchObject({ title: "MCP updated" });
  });

  it("records state_mutation=false for no-op save_issue with the same title", async () => {
    const recorder = createRecorderStore();
    const { app } = fixture(recorder);
    const created = await call(app, 1, "save_issue", {
      title: "No-op title",
      team: "ENG",
    });
    const issueId = (created.result.structuredContent as { id: string }).id;
    await call(app, 2, "save_issue", { id: issueId, title: "No-op title" });
    const updateEvents = recorder.events().filter((event) => {
      const body = event.request_body as { tool?: string } | null;
      return body?.tool === "save_issue" && (body as { arguments?: { id?: string } }).arguments?.id;
    });
    expect(updateEvents.length).toBeGreaterThanOrEqual(1);
    const last = updateEvents.at(-1);
    expect(last?.state_mutation).toBe(false);
    expect(last?.state_delta).toBeNull();
  });

  it("omits cursor when the page is exhausted", async () => {
    const { app } = fixture();
    const listed = await call(app, 1, "list_issues", { team: "ENG", limit: 250 });
    expect(listed.result.isError).toBe(false);
    expect(listed.result.structuredContent).toHaveProperty("issues");
    expect(listed.result.structuredContent).not.toHaveProperty("cursor");
  });
});
