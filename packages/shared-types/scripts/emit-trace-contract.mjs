// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const check = args.includes("--check");
const outPath = resolve(outIdx >= 0 ? args[outIdx + 1] : join(packageRoot, "trace-contract.json"));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
      continue;
    }
    if (entry.name.endsWith(".json")) out.push(abs);
  }
  return out;
}

const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const fixturesRoot = join(packageRoot, "test/fixtures/v1");

const contract = {
  package: pkg.name,
  version: pkg.version,
  zod: {
    range: pkg.peerDependencies.zod,
    major: 4,
  },
  exports: {
    root: "@pome-sh/shared-types",
    recorderEvents: "@pome-sh/shared-types/recorder-events",
    run: "@pome-sh/shared-types/run",
    otel: "@pome-sh/shared-types/otel",
    redaction: "@pome-sh/shared-types/redaction",
  },
  canonicalSchemas: [
    "recorderEventSchema",
    "eventSchema",
    "otelEventSchema",
    "runSchema",
  ],
  fixtures: walk(fixturesRoot)
    .map((file) => relative(packageRoot, file).replaceAll("\\", "/"))
    .sort(),
};

const body = `${JSON.stringify(contract, null, 2)}\n`;

if (check) {
  if (!existsSync(outPath)) {
    throw new Error(`${relative(packageRoot, outPath)} does not exist. Run emit:trace-contract.`);
  }
  const existing = readFileSync(outPath, "utf8");
  if (existing !== body) {
    throw new Error(`${relative(packageRoot, outPath)} is stale. Run emit:trace-contract.`);
  }
} else {
  writeFileSync(outPath, body);
}

console.log(relative(packageRoot, outPath));
