// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sign } from "hono/jwt";
import {
  DEFAULT_LINEAR_EMAIL,
  DEFAULT_LINEAR_SID,
  DEFAULT_LINEAR_TOKEN,
  createLinearTwinApp,
  openLinearTwinDatabase,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

const secret = "linear-parity-test-secret-32chars!!";
const sid = DEFAULT_LINEAR_SID;
const previousSecret = process.env.TWIN_AUTH_SECRET;
let jwt: string;

beforeAll(async () => {
  process.env.TWIN_AUTH_SECRET = secret;
  jwt = await sign(
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

function fixture() {
  const db = openLinearTwinDatabase(":memory:");
  const app = createLinearTwinApp({ db, seed: testSeed(), runId: "parity" });
  return { app, db };
}

async function mcpCall(
  app: ReturnType<typeof createLinearTwinApp>,
  id: number,
  name: string,
  args: Record<string, unknown>
) {
  const response = await app.request(`/s/${sid}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
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
    result: { isError: boolean; structuredContent?: Record<string, unknown> };
  };
}

async function gql(
  app: ReturnType<typeof createLinearTwinApp>,
  query: string,
  variables?: Record<string, unknown>
) {
  const response = await app.request("/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEFAULT_LINEAR_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
}

describe("MCP / GraphQL parity", () => {
  it("creates via MCP and reads via GraphQL", async () => {
    const { app } = fixture();
    const created = await mcpCall(app, 1, "save_issue", {
      title: "Parity MCP→GQL",
      team: "ENG",
    });
    expect(created.result.isError).toBe(false);
    const issue = created.result.structuredContent as { id: string; identifier: string };

    const fetched = await gql(
      app,
      `query($id: String!) { issue(id: $id) { id identifier title } }`,
      { id: issue.id }
    );
    expect(fetched.errors).toBeUndefined();
    expect(fetched.data?.issue).toMatchObject({
      id: issue.id,
      identifier: issue.identifier,
      title: "Parity MCP→GQL",
    });
  });

  it("creates via GraphQL and reads via MCP", async () => {
    const { app } = fixture();
    const created = await gql(
      app,
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { id identifier title } }
      }`,
      { input: { teamId: "team_eng", title: "Parity GQL→MCP" } }
    );
    expect(created.errors).toBeUndefined();
    const issue = (created.data?.issueCreate as { issue: { id: string; identifier: string } }).issue;

    const fetched = await mcpCall(app, 1, "get_issue", { id: issue.identifier });
    expect(fetched.result.isError).toBe(false);
    expect(fetched.result.structuredContent).toMatchObject({
      id: issue.id,
      identifier: issue.identifier,
      title: "Parity GQL→MCP",
    });
  });
});
