#!/usr/bin/env node
// Cross-platform replacement for `rm -rf <dest> && cp -R <src> <dest>` in the
// build script. Runs on macOS / Linux / Windows without shell assumptions.
//
// Also writes `dist/build-info.json`, baking the git SHA and ISO build
// timestamp into the published tarball (F6). CI sets POME_GIT_SHA and
// POME_BUILD_TIME ahead of `npm run build`; locally we best-effort resolve
// the SHA via `git rev-parse HEAD`. Falls back to "dev" so a contributor
// install (`npm install -g .`) still produces a working — if uninformative —
// `pome health` runtime block.

import { rm, cp, writeFile, readFile, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(__dirname, "..");

const SRC = "src/fix-prompt/prompts";
const DEST = "dist/src/fix-prompt/prompts";

await rm(DEST, { recursive: true, force: true });
await cp(SRC, DEST, { recursive: true });

await writeBuildInfo();

async function writeBuildInfo() {
  const buildInfo = {
    package: "pome-sh",
    version: await readPackageVersion(),
    git_sha: resolveGitSha(),
    build_time: process.env.POME_BUILD_TIME ?? new Date().toISOString(),
  };
  await mkdir(resolve(CLI_ROOT, "dist"), { recursive: true });
  await writeFile(
    resolve(CLI_ROOT, "dist", "build-info.json"),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
  );
}

async function readPackageVersion() {
  try {
    const raw = await readFile(resolve(CLI_ROOT, "package.json"), "utf8");
    const json = JSON.parse(raw);
    return typeof json.version === "string" ? json.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function resolveGitSha() {
  // CI sets this explicitly (cleaner than depending on a usable git checkout
  // inside the runner). Falls back to `git rev-parse` for local builds, then
  // "dev" for contributor installs that landed without a .git directory.
  if (process.env.POME_GIT_SHA) return process.env.POME_GIT_SHA;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", {
      cwd: CLI_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}
