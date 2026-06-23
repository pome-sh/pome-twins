// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";
import { BUNDLED_SKILLS } from "../../src/cli/skills.js";

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
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDest(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pome-skills-"));
  tempDirs.push(dir);
  return dir;
}

describe("pome skills install", () => {
  it("symlinks both bundled skills by default into --dest", async () => {
    const dest = await makeTempDest();
    const captured = captureConsole();

    await createProgram().parseAsync([
      "node",
      "pome",
      "skills",
      "install",
      "--dest",
      dest,
    ]);

    for (const name of BUNDLED_SKILLS) {
      const installed = join(dest, name);
      expect(existsSync(installed)).toBe(true);
      const stat = lstatSync(installed);
      expect(stat.isSymbolicLink()).toBe(true);
      // The symlink target should contain a SKILL.md.
      expect(existsSync(join(installed, "SKILL.md"))).toBe(true);
    }
    expect(process.exitCode).toBeFalsy();
    const out = captured.log.join("\n");
    expect(out).toContain("symlink");
    expect(out).toContain("/pome-setup");
    expect(out).toContain("/pome-test");
  });

  it("--copy writes independent copies (not symlinks)", async () => {
    const dest = await makeTempDest();
    captureConsole();

    await createProgram().parseAsync([
      "node",
      "pome",
      "skills",
      "install",
      "--copy",
      "--dest",
      dest,
    ]);

    for (const name of BUNDLED_SKILLS) {
      const installed = join(dest, name);
      const stat = lstatSync(installed);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);
      expect(existsSync(join(installed, "SKILL.md"))).toBe(true);
    }
  });

  it("skips existing installs without --force", async () => {
    const dest = await makeTempDest();
    const captured = captureConsole();

    // Pre-create an existing skill folder the user has hand-edited.
    const userSkill = join(dest, "pome-setup");
    await mkdir(userSkill, { recursive: true });
    const stamped = "# user-edited copy — keep me\n";
    writeFileSync(join(userSkill, "SKILL.md"), stamped);

    await createProgram().parseAsync([
      "node",
      "pome",
      "skills",
      "install",
      "--dest",
      dest,
    ]);

    // Untouched.
    expect(readFileSync(join(userSkill, "SKILL.md"), "utf8")).toBe(stamped);
    const stat = lstatSync(userSkill);
    expect(stat.isSymbolicLink()).toBe(false);

    // The other skill still installs.
    expect(existsSync(join(dest, "pome-test"))).toBe(true);

    const out = captured.log.join("\n");
    expect(out).toContain("pome-setup");
    expect(out).toContain("exists");
  });

  it("--force overwrites existing installs (replaces with symlink)", async () => {
    const dest = await makeTempDest();
    captureConsole();

    const userSkill = join(dest, "pome-setup");
    await mkdir(userSkill, { recursive: true });
    writeFileSync(join(userSkill, "SKILL.md"), "# stale\n");

    await createProgram().parseAsync([
      "node",
      "pome",
      "skills",
      "install",
      "--force",
      "--dest",
      dest,
    ]);

    const stat = lstatSync(join(dest, "pome-setup"));
    expect(stat.isSymbolicLink()).toBe(true);

    // The symlinked SKILL.md should be the bundled one (frontmatter present).
    const content = readFileSync(
      join(dest, "pome-setup", "SKILL.md"),
      "utf8",
    );
    expect(content).toContain("name: pome-setup");
  });

  it("--force on an existing symlink replaces it (idempotent re-install)", async () => {
    const dest = await makeTempDest();
    captureConsole();

    await createProgram().parseAsync([
      "node",
      "pome",
      "skills",
      "install",
      "--dest",
      dest,
    ]);
    const firstTarget = realpathSync(join(dest, "pome-setup"));

    // Re-run with --force; should not error and result should still be a symlink.
    await createProgram().parseAsync([
      "node",
      "pome",
      "skills",
      "install",
      "--force",
      "--dest",
      dest,
    ]);

    const stat = lstatSync(join(dest, "pome-setup"));
    expect(stat.isSymbolicLink()).toBe(true);
    expect(realpathSync(join(dest, "pome-setup"))).toBe(firstTarget);
    expect(process.exitCode).toBeFalsy();
  });

  it("errors with a Claude Code install hint when ~/.claude/ is missing and --dest is not set", async () => {
    // Force os.homedir() to point at an empty tmpdir with no .claude/ subdir
    // by overriding $HOME / $USERPROFILE — os.homedir() respects these.
    const fakeHome = await makeTempDest();
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    try {
      const captured = captureConsole();
      await createProgram().parseAsync(["node", "pome", "skills", "install"]);

      expect(process.exitCode).toBe(2);
      const err = captured.error.join("\n");
      expect(err.toLowerCase()).toContain(".claude");
      expect(err).toContain("https://claude.com/download");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
    }
  });
});
