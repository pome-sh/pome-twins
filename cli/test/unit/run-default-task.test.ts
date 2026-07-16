// SPDX-License-Identifier: Apache-2.0
// FDRS-645 — "run yours": bare `pome run` defaults to the demo task.
//   - default-task module: the user copy pins `runs: 5` inside the Config
//     fence, swaps the packaged maintainer comment for the user-facing one,
//     ships the seed sidecar, and never clobbers an existing copy;
//   - main.ts glue: bare `pome run` drops the copy on first use, announces
//     it, prints the moment-05 frame after the doctor + credential gates,
//     and dispatches the trial-group path with the pinned k=5 (an explicit
//     -n still wins); an explicit path never triggers any of it.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";
import {
  DEFAULT_TASK_TRIALS,
  copyAnnounceLine,
  ensureDefaultTask,
  runYoursFrameLines,
  withDefaultTrials,
  withUserCopyComment,
} from "../../src/cli/default-task.js";
import { DEMO_TASK_NAME, demoTaskPath } from "../../src/demo/task.js";
import { parseScenario, parseScenarioFile } from "../../src/scenario/parseScenario.js";
import { runTrialGroup } from "../../src/runner/runTrialGroup.js";
import { runScenarioHosted } from "../../src/runner/runScenarioHosted.js";

vi.mock("../../src/runner/runTrialGroup.js", () => ({
  GROUP_FINALIZE_TIMEOUT_MS: 60_000,
  runTrialGroup: vi.fn(async () => ({
    groupId: "grp_test",
    rows: [],
    exitCode: 0,
    reliabilityUrl: "https://app.pome.sh/runs/task/first-run-demo",
  })),
}));

vi.mock("../../src/runner/runScenarioHosted.js", () => ({
  runScenarioHosted: vi.fn(async () => ({
    scenario: { title: "Fixture", slug: "scn", config: { passThreshold: 100 } },
    runId: "ses_1",
    cloudRunId: "run_1",
    cloudDashboardUrl: "https://app.pome.sh/runs/run_1",
    artifacts: { runDir: "/tmp/runs/x" },
    score: {
      satisfaction: 100,
      passed: 1,
      failed: 0,
      skipped: 0,
      errored: 0,
      total_required: 1,
      evaluated: true,
      can_pass: true,
      results: [],
      judge_model: "test-judge",
      judge_tokens_in: null,
      judge_tokens_out: null,
    },
    exitCode: 0,
    durationMs: 1000,
  })),
}));

const EXPLICIT_SCENARIO =
  "# Trivial\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [code] No unsupported endpoint was called\n";

const WIRED_AGENT_SOURCE = [
  'import { withPome } from "@pome-sh/adapter-claude-sdk";',
  "withPome();",
  "const baseUrl = process.env.POME_GITHUB_REST_URL;",
  "export { baseUrl };",
].join("\n");

async function fixtureRepo(opts: { wired?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-run-default-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "pome.config.json"),
    JSON.stringify({ agent: { command: 'node -e "process.exit(0)"' } }, null, 2),
  );
  if (opts.wired !== false) {
    await writeFile(join(dir, "src/agent.ts"), WIRED_AGENT_SOURCE);
  } else {
    // A hardcoded production host fails the doctor routing probe.
    await writeFile(
      join(dir, "src/agent.ts"),
      'const base = "https://api.github.com";\nexport { base };',
    );
  }
  return dir;
}

describe("default-task module (FDRS-645)", () => {
  it("pins runs: 5 into the real packaged md's Config fence and the real parser reads it back", async () => {
    const raw = await readFile(demoTaskPath(), "utf8");
    const sidecar = JSON.parse(
      await readFile(demoTaskPath().replace(/\.md$/, ".seed.json"), "utf8"),
    ) as unknown;
    const pinned = withDefaultTrials(raw);
    expect(pinned.applied).toBe(true);
    const parsed = parseScenario(pinned.content, DEMO_TASK_NAME, sidecar);
    expect(parsed.config.runs).toBe(DEFAULT_TASK_TRIALS);
    // Everything the judge definition is regenerated from is untouched.
    expect(parsed.title).toBe(DEMO_TASK_NAME);
    expect(parsed.criteria.length).toBeGreaterThan(0);
    expect(parsed.prompt).toContain("POST /orders");
  });

  it("leaves a fence that already sets runs alone", () => {
    const src = "# t\n\n## Config\n```yaml\nruns: 2\ntimeout: 60\n```\n";
    const out = withDefaultTrials(src);
    expect(out.applied).toBe(true);
    expect(out.content).toBe(src);
  });

  it("reports applied=false when no Config fence exists", () => {
    const out = withDefaultTrials("# t\n\n## Prompt\nhi\n");
    expect(out.applied).toBe(false);
    expect(out.content).toBe("# t\n\n## Prompt\nhi\n");
  });

  it("swaps the packaged maintainer comment for the user-facing one", async () => {
    const raw = await readFile(demoTaskPath(), "utf8");
    const out = withUserCopyComment(raw);
    expect(out).not.toContain("CANONICAL");
    expect(out).toContain("This copy is yours.");
    // Still exactly one preamble comment, before the first section.
    expect(out.indexOf("<!--")).toBeLessThan(out.search(/^##[ \t]/m));
  });

  it("ensureDefaultTask drops md + seed sidecar once, then reuses the copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-default-task-"));
    const first = await ensureDefaultTask(dir);
    expect(first.copied).toBe(true);
    expect(first.trialsApplied).toBe(true);
    expect(existsSync(join(dir, "scenarios", "first-run-demo.md"))).toBe(true);
    expect(existsSync(join(dir, "scenarios", "first-run-demo.seed.json"))).toBe(true);

    // The dropped copy parses with the real parser: sidecar honored, k pinned.
    const parsed = await parseScenarioFile(first.path);
    expect(parsed.config.runs).toBe(DEFAULT_TASK_TRIALS);
    expect(parsed.slug).toBe(DEMO_TASK_NAME);

    const second = await ensureDefaultTask(dir);
    expect(second.copied).toBe(false);
    expect(second.path).toBe(first.path);
  });

  it("never clobbers a user-edited copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-default-task-"));
    await mkdir(join(dir, "scenarios"), { recursive: true });
    const custom = "# first-run-demo\n\n## Prompt\nmine now\n\n## Success Criteria\n- [code] x\n\n## Config\n```yaml\nruns: 2\n```\n";
    await writeFile(join(dir, "scenarios", "first-run-demo.md"), custom);
    const res = await ensureDefaultTask(dir);
    expect(res.copied).toBe(false);
    expect(await readFile(res.path, "utf8")).toBe(custom);
  });

  it("preserves a user-edited seed when only the md was deleted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-default-task-"));
    await mkdir(join(dir, "scenarios"), { recursive: true });
    const editedSeed = '{"edited":"by the user"}';
    await writeFile(
      join(dir, "scenarios", "first-run-demo.seed.json"),
      editedSeed,
    );
    const res = await ensureDefaultTask(dir);
    expect(res.copied).toBe(true);
    expect(
      await readFile(join(dir, "scenarios", "first-run-demo.seed.json"), "utf8"),
    ).toBe(editedSeed);
  });

  it("names a `scenarios`-is-a-file collision as a usage error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pome-default-task-"));
    await writeFile(join(dir, "scenarios"), "not a directory");
    await expect(ensureDefaultTask(dir)).rejects.toThrow(/exists as a file/);
  });
});

describe("bare `pome run` glue (FDRS-645)", () => {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      stderr.push(String(msg));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.exitCode = undefined;
    process.env.POME_API_KEY = "pme_test_env_key";
    vi.mocked(runTrialGroup).mockClear();
    vi.mocked(runScenarioHosted).mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.POME_API_KEY;
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  async function run(...args: string[]): Promise<void> {
    await createProgram().parseAsync(["node", "pome", "run", ...args]);
  }

  it("bare run drops the copy, announces it, frames, and dispatches k=5", async () => {
    const dir = await fixtureRepo();
    process.chdir(dir);
    await run();

    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync(join(dir, "scenarios", "first-run-demo.md"))).toBe(true);
    expect(existsSync(join(dir, "scenarios", "first-run-demo.seed.json"))).toBe(true);

    const err = stderr.join("\n");
    expect(err).toContain("copied the demo task into");
    for (const line of runYoursFrameLines()) expect(err).toContain(line);

    expect(runScenarioHosted).not.toHaveBeenCalled();
    expect(runTrialGroup).toHaveBeenCalledTimes(1);
    const options = vi.mocked(runTrialGroup).mock.calls[0]![0];
    expect(options.trials).toBe(DEFAULT_TASK_TRIALS);
    expect(options.scenarioPath.endsWith(join("scenarios", "first-run-demo.md"))).toBe(true);
  }, 30_000);

  it("second bare run reuses the copy without re-announcing", async () => {
    const dir = await fixtureRepo();
    process.chdir(dir);
    await run();
    stderr.length = 0;
    vi.mocked(runTrialGroup).mockClear();

    await run();
    expect(runTrialGroup).toHaveBeenCalledTimes(1);
    const err = stderr.join("\n");
    expect(err).not.toContain("copied the demo task into");
    expect(err).toContain(runYoursFrameLines()[0]);
  }, 30_000);

  it("an explicit -n beats the copy's pinned runs", async () => {
    const dir = await fixtureRepo();
    process.chdir(dir);
    await run("-n", "3");
    expect(runTrialGroup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runTrialGroup).mock.calls[0]![0].trials).toBe(3);
  }, 30_000);

  it("a user-edited copy's runs field drives the default (runs: 1 → single-run path)", async () => {
    const dir = await fixtureRepo();
    process.chdir(dir);
    await mkdir(join(dir, "scenarios"), { recursive: true });
    await writeFile(
      join(dir, "scenarios", "first-run-demo.md"),
      "# first-run-demo\n\n## Prompt\nmine\n\n## Success Criteria\n- [code] x\n\n## Config\n```yaml\nruns: 1\n```\n",
    );
    await run();
    expect(runTrialGroup).not.toHaveBeenCalled();
    expect(runScenarioHosted).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("an explicit path never announces, frames, or drops the copy", async () => {
    const dir = await fixtureRepo();
    process.chdir(dir);
    await mkdir(join(dir, "scenarios"), { recursive: true });
    await writeFile(join(dir, "scenarios", "scn.md"), EXPLICIT_SCENARIO);
    await run("scenarios/scn.md");

    expect(existsSync(join(dir, "scenarios", "first-run-demo.md"))).toBe(false);
    const err = stderr.join("\n");
    expect(err).not.toContain("copied the demo task into");
    expect(err).not.toContain(runYoursFrameLines()[0]);
    expect(runScenarioHosted).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("a failing doctor gate refuses before the frame ever prints", async () => {
    const dir = await fixtureRepo({ wired: false });
    process.chdir(dir);
    await run();

    expect(process.exitCode).toBe(1);
    const err = stderr.join("\n");
    expect(err).toContain("wiring check failed");
    expect(err).not.toContain(runYoursFrameLines()[0]);
    expect(runTrialGroup).not.toHaveBeenCalled();
    expect(runScenarioHosted).not.toHaveBeenCalled();
  }, 30_000);
});
