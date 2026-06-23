// SPDX-License-Identifier: Apache-2.0
//
// CLI for `bun run --filter @pome-sh/sdk emit-fidelity --twin <package>`.
// Loads the twin package, finds an exported `TwinDefinition`, and writes
// FIDELITY.md into the package directory.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { emitFidelityMarkdown } from "../src/fidelity.js";
import type { TwinDefinition } from "../src/index.js";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      twin: { type: "string", short: "t" },
      output: { type: "string", short: "o" },
      "last-verified": { type: "string" },
    },
  });

  if (!values.twin) {
    console.error(
      "Usage: emit-fidelity --twin <package-dir> [--output <path>] [--last-verified YYYY-MM-DD]"
    );
    process.exit(2);
  }

  const pkgDir = resolve(process.cwd(), values.twin);
  const entry = resolveTwinEntrypoint(pkgDir);
  const mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  const def = pickTwinDefinition(mod);
  if (!def) {
    console.error(`No exported TwinDefinition found in ${entry}`);
    process.exit(1);
  }

  const output = values.output ? resolve(process.cwd(), values.output) : resolve(pkgDir, "FIDELITY.md");
  const md = emitFidelityMarkdown(def, { lastVerified: values["last-verified"] });
  writeFileSync(output, md);
  console.log(`Wrote ${output}`);
}

function pickTwinDefinition(mod: Record<string, unknown>): TwinDefinition | undefined {
  for (const value of Object.values(mod)) {
    if (looksLikeTwinDefinition(value)) return value;
  }
  return undefined;
}

function looksLikeTwinDefinition(value: unknown): value is TwinDefinition {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.version === "string" &&
    typeof v.fidelity === "object" &&
    Array.isArray(v.tools)
  );
}

function resolveTwinEntrypoint(pkgDir: string): string {
  const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as {
    main?: string;
    exports?: unknown;
  };
  const exportsField = pkg.exports;
  let entry: string | undefined;
  if (typeof exportsField === "string") {
    entry = exportsField;
  } else if (exportsField && typeof exportsField === "object") {
    const root = (exportsField as Record<string, unknown>)["."];
    if (typeof root === "string") entry = root;
    else if (root && typeof root === "object") {
      const r = root as Record<string, unknown>;
      entry = (r.import ?? r.default ?? r.node) as string | undefined;
    }
  }
  entry ??= pkg.main ?? "src/index.ts";
  return resolve(pkgDir, entry);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
