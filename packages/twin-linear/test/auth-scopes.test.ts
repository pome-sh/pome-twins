// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAR_TOKEN,
  LinearDomain,
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
    const commands = new LinearDomain(db);
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
    const commands = new LinearDomain(db);
    commands.seed(testSeed({ strictScopes: true }));
    const issue = await commands.createIssue(
      { teamId: "team_eng", title: "Scoped create" },
      { email: "admin@pome-twin.test", scopes: ["write"] }
    );
    expect(issue.title).toBe("Scoped create");
  });

  it("blocks delete/archive/label/webhook/project when actor has only read", async () => {
    const db = openLinearTwinDatabase(":memory:");
    const commands = new LinearDomain(db);
    commands.seed(testSeed({ strictScopes: true }));
    const readActor = { email: "admin@pome-twin.test", scopes: ["read"] };
    const issue = commands.getIssue("issue_todo")!;
    const label = commands.getLabel("Bug")!;

    await expect(commands.deleteIssue(issue.id, readActor)).rejects.toThrow(
      /Missing required Linear scope/
    );
    await expect(commands.archiveIssue(issue.id, readActor)).rejects.toThrow(
      /Missing required Linear scope/
    );
    await expect(commands.addIssueLabel(issue.id, label.id, readActor)).rejects.toThrow(
      /Missing required Linear scope/
    );
    expect(() =>
      commands.createWebhook({ url: "http://127.0.0.1:9999/hooks" }, readActor)
    ).toThrow(/Missing required Linear scope/);
    expect(() =>
      commands.createProject({ name: "Scoped Project", teamId: "team_eng" }, readActor)
    ).toThrow(/Missing required Linear scope/);
  });

  it("allows write-scoped mutators and leaves default strictScopes off", async () => {
    const writeDb = openLinearTwinDatabase(":memory:");
    const writeCommands = new LinearDomain(writeDb);
    writeCommands.seed(testSeed({ strictScopes: true }));
    const writeActor = { email: "admin@pome-twin.test", scopes: ["write"] };
    const issue = writeCommands.getIssue("issue_todo")!;
    const archived = await writeCommands.archiveIssue(issue.id, writeActor);
    expect(archived.archivedAt).toBeTruthy();
    const project = writeCommands.createProject(
      { name: "Write Project", teamId: "team_eng" },
      writeActor
    );
    expect(project.name).toBe("Write Project");

    const openDb = openLinearTwinDatabase(":memory:");
    const openCommands = new LinearDomain(openDb);
    openCommands.seed(testSeed({ strictScopes: false }));
    const created = await openCommands.createIssue(
      { teamId: "team_eng", title: "Open scopes" },
      { email: "admin@pome-twin.test", scopes: ["read"] }
    );
    expect(created.title).toBe("Open scopes");
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
