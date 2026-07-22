// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINEAR_EMAIL,
  LinearDomain,
  openLinearTwinDatabase,
} from "../src/index.js";
import { testSeed } from "./_helpers.js";

function domain() {
  const db = openLinearTwinDatabase(":memory:");
  const commands = new LinearDomain(db);
  commands.seed(testSeed());
  return commands;
}

describe("Linear concurrency suite", () => {
  it("allocates unique issue identifiers under parallel createIssue", async () => {
    const commands = domain();
    const team = commands.getTeam("ENG")!;
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        commands.createIssue(
          { teamId: team.id, title: `Parallel ${index}` },
          { email: DEFAULT_LINEAR_EMAIL }
        )
      )
    );
    const identifiers = results.map((issue) => issue.identifier);
    const ids = results.map((issue) => issue.id);
    expect(new Set(identifiers).size).toBe(identifiers.length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(identifiers.every((value) => /^ENG-\d+$/.test(value))).toBe(true);
  });
});
