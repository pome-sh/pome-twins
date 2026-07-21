// SPDX-License-Identifier: Apache-2.0
//
// `.pome/link.json` — the gitignored, machine-local resolver cache (F-819,
// spec F-804). It maps the committed `agent.slug` to the `agt_` id the platform
// resolved for it, scoped to the team that resolved it. The cache is TRUSTED
// only when its `team_id` matches the caller's team: a re-clone under the same
// team short-circuits (Champion TTHW), a fork or team switch silently
// re-resolves by slug so we never send a foreign `agt_` id.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const POME_DIR = ".pome";
export const LINK_FILE = "link.json";
const GITIGNORE_ENTRY = `${POME_DIR}/`;

export interface LinkCache {
  agent_id: string;
  team_id: string;
  resolved_at: string;
}

function linkPath(projectDir: string): string {
  return join(projectDir, POME_DIR, LINK_FILE);
}

/** Read the link cache next to a manifest. Missing or malformed → null: this
 *  is a cache, never a hard failure (a bad file just forces re-resolution). */
export async function readLinkCache(projectDir: string): Promise<LinkCache | null> {
  let text: string;
  try {
    text = await readFile(linkPath(projectDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as LinkCache).agent_id !== "string" ||
    typeof (parsed as LinkCache).team_id !== "string"
  ) {
    return null;
  }
  const { agent_id, team_id } = parsed as LinkCache;
  const resolved_at =
    typeof (parsed as LinkCache).resolved_at === "string"
      ? (parsed as LinkCache).resolved_at
      : "";
  return { agent_id, team_id, resolved_at };
}

/** Persist `.pome/link.json`, stamping `resolved_at` now. Creates `.pome/`. */
export async function writeLinkCache(
  projectDir: string,
  entry: { agent_id: string; team_id: string },
): Promise<void> {
  await mkdir(join(projectDir, POME_DIR), { recursive: true });
  const body: LinkCache = {
    agent_id: entry.agent_id,
    team_id: entry.team_id,
    resolved_at: new Date().toISOString(),
  };
  await writeFile(linkPath(projectDir), `${JSON.stringify(body, null, 2)}\n`);
}

/** The team gate: the cached id is usable only when it was resolved under the
 *  caller's own team. Any mismatch (or unknown caller team) → undefined, so the
 *  caller re-resolves by slug instead of sending a foreign `agt_` id. */
export function resolveCachedAgentId(
  cache: LinkCache | null,
  callerTeamId: string | undefined,
): string | undefined {
  if (!cache || !callerTeamId) return undefined;
  return cache.team_id === callerTeamId ? cache.agent_id : undefined;
}

/** Ensure the project's `.gitignore` ignores `.pome/`. Creates the file when
 *  absent; appends the entry when missing. Idempotent, and a bare `.pome`
 *  (no trailing slash) already counts as ignored. */
export async function ensurePomeGitignored(projectDir: string): Promise<void> {
  const path = join(projectDir, ".gitignore");
  let existing: string | null;
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existing = null;
  }
  if (existing === null) {
    await writeFile(path, `${GITIGNORE_ENTRY}\n`);
    return;
  }
  const alreadyIgnored = existing
    .split(/\r?\n/)
    .some((line) => line.trim() === GITIGNORE_ENTRY || line.trim() === POME_DIR);
  if (alreadyIgnored) return;
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${existing}${separator}${GITIGNORE_ENTRY}\n`);
}
