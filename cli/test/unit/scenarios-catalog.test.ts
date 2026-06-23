// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SCENARIO_TWINS,
  findTwin,
  runnableScenarios,
} from "../../src/cli/scenarios-catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..", "..");
const bundledScenariosDir = join(packageRoot, "scenarios");

describe("scenarios catalog", () => {
  it("exposes the github twin", () => {
    const github = findTwin("github");
    expect(github).not.toBeNull();
    expect(github?.id).toBe("github");
  });

  it("returns null for unknown twin", () => {
    expect(findTwin("not-a-twin")).toBeNull();
  });

  it("github twin lists exactly 4 runnable scenarios plus a non-runnable seed", () => {
    const github = findTwin("github")!;
    expect(runnableScenarios(github)).toHaveLength(4);
    const nonRunnable = github.scenarios.filter((s) => !s.runnable);
    expect(nonRunnable).toHaveLength(1);
    expect(nonRunnable[0]?.filename).toBe("00-default-seed.md");
  });

  it("every catalog filename resolves to a bundled scenario file", () => {
    for (const twin of SCENARIO_TWINS) {
      for (const scenario of twin.scenarios) {
        const filePath = join(bundledScenariosDir, scenario.filename);
        expect(
          existsSync(filePath),
          `missing bundled scenario for ${twin.id}: ${scenario.filename}`,
        ).toBe(true);
      }
    }
  });

  it("each scenario has a non-empty title and summary", () => {
    for (const twin of SCENARIO_TWINS) {
      for (const scenario of twin.scenarios) {
        expect(scenario.title.trim().length).toBeGreaterThan(0);
        expect(scenario.summary.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
