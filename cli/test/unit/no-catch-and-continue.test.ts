// SPDX-License-Identifier: Apache-2.0
// F-745 / D4 — the no-catch-and-continue gate must (a) pass on the real SDK
// engine tree (every catch there rethrows, returns an error/sentinel, rejects,
// or is a documented fingerprint-allowlisted fall-through) and (b) FAIL the
// moment a statement-level catch clause in packages/sdk/src swallows a failure
// without throwing, returning, or rejecting. Promise `.catch(cb)` handlers are
// OUT of scope. Exit keywords are strict: `.throw(`/`.return(`/`.reject(`
// property calls and identifiers like `throwaway`/`returnValue` do NOT count.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs gate script, no type declarations.
import { findViolations } from "../../../scripts/no-catch-and-continue.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("no-catch-and-continue gate (SDK engine)", () => {
  it("passes on the real SDK engine tree", async () => {
    const violations = await findViolations(repoRoot);
    expect(violations).toEqual([]);
  });

  describe("tmp-dir fixtures", () => {
    let tmp: string;
    let engineDir: string;

    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), "no-catch-gate-"));
      engineDir = join(tmp, "packages", "sdk", "src");
      await mkdir(engineDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    const write = (name: string, body: string) => writeFile(join(engineDir, name), body);

    it("flags an empty catch (a)", async () => {
      await write("bad.ts", "export function f() {\n  try {\n    risky();\n  } catch {\n  }\n}\n");
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
    });

    it("flags a log-only catch (b)", async () => {
      await write(
        "bad.ts",
        "export function f() {\n  try {\n    risky();\n  } catch (e) {\n    console.error(e);\n  }\n}\n",
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
    });

    it("accepts a catch that throws (c)", async () => {
      await write(
        "ok.ts",
        "export function f() {\n  try {\n    risky();\n  } catch (e) {\n    throw new Error(String(e));\n  }\n}\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("accepts a catch that returns (d)", async () => {
      await write(
        "ok.ts",
        "export function f(): number | undefined {\n  try {\n    return risky();\n  } catch {\n    return undefined;\n  }\n}\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("ignores the word catch inside a comment or string (e)", async () => {
      await write(
        "ok.ts",
        [
          "// this comment mentions catch but is not a catch clause { }",
          'const s = "we catch nothing here { }";',
          "const t = `template catch { }`;",
          "export const x = 1;",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("ignores a Promise .catch(cb) arrow handler — out of scope (f)", async () => {
      await write(
        "ok.ts",
        "export async function f() {\n  await risky().catch(() => {});\n  const b = await g().catch(() => ({}));\n  return b;\n}\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("ignores a Promise .catch(function () {…}) handler — the dot excludes it", async () => {
      await write(
        "ok.ts",
        [
          "export async function f() {",
          "  await risky().catch(function () {",
          "    log();",
          "  });",
          "  return 1;",
          "}",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("handles nested template literals without desyncing (`a${`b`}c`)", async () => {
      await write(
        "ok.ts",
        [
          "export function f(x: string) {",
          "  const s = `a${`b${x}c`}d`;",
          "  try {",
          "    return risky(s);",
          "  } catch {",
          "    return undefined;",
          "  }",
          "}",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("still sees a catch-and-continue INSIDE a template ${} expression", async () => {
      await write(
        "bad.ts",
        [
          "export const s = `v${(() => {",
          "  try {",
          "    return risky();",
          "  } catch (e) {",
          "    console.error(e);",
          "  }",
          "  return 0;",
          "})()}w`;",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
    });

    it("strips regex literals after keywords so their braces can't desync (return /a{2}/)", async () => {
      await write(
        "ok.ts",
        [
          "export function f(s: string): boolean {",
          '  if (s === "x") return /a{2}/.test(s);',
          '  if (s === "y") return /^}/.test(s);', // unbalanced `}` inside regex
          "  try {",
          "    return risky(s);",
          "  } catch {",
          "    return false;",
          "  }",
          "}",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("flags a body whose only 'exit' is a .throw property call", async () => {
      await write(
        "bad.ts",
        [
          "export function f(gen: Generator) {",
          "  try {",
          "    risky();",
          "  } catch (e) {",
          "    gen.throw(e);",
          "  }",
          "}",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
    });

    it("accepts a bare reject(…) call in the catch body", async () => {
      await write(
        "ok.ts",
        [
          "export function f(reject: (e: unknown) => void) {",
          "  try {",
          "    risky();",
          "  } catch (e) {",
          "    reject(e);",
          "  }",
          "}",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("does not count throwaway/returnValue identifiers as exits", async () => {
      await write(
        "bad.ts",
        [
          "export function f() {",
          "  let returnValue = 1;",
          "  try {",
          "    returnValue = risky();",
          "  } catch (e) {",
          "    const throwaway = e;",
          "    returnValue = 2 + Number(Boolean(throwaway));",
          "  }",
          "  return returnValue;",
          "}",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
    });

    it("flags a catch whose only exits live inside NESTED function bodies", async () => {
      await write(
        "bad.ts",
        [
          "export function f() {",
          "  try {",
          "    risky();",
          "  } catch (e) {",
          "    const g = () => {",
          "      return 1;", // exits g when called later — not the catch
          "    };",
          "    const h = function named() {",
          "      throw e;", // ditto
          "    };",
          "    log(e, g, h);",
          "  }",
          "}",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("bad.ts"))).toBe(true);
    });

    it("accepts a top-level throw after a nested function definition", async () => {
      await write(
        "ok.ts",
        [
          "export function f() {",
          "  try {",
          "    risky();",
          "  } catch (e) {",
          "    const cleanup = () => {",
          "      log(e);",
          "    };",
          "    cleanup();",
          "    throw e;", // the catch's OWN exit — must still count
          "  }",
          "}",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toEqual([]);
    });

    it("handles a destructured catch binding ({ message })", async () => {
      await write(
        "mixed.ts",
        [
          "export function ok(): string {",
          "  try {",
          "    return risky();",
          "  } catch ({ message }) {",
          "    return String(message);",
          "  }",
          "}",
          "export function bad() {",
          "  try {",
          "    risky();",
          "  } catch ({ message }) {",
          "    console.error(message);",
          "  }",
          "}",
        ].join("\n") + "\n",
      );
      const violations = await findViolations(tmp);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("mixed.ts");
    });

    // The two real allowlist entries are keyed by file + a body fingerprint,
    // not a line number: the same fall-through shape in the RIGHT file with the
    // fingerprint passes, while an identical shape elsewhere is still flagged.
    it("allowlist: fingerprint match in the named file passes; same shape elsewhere is flagged", async () => {
      const fallThrough = (marker: string) =>
        [
          "export async function f() {",
          "  let toolError: string | null = null;",
          "  let status = 200;",
          "  try {",
          "    status = await risky();",
          "  } catch (err) {",
          `    ${marker}`,
          "    status = 500;",
          "  }",
          "  record(status, toolError);",
          "  return status;",
          "}",
        ].join("\n") + "\n";
      // Fingerprinted body in the allowlisted file → skipped.
      await write("mcp-jsonrpc.ts", fallThrough('toolError = err instanceof Error ? err.message : "x";'));
      // Same fall-through shape, different file / no fingerprint → flagged.
      await write("other.ts", fallThrough("toolError = String(err);"));
      const violations = await findViolations(tmp);
      expect(violations.some((v: string) => v.includes("mcp-jsonrpc.ts"))).toBe(false);
      expect(violations.some((v: string) => v.includes("other.ts"))).toBe(true);
    });
  });
});
