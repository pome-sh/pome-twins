// SPDX-License-Identifier: Apache-2.0
//
// F-679/M6 copy-marker gate. Cross-package file copies are not allowed in OSS
// packages; shared code should move through published packages instead.
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWLIST = new Set([]);

const SCAN_DIRS = ["packages", "cli/src"];
const MARKER_RES = [
  /^\s*\/\/\s*Canonical:\s/i,
  /^\s*\/\/\s*Mirrors\s+[`'"]/i,
];

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      await walk(abs, out);
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(abs);
    }
  }
  return out;
}

const violations = [];

for (const scanDir of SCAN_DIRS) {
  const files = await walk(resolve(root, scanDir));
  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!MARKER_RES.some((re) => re.test(line))) continue;
      if (ALLOWLIST.has(rel)) continue;
      violations.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(
    `Copy-marker gate failed (${violations.length} unallowlisted marker(s)). ` +
      `Add to scripts/check-copy-markers.mjs ALLOWLIST only for intentional mirrors:\n` +
      violations.map((v) => `  - ${v}`).join("\n"),
  );
}

console.log(`Copy-marker gate passed (${ALLOWLIST.size} allowlisted mirror files).`);
