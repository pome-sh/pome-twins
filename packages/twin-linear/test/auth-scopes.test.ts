// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAR_TOKEN,
  LinearCommands,
  createLinearTwinApp,
  looksLikeLinearToken,
  openLinearTwinDatabase,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

describe("looksLikeLinearToken", () => {
  it("accepts lin_ twin tokens and rejects provider / opaque strings", () => {
    expect(looksLikeLinearToken("lin_test_admin")).toBe(true);
    expect(looksLikeLinearToken("lin_oauth_abc1234567890")).toBe(true);
    expect(looksLikeLinearToken("lin_pome_session")).toBe(false);
    expect(looksLikeLinearToken("ghp_abcdefghijklmnopqrstuvwxyz12")).toBe(false);
    expect(looksLikeLinearToken("short")).toBe(false);
  });
});

describe("strictScopes", () => {
  it("blocks issue create when the actor lacks issues:create", async () => {
    const db = openLinearTwinDatabase(":memory:");
    const commands = new LinearCommands(db);
    commands.seed(
      testSeed({
        strictScopes: true,
        tokens: [
          {
            token: "lin_read_only_token",
            type: "personal",
            user: "admin@pome-twin.test",
            scopes: ["read"],
            actor: "user",
          },
        ],
      })
    );

    await expect(
      commands.createIssue(
        { teamId: "team_eng", title: "Should fail" },
        { email: "admin@pome-twin.test", scopes: ["read"] }
      )
    ).rejects.toThrow(/Missing required Linear scope/);
  });

  it("allows issue create when write is present (covers issues:create)", async () => {
    const db = openLinearTwinDatabase(":memory:");
    const commands = new LinearCommands(db);
    commands.seed(testSeed({ strictScopes: true }));
    const issue = await commands.createIssue(
      { teamId: "team_eng", title: "Scoped create" },
      { email: "admin@pome-twin.test", scopes: ["write"] }
    );
    expect(issue.title).toBe("Scoped create");
  });

  it("surfaces scope failures as GraphQL error extensions", async () => {
    process.env.TWIN_AUTH_SECRET = "linear-scopes-test-secret-32chars!!";
    const db = openLinearTwinDatabase(":memory:");
    const app = createLinearTwinApp({
      db,
      seed: testSeed({
        strictScopes: true,
        tokens: [
          {
            token: "lin_read_only_gql",
            type: "personal",
            user: "admin@pome-twin.test",
            scopes: ["read"],
            actor: "user",
          },
          {
            token: DEFAULT_LINEAR_TOKEN,
            type: "personal",
            user: "admin@pome-twin.test",
            scopes: ["read", "write", "issues:create", "comments:create", "admin"],
            actor: "user",
          },
        ],
      }),
      runId: "scopes-gql",
    });

    const response = await app.request("/graphql", {
      method: "POST",
      headers: {
        authorization: "Bearer lin_read_only_gql",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id } }
        }`,
        variables: { input: { teamId: "team_eng", title: "Denied" } },
      }),
    });
    const body = (await response.json()) as {
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    };
    expect(body.errors?.[0]?.message).toMatch(/Missing required Linear scope/);
    expect(body.errors?.[0]?.extensions?.code).toBeTruthy();
  });
});
