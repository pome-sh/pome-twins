// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import {
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_LINEAR_SID,
  createLinearTwinApp,
  openLinearTwinDatabase,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

const SID = DEFAULT_LINEAR_SID;
const SECRET = "linear-agent-path-test-secret-32!";
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = SECRET;
  token = await sign(
    {
      sid: SID,
      team_id: "team_agent_path",
      linear_email: DEFAULT_LINEAR_EMAIL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SECRET
  );
});

function fixture() {
  const db = openLinearTwinDatabase(":memory:");
  const app = createLinearTwinApp({
    db,
    seed: testSeed(),
    runId: "agent-path-test",
  });
  return { app, db };
}

async function mcp(
  app: ReturnType<typeof createLinearTwinApp>,
  id: number,
  name: string,
  args: Record<string, unknown>
) {
  const response = await app.request(`/s/${SID}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return (await response.json()) as {
    result: {
      isError: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ text: string }>;
    };
  };
}

describe("Linear agent-path MCP triage", () => {
  it("lists issues, updates one, and creates a comment", async () => {
    const { app } = fixture();

    const listed = await mcp(app, 1, "list_issues", { team: "ENG", limit: 20 });
    expect(listed.result.isError).toBe(false);
    const issues = listed.result.structuredContent?.issues as Array<{
      id: string;
      identifier: string;
      title: string;
      state?: { name?: string };
    }>;
    expect(issues.length).toBeGreaterThanOrEqual(4);
    const backlog = issues.find((issue) => issue.state?.name === "Backlog") ?? issues[0]!;

    const updated = await mcp(app, 2, "save_issue", {
      id: backlog.id,
      state: "In Progress",
      title: backlog.title,
    });
    expect(updated.result.isError).toBe(false);
    expect(updated.result.structuredContent).toMatchObject({
      id: backlog.id,
      state: { name: "In Progress" },
    });

    const commented = await mcp(app, 3, "save_comment", {
      issueId: backlog.id,
      body: "Agent triage: moving into progress.",
    });
    expect(commented.result.isError).toBe(false);
    expect(commented.result.structuredContent).toMatchObject({
      issueId: backlog.id,
      body: "Agent triage: moving into progress.",
    });
  });
});
