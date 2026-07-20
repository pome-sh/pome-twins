// SPDX-License-Identifier: Apache-2.0
// F-705 — the no-native-modules gate keeps M2's "zero native deps" true by
// failing CI when a gyp-marked package enters the production closure. The
// decision table lives here: prod + gyp marker = offend; install-script
// without markers (esbuild-shaped) = pass; dev/devOptional (fsevents-shaped)
// = out of scope; platform-gated optional prod = skipped, missing prod = throw.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs gate script, no type declarations.
import { findNativeModules } from "../../../scripts/no-native-modules.mjs";

interface FixturePkg {
  path: string;
  flags?: Record<string, boolean>;
  bindingGyp?: boolean;
  gypfileField?: boolean;
  installScript?: boolean;
  onDisk?: boolean; // default true
}

async function makeRoot(pkgs: FixturePkg[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "no-native-fixture-"));
  const lockPackages: Record<string, object> = {
    "": { name: "fixture-root", version: "0.0.0" },
  };
  for (const pkg of pkgs) {
    lockPackages[pkg.path] = { version: "1.0.0", ...(pkg.flags ?? {}) };
    if (pkg.onDisk === false) continue;
    const dir = join(root, pkg.path);
    await mkdir(dir, { recursive: true });
    const manifest: Record<string, unknown> = { name: pkg.path.split("/").pop(), version: "1.0.0" };
    if (pkg.gypfileField) manifest.gypfile = true;
    if (pkg.installScript) manifest.scripts = { install: "node install.js" };
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
    if (pkg.bindingGyp) await writeFile(join(dir, "binding.gyp"), "{}");
  }
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({ name: "fixture-root", lockfileVersion: 3, packages: lockPackages }),
  );
  return root;
}

describe("no-native-modules gate (F-705)", () => {
  it("flags a production package with binding.gyp", async () => {
    const root = await makeRoot([
      { path: "node_modules/native-thing", bindingGyp: true },
    ]);
    const { offenders } = await findNativeModules(root);
    expect(offenders).toEqual([
      { path: "node_modules/native-thing", markers: ["binding.gyp"] },
    ]);
  });

  it('flags a production package with "gypfile": true even without binding.gyp', async () => {
    const root = await makeRoot([
      { path: "node_modules/gypfield", gypfileField: true },
    ]);
    const { offenders } = await findNativeModules(root);
    expect(offenders).toEqual([
      { path: "node_modules/gypfield", markers: ['"gypfile": true'] },
    ]);
  });

  it("passes an install-script-only prebuilt installer (esbuild-shaped)", async () => {
    const root = await makeRoot([
      { path: "node_modules/prebuilt", installScript: true, flags: { hasInstallScript: true } },
    ]);
    const { offenders, checked } = await findNativeModules(root);
    expect(offenders).toEqual([]);
    expect(checked).toBe(1);
  });

  it("ignores dev and devOptional packages even with gyp markers (fsevents-shaped)", async () => {
    const root = await makeRoot([
      { path: "node_modules/dev-native", bindingGyp: true, flags: { dev: true } },
      { path: "node_modules/devopt-native", bindingGyp: true, flags: { devOptional: true } },
    ]);
    const { offenders, checked } = await findNativeModules(root);
    expect(offenders).toEqual([]);
    expect(checked).toBe(0);
  });

  it("skips a platform-gated optional prod package that is not installed", async () => {
    const root = await makeRoot([
      { path: "node_modules/other-os-binary", flags: { optional: true }, onDisk: false },
    ]);
    const { offenders, skippedOptional } = await findNativeModules(root);
    expect(offenders).toEqual([]);
    expect(skippedOptional).toEqual(["node_modules/other-os-binary"]);
  });

  it("throws (fail-closed) when a non-optional prod package is missing from disk", async () => {
    const root = await makeRoot([
      { path: "node_modules/not-installed", onDisk: false },
    ]);
    await expect(findNativeModules(root)).rejects.toThrow(/npm ci/);
  });

  it("ignores workspace link entries", async () => {
    const root = await makeRoot([
      { path: "node_modules/@pome-sh/sdk", flags: { link: true }, onDisk: false },
    ]);
    const { offenders, checked } = await findNativeModules(root);
    expect(offenders).toEqual([]);
    expect(checked).toBe(0);
  });

  it("flags a production package that ships a packaged .node binary", async () => {
    const root = await makeRoot([{ path: "node_modules/prebuilt-addon" }]);
    await mkdir(join(root, "node_modules/prebuilt-addon/lib"), { recursive: true });
    await writeFile(join(root, "node_modules/prebuilt-addon/lib/addon.node"), "");
    const { offenders } = await findNativeModules(root);
    expect(offenders).toEqual([
      { path: "node_modules/prebuilt-addon", markers: ["packaged .node binary"] },
    ]);
  });
});
