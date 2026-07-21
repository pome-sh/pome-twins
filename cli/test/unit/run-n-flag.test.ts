// SPDX-License-Identifier: Apache-2.0
// FDRS-636 — `pome run -n k` flag wiring on the hosted path:
//   - -n is an integer 1..20; invalid values are usage errors (exit 5)
//     surfaced before the doctor gate ever runs;
//   - -n is hosted-only: combining it with --local is a usage error;
//   - the DEFAULT k comes from the scenario config's `runs` field (capped at
//     20), which nothing consumed before this ticket;
//   - k=1 (explicit -n 1, or the runs default) stays EXACTLY today's
//     single-run path — no trial group, no group_id;
//   - k>1 dispatches to runTrialGroup with the effective k.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";
import { runTrialGroup } from "../../src/runner/runTrialGroup.js";
import { runScenarioHosted } from "../../src/runner/runScenarioHosted.js";

vi.mock("../../src/runner/runTrialGroup.js", () => ({
  GROUP_FINALIZE_TIMEOUT_MS: 60_000,
  runTrialGroup: vi.fn(async () => ({
    groupId: "grp_test",
    rows: [],
    exitCode: 0,
    reliabilityUrl: "https://app.pome.sh/runs/task/x",
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

const SCENARIO =
  "# Trivial\n\n## Prompt\nPretend prompt.\n\n## Success Criteria\n- [code] No unsupported endpoint was called\n";

function scenarioWithRuns(runs: number): string {
  return `${SCENARIO}\n## Config\n\`\`\`yaml\nruns: ${runs}\n\`\`\`\n`;
}

const WIRED_AGENT_SOURCE = [
  'import { withPome } from "@pome-sh/adapter-claude-sdk";',
  "withPome();",
  "const baseUrl = process.env.POME_GITHUB_REST_URL;",
  "export { baseUrl };",
].join("\n");

async function fixtureRepo(scenarioSource: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-run-n-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "scenarios"), { recursive: true });
  await writeFile(
    join(dir, "pome.json"),
    JSON.stringify({ agent: { slug: "fixture-agent" }, command: 'node -e "process.exit(0)"' }, null, 2),
  );
  await writeFile(join(dir, "src/agent.ts"), WIRED_AGENT_SOURCE);
  await writeFile(join(dir, "scenarios/scn.md"), scenarioSource, "utf8");
  return dir;
}

describe("pome run -n (FDRS-636)", () => {
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

  it.each(["0", "21", "abc", "2.5"])(
    "-n %s is a usage error (exit 5) and nothing runs",
    async (bad) => {
      const dir = await fixtureRepo(SCENARIO);
      process.chdir(dir);
      await run("scenarios/scn.md", "-n", bad);
      expect(process.exitCode).toBe(5);
      expect(stderr.join("\n")).toMatch(/1-20/);
      expect(runTrialGroup).not.toHaveBeenCalled();
      expect(runScenarioHosted).not.toHaveBeenCalled();
    },
  );

  it("-n with --local is a usage error — trial groups are hosted-only", async () => {
    const dir = await fixtureRepo(SCENARIO);
    process.chdir(dir);
    await run("scenarios/scn.md", "-n", "3", "--local");
    expect(process.exitCode).toBe(5);
    expect(stderr.join("\n")).toMatch(/hosted/i);
    expect(runTrialGroup).not.toHaveBeenCalled();
  });

  it("-n 5 dispatches the hosted path to runTrialGroup with trials=5", async () => {
    const dir = await fixtureRepo(SCENARIO);
    process.chdir(dir);
    await run("scenarios/scn.md", "-n", "5");

    expect(process.exitCode ?? 0).toBe(0);
    expect(runScenarioHosted).not.toHaveBeenCalled();
    expect(runTrialGroup).toHaveBeenCalledTimes(1);
    const options = vi.mocked(runTrialGroup).mock.calls[0]![0];
    expect(options.trials).toBe(5);
    expect(options.agentCommand).toBe('node -e "process.exit(0)"');
    expect(options.agentCommandSource).toBe("pome.json");
    expect(options.hosted.apiKey).toBe("pme_test_env_key");
    expect(options.dashboardBaseUrl).toBe("https://app.pome.sh");
  }, 30_000);

  it("the scenario config's runs field is the default k (runs: 3 → 3 trials)", async () => {
    const dir = await fixtureRepo(scenarioWithRuns(3));
    process.chdir(dir);
    await run("scenarios/scn.md");

    expect(runTrialGroup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runTrialGroup).mock.calls[0]![0].trials).toBe(3);
    expect(runScenarioHosted).not.toHaveBeenCalled();
  }, 30_000);

  it("the runs-field default is capped at 20", async () => {
    const dir = await fixtureRepo(scenarioWithRuns(50));
    process.chdir(dir);
    await run("scenarios/scn.md");

    expect(runTrialGroup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runTrialGroup).mock.calls[0]![0].trials).toBe(20);
  }, 30_000);

  it("-n overrides the config runs field", async () => {
    const dir = await fixtureRepo(scenarioWithRuns(2));
    process.chdir(dir);
    await run("scenarios/scn.md", "-n", "4");

    expect(vi.mocked(runTrialGroup).mock.calls[0]![0].trials).toBe(4);
  }, 30_000);

  it("no -n and runs default (1) keeps EXACTLY today's single-run path", async () => {
    const dir = await fixtureRepo(SCENARIO);
    process.chdir(dir);
    await run("scenarios/scn.md");

    expect(runTrialGroup).not.toHaveBeenCalled();
    expect(runScenarioHosted).toHaveBeenCalledTimes(1);
    expect(process.exitCode ?? 0).toBe(0);
  }, 30_000);

  it("-n 1 also keeps the single-run path (a group of 1 would flip the reliability page off its latest-k fallback)", async () => {
    const dir = await fixtureRepo(scenarioWithRuns(5));
    process.chdir(dir);
    await run("scenarios/scn.md", "-n", "1");

    expect(runTrialGroup).not.toHaveBeenCalled();
    expect(runScenarioHosted).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("the group exit code propagates as the command's exit code", async () => {
    vi.mocked(runTrialGroup).mockResolvedValueOnce({
      groupId: "grp_test",
      rows: [],
      exitCode: 1,
      reliabilityUrl: "https://app.pome.sh/runs/task/x",
    });
    const dir = await fixtureRepo(SCENARIO);
    process.chdir(dir);
    await run("scenarios/scn.md", "-n", "2");
    expect(process.exitCode).toBe(1);
  }, 30_000);
});
