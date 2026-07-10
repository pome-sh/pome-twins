#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// FDRS-642 — build an UNWIRED copy of examples/triage-agent for the
// `pome install` manual acceptance run.
//
// The copy looks like a pre-pome repo: no adapter import, no withPome(),
// and the twin base URL replaced by a hardcoded production host
// (https://api.github.com) — exactly the finding doctor's routing scan
// names with file:line. `pome install` + the pome-setup skill should take
// this copy back to doctor-green. There is no pome.config.json either, so
// the first doctor red is "config missing" (the skill runs `pome init`),
// then the hardcoded-host red.
//
// The package.json keeps the adapter dependency, rewritten to an absolute
// file: path — pre-npm-publish the adapter only exists inside a pome-twins
// checkout, and the wiring agent should be able to `import` it without
// also having to invent the dependency line.
//
// Usage: node cli/scripts/make-unwired-fixture.mjs [dest-dir]
//   dest-dir defaults to a fresh directory under the OS tmpdir.
//   Prints the fixture path on stdout; everything else goes to stderr.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = join(repoRoot, "examples", "triage-agent");
const dest = process.argv[2]
  ? resolve(process.argv[2])
  : await mkdtemp(join(tmpdir(), "pome-unwired-"));

const SKIP_SEGMENTS = new Set(["node_modules", "runs", "test", ".pome"]);
await cp(src, dest, {
  recursive: true,
  filter: (p) => !p.split(sep).some((segment) => SKIP_SEGMENTS.has(segment)),
});

// The README documents the wired example; stale claims would just confuse
// the wiring agent. The scenario file (01-triage-acme-issues.md) stays —
// it's what `pome run` needs after the wiring lands.
await rm(join(dest, "README.md"), { force: true });
// package-lock.json may pin the adapter at a relative file: path that breaks
// outside the monorepo — drop it and let `npm install` regenerate.
await rm(join(dest, "package-lock.json"), { force: true });

// ---- src/index.ts: strip the wiring -----------------------------------

const indexPath = join(dest, "src", "index.ts");
let index = await readFile(indexPath, "utf8");

function replaceOnce(from, to, what) {
  if (!index.includes(from)) {
    console.error(`make-unwired-fixture: could not find ${what} in src/index.ts.`);
    console.error("examples/triage-agent drifted — update this script's replacements.");
    process.exit(2);
  }
  index = index.replace(from, to);
}

// 1. Neutral file header — the original names Pome throughout.
replaceOnce(
  /^\/\*\*[\s\S]*?\*\//.exec(index)?.[0] ?? "<header comment>",
  [
    "/**",
    " * triage-agent: a small Claude Agent SDK agent that triages open GitHub",
    " * issues — for each open issue it picks one of `bug` / `feature` /",
    " * `question`, applies the label, and posts a one-sentence comment",
    " * explaining the choice.",
    " */",
  ].join("\n"),
  "the file header comment",
);

// 2. Adapter import (+ its doc comment) → plain SDK import.
replaceOnce(
  [
    "// F0-4 / L7 — overlay pome adapter signals on the Claude Agent SDK trace.",
    "// `withPome()` installs a `globalThis.fetch` hook that emits",
    "// `ToolUseEvent` / `HookEvent` / `SubagentSpawnEvent` rows to",
    "// `POME_ADAPTER_SIGNALS_PATH` (Pome CLI injects this env var) and a",
    "// `x-pome-correlation-id` header on outgoing fetches so the twin recorder",
    "// links each twin-HTTP row back to the originating tool call. `tool` and",
    "// `query` are drop-in replacements for the upstream SDK exports — the",
    "// adapter just adds the signals layer. `createSdkMcpServer` is not part of",
    "// the adapter's surface; keep importing it from the SDK directly.",
    'import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";',
    'import { query, tool, withPome } from "@pome-sh/adapter-claude-sdk";',
  ].join("\n"),
  'import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";',
  "the adapter import block",
);

// 3. The startup hook (and the import.meta.main comments that name pome).
replaceOnce(
  [
    "// Only run the agent when executed directly (`npx tsx src/index.ts`). Guarding",
    "// on `import.meta.main` keeps the module importable — e.g. by the secret-path",
    "// unit test — without kicking off a full agent run on import.",
    "if (import.meta.main) {",
    "  // Install the pome fetch-hook only for a real run — keeps the module free of",
    "  // import-time side effects (the secret-path unit test imports it).",
    "  withPome();",
    "  await main();",
    "}",
  ].join("\n"),
  ["if (import.meta.main) {", "  await main();", "}"].join("\n"),
  "the withPome() startup block",
);

// 4. Env-injected base URL → hardcoded production host. This is the exact
// line doctor's routing scan (PRODUCTION_HOSTS) names as the cause.
replaceOnce(
  'const TWIN_BASE_URL = process.env.POME_TWIN_BASE_URL ?? "http://127.0.0.1:3333";',
  'const TWIN_BASE_URL = "https://api.github.com";',
  "the TWIN_BASE_URL env read",
);
replaceOnce(
  "const MCP_URL = process.env.POME_GITHUB_MCP_URL ?? `${TWIN_BASE_URL}/s/${SID}/mcp`;",
  "const MCP_URL = `${TWIN_BASE_URL}/s/${SID}/mcp`;",
  "the MCP_URL env read",
);

// 5. The preflight's runner-mode gate (FDRS-667) → the unconditional probe
// a pre-pome repo would have. The gate keys off POME_GITHUB_MCP_URL, which
// must not survive unwiring.
replaceOnce(
  [
    "  // Standalone mode only: probe the docker twin's root /healthz so \"docker",
    "  // compose isn't up\" gets a direct message. When a pome runner injected",
    "  // POME_GITHUB_MCP_URL there is no loopback twin — TWIN_BASE_URL falls back",
    "  // to 127.0.0.1:3333 and hosted `pome run` died here probing it (FDRS-667).",
    "  // The authenticated ${MCP_URL}/tools probe below already covers",
    "  // reachability + auth in every mode.",
    "  if (!process.env.POME_GITHUB_MCP_URL) {",
    "    const healthUrl = `${TWIN_BASE_URL.replace(/\\/$/, \"\")}/healthz`;",
    "    const res = await fetch(healthUrl).catch((err) => {",
    "      throw new Error(`twin not reachable at ${healthUrl}: ${err instanceof Error ? err.message : String(err)}`);",
    "    });",
    "    if (!res.ok) throw new Error(`twin healthz returned ${res.status}`);",
    "  }",
  ].join("\n"),
  [
    "  const healthUrl = `${TWIN_BASE_URL.replace(/\\/$/, \"\")}/healthz`;",
    "  const res = await fetch(healthUrl).catch((err) => {",
    "    throw new Error(`twin not reachable at ${healthUrl}: ${err instanceof Error ? err.message : String(err)}`);",
    "  });",
    "  if (!res.ok) throw new Error(`twin healthz returned ${res.status}`);",
  ].join("\n"),
  "the preflight runner-mode healthz gate",
);

for (const leftover of ["withPome", "@pome-sh/adapter", "POME_TWIN_BASE_URL", "POME_GITHUB_MCP_URL"]) {
  if (index.includes(leftover)) {
    console.error(`make-unwired-fixture: "${leftover}" still present after unwiring — update this script.`);
    process.exit(2);
  }
}
await writeFile(indexPath, index);

// ---- package.json: keep the adapter resolvable from the copy ----------

const pkgPath = join(dest, "package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
pkg.name = "triage-agent-unwired";
pkg.description =
  "Manual-acceptance fixture (FDRS-642): examples/triage-agent with the pome wiring stripped.";
pkg.dependencies["@pome-sh/adapter-claude-sdk"] = `file:${join(repoRoot, "packages", "adapter-claude-sdk")}`;
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// npm packs file: deps at install time, so the adapter's dist must exist
// BEFORE the fixture's `npm install` — otherwise the wired agent dies at
// import with "Cannot find module ./dist/index.js" (the FDRS-658 class of
// failure). Build it here if this checkout hasn't yet.
const adapterDir = join(repoRoot, "packages", "adapter-claude-sdk");
if (!existsSync(join(adapterDir, "dist", "index.js"))) {
  console.error("adapter dist missing — building @pome-sh/adapter-claude-sdk …");
  try {
    await execFileAsync("npm", ["run", "build", "-w", "@pome-sh/adapter-claude-sdk"], {
      cwd: repoRoot,
    });
  } catch (err) {
    console.error(`adapter build failed: ${err instanceof Error ? err.message : err}`);
    console.error(
      `run \`npm run build -w @pome-sh/adapter-claude-sdk\` before \`npm install\` in the fixture.`,
    );
  }
}

console.log(dest);
console.error("");
console.error("unwired fixture ready. acceptance run:");
console.error(`  cd ${dest}`);
console.error("  npm install");
console.error("  pome doctor     # red: no pome.config.json; after the skill runs pome init,");
console.error("                  # red: hardcoded https://api.github.com in src/index.ts");
console.error("  pome install    # hands off to your coding agent; approve its edits; ends green");
