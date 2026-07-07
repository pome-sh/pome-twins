// SPDX-License-Identifier: Apache-2.0
// FDRS-661 — the terminal diff gate: shadow staging, the moment-02 render,
// [y/N] apply, path confinement, and the named-reason no-op.
//
// The SDK is faked at the query() seam: the "session" is a script that
// edits files inside whatever cwd the wiring hands it (the shadow), then
// yields SDK-shaped messages. Everything else — shadow population, git
// baseline/diff/apply, rendering — runs for real.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSdkQueryFn } from "../../src/cli/agent-sdk.js";
import {
  buildStagingCanUseTool,
  EMBEDDED_KICKOFF_PROMPT,
  runEmbeddedWiring,
  STAGING_TOOLS,
} from "../../src/cli/embedded-wiring.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixtureRepo(): Promise<string> {
  const dir = await tempDir("pome-embed-repo-");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/agent.ts"), 'const gh = "https://api.github.com";\n');
  await writeFile(join(dir, "package.json"), '{\n  "name": "fixture"\n}\n');
  return dir;
}

async function fakeSkillDir(): Promise<string> {
  const dir = await tempDir("pome-embed-skill-");
  await writeFile(join(dir, "SKILL.md"), "# pome-setup (test copy)\n");
  return dir;
}

interface SessionCapture {
  prompt?: string;
  options?: Record<string, unknown>;
  shadow?: string;
}

/** SDK-shaped fake: run `script` against the shadow, then yield a result. */
function scriptedQuery(
  capture: SessionCapture,
  script: (shadow: string) => Promise<void>,
  end: Record<string, unknown> = { type: "result", subtype: "success", result: "wired" },
): AgentSdkQueryFn {
  return ({ prompt, options }) => ({
    async *[Symbol.asyncIterator]() {
      capture.prompt = prompt;
      capture.options = options;
      capture.shadow = options.cwd as string;
      await script(options.cwd as string);
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "staging the wiring edits" }] },
      };
      yield end;
    },
  });
}

function harness() {
  const lines: string[] = [];
  const questions: string[] = [];
  return {
    lines,
    questions,
    log: (line: string) => lines.push(line),
    text: () => lines.join("\n"),
    confirm: (answer: boolean) => async (q: string) => {
      questions.push(q);
      return answer;
    },
  };
}

describe("runEmbeddedWiring (FDRS-661)", () => {
  it("stages edits in a shadow, renders the file list + diff, and applies on [y]", async () => {
    const repo = await fixtureRepo();
    const skill = await fakeSkillDir();
    const capture: SessionCapture = {};
    const h = harness();

    const outcome = await runEmbeddedWiring({
      cwd: repo,
      claudePath: "/fake/claude",
      skillSourceDir: skill,
      confirm: h.confirm(true),
      log: h.log,
      query: scriptedQuery(capture, async (shadow) => {
        // The injected knowledge layer is in place before the session runs.
        expect(existsSync(join(shadow, ".claude", "skills", "pome-setup", "SKILL.md"))).toBe(
          true,
        );
        // Repo files crossed into the shadow.
        expect(existsSync(join(shadow, "src", "agent.ts"))).toBe(true);
        await writeFile(
          join(shadow, "src", "agent.ts"),
          "const baseUrl = process.env.POME_GITHUB_REST_URL;\n",
        );
        await writeFile(join(shadow, "pome.config.json"), '{ "agent": {} }\n');
      }),
    });

    expect(outcome).toEqual({ kind: "applied", files: 2, packageJsonChanged: false });

    // The session ran in the shadow, not the repo, with the verified options.
    expect(capture.shadow).not.toBe(repo);
    expect(capture.prompt).toBe(EMBEDDED_KICKOFF_PROMPT);
    expect(capture.options).toMatchObject({
      pathToClaudeCodeExecutable: "/fake/claude",
      permissionMode: "default",
      settingSources: ["project"],
      skills: "all",
      tools: [...STAGING_TOOLS],
    });
    expect(capture.options?.tools).not.toContain("Bash");

    // Moment 02: file list, unified diff, the gate, the write confirmation.
    const text = h.text();
    expect(text).toContain("here's what it will change:");
    expect(text).toContain("modified");
    expect(text).toContain("src/agent.ts");
    expect(text).toContain("new file");
    expect(text).toContain("pome.config.json");
    expect(text).toContain("+const baseUrl = process.env.POME_GITHUB_REST_URL;");
    expect(text).toContain("✓ wrote 2 files");
    expect(h.questions).toEqual(["apply these changes? [y/N] "]);

    // The real tree changed only after the [y].
    expect(await readFile(join(repo, "src/agent.ts"), "utf8")).toContain(
      "POME_GITHUB_REST_URL",
    );
    expect(existsSync(join(repo, "pome.config.json"))).toBe(true);
  });

  it("leaves the repo untouched on [N]", async () => {
    const repo = await fixtureRepo();
    const skill = await fakeSkillDir();
    const h = harness();

    const outcome = await runEmbeddedWiring({
      cwd: repo,
      claudePath: "/fake/claude",
      skillSourceDir: skill,
      confirm: h.confirm(false),
      log: h.log,
      query: scriptedQuery({}, async (shadow) => {
        await writeFile(join(shadow, "src", "agent.ts"), "changed\n");
      }),
    });

    expect(outcome).toEqual({ kind: "declined" });
    expect(await readFile(join(repo, "src/agent.ts"), "utf8")).toContain("api.github.com");
  });

  it("returns the agent's named reason when the session stages no changes", async () => {
    const repo = await fixtureRepo();
    const skill = await fakeSkillDir();
    const h = harness();

    const outcome = await runEmbeddedWiring({
      cwd: repo,
      claudePath: "/fake/claude",
      skillSourceDir: skill,
      confirm: h.confirm(true),
      log: h.log,
      query: scriptedQuery({}, async () => {}, {
        type: "result",
        subtype: "success",
        result: "this repository is already wired — pome doctor should be green.",
      }),
    });

    expect(outcome).toEqual({
      kind: "no-diff",
      reason: "this repository is already wired — pome doctor should be green.",
    });
    expect(h.questions).toEqual([]); // never asked to apply nothing
  });

  it("surfaces a session error result instead of applying anything", async () => {
    const repo = await fixtureRepo();
    const skill = await fakeSkillDir();
    const h = harness();

    const outcome = await runEmbeddedWiring({
      cwd: repo,
      claudePath: "/fake/claude",
      skillSourceDir: skill,
      confirm: h.confirm(true),
      log: h.log,
      query: scriptedQuery(
        {},
        async (shadow) => {
          await writeFile(join(shadow, "src", "agent.ts"), "half-finished\n");
        },
        { type: "result", subtype: "error_max_turns", errors: ["Reached maximum turns"] },
      ),
    });

    expect(outcome).toMatchObject({ kind: "session-error" });
    expect((outcome as { reason: string }).reason).toContain("Reached maximum turns");
    expect(await readFile(join(repo, "src/agent.ts"), "utf8")).toContain("api.github.com");
  });

  it("keeps .claude writes out of the diff and off the real repo", async () => {
    const repo = await fixtureRepo();
    const skill = await fakeSkillDir();
    const h = harness();

    const outcome = await runEmbeddedWiring({
      cwd: repo,
      claudePath: "/fake/claude",
      skillSourceDir: skill,
      confirm: h.confirm(true),
      log: h.log,
      query: scriptedQuery({}, async (shadow) => {
        await writeFile(join(shadow, ".claude", "settings.json"), '{ "sneaky": true }\n');
        await writeFile(join(shadow, "src", "agent.ts"), "wired\n");
      }),
    });

    expect(outcome).toEqual({ kind: "applied", files: 1, packageJsonChanged: false });
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(h.text()).not.toContain("settings.json");
  });

  it("reports packageJsonChanged so install can run the package manager", async () => {
    const repo = await fixtureRepo();
    const skill = await fakeSkillDir();
    const h = harness();

    const outcome = await runEmbeddedWiring({
      cwd: repo,
      claudePath: "/fake/claude",
      skillSourceDir: skill,
      confirm: h.confirm(true),
      log: h.log,
      query: scriptedQuery({}, async (shadow) => {
        await writeFile(
          join(shadow, "package.json"),
          '{\n  "name": "fixture",\n  "dependencies": { "@pome-sh/adapter-claude-sdk": "^0.1.0" }\n}\n',
        );
      }),
    });

    expect(outcome).toEqual({ kind: "applied", files: 1, packageJsonChanged: true });
  });

  it("flags a nested package.json too (workspace wiring)", async () => {
    const repo = await fixtureRepo();
    await mkdir(join(repo, "packages", "app"), { recursive: true });
    await writeFile(join(repo, "packages", "app", "package.json"), '{ "name": "app" }\n');
    const skill = await fakeSkillDir();
    const h = harness();

    const outcome = await runEmbeddedWiring({
      cwd: repo,
      claudePath: "/fake/claude",
      skillSourceDir: skill,
      confirm: h.confirm(true),
      log: h.log,
      query: scriptedQuery({}, async (shadow) => {
        await writeFile(
          join(shadow, "packages", "app", "package.json"),
          '{ "name": "app", "dependencies": { "@pome-sh/adapter-claude-sdk": "^0.1.0" } }\n',
        );
      }),
    });

    expect(outcome).toEqual({ kind: "applied", files: 1, packageJsonChanged: true });
  });

  it("respects .gitignore when the repo is a git repo (secrets never reach the shadow)", async () => {
    const repo = await fixtureRepo();
    await writeFile(join(repo, ".gitignore"), ".env\n");
    await writeFile(join(repo, ".env"), "SECRET=1\n");
    await writeFile(join(repo, "untracked-note.md"), "untracked but not ignored\n");
    await execFileAsync("git", ["init", "-q"], { cwd: repo });
    const skill = await fakeSkillDir();
    const h = harness();
    let sawEnv: boolean | null = null;
    let sawUntracked: boolean | null = null;

    await runEmbeddedWiring({
      cwd: repo,
      claudePath: "/fake/claude",
      skillSourceDir: skill,
      confirm: h.confirm(false),
      log: h.log,
      query: scriptedQuery({}, async (shadow) => {
        sawEnv = existsSync(join(shadow, ".env"));
        sawUntracked = existsSync(join(shadow, "untracked-note.md"));
        await writeFile(join(shadow, "src", "agent.ts"), "changed\n");
      }),
    });

    expect(sawEnv).toBe(false);
    expect(sawUntracked).toBe(true);
  });

  it("never copies symlinks into the shadow (git and non-git repos alike)", async () => {
    // A tracked symlink copied verbatim would carry a pointer out of the
    // shadow that Read/Write could follow past the path fence.
    const outside = await tempDir("pome-embed-outside-");
    await writeFile(join(outside, "secret.txt"), "outside the shadow\n");
    const skill = await fakeSkillDir();

    for (const gitRepo of [false, true]) {
      const repo = await fixtureRepo();
      const { symlink } = await import("node:fs/promises");
      await symlink(join(outside, "secret.txt"), join(repo, "leak.txt"));
      if (gitRepo) {
        await execFileAsync("git", ["init", "-q"], { cwd: repo });
      }
      const h = harness();
      let sawLink: boolean | null = null;

      await runEmbeddedWiring({
        cwd: repo,
        claudePath: "/fake/claude",
        skillSourceDir: skill,
        confirm: h.confirm(false),
        log: h.log,
        query: scriptedQuery({}, async (shadow) => {
          sawLink = existsSync(join(shadow, "leak.txt"));
          await writeFile(join(shadow, "src", "agent.ts"), "changed\n");
        }),
      });

      expect(sawLink).toBe(false);
      expect(h.text()).toContain("symlinks stay out of the staged copy");
      expect(h.text()).toContain("leak.txt");
    }
  });
});

describe("buildStagingCanUseTool", () => {
  it("confines file paths to the shadow root", async () => {
    const root = await tempDir("pome-shadow-gate-");
    const gate = buildStagingCanUseTool(root, () => {});
    await expect(
      gate("Read", { file_path: join(root, "src/agent.ts") }),
    ).resolves.toMatchObject({ behavior: "allow" });
    await expect(gate("Read", { file_path: "/Users/someone/hello.txt" })).resolves.toMatchObject(
      { behavior: "deny" },
    );
    await expect(gate("Edit", { file_path: join(root, "..", "escape.txt") })).resolves.toMatchObject(
      { behavior: "deny" },
    );
    await expect(gate("Write", { file_path: "relative/inside.txt" })).resolves.toMatchObject({
      behavior: "allow",
    });

    // Defense in depth: a symlink that somehow appears inside the shadow
    // can't smuggle the operation outside — paths are canonicalized.
    const outside = await tempDir("pome-shadow-outside-");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(outside, "secret.txt"), join(root, "sneaky-link"));
    await expect(gate("Read", { file_path: join(root, "sneaky-link") })).resolves.toMatchObject({
      behavior: "deny",
    });
  });

  it("refuses tools outside the staging whitelist, Bash above all", async () => {
    const root = await tempDir("pome-shadow-gate-");
    const gate = buildStagingCanUseTool(root, () => {});
    const bash = await gate("Bash", { command: "npm install" });
    expect(bash).toMatchObject({ behavior: "deny" });
    expect((bash as { message: string }).message).toContain("staging session");
    await expect(gate("WebFetch", { url: "https://example.com" })).resolves.toMatchObject({
      behavior: "deny",
    });
  });

  it("logs a staged line for approved edits", async () => {
    const root = await tempDir("pome-shadow-gate-");
    const lines: string[] = [];
    const gate = buildStagingCanUseTool(root, (l) => lines.push(l));
    await gate("Edit", { file_path: join(root, "src/agent.ts") });
    expect(lines.join("\n")).toContain("staged src/agent.ts");
  });
});
