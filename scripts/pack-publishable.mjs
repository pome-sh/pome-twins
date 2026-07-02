// SPDX-License-Identifier: Apache-2.0
//
// FDRS-585 / FDRS-612 (T10) — produce publishable npm tarballs for
// @pome-sh/shared-types, @pome-sh/adapter-claude-sdk and @pome-sh/sdk.
//
// In-repo dev resolves these packages via the bun workspace to their raw
// `./src/*.ts` (fast, no build). That source-pointing package.json cannot be
// published: npm consumers can't run TypeScript, and `workspace:*` is
// unresolvable off-workspace. This script bridges the gap WITHOUT disturbing
// the committed dev manifests:
//
//   1. `tsc -p tsconfig.build.json` emits runnable `dist/` (JS + .d.ts).
//   2. each package is copied into an isolated staging dir with a rewritten
//      manifest whose main/types/exports point at `dist`, devDependencies are
//      dropped, and (for @pome-sh/sdk) the `workspace:*` shared-types dep is
//      replaced with the vendored `file:./vendor/<tgz>` + bundledDependencies
//      so `npm pack` bundles a runnable shared-types.
//   3. `npm pack` runs in the staging dir (off-workspace, so `file:` resolves
//      and bundledDependencies is honoured).
//
// Usage:
//   node scripts/pack-publishable.mjs --out <dir>
//   node scripts/pack-publishable.mjs --vendor        # refresh packages/sdk/vendor
//   node scripts/pack-publishable.mjs --check-vendor  # fail if packages/sdk/vendor is stale
//
// Emits: <out>/pome-sh-shared-types-<v>.tgz, pome-sh-adapter-claude-sdk-<v>.tgz,
//        pome-sh-sdk-<v>.tgz  (default <out> = dist-tarballs/ at repo root)

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : join(repoRoot, "dist-tarballs"));
const doVendor = args.includes("--vendor");
const checkVendor = args.includes("--check-vendor");

const sh = (cmd, cwd, extraArgs) =>
  execFileSync(cmd, extraArgs, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });

const readPkg = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

function build(pkgDir) {
  // Clean stale output so a renamed/removed source file can't linger in dist.
  rmSync(join(pkgDir, "dist"), { recursive: true, force: true });
  // bun hoists tsc per-package; prefer the package-local binary, fall back to root.
  const local = join(pkgDir, "node_modules/.bin/tsc");
  const root = resolve(repoRoot, "node_modules/.bin/tsc");
  const tsc = existsSync(local) ? local : root;
  sh(tsc, pkgDir, ["-p", "tsconfig.build.json"]);
}

// npm pack prints the produced filename on stdout.
function npmPack(cwd) {
  const out = sh("npm", cwd, ["pack", "--silent"]);
  return out.trim().split("\n").pop().trim();
}

function extractTgz(tgzPath) {
  const dir = mkdtempSync(join(tmpdir(), "pome-pack-check-"));
  sh("tar", dir, ["-xzf", tgzPath]);
  return dir;
}

function listFiles(root, dir = root) {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      const rel = path.slice(root.length + 1);
      if (statSync(path).isDirectory()) return listFiles(root, path);
      return rel;
    })
    .sort();
}

function assertSamePackageContents(actualTgz, expectedTgz) {
  const actualRoot = extractTgz(actualTgz);
  const expectedRoot = extractTgz(expectedTgz);
  try {
    const actualPkg = join(actualRoot, "package");
    const expectedPkg = join(expectedRoot, "package");
    const actualFiles = listFiles(actualPkg);
    const expectedFiles = listFiles(expectedPkg);
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(
        `file list differs\nactual:   ${actualFiles.join(", ")}\nexpected: ${expectedFiles.join(", ")}`,
      );
    }
    for (const file of actualFiles) {
      const actualBytes = readFileSync(join(actualPkg, file));
      const expectedBytes = readFileSync(join(expectedPkg, file));
      if (!actualBytes.equals(expectedBytes)) {
        throw new Error(`contents differ for ${file}`);
      }
    }
  } finally {
    rmSync(actualRoot, { recursive: true, force: true });
    rmSync(expectedRoot, { recursive: true, force: true });
  }
}

function stage(pkgDir, transform) {
  const staging = mkdtempSync(join(tmpdir(), "pome-pack-"));
  const pkg = readPkg(pkgDir);
  const included = new Set(["dist", "vendor", "README.md", ...(pkg.files ?? [])]);
  for (const entry of included) {
    try {
      cpSync(join(pkgDir, entry), join(staging, entry), { recursive: true });
    } catch {
      /* optional entry (e.g. no README) */
    }
  }
  const manifest = transform({ ...pkg });
  writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { staging, version: pkg.version };
}

function distManifest(pkg, extraExports = {}) {
  const { devDependencies, ...rest } = pkg;
  return {
    ...rest,
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      ...extraExports,
    },
    files: ["dist", "package.json", ...(pkg.files?.includes("README.md") ? ["README.md"] : [])],
  };
}

mkdirSync(outDir, { recursive: true });
const results = {};

// ── @pome-sh/shared-types ─────────────────────────────────────────────────
const stDir = join(repoRoot, "packages/shared-types");
build(stDir);
{
  const { staging, version } = stage(stDir, (pkg) => {
    const m = distManifest(pkg);
    m.files = ["dist", "package.json"];
    return m;
  });
  const tgz = npmPack(staging);
  cpSync(join(staging, tgz), join(outDir, tgz));
  results.sharedTypes = { tgz, version };
  rmSync(staging, { recursive: true, force: true });
}
const sharedTypesTgz = results.sharedTypes.tgz;

// Optionally refresh the committed @pome-sh/sdk vendor copy.
//
// NOTE: this deliberately does NOT touch cli/vendor. The CLI's shared-types
// re-vendor is a separately version-gated change (cli-version-gate.yml pins the
// tgz SHA in cli/scripts/verify-vendor.mjs); it is tracked as a follow-up.
if (doVendor) {
  const vendorDir = join(repoRoot, "packages/sdk/vendor");
  mkdirSync(vendorDir, { recursive: true });
  // Drop any stale shared-types tarball so only one version is vendored.
  for (const f of readdirSync(vendorDir)) {
    if (/^pome-sh-shared-types-.*\.tgz$/.test(f) && f !== sharedTypesTgz) {
      rmSync(join(vendorDir, f));
    }
  }
  cpSync(join(outDir, sharedTypesTgz), join(vendorDir, sharedTypesTgz));
  console.error(`vendored ${sharedTypesTgz} into packages/sdk/vendor`);
}

if (checkVendor) {
  const vendoredTgz = join(repoRoot, "packages/sdk/vendor", sharedTypesTgz);
  if (!existsSync(vendoredTgz)) {
    throw new Error(
      `packages/sdk/vendor/${sharedTypesTgz} is missing. Run: node scripts/pack-publishable.mjs --vendor`,
    );
  }
  assertSamePackageContents(vendoredTgz, join(outDir, sharedTypesTgz));
  console.error(`verified packages/sdk/vendor/${sharedTypesTgz} matches a fresh shared-types pack`);
}

// ── @pome-sh/adapter-claude-sdk ───────────────────────────────────────────
const adapterDir = join(repoRoot, "packages/adapter-claude-sdk");
build(adapterDir);
{
  const { staging, version } = stage(adapterDir, (pkg) => distManifest(pkg));
  const tgz = npmPack(staging);
  cpSync(join(staging, tgz), join(outDir, tgz));
  results.adapter = { tgz, version };
  rmSync(staging, { recursive: true, force: true });
}

// ── @pome-sh/sdk (bundles vendored shared-types) ──────────────────────────
const sdkDir = join(repoRoot, "packages/sdk");
build(sdkDir);
{
  const { staging, version } = stage(sdkDir, (pkg) => {
    const m = distManifest(pkg, {
      "./server": { types: "./dist/server.d.ts", default: "./dist/server.js" },
    });
    m.files = ["dist", "vendor", "package.json"];
    m.dependencies = {
      ...pkg.dependencies,
      "@pome-sh/shared-types": `file:./vendor/${sharedTypesTgz}`,
    };
    m.bundledDependencies = ["@pome-sh/shared-types"];
    return m;
  });
  // Ensure the freshly built shared-types tgz is the one vendored into staging.
  mkdirSync(join(staging, "vendor"), { recursive: true });
  cpSync(join(outDir, sharedTypesTgz), join(staging, "vendor", sharedTypesTgz));
  // Materialize node_modules from the vendored tgz so bundledDependencies packs it.
  sh("npm", staging, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"]);
  const tgz = npmPack(staging);
  cpSync(join(staging, tgz), join(outDir, tgz));
  results.sdk = { tgz, version };
  rmSync(staging, { recursive: true, force: true });
}

console.error(`\nTarballs written to ${outDir}:`);
for (const { tgz } of Object.values(results)) console.error(`  ${tgz}`);
console.log(JSON.stringify(results));
