// SPDX-License-Identifier: Apache-2.0
/**
 * `pome skills install` — install the bundled pome agent skills into the
 * user's Claude Code skills directory (`~/.claude/skills/`).
 *
 * Defaults to symlinking each skill folder to the canonical source inside
 * this pome package install, matching the `npx skills` industry convention:
 * an `npm i -g @pome-sh/cli@latest` automatically updates every linked skill.
 * Pass `--copy` to fall back to independent copies (CI, Windows without
 * symlink permission, or any environment where symlinks aren't suitable).
 */
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { resolvePackageRoot } from "./resolve-package-root.js";

export interface SkillsInstallOptions {
  copy?: boolean;
  force?: boolean;
  dest?: string;
}

/** Skills shipped with this CLI. Keep in sync with `skills/<name>/`. */
export const BUNDLED_SKILLS = ["pome-setup", "pome-test"] as const;

const CLAUDE_DOWNLOAD_URL = "https://claude.com/download";

function useColor(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

function dim(s: string): string {
  return useColor() ? `\x1b[2m${s}\x1b[0m` : s;
}

function bold(s: string): string {
  return useColor() ? `\x1b[1m${s}\x1b[0m` : s;
}

interface InstallOutcome {
  installed: string[];
  skipped: string[];
  missingSources: string[];
  fellBackToCopy: string[];
}

export async function runSkillsInstall(
  opts: SkillsInstallOptions,
): Promise<void> {
  const root = resolvePackageRoot(import.meta.url);
  if (!root) {
    console.error(
      "Could not locate the installed pome package (package.json not found).",
    );
    process.exitCode = 2;
    return;
  }

  const sourceDir = join(root, "skills");
  if (!existsSync(sourceDir)) {
    console.error(
      `Bundled skills directory missing from this pome install: ${sourceDir}`,
    );
    console.error(
      "This is a packaging bug — please report at https://github.com/pome-sh/pome-twins/issues.",
    );
    process.exitCode = 2;
    return;
  }

  const destDir = await resolveDestDir(opts.dest);
  if (!destDir) {
    // resolveDestDir already printed a friendly error.
    process.exitCode = 2;
    return;
  }
  await mkdir(destDir, { recursive: true });

  const outcome = await installSkills({
    sourceDir,
    destDir,
    copy: Boolean(opts.copy),
    force: Boolean(opts.force),
  });

  const mode = opts.copy ? "copy" : "symlink";
  console.log(
    bold(
      `Installed ${outcome.installed.length} pome skill${outcome.installed.length === 1 ? "" : "s"} to ${destDir} (${mode}).`,
    ),
  );
  for (const name of outcome.installed) {
    const note = outcome.fellBackToCopy.includes(name)
      ? dim(" (copied — symlink unavailable)")
      : "";
    console.log(`  ${dim("+")} ${name}${note}`);
  }
  for (const name of outcome.skipped) {
    console.log(
      `  ${dim("-")} ${name} ${dim("(exists — pass --force to overwrite)")}`,
    );
  }
  for (const name of outcome.missingSources) {
    console.error(
      `  ${dim("!")} ${name} ${dim("(missing from this package install)")}`,
    );
  }

  if (outcome.missingSources.length > 0) {
    process.exitCode = 2;
    return;
  }

  if (outcome.installed.length > 0) {
    console.log("");
    console.log("Invoke them from your agent:");
    console.log(`  ${bold("/pome-setup")}   — wire your agent up to pome`);
    console.log(`  ${bold("/pome-test")}    — run scenarios for a registered agent`);
  }
}

async function resolveDestDir(explicit: string | undefined): Promise<string | undefined> {
  if (explicit) {
    return resolve(explicit);
  }
  const claudeHome = join(homedir(), ".claude");
  if (!existsSync(claudeHome)) {
    console.error("Couldn't find Claude Code's home directory at ~/.claude/.");
    console.error(`Install Claude Code first: ${CLAUDE_DOWNLOAD_URL}`);
    console.error(
      "Or pass --dest <dir> to install into a custom skills directory.",
    );
    return undefined;
  }
  return join(claudeHome, "skills");
}

interface InstallInput {
  sourceDir: string;
  destDir: string;
  copy: boolean;
  force: boolean;
}

async function installSkills(input: InstallInput): Promise<InstallOutcome> {
  const outcome: InstallOutcome = {
    installed: [],
    skipped: [],
    missingSources: [],
    fellBackToCopy: [],
  };

  for (const name of BUNDLED_SKILLS) {
    const src = join(input.sourceDir, name);
    const dest = join(input.destDir, name);

    if (!existsSync(join(src, "SKILL.md"))) {
      outcome.missingSources.push(name);
      continue;
    }

    if (await pathPresent(dest)) {
      if (!input.force) {
        outcome.skipped.push(name);
        continue;
      }
      await rm(dest, { recursive: true, force: true });
    }

    if (input.copy) {
      await cp(src, dest, { recursive: true });
    } else {
      try {
        await symlink(src, dest, "dir");
      } catch (err) {
        // Windows without dev-mode, restricted FS, etc. Fall back transparently.
        await cp(src, dest, { recursive: true });
        outcome.fellBackToCopy.push(name);
      }
    }
    outcome.installed.push(name);
  }

  return outcome;
}

/** lstat-based existence check — true for files, dirs, and dangling symlinks. */
async function pathPresent(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}
