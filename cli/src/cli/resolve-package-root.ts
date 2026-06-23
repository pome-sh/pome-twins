// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the npm package root that contains `package.json` (published CLI layout or dev `src/cli`). */
export function resolvePackageRoot(importMetaUrl: string): string | undefined {
  let dir = dirname(fileURLToPath(importMetaUrl));
  // Walk up to the nearest enclosing package.json. The previous fixed-depth
  // approach broke when cli landed inside the pome monorepo: an outer
  // package.json at ../../.. would shadow cli's at ../../ for source-tree runs.
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
