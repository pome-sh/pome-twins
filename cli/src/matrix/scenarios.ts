// SPDX-License-Identifier: Apache-2.0
//
// Dependency-free scenario globber shared by the `pome matrix` command (grid
// printing) and the orchestrator. Accepts a directory, a single .md file, or a
// single-directory `*`-glob (e.g. `scenarios/0*.md`). Adequate for v1's flat
// scenario dirs; intentionally avoids pulling a globbing lib.
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function resolveScenarioPaths(pattern: string): Promise<string[]> {
  const resolved = resolve(pattern);

  // Plain file or directory.
  if (existsSync(resolved)) {
    const s = await stat(resolved);
    if (s.isFile()) return resolved.endsWith(".md") ? [resolved] : [];
    if (s.isDirectory()) return listMdFiles(resolved);
  }

  // Glob: only the basename may contain `*` (single-directory glob).
  const lastSlash = resolved.lastIndexOf("/");
  const dir = lastSlash >= 0 ? resolved.slice(0, lastSlash) : ".";
  const globPart = lastSlash >= 0 ? resolved.slice(lastSlash + 1) : resolved;
  if (!globPart.includes("*")) return [];
  if (!existsSync(dir)) return [];
  const re = globToRegExp(globPart);
  const entries = await readdir(dir);
  return entries
    .filter((e) => e.endsWith(".md") && re.test(e))
    .sort()
    .map((e) => join(dir, e));
}

async function listMdFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((e) => e.endsWith(".md"))
    .sort()
    .map((e) => join(dir, e));
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
