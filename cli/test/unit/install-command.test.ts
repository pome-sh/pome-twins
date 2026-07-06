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

import {
  detectAgent,
  KICKOFF_PROMPT,
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

  // FDRS-669 — install registers the agent after the session, idempotently.
  it("registers the agent after the session so the first run submits under it", async () => {
    const { binDir } = await fakeClaudeBin();
    const home = await fakeHome();
    const repo = await fixtureRepo(WIRED_SOURCE);
    vi.stubEnv("PATH", binDir);
    vi.stubEnv("HOME", home);
    vi.stubEnv("POME_API_KEY", "pme_test");
    vi.stubEnv("POME_CLI_DISABLE_KEYCHAIN", "1");
    const realFetch = globalThis.fetch;
    const agentPosts: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/agents")) {
        agentPosts.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            id: "agt_fresh",
            slug: "fixture-repo",
            display_name: "fixture-repo",
            judge_model: "google/gemini-2.5-flash",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return realFetch(input, init);
    });

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      cwd: repo,
      confirm: async () => true,
    });

    expect(agentPosts).toHaveLength(1);
    const config = JSON.parse(
      await readFile(join(repo, "pome.config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config.agentId).toBe("agt_fresh");
    expect(config.agentSlug).toBe("fixture-repo");
    const text = stderrText();
    expect(text).toContain("registered agent");
    expect(text).toContain("fixture-repo");
    expect(process.exitCode).toBeFalsy();
  }, 60_000);

  it("re-running install on a registered repo is idempotent: no duplicate agent, same slug", async () => {
    const { binDir } = await fakeClaudeBin();
    const home = await fakeHome();
    const repo = await fixtureRepo(WIRED_SOURCE);
    await writeFile(
      join(repo, "pome.config.json"),
      JSON.stringify(
        {
          agent: { command: 'node -e "process.exit(0)"' },
          agentId: "agt_existing",
          agentSlug: "already-there",
        },
        null,
        2,
      ),
    );
    vi.stubEnv("PATH", binDir);
    vi.stubEnv("HOME", home);
    vi.stubEnv("POME_API_KEY", "pme_test");
    vi.stubEnv("POME_CLI_DISABLE_KEYCHAIN", "1");
    const realFetch = globalThis.fetch;
    let agentPosts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/agents")) {
        agentPosts += 1;
        throw new Error("must not re-register");
      }
      return realFetch(input, init);
    });

    await runInstall({
      apiUrl: API_URL,
      dashboardUrl: DASHBOARD_URL,
      stdinIsTTY: true,
      cwd: repo,
      confirm: async () => true,
    });

    expect(agentPosts).toBe(0);
    const config = JSON.parse(
      await readFile(join(repo, "pome.config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config.agentId).toBe("agt_existing");
    expect(config.agentSlug).toBe("already-there");
    expect(stderrText()).toContain("already-there");
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
    });

    const text = stderrText();
    expect(text).toContain("verifying the wiring …");
    expect(text).toContain("cause");
    expect(text).toContain("api.github.com");
    expect(text).toContain("re-run pome install");
    expect(process.exitCode).toBe(1);
  }, 60_000);
});
