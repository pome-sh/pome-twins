// SPDX-License-Identifier: Apache-2.0
//
// no-eval-in-oss gate (FDRS-657 / F-692 / D9) — REPO-WIDE, consolidated.
//
// pome-twins is capture-only: it must never compute a score, call a judge, or
// correlate locally, anywhere in the OSS surface (cli/src/**, cli/scripts/**,
// packages/**). Evaluation is the product; it lives in pome-cloud. This gate
// FAILS the build when any of that reappears, in three independent ways:
//
//   1. PATH — a known deleted local-eval tree/package/file reappears on disk
//      (cli/src/evaluator, cli/src/matrix, cli/src/score, packages/correlator,
//      the retired local-scoring CLI entrypoints, ...).
//   2. NAME — any scanned file's basename matches a denied eval-role stem
//      (correlate*/score*/judge*/verdict*, case-insensitive). This catches a
//      reintroduction under a NEW path we don't remember to deny by name —
//      e.g. a fresh `packages/x/src/score.ts` — not just the historical ones.
//   3. IMPORT — any scanned file IMPORTS a forbidden module SPECIFIER: the
//      local correlator/judge/matcher packages, or ANY `@pome-cloud/*`
//      package (pome-twins, the OSS repo, must never depend on cloud-only
//      code). Matches every module-loading form — static `import ... from`,
//      `export ... from`, dynamic `import(...)`, `require(...)`, and bare
//      side-effect `import "..."` — against the SPECIFIER, so prose/comments
//      referencing the old design don't trip it.
//
// Promoted from `cli/scripts/no-eval-in-oss.mjs` (D9/F-692) — grown, not
// rewritten — and folds in the former `scripts/no-correlator-in-oss.mjs`
// (deleted; its `packages/correlator` + `@pome-sh/correlator` checks are
// subsumed by rules 1 and 3 above).
//
// ALLOWLIST (D16): file-name-stem violations may be allowlisted by relative
// path below, for a module that is GENUINELY only trace-format TYPES (no
// eval logic) and happens to collide with a denied stem. Target: EMPTY — the
// D16 renames (`score/view.ts` → `hosted/evalResultView.ts`,
// `recorder/verdictArtifact.ts` → `hosted/evalResultCache.ts`) exist
// specifically so nothing needs to be listed here. Path violations and
// import violations are NEVER allowlistable.
//
// LIMITATIONS (honest): this is a static import/path/name scanner. It cannot
// detect local evaluation logic hand-written INLINE inside an innocuously
// named, non-importing file. It does not scan `test/`, `tests/`,
// `__fixtures__/`, or `fixtures/` directories (at any depth) — those
// legitimately embed forbidden strings as gate FIXTURES (this file's own
// unit test does exactly that in a tmp dir; several packages ship
// `fixtures/` dirs of their own). The NAME rule is a PREFIX match only —
// `basename.startsWith(stem)` — so `scoreRun.ts` / `judgeOutput.ts` trip it
// but an infix like `runScorer.ts` or `myJudgeHelper.ts` does not; those rely
// on the import rule instead. This narrowness is accepted policy for the OSS
// gate (allowlist discipline over broad heuristics), not an oversight.

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Deleted logic trees / packages / entrypoints must stay gone. Paths are
// relative to the repo root.
const FORBIDDEN_PATHS = [
  "cli/src/evaluator",
  "cli/src/matrix",
  "cli/src/score",
  "cli/src/runner/correlateRun.ts",
  "cli/src/cli/render.ts",
  "cli/src/cli/matrix.ts",
  "cli/src/cli/matrix-html.ts",
  "cli/src/cli/eval-report.ts",
  "cli/src/recorder/verdictArtifact.ts",
  "packages/correlator",
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
  { re: /^@pome-cloud\//, why: "a pome-cloud-only package — pome-twins (OSS) must never depend on cloud code" },
];

// D9 — module NAME denylist. Any scanned file whose basename (without
// extension) starts with one of these stems, case-insensitively, is a
// violation regardless of import graph or directory. Catches a reintroduced
// evaluator/judge/correlator/verdict module under a name we haven't seen
// before.
const FORBIDDEN_NAME_STEMS = ["correlate", "score", "judge", "verdict"];

// D16 — allowlist by relative (repo-root) path for FILE-NAME-STEM violations
// only. Target: empty. See the module comment above.
const FILE_ALLOWLIST = new Set([]);

// Capture the module SPECIFIER from every module-loading form:
//   - static / re-export:      `... from "x"` / `... from 'x'`
//   - dynamic import:          `import("x")`
//   - CommonJS require:        `require("x")`
//   - bare side-effect import: `import "x"` (no `from`)
const IMPORT_SPECIFIER_RES = [
  /\bfrom\s*["']([^"']+)["']/g, // static import + `export ... from`
  /(?:^|[^.\w])import\s*\(\s*["']([^"']+)["']/g, // dynamic import()
  /(?:^|[^.\w])require\s*\(\s*["']([^"']+)["']/g, // require()
  /(?:^|[^.\w])import\s+["']([^"']+)["']/g, // bare side-effect `import "x"`
];

// Which directories to scan (relative to the repo root). Repo-root `scripts/`
// is included so eval logic reintroduced as e.g. `scripts/local-judge.mjs`
// (alongside the other build/CI scripts) is walked too — same coverage the
// deleted `scripts/no-correlator-in-oss.mjs` had. This gate's OWN file lives
// there; it is self-excluded from the walk (see SELF_FILE below) so its
// denylist source strings and fixtures don't self-trip.
const SCAN_DIRS = ["cli/src", "cli/scripts", "packages", "scripts"];

// This gate's own absolute path — skipped during the walk so scanning
// repo-root `scripts/` doesn't flag the denylist literals in this file.
const SELF_FILE = resolve(fileURLToPath(import.meta.url));

// File extensions to scan — TS + JS module flavors, so a reintroduced import in
// a .mjs build/CI script is caught too.
const SCANNED_EXT_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

// Directory names skipped at ANY depth while walking. test/tests/fixtures
// dirs legitimately embed forbidden strings as gate fixtures (see the
// LIMITATIONS note above); node_modules/dist are build/install output.
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "test", "tests", "__fixtures__", "fixtures"]);

/**
 * Scan the repo root for reintroduced local-evaluation logic. Returns a list
 * of human-readable violation strings (empty when the tree is clean).
 * @param {string} root Absolute path to the pome-twins repo root.
 * @returns {Promise<string[]>}
 */
export async function findViolations(root) {
  const violations = [];

  for (const rel of FORBIDDEN_PATHS) {
    if (existsSync(join(root, rel))) {
      violations.push(
        `deleted local-eval path reappeared: ${rel} — evaluation is the product; it lives in pome-cloud, never in pome-twins.`,
      );
    }
  }

  for (const relDir of SCAN_DIRS) {
    const dir = join(root, relDir);
    if (existsSync(dir) && (await stat(dir)).isDirectory()) {
      await walk(dir, root, violations);
    }
  }

  return violations;
}

async function walk(dir, root, violations) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walk(full, root, violations);
    } else if (entry.isFile() && SCANNED_EXT_RE.test(entry.name)) {
      if (resolve(full) === SELF_FILE) continue; // don't self-scan the gate
      scanFileName(full, root, violations);
      await scanFileImports(full, root, violations);
    }
  }
}

function basenameStem(fileName) {
  return fileName.replace(SCANNED_EXT_RE, "");
}

function scanFileName(file, root, violations) {
  const rel = relative(root, file).replaceAll("\\", "/");
  if (FILE_ALLOWLIST.has(rel)) return;
  const stem = basenameStem(file.split(/[\\/]/).pop()).toLowerCase();
  for (const denied of FORBIDDEN_NAME_STEMS) {
    if (stem.startsWith(denied)) {
      violations.push(
        `${rel}: file name matches denied eval-role stem "${denied}*" — evaluation is the product; capture-only modules must not be named like one.`,
      );
      return;
    }
  }
}

async function scanFileImports(file, root, violations) {
  const text = await readFile(file, "utf8");
  const rel = relative(root, file).replaceAll("\\", "/");
  // De-dupe so a single offending line matched by multiple specifier regexes
  // (or multiple forbidden patterns) is reported once per (specifier, reason).
  const seen = new Set();
  for (const specRe of IMPORT_SPECIFIER_RES) {
    specRe.lastIndex = 0;
    let match;
    while ((match = specRe.exec(text)) !== null) {
      const specifier = match[1];
      for (const { re, why } of FORBIDDEN_MODULE_PATTERNS) {
        if (!re.test(specifier)) continue;
        const key = `${specifier}|${why}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push(
          `${rel}: imports "${specifier}" → ${why}. Capture is open; evaluation is the product.`,
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
      "\npome-twins must never score, judge, or correlate locally. A verdict comes only from pome-cloud (`pome eval`, or a hosted `pome run`).",
    );
    process.exit(1);
  }
  console.log("no-eval-in-oss gate passed — pome-twins is capture-only.");
}
