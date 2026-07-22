// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import {
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_LINEAR_SID,
  DEFAULT_LINEAR_TOKEN,
  LinearDomain,
  createLinearTwinApp,
  defaultSeedState,
  openLinearTwinDatabase,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

const TITLE_MAX_BYTES = 512;
const MCP_PAGE_MAX = 250;

const SID = DEFAULT_LINEAR_SID;
const SECRET = "linear-limits-test-secret-32chars!";
let token: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = SECRET;
  token = await sign(
    {
      sid: SID,
      team_id: "team_limits",
      linear_email: DEFAULT_LINEAR_EMAIL,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SECRET
  );
});

function fixture() {
  const db = openLinearTwinDatabase(":memory:");
  const app = createLinearTwinApp({ db, seed: testSeed(), runId: "limits-test" });
  return { app, db };
}

async function mcpCall(
  app: ReturnType<typeof createLinearTwinApp>,
  id: number,
  name: string,
  args: unknown
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
  return response.json() as Promise<{
    result: { isError?: boolean; content?: Array<{ text: string }> };
  }>;
}

describe("LIMITS.md max+1 enforcement", () => {
  it("rejects titles over TITLE_MAX_BYTES", async () => {
    const db = openLinearTwinDatabase(":memory:");
    const commands = new LinearDomain(db);
    commands.seed(defaultSeedState());
    const team = commands.getTeam("ENG")!;
    await expect(
      commands.createIssue({
        teamId: team.id,
        title: "x".repeat(TITLE_MAX_BYTES + 1),
      })
    ).rejects.toThrow(/title exceeds/i);
  });

  it("rejects MCP list limit max+1", async () => {
    const { app } = fixture();
    const response = await mcpCall(app, 1, "list_issues", { limit: MCP_PAGE_MAX + 1 });
    expect(response.result.isError).toBe(true);
  });

  it("rejects GraphQL issueCreate with overlong title", async () => {
    const { app } = fixture();
    const response = await app.request("/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${DEFAULT_LINEAR_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id } }
        }`,
        variables: {
          input: {
            teamId: "team_eng",
            title: "y".repeat(TITLE_MAX_BYTES + 1),
          },
        },
      }),
    });
    const body = (await response.json()) as { errors?: unknown[] };
    expect(body.errors?.length).toBeGreaterThan(0);
  });
});
