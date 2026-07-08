// SPDX-License-Identifier: Apache-2.0
//
// meta.json contract constants (D18.1 / F-689 remainder). `spec_version` and
// the twin package versions let cloud's ingest (a parallel PR) validate that
// a run's meta.json matches a shape it knows how to parse, and lets the
// dashboard attribute a run's captured behavior to the exact twin build that
// produced it.
//
// Versions are read from the INSTALLED twin package's own package.json
// `version` field (resolved via node module resolution), never from the
// dependency SPEC in this package's own package.json — that spec can be a
// semver range, a `workspace:*` link, or (pre-first-npm-publish / cli-ci.yml)
// a rewritten `file:...tgz` path (`scripts/use-local-pome-tarballs.mjs`).
// Reading the twin's own manifest gives the true resolved version no matter
// how the dependency was satisfied.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Bump when the meta.json SHAPE changes in a way a consumer must branch on
// (new required field, renamed key, etc.). Purely additive fields don't need
// a bump.
export const META_SPEC_VERSION = 1;

const TWIN_PACKAGE_PREFIX = "@pome-sh/twin-";
// Bound the upward package.json search so a resolution oddity can't spin.
const MAX_WALK_UP = 8;

const twinVersionCache = new Map<string, string | null>();

/** Resolve the installed twin package's OWN version by requiring the bare
 *  specifier (never a `/package.json` subpath — several twins' `exports`
 *  map restricts subpaths to `.`, so that would 404 the resolver) and
 *  walking up from the resolved entry file until a `package.json` whose
 *  `name` matches is found. Returns null when the package can't be
 *  resolved (unknown twin id) or its manifest can't be located/parsed —
 *  NEVER fabricated. */
function readInstalledTwinVersion(twinId: string): string | null {
  const pkgName = `${TWIN_PACKAGE_PREFIX}${twinId}`;
  if (twinVersionCache.has(pkgName)) return twinVersionCache.get(pkgName)!;

  let version: string | null = null;
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve(pkgName));
    for (let i = 0; i < MAX_WALK_UP; i += 1) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg.name === pkgName && typeof pkg.version === "string") {
          version = pkg.version;
          break;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* unresolvable (unknown twin id, or no node_modules reachable) */
  }

  twinVersionCache.set(pkgName, version);
  return version;
}

/** Resolve installed twin package versions for the given twin ids (e.g.
 *  `scenario.config.twins`). A twin with no resolvable installed package
 *  (unknown id, or a dev checkout that hasn't installed dependencies) is
 *  OMITTED — never fabricated. */
export function resolveTwinPackageVersions(twinIds: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of twinIds) {
    const version = readInstalledTwinVersion(id);
    if (version) out[id] = version;
  }
  return out;
}

/** Test-only escape hatch: clear the resolved-version cache. */
export function resetTwinVersionCacheForTests(): void {
  twinVersionCache.clear();
}
