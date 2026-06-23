// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TwinBuildInfo = {
  package: string;
  version: string;
  git_sha: string;
  build_time: string;
};

// F6 — read the CI-baked `dist/build-info.json` written by
// `scripts/copy-prompts.mjs`. The published tarball ships this file under
// `dist/`, so a `pome health` from `npm install -g pome-sh` resolves the real
// commit SHA and ISO build timestamp instead of the previous "dev"
// placeholder. Runtime env vars (POME_TWIN_GIT_SHA / POME_TWIN_VERSION /
// POME_TWIN_BUILD_TIME) still override — useful for hosted twins that bake
// versioning in via process env. Final fallback is "dev" so a contributor
// install without CI baking still produces a working response.

let cachedBakedInfo: Partial<TwinBuildInfo> | null = null;

function loadBakedInfo(): Partial<TwinBuildInfo> {
  if (cachedBakedInfo) return cachedBakedInfo;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // From `dist/src/twin-github/build-info.js`, dist/build-info.json is
    // three levels up. From the unbuilt source file the lookup misses and
    // we cleanly fall back. Walk both shapes so tests / direct tsx runs
    // also pick up a sibling-of-source generated file if one exists.
    const candidates = [
      resolve(here, "..", "..", "..", "build-info.json"),
      resolve(here, "..", "..", "build-info.json"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const raw = readFileSync(candidate, "utf8");
        cachedBakedInfo = JSON.parse(raw) as Partial<TwinBuildInfo>;
        return cachedBakedInfo;
      }
    }
  } catch {
    /* fall through */
  }
  cachedBakedInfo = {};
  return cachedBakedInfo;
}

export function twinBuildInfo(): TwinBuildInfo {
  const baked = loadBakedInfo();
  return {
    package: "@pome-sh/twin-github",
    version: process.env.POME_TWIN_VERSION ?? baked.version ?? "0.1.0",
    git_sha:
      process.env.POME_TWIN_GIT_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      baked.git_sha ??
      "dev",
    build_time:
      process.env.POME_TWIN_BUILD_TIME ?? baked.build_time ?? "dev",
  };
}
