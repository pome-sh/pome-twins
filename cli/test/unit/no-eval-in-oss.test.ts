// SPDX-License-Identifier: Apache-2.0
// FDRS-657 — the no-eval-in-oss gate must (a) pass on the real capture-only
// tree and (b) FAIL the moment a judge / matcher / correlator import is
// reintroduced.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs gate script, no type declarations.
import { findViolations } from "../../scripts/no-eval-in-oss.mjs";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("no-eval-in-oss gate", () => {
  it("passes on the real OSS CLI tree (capture-only)", async () => {
    const violations = await findViolations(cliRoot);
    expect(violations).toEqual([]);
  });

  describe("fails on a reintroduced violation", () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), "no-eval-gate-"));
      await mkdir(join(tmp, "src", "cli"), { recursive: true });
      // A clean baseline file that must NOT trip the gate.
      await writeFile(
        join(tmp, "src", "cli", "ok.ts"),
        'import { runEval } from "./eval.js";\nexport { runEval };\n',
      );
    });

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it("catches a reintroduced local LLM judge import", async () => {
      await writeFile(
        join(tmp, "src", "cli", "bad.ts"),
        'import { callJudge } from "../evaluator/probabilistic/client.js";\ncallJudge();\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
      expect(violations.some((v: string) => /judge|evaluator/.test(v))).toBe(true);
    });

    it("catches a reintroduced deterministic matcher import", async () => {
      await writeFile(
        join(tmp, "src", "cli", "bad.ts"),
        'import { evaluateScenario } from "../evaluator/deterministic.js";\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
    });

    it("catches a reintroduced correlator import", async () => {
      await writeFile(
        join(tmp, "src", "cli", "bad.ts"),
        'import { correlateHeuristic } from "@pome-sh/correlator";\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => /correlator/.test(v))).toBe(true);
    });

    it("catches a correlator reintroduced via require()", async () => {
      await writeFile(
        join(tmp, "src", "cli", "bad.ts"),
        'const { correlateHeuristic } = require("@pome-sh/correlator");\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
      expect(violations.some((v: string) => /correlator/.test(v))).toBe(true);
    });

    it("catches a bare side-effect import of a forbidden module", async () => {
      await writeFile(
        join(tmp, "src", "cli", "bad.ts"),
        'import "@pome-sh/correlator";\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => /correlator/.test(v))).toBe(true);
    });

    it("catches eval logic reintroduced OUTSIDE src/ (in scripts/)", async () => {
      await mkdir(join(tmp, "scripts"), { recursive: true });
      await writeFile(
        join(tmp, "scripts", "sneaky.mjs"),
        'import { callJudge } from "../src/evaluator/probabilistic/client.js";\n',
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("scripts/sneaky.mjs"))).toBe(true);
    });

    it("catches a reappeared src/evaluator tree on disk", async () => {
      await mkdir(join(tmp, "src", "evaluator"), { recursive: true });
      await writeFile(join(tmp, "src", "evaluator", "score.ts"), "export const x = 1;\n");
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => /src\/evaluator/.test(v))).toBe(true);
    });

    it("does NOT flag a comment that merely mentions the old modules", async () => {
      await writeFile(
        join(tmp, "src", "cli", "comment.ts"),
        "// This used to import @pome-sh/correlator and evaluator/score.\nexport const y = 2;\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });
  });
});
