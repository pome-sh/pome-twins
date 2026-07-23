// SPDX-License-Identifier: Apache-2.0
//
// F-866 example-typecheck gate. The bundled `examples/*` projects are
// standalone npm packages (each with its own lockfile), NOT workspaces, so the
// root `npm run typecheck` never covers them. That gap is how a zod-4 / Claude
// Agent SDK `tool()` typing regression sat latent until F-866. This gate
// typechecks every example that declares a `typecheck` script.
//
// The three Claude-Agent-SDK examples consume `@pome-sh/adapter-claude-sdk`
// through a local `file:` link, so the adapter's `dist/` must be current before
// they can resolve its types. The gate rebuilds the adapter first (a fast
// incremental tsc) so it always reflects the adapter source in the working
// tree — a prior root `npm ci`/`npm install` must have populated node_modules.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = join(repoRoot, "examples");

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function discoverExamples() {
  const found = [];
  for (const name of readdirSync(examplesDir).sort()) {
    const pkgPath = join(examplesDir, name, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.scripts?.typecheck) found.push(name);
  }
  return found;
}

const examples = discoverExamples();
if (examples.length === 0) {
  console.error("No examples with a `typecheck` script found.");
  process.exit(1);
}

// Build the adapter so the file:-linked examples typecheck against current source.
console.log("Building @pome-sh/adapter-claude-sdk…");
try {
  run("npm", ["run", "build", "-w", "@pome-sh/adapter-claude-sdk"], repoRoot);
} catch {
  console.error(
    "Failed to build @pome-sh/adapter-claude-sdk. Run `npm ci` at the repo root first.",
  );
  process.exit(1);
}

const failures = [];
for (const name of examples) {
  const cwd = join(examplesDir, name);
  console.log(`\n=== examples/${name} ===`);
  try {
    run("npm", ["ci"], cwd);
    run("npm", ["run", "typecheck"], cwd);
    console.log(`examples/${name}: OK`);
  } catch {
    failures.push(name);
    console.error(`examples/${name}: FAILED`);
  }
}

if (failures.length > 0) {
  console.error(`\nExamples failing typecheck: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\nAll ${examples.length} examples typechecked clean.`);
