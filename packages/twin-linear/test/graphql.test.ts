// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createRecorderStore } from "@pome-sh/sdk/server";
import {
  DEFAULT_LINEAR_TOKEN,
  createLinearTwinApp,
  openLinearTwinDatabase,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

const SECRET = "linear-graphql-test-secret-32chars!";

function fixture(runId = "graphql-test") {
  process.env.TWIN_AUTH_SECRET = SECRET;
  const db = openLinearTwinDatabase(":memory:");
  const recorder = createRecorderStore();
  const app = createLinearTwinApp({ db, seed: testSeed(), recorder, runId });
  return { app, db, recorder };
}

async function graphql(app: ReturnType<typeof createLinearTwinApp>, query: string, variables?: Record<string, unknown>) {
  const response = await app.request("/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEFAULT_LINEAR_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      data?: Record<string, unknown>;
      errors?: Array<{ message: string }>;
    },
  };
}

describe("Linear GraphQL surface", () => {
  it("returns viewer for the seeded admin token", async () => {
    const { app } = fixture();
    const { status, body } = await graphql(
      app,
      `query { viewer { id email name admin } }`
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data?.viewer).toMatchObject({
      email: "admin@pome-twin.test",
      admin: true,
    });
  });

  it("lists seeded issues", async () => {
    const { app } = fixture();
    const { status, body } = await graphql(
      app,
      `query { issues(first: 10) { nodes { id identifier title } } }`
    );
    expect(status).toBe(200);
    const nodes = (body.data?.issues as { nodes: Array<{ identifier: string }> }).nodes;
    expect(nodes.length).toBeGreaterThanOrEqual(4);
    expect(nodes.map((n) => n.identifier).every((id) => /^ENG-\d+$/.test(id))).toBe(true);
  });

  it("creates an issue via issueCreate", async () => {
    const { app } = fixture();
    const { status, body } = await graphql(
      app,
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier title team { key } }
        }
      }`,
      { input: { teamId: "team_eng", title: "GraphQL created issue" } }
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const payload = body.data?.issueCreate as {
      success: boolean;
      issue: { identifier: string; title: string; team: { key: string } };
    };
    expect(payload.success).toBe(true);
    expect(payload.issue.title).toBe("GraphQL created issue");
    expect(payload.issue.team.key).toBe("ENG");
    expect(payload.issue.identifier).toMatch(/^ENG-\d+$/);
  });

  it("records state_delta for issueCreate and null delta for no-op issueUpdate", async () => {
    const { app, recorder } = fixture("graphql-recorder");
    const create = await graphql(
      app,
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id title }
        }
      }`,
      { input: { teamId: "team_eng", title: "Recorder issue" } }
    );
    expect(create.status).toBe(200);
    expect(create.body.errors).toBeUndefined();
    const created = create.body.data?.issueCreate as { issue: { id: string; title: string } };
    const createEvent = recorder.events().find((event) => event.path === "/graphql" && event.state_mutation);
    expect(createEvent).toBeDefined();
    expect(createEvent?.state_delta).not.toBeNull();

    const noop = await graphql(
      app,
      `mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { id title }
        }
      }`,
      { id: created.issue.id, input: { title: created.issue.title } }
    );
    expect(noop.status).toBe(200);
    expect(noop.body.errors).toBeUndefined();
    const noopEvent = recorder
      .events()
      .filter((event) => event.path === "/graphql")
      .at(-1);
    expect(noopEvent?.state_mutation).toBe(false);
    expect(noopEvent?.state_delta).toBeNull();
  });
});
