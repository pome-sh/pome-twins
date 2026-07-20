// SPDX-License-Identifier: Apache-2.0
//
// Canonical first-party registration drift gate. First-party twins must be
// explicit at operational seams (contracts, bundles, images, Dependabot), but
// those explicit arrays are easy to update incompletely. This check compares
// every registration with config/first-party-twins.json and fails loudly.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const canonical = JSON.parse(read("config/first-party-twins.json")).twins;
const expected = [...canonical].sort();
const failures = [];

function compare(label, actual) {
  const sorted = [...new Set(actual)].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected [${expected.join(", ")}], got [${sorted.join(", ")}]`);
  }
}

function quotedArray(path, exportName) {
  const text = read(path);
  const match = text.match(
    new RegExp(`(?:const|export const)\\s+${exportName}\\s*=\\s*\\[([\\s\\S]*?)\\](?:\\s+as const)?`),
  );
  if (!match) throw new Error(`${path}: could not find array ${exportName}`);
  return [...match[1].matchAll(/["']([a-z][a-z0-9-]*)["']/g)].map((item) => item[1]);
}

compare(
  "packages/shared-types/src/sessions.ts MOUNTED_TWINS",
  quotedArray("packages/shared-types/src/sessions.ts", "MOUNTED_TWINS"),
);
compare(
  "packages/shared-types/src/recorder-events.ts KNOWN_TWIN_IDS",
  quotedArray("packages/shared-types/src/recorder-events.ts", "KNOWN_TWIN_IDS"),
);
compare(
  "cli/src/twin/twinStart.ts SUPPORTED_STANDALONE_TWINS",
  quotedArray("cli/src/twin/twinStart.ts", "SUPPORTED_STANDALONE_TWINS"),
);

const contractNames = [
  ...read("contract/helpers.mjs").matchAll(/\{\s*name:\s*"([a-z][a-z0-9-]*)",\s*pkg:\s*"packages\/twin-/g),
].map((match) => match[1]);
compare("contract/helpers.mjs ALL_TWINS", contractNames);
const cliContractNames = [
  ...read("contract/cli-start.test.mjs").matchAll(/cliStart\("([a-z][a-z0-9-]*)"/g),
].map((match) => match[1]);
compare("contract/cli-start.test.mjs TWINS", cliContractNames);

const imageMatch = read(".github/workflows/twin-image.yml").match(/twin:\s*\[([^\]]+)\]/);
if (!imageMatch) throw new Error(".github/workflows/twin-image.yml: twin matrix not found");
compare(
  ".github/workflows/twin-image.yml matrix",
  imageMatch[1].split(",").map((value) => value.trim()),
);

const dependabot = [
  ...read(".github/dependabot.yml").matchAll(/directory:\s*\/packages\/twin-([a-z][a-z0-9-]*)/g),
].map((match) => match[1]);
compare(".github/dependabot.yml docker directories", dependabot);

const cliPackage = JSON.parse(read("cli/package.json"));
compare(
  "cli/package.json dependencies",
  Object.keys(cliPackage.dependencies)
    .filter((name) => name.startsWith("@pome-sh/twin-"))
    .map((name) => name.slice("@pome-sh/twin-".length)),
);
compare(
  "cli/package.json bundleDependencies",
  cliPackage.bundleDependencies
    .filter((name) => name.startsWith("@pome-sh/twin-"))
    .map((name) => name.slice("@pome-sh/twin-".length)),
);

const packed = [
  ...read("scripts/pack-publishable.mjs").matchAll(/"packages\/twin-([a-z][a-z0-9-]*)"/g),
].map((match) => match[1]);
compare("scripts/pack-publishable.mjs packageDirs", packed);

const rootPackage = JSON.parse(read("package.json"));
for (const twin of canonical) {
  if (!rootPackage.scripts.build.includes(`-w @pome-sh/twin-${twin}`)) {
    failures.push(`package.json build: missing @pome-sh/twin-${twin}`);
  }
}

for (const workflow of [
  ".github/workflows/cli-ci.yml",
  ".github/workflows/twin-image.yml",
  ".github/workflows/agent-trace-overhead-gate.yml",
]) {
  const text = read(workflow);
  for (const twin of canonical) {
    if (!text.includes(`packages/twin-${twin}/**`)) {
      failures.push(`${workflow}: missing packages/twin-${twin}/** path filter`);
    }
  }
}

const packagePublish = read(".github/workflows/sdk-publish.yml");
const cliRelease = read(".github/workflows/cli-release.yml");
for (const twin of canonical) {
  if (!packagePublish.includes(`pome-sh-twin-${twin}-*.tgz`)) {
    failures.push(`sdk-publish.yml: missing twin-${twin} publish artifact`);
  }
  if (!cliRelease.includes(`npm view @pome-sh/twin-${twin}@`)) {
    failures.push(`cli-release.yml: missing twin-${twin} dependency gate`);
  }
}

const catalogIds = [
  ...read("cli/src/cli/scenarios-catalog.ts").matchAll(/^\s{4}id:\s*"([a-z][a-z0-9-]*)",$/gm),
].map((match) => match[1]);
compare("cli/src/cli/scenarios-catalog.ts SCENARIO_TWINS", catalogIds);

if (failures.length > 0) {
  console.error("First-party twin registration drift:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`First-party twin registrations agree: ${canonical.join(", ")}`);
