// SPDX-License-Identifier: Apache-2.0
// FDRS-642 — `pome install` orchestration: the auth branch, agent detection
// with the no-agent fallback, the git-as-undo guard, skill ensure, the
// interactive handoff, and the doctor verify that owns the ending.
//
// The agent session is a fake `claude` shell script placed on a stubbed
// PATH: detection, spawn, and the kickoff prompt are exercised for real;
// only the LLM is fake. Doctor runs the real engine against tmp fixture
// repos (run-doctor-gate.test.ts pattern).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSdkQueryFn } from "../../src/cli/agent-sdk.js";
import {
  detectAgent,
  KICKOFF_PROMPT,
  lockfilePackageManager,
  PASTE_PROMPT,
  runInstall,
} from "../../src/cli/install.js";
import { createProgram } from "../../src/cli/main.js";

const execFileAsync = promisify(execFile);

const API_URL = "https://api.pome.test";
const DASHBOARD_URL = "https://app.pome.test";

const WIRED_SOURCE = [
  'import { withPome } from "@pome-sh/adapter-claude-sdk";',
  "withPome();",
  "const baseUrl = process.env.POME_GITHUB_REST_URL;",
  "export { baseUrl };",
].join("\n");

const UNWIRED_SOURCE = ['const gh = "https://api.github.com";', "export { gh };"].join("\n");

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A repo the doctor engine can walk: config + one agent source file. */
async function fixtureRepo(agentSource: string): Promise<string> {
  const dir = await tempDir("pome-install-repo-");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "pome.config.json"),
    JSON.stringify({ agent: { command: 'node -e "process.exit(0)"' } }, null, 2),
  );
  await writeFile(join(dir, "src/agent.ts"), agentSource);
  return dir;
}

/** A stubbed HOME with ~/.claude present so runSkillsInstall has a dest. */
async function fakeHome(): Promise<string> {
  const home = await tempDir("pome-install-home-");
  await mkdir(join(home, ".claude"), { recursive: true });
  return home;
}

/** A PATH dir holding a fake `claude` that records its first argument. */
async function fakeClaudeBin(): Promise<{ binDir: string; argsFile: string }> {
  const binDir = await tempDir("pome-install-bin-");
  const argsFile = join(binDir, "claude-args.txt");
  await writeFile(
    join(binDir, "claude"),
    `#!/bin/sh\nprintf '%s' "$1" > "${argsFile}"\nexit 0\n`,
    { mode: 0o755 },
  );
  return { binDir, argsFile };
}

describe("pome install (FDRS-642)", () => {
  let stderrLines: string[];

  const stderrText = () => stderrLines.join("\n");

  beforeEach(() => {
    stderrLines = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrLines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("registers a top-level install command with --api-url/--dashboard-url", () => {
    const install = createProgram().commands.find((c) => c.name() === "install");
    expect(install).toBeDefined();
    const flags = install!.options.map((o) => o.long);
    expect(flags).toContain("--api-url");
    expect(flags).toContain("--dashboard-url");
  });

  it("refuses when stdin is not a TTY", async () => {
    await runInstall({ apiUrl: API_URL, dashboardUrl: DASHBOARD_URL, stdinIsTTY: false });
    expect(process.exitCode).toBe(2);
    expect(stderrText()).toContain("pome install is interactive");
  });

  it("passes auth silently with POME_API_KEY and prints the manual fallback when no agent is on PATH", async () => {
    const emptyBin = await tempDir("pome-install-emptybin-");
    vi.stubEnv("PATH", emptyBin);
    vi.stubEnv("POME_API_KEY", "pme_test");
    vi.stubEnv("POME_CLI_DISABLE_KEYCHAIN", "1");
    const login = vi.fn(async () => {});

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      login,
    });

    expect(login).not.toHaveBeenCalled();
    const text = stderrText();
    expect(text).toContain("✓ signed in");
    expect(text).toContain("no coding agent found on PATH");
    // Both halves of the fallback: manual steps + the paste-anywhere prompt.
    expect(text).toContain("pome doctor");
    expect(text).toContain(PASTE_PROMPT);
    expect(text).not.toContain("verifying the wiring");
    // The designed no-agent outcome, not a failure.
    expect(process.exitCode).toBeFalsy();
  });

  it("routes through pome login when no credentials exist anywhere", async () => {
    const emptyBin = await tempDir("pome-install-emptybin-");
    const missingCreds = join(await tempDir("pome-install-creds-"), "credentials.json");
    vi.stubEnv("PATH", emptyBin);
    vi.stubEnv("POME_API_KEY", "");
    vi.stubEnv("POME_CLI_DISABLE_KEYCHAIN", "1");
    const login = vi.fn(async () => {});

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      credentialsPath: missingCreds,
      login,
    });

    expect(login).toHaveBeenCalledExactlyOnceWith({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      keyName: "pome install",
    });
    expect(stderrText()).toContain("routing through pome login");
  });

  it("detects an executable claude on PATH", async () => {
    const { binDir } = await fakeClaudeBin();
    expect(detectAgent({ PATH: binDir })).toMatchObject({
      bin: "claude",
      label: "Claude Code",
      path: join(binDir, "claude"),
    });
    const emptyBin = await tempDir("pome-install-emptybin-");
    expect(detectAgent({ PATH: emptyBin })).toBeNull();
  });

  it("warns on a dirty tree and aborts before spawning when the user declines", async () => {
    const { binDir, argsFile } = await fakeClaudeBin();
    const home = await fakeHome();
    const repo = await fixtureRepo(WIRED_SOURCE);
    // git init + untracked files = a dirty tree, no commit config needed.
    await execFileAsync("git", ["init"], { cwd: repo });
    // Fake bin first so it wins detection; the rest of PATH keeps git around.
    vi.stubEnv("PATH", `${binDir}${delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("POME_API_KEY", "pme_test");
    vi.stubEnv("POME_CLI_DISABLE_KEYCHAIN", "1");
    const confirm = vi.fn(async () => false);

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      cwd: repo,
      confirm,
    });

    expect(confirm).toHaveBeenCalledOnce();
    const text = stderrText();
    expect(text).toContain("uncommitted changes");
    expect(text).toContain("aborted — nothing changed");
    // The session was never spawned and doctor never ran.
    expect(existsSync(argsFile)).toBe(false);
    expect(text).not.toContain("verifying the wiring");
    expect(process.exitCode).toBeFalsy();
  });

  it("hands off to the detected agent and verifies to green on a wired repo", async () => {
    const { binDir, argsFile } = await fakeClaudeBin();
    const home = await fakeHome();
    const repo = await fixtureRepo(WIRED_SOURCE);
    // PATH holds only the fake agent: no git → the not-a-repo warning path.
    vi.stubEnv("PATH", binDir);
    vi.stubEnv("HOME", home);
    vi.stubEnv("POME_API_KEY", "pme_test");
    vi.stubEnv("POME_CLI_DISABLE_KEYCHAIN", "1");
    const confirm = vi.fn(async () => true);

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      cwd: repo,
      confirm,
      // This test exercises the FDRS-642 interactive path — opt out of the
      // FDRS-661 headless default explicitly (the machine running the tests
      // may well have a real Claude login).
      hasClaudeLogin: () => false,
    });

    // The no-undo warning fired and was accepted.
    expect(confirm).toHaveBeenCalledOnce();
    expect(stderrText()).toContain("not a git repository");
    // The kickoff prompt reached the agent verbatim.
    expect(await readFile(argsFile, "utf8")).toBe(KICKOFF_PROMPT);
    // The skill was ensured into the (stubbed) home.
    expect(
      existsSync(join(home, ".claude", "skills", "pome-setup", "SKILL.md")),
    ).toBe(true);
    const text = stderrText();
    expect(text).toContain("handing off to Claude Code");
    expect(text).toContain("verifying the wiring …");
    expect(text).toContain("wiring verified — your agent is ready.");
    expect(text).toContain("pome run scenarios/01-bug-happy-path.md");
    expect(process.exitCode).toBeFalsy();
  }, 60_000);

  it("ends red with doctor's named cause when the session leaves the repo unwired", async () => {
    const { binDir } = await fakeClaudeBin();
    const home = await fakeHome();
    const repo = await fixtureRepo(UNWIRED_SOURCE);
    vi.stubEnv("PATH", binDir);
    vi.stubEnv("HOME", home);
    vi.stubEnv("POME_API_KEY", "pme_test");
    vi.stubEnv("POME_CLI_DISABLE_KEYCHAIN", "1");

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      cwd: repo,
      confirm: async () => true,
      // FDRS-642 interactive path — opt out of the headless default.
      hasClaudeLogin: () => false,
    });

    const text = stderrText();
    expect(text).toContain("verifying the wiring …");
    expect(text).toContain("cause");
    expect(text).toContain("api.github.com");
    expect(text).toContain("re-run pome install");
    expect(process.exitCode).toBe(1);
  }, 60_000);

  // -------------------------------------------------------------------------
  // FDRS-661 — the headless staged-diff default and its fallbacks.

  /** SDK-shaped fake: edit the shadow, then yield a result message. */
  function scriptedQuery(
    script: (shadow: string) => Promise<void>,
    end: Record<string, unknown> = { type: "result", subtype: "success", result: "wired" },
  ): AgentSdkQueryFn {
    return ({ options }) => ({
      async *[Symbol.asyncIterator]() {
        await script(options.cwd as string);
        yield end;
      },
    });
  }

  /** PATH with the fake claude first (wins detection) and the real PATH
   *  behind it — the shadow staging needs a real `git`. */
  function stubEmbeddedEnv(binDir: string, home: string): void {
    vi.stubEnv("PATH", `${binDir}${delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("POME_API_KEY", "pme_test");
    vi.stubEnv("POME_CLI_DISABLE_KEYCHAIN", "1");
  }

  it("defaults to the headless staged-diff flow and verifies to green after [y]", async () => {
    const { binDir, argsFile } = await fakeClaudeBin();
    const home = await fakeHome();
    const repo = await fixtureRepo(UNWIRED_SOURCE);
    stubEmbeddedEnv(binDir, home);
    const confirm = vi.fn(async () => true);

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      cwd: repo,
      confirm,
      hasClaudeLogin: () => true,
      acquireSdk: async () => ({
        query: scriptedQuery(async (shadow) => {
          await writeFile(join(shadow, "src/agent.ts"), WIRED_SOURCE);
        }),
      }),
    });

    const text = stderrText();
    // The staged session ran instead of the interactive handoff.
    expect(text).toContain("nothing is written until you approve the diff");
    expect(existsSync(argsFile)).toBe(false);
    // Moment 02: diff gate, then the write, then doctor to green.
    expect(text).toContain("here's what it will change:");
    expect(text).toContain("modified");
    expect(text).toContain("src/agent.ts");
    expect(text).toContain("✓ wrote 1 file");
    expect(text).toContain("verifying the wiring …");
    expect(text).toContain("wiring verified — your agent is ready.");
    // The [y] actually landed the wiring in the real repo.
    expect(await readFile(join(repo, "src/agent.ts"), "utf8")).toBe(WIRED_SOURCE);
    expect(process.exitCode).toBeFalsy();
  }, 60_000);

  it("declining the diff aborts with nothing changed", async () => {
    const { binDir } = await fakeClaudeBin();
    const home = await fakeHome();
    const repo = await fixtureRepo(UNWIRED_SOURCE);
    stubEmbeddedEnv(binDir, home);
    // Accept the no-undo guard, decline the diff.
    const answers = [true, false];
    const confirm = vi.fn(async () => answers.shift() ?? false);

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      cwd: repo,
      confirm,
      hasClaudeLogin: () => true,
      acquireSdk: async () => ({
        query: scriptedQuery(async (shadow) => {
          await writeFile(join(shadow, "src/agent.ts"), WIRED_SOURCE);
        }),
      }),
    });

    const text = stderrText();
    expect(text).toContain("aborted — nothing changed");
    expect(text).not.toContain("verifying the wiring");
    expect(await readFile(join(repo, "src/agent.ts"), "utf8")).toBe(UNWIRED_SOURCE);
    expect(process.exitCode).toBeFalsy();
  });

  it("a session that stages nothing exits 1 with the agent's named reason", async () => {
    const { binDir } = await fakeClaudeBin();
    const home = await fakeHome();
    const repo = await fixtureRepo(WIRED_SOURCE);
    stubEmbeddedEnv(binDir, home);

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      cwd: repo,
      confirm: async () => true,
      hasClaudeLogin: () => true,
      acquireSdk: async () => ({
        query: scriptedQuery(async () => {}, {
          type: "result",
          subtype: "success",
          result: "already wired — nothing to change.",
        }),
      }),
    });

    const text = stderrText();
    expect(text).toContain("the session staged no changes");
    expect(text).toContain("reason: already wired — nothing to change.");
    expect(process.exitCode).toBe(1);
  });

  it("--interactive forces the agent-session handoff even with credentials", async () => {
    const { binDir, argsFile } = await fakeClaudeBin();
    const home = await fakeHome();
    const repo = await fixtureRepo(WIRED_SOURCE);
    stubEmbeddedEnv(binDir, home);
    const acquireSdk = vi.fn();

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      interactive: true,
      cwd: repo,
      confirm: async () => true,
      hasClaudeLogin: () => true,
      acquireSdk,
    });

    expect(acquireSdk).not.toHaveBeenCalled();
    expect(await readFile(argsFile, "utf8")).toBe(KICKOFF_PROMPT);
    expect(stderrText()).toContain("handing off to Claude Code");
  }, 60_000);

  it("falls back to the interactive handoff when no Claude credentials exist", async () => {
    const { binDir, argsFile } = await fakeClaudeBin();
    const home = await fakeHome();
    const repo = await fixtureRepo(WIRED_SOURCE);
    stubEmbeddedEnv(binDir, home);

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      cwd: repo,
      confirm: async () => true,
      hasClaudeLogin: () => false,
    });

    const text = stderrText();
    expect(text).toContain("no Claude login or ANTHROPIC_API_KEY found");
    expect(await readFile(argsFile, "utf8")).toBe(KICKOFF_PROMPT);
  }, 60_000);

  it("falls back to the interactive handoff when the SDK download is declined", async () => {
    const { binDir, argsFile } = await fakeClaudeBin();
    const home = await fakeHome();
    const repo = await fixtureRepo(WIRED_SOURCE);
    stubEmbeddedEnv(binDir, home);

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      cwd: repo,
      confirm: async () => true,
      hasClaudeLogin: () => true,
      acquireSdk: async () => null,
    });

    const text = stderrText();
    expect(text).toContain("continuing with the interactive session instead");
    expect(await readFile(argsFile, "utf8")).toBe(KICKOFF_PROMPT);
  }, 60_000);

  it("registers the --interactive flag on the install command", () => {
    const install = createProgram().commands.find((c) => c.name() === "install");
    expect(install!.options.map((o) => o.long)).toContain("--interactive");
  });

  it("names the package manager from the lockfile, per directory", async () => {
    const dir = await tempDir("pome-install-lock-");
    expect(lockfilePackageManager(dir)).toBeNull();
    await writeFile(join(dir, "pnpm-lock.yaml"), "");
    expect(lockfilePackageManager(dir)).toBe("pnpm");
    await writeFile(join(dir, "bun.lock"), "");
    expect(lockfilePackageManager(dir)).toBe("bun"); // bun wins over pnpm
  });
});
