// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAR_CLOCK,
  DEFAULT_LINEAR_EMAIL,
  LinearDomain,
  defaultSeedState,
  linearStateDelta,
  openLinearTwinDatabase,
  parseSeed,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

function domain() {
  const db = openLinearTwinDatabase(":memory:");
  const commands = new LinearDomain(db);
  commands.seed(testSeed());
  return { db, commands };
}

describe("Linear domain", () => {
  it("keeps seed clock at or after the newest issue timestamp", () => {
    const seed = defaultSeedState();
    const clock = Date.parse(seed.clock ?? DEFAULT_LINEAR_CLOCK);
    const newest = Math.max(
      ...(seed.issues ?? []).flatMap((issue) =>
        [issue.createdAt, issue.updatedAt].filter(Boolean).map((value) => Date.parse(value!))
      )
    );
    expect(clock).toBeGreaterThanOrEqual(newest);
  });

  it("rejects seeds that reference a missing team", () => {
    expect(() =>
      parseSeed({
        ...defaultSeedState(),
        issues: [
          {
            team: "NOPE",
            title: "Bad team ref",
          },
        ],
      })
    ).toThrow(/Issue team not found/);
  });

  it("creates, archives, and unarchives issues with ENG-N identifiers", async () => {
    const { commands } = domain();
    const team = commands.getTeam("ENG")!;
    expect(team.key).toBe("ENG");

    const created = await commands.createIssue(
      { teamId: team.id, title: "Domain create" },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    expect(created.identifier).toMatch(/^ENG-\d+$/);
    expect(created.number).toBeGreaterThanOrEqual(5);

    const archived = await commands.archiveIssue(created.id, { email: DEFAULT_LINEAR_EMAIL });
    expect(archived.archivedAt).toBeTruthy();

    const unarchived = await commands.unarchiveIssue(created.id, { email: DEFAULT_LINEAR_EMAIL });
    expect(unarchived.archivedAt).toBeNull();
  });

  it("returns null state_delta when adding the same label twice", async () => {
    const { commands } = domain();
    const issue = commands.getIssue("issue_todo")!;
    const label = commands.getLabel("Bug")!;

    const beforeFirst = commands.exportState();
    await commands.addIssueLabel(issue.id, label.id, { email: DEFAULT_LINEAR_EMAIL });
    const afterFirst = commands.exportState();
    expect(linearStateDelta(beforeFirst, afterFirst)).not.toBeNull();

    const beforeSecond = commands.exportState();
    await commands.addIssueLabel(issue.id, label.id, { email: DEFAULT_LINEAR_EMAIL });
    const afterSecond = commands.exportState();
    expect(linearStateDelta(beforeSecond, afterSecond)).toBeNull();
  });

  it("clears completed_at when reopening a Done issue to Todo", async () => {
    const { commands } = domain();
    const issue = commands.getIssue("issue_todo")!;
    const done = commands.getWorkflowState("Done", "ENG")!;
    const todo = commands.getWorkflowState("Todo", "ENG")!;

    const completed = await commands.updateIssue(
      issue.id,
      { stateId: done.id },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    expect(completed.completedAt).toBeTruthy();

    const reopened = await commands.updateIssue(
      issue.id,
      { stateId: todo.id },
      { email: DEFAULT_LINEAR_EMAIL }
    );
    expect(reopened.completedAt).toBeNull();
    expect(reopened.canceledAt).toBeNull();
  });

  it("allocates sequential ENG-N identifiers from the team sequence", async () => {
    const { commands } = domain();
    const team = commands.getTeam("ENG")!;
    const first = await commands.createIssue({ teamId: team.id, title: "Seq A" });
    const second = await commands.createIssue({ teamId: team.id, title: "Seq B" });
    expect(second.number).toBe(first.number + 1);
    expect(first.identifier).toBe(`ENG-${first.number}`);
    expect(second.identifier).toBe(`ENG-${second.number}`);
  });
});
