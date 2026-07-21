// SPDX-License-Identifier: Apache-2.0
//
// The pome MANIFEST loader (F-819, format spec F-804). Replaces the legacy
// `pome.config.json` handling — no back-compat, 0 users. The committed manifest
// is `pome.json` (canonical) with `pome.yaml` / `pome.yml` as interchangeable
// carriers of the same snake_case keys. One canonical zod schema
// (`@pome-sh/shared-types` `manifestSchema`) validates every carrier.
//
// The registered `agt_` id is deliberately NOT in the manifest — it lives in
// the gitignored `.pome/link.json` cache (see link-cache.ts). The portable
// identity is `agent.slug`; the platform resolver maps slug → id per team.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  SLUG_RE,
  deriveAgentSlug,
  manifestSchema,
  type Manifest,
} from "@pome-sh/shared-types";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { HostedOrchError } from "../hosted/errors.js";

export const MANIFEST_JSON = "pome.json";
export const MANIFEST_YAML = "pome.yaml";
export const MANIFEST_YML = "pome.yml";
/** Discovery order is fixed; a directory carrying more than one is a hard
 *  error (a repo must have exactly one manifest). */
export const MANIFEST_FILES = [MANIFEST_JSON, MANIFEST_YAML, MANIFEST_YML] as const;

export type ManifestFormat = "json" | "yaml";

export interface ManifestLocation {
  path: string;
  format: ManifestFormat;
}

export interface ManifestRead extends ManifestLocation {
  /** Validated + defaulted view — read fields off this. */
  manifest: Manifest;
  /** Pre-validation object, for format-preserving round-trip writes
   *  (`pome register --force` must not drop unrelated top-level keys). */
  raw: Record<string, unknown>;
}

const SCHEMA_URL = "https://pome.sh/schemas/v1/pome.json";
const YAML_SCHEMA_COMMENT = `# yaml-language-server: $schema=${SCHEMA_URL}`;

function formatFor(fileName: string): ManifestFormat {
  return fileName === MANIFEST_JSON ? "json" : "yaml";
}

/** Walk up from `startDir` looking for a manifest. In each directory a single
 *  manifest is required; two present (e.g. `pome.json` + `pome.yaml`) is a hard
 *  error naming both files. Returns null when none is found up to the root. */
export async function findManifestPath(
  startDir: string = process.cwd(),
): Promise<ManifestLocation | null> {
  let dir = resolve(startDir);
  for (;;) {
    const present: string[] = [];
    for (const fileName of MANIFEST_FILES) {
      if (await fileExists(join(dir, fileName))) present.push(fileName);
    }
    if (present.length > 1) {
      throw new HostedOrchError(
        `Multiple pome manifests in ${dir}: ${present.join(", ")}. Keep exactly one (pome.json is canonical).`,
      );
    }
    if (present.length === 1) {
      const fileName = present[0]!;
      return { path: join(dir, fileName), format: formatFor(fileName) };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function readManifest(
  startDir: string = process.cwd(),
): Promise<ManifestRead | null> {
  const found = await findManifestPath(startDir);
  if (!found) return null;
  const text = await readFile(found.path, "utf8");
  const raw = parseManifestText(text, found);
  const manifest = validateManifest(raw, found.path);
  return { ...found, manifest, raw };
}

export async function readRequiredManifest(
  startDir: string = process.cwd(),
): Promise<ManifestRead> {
  const read = await readManifest(startDir);
  if (!read) {
    throw new HostedOrchError(
      `No pome manifest found (${MANIFEST_JSON} or ${MANIFEST_YAML}). Run \`pome init\` first.`,
    );
  }
  return read;
}

/** Serialize a manifest object to `path` in the given format. JSON is
 *  pretty-printed with a trailing newline; YAML carries the schema pointer as a
 *  language-server comment (the `$schema` key is dropped from the YAML body). */
export async function writeManifest(
  path: string,
  format: ManifestFormat,
  data: Record<string, unknown>,
): Promise<void> {
  if (format === "json") {
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  const { $schema: _dropped, ...body } = data;
  await writeFile(path, `${YAML_SCHEMA_COMMENT}\n${stringifyYaml(body)}`);
}

function parseManifestText(
  text: string,
  found: ManifestLocation,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = found.format === "json" ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new HostedOrchError(
      `${found.path} is not valid ${found.format.toUpperCase()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HostedOrchError(`${found.path} is not a ${found.format} object`);
  }
  return parsed as Record<string, unknown>;
}

function validateManifest(
  raw: Record<string, unknown>,
  path: string,
): Manifest {
  const result = manifestSchema.safeParse(raw);
  if (result.success) return result.data;

  const slugIssue = result.error.issues.find(
    (issue) => issue.path[0] === "agent" && issue.path[1] === "slug",
  );
  if (slugIssue) {
    throw new HostedOrchError(slugErrorMessage(raw, path));
  }
  const summary = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new HostedOrchError(`Invalid pome manifest ${path}: ${summary}`);
}

/** The invalid-slug message names `SLUG_RE` and offers a slugified suggestion,
 *  derived from `agent.name` when present else the offending slug value. */
function slugErrorMessage(raw: Record<string, unknown>, path: string): string {
  const agent =
    typeof raw.agent === "object" && raw.agent !== null
      ? (raw.agent as Record<string, unknown>)
      : {};
  const name = typeof agent.name === "string" ? agent.name : "";
  const badSlug = typeof agent.slug === "string" ? agent.slug : "";
  const suggestion = deriveAgentSlug(name || badSlug);
  const base = `Invalid agent.slug in ${path}: must match ${SLUG_RE} (lowercase kebab-case, max 64 chars).`;
  return suggestion.length > 0 ? `${base} Did you mean "${suggestion}"?` : base;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
