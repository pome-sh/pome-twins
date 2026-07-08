// SPDX-License-Identifier: Apache-2.0
// FDRS-657 / F-692 / D9 — the no-eval-in-oss gate must (a) pass on the real
// capture-only repo tree and (b) FAIL the moment a judge / matcher /
// correlator import, path, or NAME is reintroduced anywhere in the scanned
// surface (cli/src/**, cli/scripts/**, packages/**).
//
// Promoted alongside the gate itself: this test used to live against
// `cli/scripts/no-eval-in-oss.mjs` scanning only `cli/`; it now exercises the
// repo-root `scripts/no-eval-in-oss.mjs` scanning the whole OSS surface.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs gate script, no type declarations.
import { findViolations } from "../../../scripts/no-eval-in-oss.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("no-eval-in-oss gate (repo-wide)", () => {
  it("passes on the real repo tree (capture-only)", async () => {
    const violations = await findViolations(repoRoot);
    expect(violations).toEqual([]);
  });

  describe("fails on a reintroduced violation", () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), "no-eval-gate-"));
      await mkdir(join(tmp, "cli", "src", "cli"), { recursive: true });
      // A clean baseline file that must NOT trip the gate.
      await writeFile(
        join(tmp, "cli", "src", "cli", "ok.ts"),
        'import { runEval } from "./eval.js";\nexport { runEval };\n',
      );
    });

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it("catches a reintroduced local LLM judge import", async () => {
      await writeFile(
        join(tmp, "cli", "src", "cli", "bad.ts"),
        'import { callJudge } from "../evaluator/probabilistic/client.js";\ncallJudge();\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
      expect(violations.some((v: string) => /judge|evaluator/.test(v))).toBe(true);
    });

    it("catches a reintroduced deterministic matcher import", async () => {
      await writeFile(
        join(tmp, "cli", "src", "cli", "bad.ts"),
        'import { evaluateScenario } from "../evaluator/deterministic.js";\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
    });

    it("catches a reintroduced correlator import", async () => {
      await writeFile(
        join(tmp, "cli", "src", "cli", "bad.ts"),
        'import { correlateHeuristic } from "@pome-sh/correlator";\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => /correlator/.test(v))).toBe(true);
    });

    it("catches a correlator reintroduced via require()", async () => {
      await writeFile(
        join(tmp, "cli", "src", "cli", "bad.ts"),
        'const { correlateHeuristic } = require("@pome-sh/correlator");\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
      expect(violations.some((v: string) => /correlator/.test(v))).toBe(true);
    });

    it("catches a bare side-effect import of a forbidden module", async () => {
      await writeFile(
        join(tmp, "cli", "src", "cli", "bad.ts"),
        'import "@pome-sh/correlator";\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => /correlator/.test(v))).toBe(true);
    });

    it("catches an import of ANY @pome-cloud/* package", async () => {
      await writeFile(
        join(tmp, "cli", "src", "cli", "bad.ts"),
        'import { financeJudge } from "@pome-cloud/finance";\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
      expect(violations.some((v: string) => /@pome-cloud/.test(v))).toBe(true);
    });

    it("catches eval logic reintroduced OUTSIDE src/ (in cli/scripts/)", async () => {
      await mkdir(join(tmp, "cli", "scripts"), { recursive: true });
      await writeFile(
        join(tmp, "cli", "scripts", "sneaky.mjs"),
        'import { callJudge } from "../src/evaluator/probabilistic/client.js";\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("cli/scripts/sneaky.mjs"))).toBe(true);
    });

    it("catches eval logic reintroduced in repo-root scripts/ (name + import)", async () => {
      await mkdir(join(tmp, "scripts"), { recursive: true });
      // Name-stem violation: basename starts with the denied `judge` stem.
      await writeFile(
        join(tmp, "scripts", "judge-local.mjs"),
        "export const x = 1;\n",
      );
      // Import violation under a non-denied name.
      await writeFile(
        join(tmp, "scripts", "sneaky.mjs"),
        'import { callJudge } from "../cli/src/evaluator/probabilistic/client.js";\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("scripts/judge-local.mjs"))).toBe(true);
      expect(violations.some((v: string) => v.includes("scripts/sneaky.mjs"))).toBe(true);
    });

    it("catches a reappeared cli/src/evaluator tree on disk", async () => {
      await mkdir(join(tmp, "cli", "src", "evaluator"), { recursive: true });
      await writeFile(join(tmp, "cli", "src", "evaluator", "score.ts"), "export const x = 1;\n");
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => /cli\/src\/evaluator/.test(v))).toBe(true);
    });

    it("catches a reappeared packages/correlator directory", async () => {
      await mkdir(join(tmp, "packages", "correlator"), { recursive: true });
      await writeFile(join(tmp, "packages", "correlator", "index.ts"), "export const x = 1;\n");
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => /packages\/correlator/.test(v))).toBe(true);
    });

    // D9 — the module-NAME-stem denylist (correlate*/score*/judge*/verdict*)
    // catches a reintroduction under a brand-new path, not just the paths we
    // remember to deny explicitly.
    it("catches a reintroduced packages/x/src/score.ts by NAME alone (no import needed)", async () => {
      await mkdir(join(tmp, "packages", "x", "src"), { recursive: true });
      await writeFile(
        join(tmp, "packages", "x", "src", "score.ts"),
        "export const x = 1;\n", // no forbidden import — the NAME is the violation
      );
      const violations = await findViolations(tmp);
      expect(
        violations.some((v: string) => v.includes("packages/x/src/score.ts")),
      ).toBe(true);
      expect(violations.some((v: string) => /denied eval-role stem/.test(v))).toBe(true);
    });

    it.each(["correlateHeuristic.ts", "scoreRun.ts", "judgeOutput.ts", "verdictSummary.ts"])(
      "catches %s by name stem regardless of directory",
      async (name) => {
        await mkdir(join(tmp, "packages", "twin-fake", "src"), { recursive: true });
        await writeFile(join(tmp, "packages", "twin-fake", "src", name), "export const x = 1;\n");
        const violations = await findViolations(tmp);
        expect(violations.some((v: string) => v.includes(name))).toBe(true);
      },
    );

    it("does NOT flag test/fixtures dirs under packages/ (gate fixtures live there)", async () => {
      await mkdir(join(tmp, "packages", "x", "test"), { recursive: true });
      await writeFile(
        join(tmp, "packages", "x", "test", "score.test.ts"),
        'import "@pome-sh/correlator";\n',
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("does NOT flag a comment that merely mentions the old modules", async () => {
      await writeFile(
        join(tmp, "cli", "src", "cli", "comment.ts"),
        "// This used to import @pome-sh/correlator and evaluator/score.\nexport const y = 2;\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });
  });
});
