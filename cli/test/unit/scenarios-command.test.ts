// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";
import {
  findTwin,
  runnableScenarios,
} from "../../src/cli/scenarios-catalog.js";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

interface CapturedConsole {
  log: string[];
  error: string[];
}

function captureConsole(): CapturedConsole {
  const captured: CapturedConsole = { log: [], error: [] };
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    captured.log.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    captured.error.push(args.map(String).join(" "));
  });
  return captured;
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function inTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-scenarios-"));
  tempDirs.push(dir);
  process.chdir(dir);
  return dir;
}

describe("pome scenarios", () => {
  it("lists available twins when no twin is given", async () => {
    await inTempDir();
    const captured = captureConsole();

    await createProgram().parseAsync(["node", "pome", "scenarios"]);

    const out = captured.log.concat(captured.error).join("\n");
    expect(out.toLowerCase()).toContain("github");
    expect(out.toLowerCase()).toContain("stripe");
    expect(out.toLowerCase()).toContain("slack");
    expect(out.toLowerCase()).toContain("gmail");
  });

  it("lists runnable github scenarios and omits the seed", async () => {
    await inTempDir();
    const captured = captureConsole();

    await createProgram().parseAsync(["node", "pome", "scenarios", "github"]);

    const out = captured.log.concat(captured.error).join("\n");
    expect(out).toContain("01-bug-happy-path.md");
    expect(out).toContain("03-already-triaged.md");
    expect(out).toContain("04-judge-context.md");
    expect(out).toContain("05-github-identity-spoof.md");
    expect(out).not.toContain("00-default-seed.md");
  });

  it("lists runnable stripe, slack, and gmail scenarios", async () => {
    await inTempDir();
    const captured = captureConsole();

    await createProgram().parseAsync(["node", "pome", "scenarios", "stripe"]);
    await createProgram().parseAsync(["node", "pome", "scenarios", "slack"]);
    await createProgram().parseAsync(["node", "pome", "scenarios", "gmail"]);

    const out = captured.log.concat(captured.error).join("\n");
    expect(out).toContain("14-stripe-refund-retry.md");
    expect(out).toContain("19-stripe-rerefund-persuasion.md");
    expect(out).toContain("20-slack-exfiltration.md");
    expect(out).toContain("21-slack-injection.md");
    expect(out).toContain("22-gmail-inbox-triage.md");
    expect(out).toContain("23-gmail-first-party-parity.md");
  });

  it("errors with a helpful hint on unknown twin", async () => {
    await inTempDir();
    const captured = captureConsole();

    await createProgram().parseAsync([
      "node",
      "pome",
      "scenarios",
      "nope-twin",
    ]);

    expect(process.exitCode).toBe(2);
    const out = captured.error.join("\n");
    expect(out.toLowerCase()).toContain("github");
  });

  it("--copy copies the runnable github scenarios into ./scenarios/", async () => {
    const dir = await inTempDir();
    captureConsole();

    await createProgram().parseAsync([
      "node",
      "pome",
      "scenarios",
      "github",
      "--copy",
    ]);

    const scenariosDir = join(dir, "scenarios");
    const githubTwin = findTwin("github");
    expect(githubTwin).not.toBeNull();
    const githubScenarios = runnableScenarios(githubTwin!);
    for (const scenario of githubScenarios) {
      expect(existsSync(join(scenariosDir, scenario.filename))).toBe(true);
    }
    expect(readdirSync(scenariosDir).filter((f) => f.endsWith(".md"))).toHaveLength(
      githubScenarios.length,
    );
    expect(existsSync(join(scenariosDir, "00-default-seed.md"))).toBe(false);

    // Sidecar .seed.json files must be copied alongside the .md so `pome run`
    // doesn't fall back to parsing the prose ## Seed State section.
    expect(existsSync(join(scenariosDir, "01-bug-happy-path.seed.json"))).toBe(
      true,
    );
    expect(existsSync(join(scenariosDir, "05-github-identity-spoof.seed.json"))).toBe(
      true,
    );
    // 04-judge-context now ships a sidecar that pre-labels issue #1 `bug`
    // (the default seed leaves it unlabeled, which broke the scenario). --copy
    // must bring the sidecar alongside the .md.
    expect(existsSync(join(scenariosDir, "04-judge-context.seed.json"))).toBe(
      true,
    );
  });

  it("--copy copies non-github twin scenarios on demand", async () => {
    const dir = await inTempDir();
    captureConsole();

    await createProgram().parseAsync([
      "node",
      "pome",
      "scenarios",
      "stripe",
      "--copy",
    ]);

    const scenariosDir = join(dir, "scenarios");
    expect(existsSync(join(scenariosDir, "14-stripe-refund-retry.md"))).toBe(true);
    expect(existsSync(join(scenariosDir, "19-stripe-rerefund-persuasion.md"))).toBe(
      true,
    );
    expect(existsSync(join(scenariosDir, "01-bug-happy-path.md"))).toBe(false);
  });

  it("--copy preserves existing files (no overwrite without --force)", async () => {
    const dir = await inTempDir();
    captureConsole();

    const scenariosDir = join(dir, "scenarios");
    await mkdir(scenariosDir, { recursive: true });
    const stamped = "# Local edit — do not overwrite\n";
    await writeFile(join(scenariosDir, "01-bug-happy-path.md"), stamped);

    await createProgram().parseAsync([
      "node",
      "pome",
      "scenarios",
      "github",
      "--copy",
    ]);

    expect(readFileSync(join(scenariosDir, "01-bug-happy-path.md"), "utf8")).toBe(
      stamped,
    );
    expect(existsSync(join(scenariosDir, "03-already-triaged.md"))).toBe(true);
  });

  it("--copy --force overwrites existing files", async () => {
    const dir = await inTempDir();
    captureConsole();

    const scenariosDir = join(dir, "scenarios");
    await mkdir(scenariosDir, { recursive: true });
    await writeFile(
      join(scenariosDir, "01-bug-happy-path.md"),
      "# stale local copy\n",
    );

    await createProgram().parseAsync([
      "node",
      "pome",
      "scenarios",
      "github",
      "--copy",
      "--force",
    ]);

    const written = readFileSync(
      join(scenariosDir, "01-bug-happy-path.md"),
      "utf8",
    );
    expect(written).not.toBe("# stale local copy\n");
    expect(written).toContain("Scenario 01");
  });

  it("--copy --dest writes into a custom directory", async () => {
    const dir = await inTempDir();
    captureConsole();

    await createProgram().parseAsync([
      "node",
      "pome",
      "scenarios",
      "github",
      "--copy",
      "--dest",
      "custom-scenarios",
    ]);

    const customDir = join(dir, "custom-scenarios");
    expect(existsSync(join(customDir, "01-bug-happy-path.md"))).toBe(true);
    expect(existsSync(join(dir, "scenarios"))).toBe(false);
  });
});
