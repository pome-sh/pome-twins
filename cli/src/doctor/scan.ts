// SPDX-License-Identifier: Apache-2.0
// FDRS-634 — static routing scan: the named-cause half of doctor's routing
// check.
//
// Finds hardcoded production API hosts (file:line) that would bypass the
// POME_*_REST_URL env contract, and collects positive wiring evidence — a
// POME_*_{REST,MCP}_URL / POME_*_API_BASE read or an adapter import. The
// dynamic proof that requests reach the twin is `pome run`'s recorded trace;
// doctor stays fast, deterministic, and LLM-free, so its routing verdict is
// "would this source bypass the twin", answered statically with a nameable
// file and line.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export interface HardcodedHostFinding {
  file: string; // relative to the scanned root
  line: number; // 1-based
  host: string;
  envVar: string; // the env the code ignores by hardcoding
}

export interface WiringEvidence {
  envVar: string | null; // first POME_*_{REST,MCP}_URL / POME_*_API_BASE seen
  adapterImport: boolean; // @pome-sh/adapter-* import or withPome() call
}

export interface ScanResult {
  hardcoded: HardcodedHostFinding | null;
  wiring: WiringEvidence;
  filesScanned: number;
}

// Production hosts of the twinned services. A hardcoded one of these in
// agent source means requests would bypass the twin — exactly the failure
// the design's moment-03 card names.
const PRODUCTION_HOSTS: ReadonlyArray<{ host: string; envVar: string }> = [
  { host: "api.github.com", envVar: "POME_GITHUB_REST_URL" },
  { host: "api.stripe.com", envVar: "POME_STRIPE_REST_URL" },
  { host: "hooks.slack.com", envVar: "POME_SLACK_REST_URL" },
  { host: "slack.com/api", envVar: "POME_SLACK_REST_URL" },
  { host: "gmail.googleapis.com", envVar: "POME_GMAIL_REST_URL" },
  { host: "www.googleapis.com", envVar: "POME_GMAIL_REST_URL" },
];

const WIRING_ENV_REGEX = /POME_[A-Z0-9]+_(?:REST_URL|MCP_URL|API_BASE)/;
const ADAPTER_REGEX = /@pome-sh\/adapter-|withPome\s*\(/;

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  "runs",
  ".pome-data",
]);
const MAX_FILES = 400;
const MAX_FILE_BYTES = 1_000_000;

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("#")
  );
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0 && files.length < MAX_FILES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(join(dir, entry.name));
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      if (dot === -1 || !CODE_EXTENSIONS.has(entry.name.slice(dot))) continue;
      files.push(join(dir, entry.name));
      if (files.length >= MAX_FILES) break;
    }
  }
  return files;
}

export async function scanAgentSources(rootDir: string): Promise<ScanResult> {
  const files = await collectFiles(rootDir);
  let hardcoded: HardcodedHostFinding | null = null;
  const wiring: WiringEvidence = { envVar: null, adapterImport: false };
  let filesScanned = 0;

  for (const file of files) {
    try {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    filesScanned += 1;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isCommentLine(line)) continue;

      if (!hardcoded) {
        for (const { host, envVar } of PRODUCTION_HOSTS) {
          if (line.includes(host)) {
            hardcoded = {
              file: relative(rootDir, file),
              line: i + 1,
              host,
              envVar,
            };
            break;
          }
        }
      }

      if (wiring.envVar === null) {
        const match = WIRING_ENV_REGEX.exec(line);
        if (match) wiring.envVar = match[0];
      }
      if (!wiring.adapterImport && ADAPTER_REGEX.test(line)) {
        wiring.adapterImport = true;
      }
    }
  }

  return { hardcoded, wiring, filesScanned };
}
