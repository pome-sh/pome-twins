// SPDX-License-Identifier: Apache-2.0
//
// Emits manifest-schema.json from the zod manifest schema (F-818), following
// the emit-trace-contract.mjs pattern: default mode writes the file, --check
// fails if the committed file is missing or stale. Imports the TS source
// directly — node >= 23.6 strips types natively, and src/manifest.ts
// deliberately has no relative imports (only "zod"), so no build is required.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const check = args.includes("--check");
const outPath = resolve(outIdx >= 0 ? args[outIdx + 1] : join(packageRoot, "manifest-schema.json"));

const { buildManifestJsonSchema } = await import("../src/manifest.ts");

const body = `${JSON.stringify(buildManifestJsonSchema(), null, 2)}\n`;

if (check) {
  if (!existsSync(outPath)) {
    throw new Error(`${relative(packageRoot, outPath)} does not exist. Run emit:manifest-schema.`);
  }
  const existing = readFileSync(outPath, "utf8");
  if (existing !== body) {
    throw new Error(`${relative(packageRoot, outPath)} is stale. Run emit:manifest-schema.`);
  }
} else {
  writeFileSync(outPath, body);
}

console.log(relative(packageRoot, outPath));
