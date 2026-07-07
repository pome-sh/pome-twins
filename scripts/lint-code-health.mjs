// SPDX-License-Identifier: Apache-2.0
//
// F-679 code-health gates: barrel policy + file-size tripwire.
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE_SIZE_LIMIT = 500;
const FILE_SIZE_HEADER = /^\/\/\s*file-size:\s*.+/;

const BARREL_PATHS = [
  "packages/twin-github/src/index.ts",
  "packages/twin-slack/src/index.ts",
  "packages/twin-stripe/src/index.ts",
  "packages/adapter-claude-sdk/src/index.ts",
];

// Existing large modules — shrink this list as files are split (F-679).
const FILE_SIZE_ALLOWLIST = new Set([
  "cli/src/cli/main.ts",
  "cli/src/cli/eval.ts",
  "cli/src/cli/embedded-wiring.ts",
  "cli/src/cli/install.ts",
  "cli/src/hosted/client.ts",
  "cli/src/runner/runScenarioHosted.ts",
  "packages/shared-types/src/index.ts",
  "packages/shared-types/src/otel/fixtures/data.ts",
  "packages/twin-github/src/app.ts",
  "packages/twin-github/src/domain.ts",
  "packages/twin-github/src/serializers.ts",
  "packages/twin-github/src/tools.ts",
  "packages/twin-slack/src/domain.ts",
  "packages/twin-stripe/src/x402.ts",
]);

const SIZE_SCAN_DIRS = [
  "packages/twin-github/src",
  "packages/twin-slack/src",
  "packages/twin-stripe/src",
  "packages/shared-types/src",
  "packages/sdk/src",
  "packages/adapter-claude-sdk/src",
  "cli/src",
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

function checkBarrel(relPath, text) {
  const violations = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) {
      continue;
    }
    if (line.startsWith("export ")) continue;
    if (line.startsWith("} from ")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*,?$/.test(line)) continue;
    if (line === "};" || line === "}") continue;
    violations.push(line);
  }
  if (violations.length > 0) {
    throw new Error(
      `${relPath}: barrel index must re-export only (found logic/prose):\n` +
        violations.map((line) => `  - ${line}`).join("\n"),
    );
  }
}

function checkFileSize(relPath, text) {
  if (FILE_SIZE_ALLOWLIST.has(relPath)) return;
  const lines = text.split("\n").length;
  if (lines <= FILE_SIZE_LIMIT) return;
  const firstLine = text.split("\n")[0] ?? "";
  if (FILE_SIZE_HEADER.test(firstLine)) return;
  throw new Error(
    `${relPath}: ${lines} lines exceeds ${FILE_SIZE_LIMIT} LOC — add a // file-size: reason header or split the module`,
  );
}

for (const rel of BARREL_PATHS) {
  const text = await readFile(resolve(root, rel), "utf8");
  checkBarrel(rel, text);
}

for (const scanDir of SIZE_SCAN_DIRS) {
  const files = await walk(resolve(root, scanDir));
  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    const text = await readFile(file, "utf8");
    checkFileSize(rel, text);
  }
}

console.log("Code-health gates passed (barrel policy + file-size tripwire).");
