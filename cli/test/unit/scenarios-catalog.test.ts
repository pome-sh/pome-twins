// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync } from "node:fs";
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
  it("exposes every first-party twin", () => {
    for (const id of ["github", "stripe", "slack", "gmail"]) {
      const twin = findTwin(id);
      expect(twin, `twin ${id} should be registered`).not.toBeNull();
      expect(twin?.id).toBe(id);
      expect(
        runnableScenarios(twin!).length,
        `twin ${id} should list at least one runnable scenario`,
      ).toBeGreaterThan(0);
    }
  });

  it("returns null for unknown twin", () => {
    expect(findTwin("not-a-twin")).toBeNull();
  });

  it("the only non-runnable entry is the github default seed", () => {
    const nonRunnable = SCENARIO_TWINS.flatMap((twin) =>
      twin.scenarios
        .filter((s) => !s.runnable)
        .map((s) => ({ twin: twin.id, filename: s.filename })),
    );
    expect(nonRunnable).toEqual([
      { twin: "github", filename: "00-default-seed.md" },
    ]);
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

  // Drift gate: a scenario file added to disk but not registered here is
  // invisible to `pome scenarios`. Fail loudly so the catalog stays the single
  // source of truth for the bundled scenario library (FDRS-624).
  it("every bundled scenario .md file is registered in the catalog", () => {
    const onDisk = readdirSync(bundledScenariosDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    const registered = SCENARIO_TWINS.flatMap((twin) =>
      twin.scenarios.map((s) => s.filename),
    ).sort();
    const unregistered = onDisk.filter((f) => !registered.includes(f));
    expect(
      unregistered,
      `bundled scenario file(s) missing from scenarios-catalog.ts: ${unregistered.join(", ")}`,
    ).toEqual([]);
  });

  it("registers each scenario filename exactly once across all twins", () => {
    const registered = SCENARIO_TWINS.flatMap((twin) =>
      twin.scenarios.map((s) => s.filename),
    );
    const dupes = registered.filter((f, i) => registered.indexOf(f) !== i);
    expect(dupes, `duplicate catalog entries: ${dupes.join(", ")}`).toEqual([]);
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
