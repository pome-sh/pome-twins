// SPDX-License-Identifier: Apache-2.0
// FDRS-641 — `pome run` gates on the doctor preflight: a repo failing any
// doctor check refuses to spawn the agent (before any twin/session is
// provisioned), prints the doctor output, and exits non-zero. There is no
// --force / --skip-checks escape — "pome will not run trials against a
// live API."

import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";

const SCENARIO_SRC = new URL("../../scenarios/01-bug-happy-path.md", import.meta.url).pathname;
const SCENARIO_SEED_SRC = new URL("../../scenarios/01-bug-happy-path.seed.json", import.meta.url).pathname;

async function fixtureRepo(agentSource: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-run-gate-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "scenarios"), { recursive: true });
  await writeFile(
    join(dir, "pome.config.json"),
    JSON.stringify({ agent: { command: 'node -e "process.exit(0)"' } }, null, 2),
  );
  await writeFile(join(dir, "src/agent.ts"), agentSource);
  await cp(SCENARIO_SRC, join(dir, "scenarios/01-bug-happy-path.md"));
  await cp(SCENARIO_SEED_SRC, join(dir, "scenarios/01-bug-happy-path.seed.json"));
  return dir;
}

describe("pome run — doctor preflight gate (FDRS-641)", () => {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      stderr.push(String(msg));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  it("refuses to run in a repo failing doctor, printing the named cause", async () => {
    const dir = await fixtureRepo(
      ['import fetch from "node-fetch";', 'const gh = "https://api.github.com";', "export { gh };"].join("\n"),
    );
    process.chdir(dir);

    await createProgram().parseAsync([
      "node",
      "pome",
      "run",
      "scenarios/01-bug-happy-path.md",
      "--local",
      // Keep the test hermetic under vitest: the capture-server child
      // re-invokes process.argv[1], which is vitest's fork bootstrap here.
      // The gate under test fires long before capture is a factor.
      "--no-capture",
    ]);

    expect(process.exitCode).toBe(1);
    const text = stderr.join("\n");
    expect(text).toContain("cause");
    expect(text).toContain("api.github.com");
    expect(text).toContain("refusing to spawn the agent");
    // The gate fired before any run happened: no per-scenario result lines.
    expect(text).not.toMatch(/\b(TRACE|PASS|FAIL)\b/);
  }, 30_000);

  it("runs exactly as before on a correctly wired repo", async () => {
    const dir = await fixtureRepo(
      [
        'import { withPome } from "@pome-sh/adapter-claude-sdk";',
        "withPome();",
        "const baseUrl = process.env.POME_GITHUB_REST_URL;",
        "export { baseUrl };",
      ].join("\n"),
    );
    process.chdir(dir);

    await createProgram().parseAsync([
      "node",
      "pome",
      "run",
      "scenarios/01-bug-happy-path.md",
      "--local",
      "--no-capture",
    ]);

    const text = stderr.join("\n");
    expect(text).toContain("TRACE");
    expect(process.exitCode ?? 0).toBe(0);
  }, 60_000);

  it("offers no --force / --skip-checks escape", () => {
    const run = createProgram().commands.find((c) => c.name() === "run");
    expect(run).toBeDefined();
    const flags = run!.options.map((o) => o.long);
    expect(flags).not.toContain("--force");
    expect(flags).not.toContain("--skip-checks");
  });
});
