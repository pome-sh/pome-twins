// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonical = "packages/sdk/src/admin-gate.ts";
const mirrors = [
  "packages/twin-github/src/admin-gate.ts",
  "packages/twin-stripe/src/admin-gate.ts",
];

const canonicalText = await readFile(resolve(root, canonical), "utf8");
const mismatches = [];

for (const mirror of mirrors) {
  const mirrorText = await readFile(resolve(root, mirror), "utf8");
  if (mirrorText !== canonicalText) mismatches.push(mirror);
}

if (mismatches.length > 0) {
  throw new Error(
    `Admin-gate mirrors must match ${canonical} byte-for-byte:\n${mismatches
      .map((path) => `  - ${path}`)
      .join("\n")}`,
  );
}

console.log(`Verified ${mirrors.length + 1} byte-identical admin-gate mirrors.`);
