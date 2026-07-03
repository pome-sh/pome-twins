// SPDX-License-Identifier: Apache-2.0
//
// no-eval-in-oss gate (FDRS-657).
//
// The OSS CLI is CAPTURE-ONLY: it must NEVER compute a score, call a judge, or
// correlate locally. A verdict comes only from the cloud. This gate FAILS the
// build if any of that logic is reintroduced into cli/src/**:
//
//   1. The deleted local-eval trees reappear on disk
//      (src/evaluator/, src/matrix/, src/runner/correlateRun.ts, and the
//       retired local-scoring CLI entrypoints).
//   2. Any source file IMPORTS a forbidden module — the deterministic
//      matchers, the local LLM judge, the correlator, or anything under the
//      deleted evaluator/matrix trees.
//
// It matches IMPORT statements (static, `export ... from`, and dynamic
// `import(...)`), not prose, so comments referencing the old design don't trip
// it. Run from the cli/ directory: `node scripts/no-eval-in-oss.mjs`.

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Deleted logic trees / entrypoints must stay gone. Paths are relative to the
// package root (the cli/ directory).
const FORBIDDEN_PATHS = [
  "src/evaluator",
  "src/matrix",
  "src/runner/correlateRun.ts",
  "src/cli/render.ts",
  "src/cli/matrix.ts",
  "src/cli/matrix-html.ts",
  "src/cli/eval-report.ts",
];

// Matched against the MODULE SPECIFIER of an import, so a comment mentioning
// "@pome-sh/correlator" or "evaluator/score" is not a violation.
const FORBIDDEN_MODULE_PATTERNS = [
  { re: /@pome-sh\/correlator/, why: "the correlator (no local correlation in the OSS CLI)" },
  { re: /(^|\/)evaluator\//, why: "the deleted local evaluator tree" },
  { re: /(^|\/)matrix\//, why: "the deleted local-scoring matrix tree" },
  { re: /correlateRun/, why: "the deleted local correlation module" },
  { re: /probabilistic/, why: "the deleted local LLM judge" },
  { re: /deterministic/, why: "the deleted deterministic matchers" },
  { re: /twin-plugins/, why: "the deleted deterministic twin matchers" },
];

// Capture the module specifier from `from "..."` / `from '...'` and dynamic
// `import("...")`.
const IMPORT_SPECIFIER_RE =
  /(?:\bfrom\s*|(?:^|[^.\w])import\s*\(\s*)["']([^"']+)["']/g;

/**
 * Scan a package root for reintroduced local-evaluation logic. Returns a list
 * of human-readable violation strings (empty when the tree is clean).
 * @param {string} root Absolute path to the cli/ package root.
 * @returns {Promise<string[]>}
 */
export async function findViolations(root) {
  const violations = [];

  for (const rel of FORBIDDEN_PATHS) {
    if (existsSync(join(root, rel))) {
      violations.push(
        `deleted local-eval path reappeared: ${rel} — the OSS CLI must not contain local evaluation logic.`,
      );
    }
  }

  const srcDir = join(root, "src");
  if (existsSync(srcDir) && (await stat(srcDir)).isDirectory()) {
    await walk(srcDir, root, violations);
  }

  return violations;
}

async function walk(dir, root, violations) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, violations);
    } else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      await scanFile(full, root, violations);
    }
  }
}

async function scanFile(file, root, violations) {
  const text = await readFile(file, "utf8");
  const rel = relative(root, file);
  let match;
  IMPORT_SPECIFIER_RE.lastIndex = 0;
  while ((match = IMPORT_SPECIFIER_RE.exec(text)) !== null) {
    const specifier = match[1];
    for (const { re, why } of FORBIDDEN_MODULE_PATTERNS) {
      if (re.test(specifier)) {
        violations.push(
          `${rel}: imports "${specifier}" → ${why}. The OSS CLI is capture-only.`,
        );
      }
    }
  }
}

// Run as a script (not when imported by the test).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = await findViolations(root);
  if (violations.length > 0) {
    console.error("no-eval-in-oss gate FAILED — local evaluation reintroduced:\n");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\nThe OSS CLI must never score, judge, or correlate locally. A verdict comes only from the cloud (`pome eval`, or a hosted `pome run`).",
    );
    process.exit(1);
  }
  console.log("no-eval-in-oss gate passed — the OSS CLI is capture-only.");
}
